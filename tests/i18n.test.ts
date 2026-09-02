import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const agentDir = await mkdtemp(join(tmpdir(), "pi-model-manager-i18n-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	getEnglishMessageEntries,
	getUiLanguage,
	setUiLanguage,
	t,
} = await import("../i18n.ts");
const {
	readUiLanguage,
	writeUiLanguage,
	UI_LANGUAGE_SETTINGS_PATH,
} = await import("../ui-language-settings.ts");
const {
	formatModelListHeader,
	formatProviderConsoleHeader,
} = await import("../tui/ui-helpers.ts");

const provider = {
	name: "Demo",
	api: "openai-responses" as const,
	baseUrl: "https://example.test/v1",
	managed: true,
	clientHeaderProfile: "recommended" as const,
	models: [],
};

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!).sort();
}

after(async () => {
	setUiLanguage("zh-CN");
	await import("node:fs/promises").then(({ rm }) => rm(agentDir, { recursive: true, force: true }));
});

test("默认语言为简体中文且英文目录占位符完整", () => {
	setUiLanguage("zh-CN");
	assert.equal(getUiLanguage(), "zh-CN");
	assert.equal(t("已保存接入 {providerId}", { providerId: "demo" }), "已保存接入 demo");

	for (const [source, english] of getEnglishMessageEntries()) {
		assert.deepEqual(placeholders(english), placeholders(source), `翻译占位符不一致：${source}`);
	}
});

test("英文模式覆盖表格文本", () => {
	setUiLanguage("en");
	assert.equal(t("已保存接入 {providerId}", { providerId: "demo" }), "Saved provider demo");
	for (const width of [60, 80, 100]) {
		const providerHeader = formatProviderConsoleHeader(width);
		const modelHeader = formatModelListHeader(provider, width);
		assert.ok(visibleWidth(providerHeader) <= width, `${width} 列英文 Provider 表头溢出`);
		assert.ok(visibleWidth(modelHeader) <= width, `${width} 列英文 Model 表头溢出`);
	}
	assert.match(formatProviderConsoleHeader(100), /Provider/);
	assert.doesNotMatch(formatProviderConsoleHeader(100), /接入/);
	assert.match(formatModelListHeader(provider, 100), /Model ID/);
});

test("语言设置缺失时默认简体中文，损坏或未知设置不被覆盖", async () => {
	setUiLanguage("zh-CN");
	assert.equal(await readUiLanguage(), "zh-CN");
	await mkdir(dirname(UI_LANGUAGE_SETTINGS_PATH), { recursive: true });

	await writeFile(UI_LANGUAGE_SETTINGS_PATH, "{broken", "utf8");
	await assert.rejects(readUiLanguage(), /SyntaxError|JSON/);
	assert.equal(await readFile(UI_LANGUAGE_SETTINGS_PATH, "utf8"), "{broken");

	await writeFile(UI_LANGUAGE_SETTINGS_PATH, JSON.stringify({ version: 1, language: "fr" }), "utf8");
	await assert.rejects(readUiLanguage(), /不支持的界面语言/);
	assert.deepEqual(JSON.parse(await readFile(UI_LANGUAGE_SETTINGS_PATH, "utf8")), { version: 1, language: "fr" });
});

test("英文选择可原子保存并在重新加载后恢复", async () => {
	await writeUiLanguage("en");
	assert.equal(await readUiLanguage(), "en");
	assert.deepEqual(JSON.parse(await readFile(UI_LANGUAGE_SETTINGS_PATH, "utf8")), { version: 1, language: "en" });
});
