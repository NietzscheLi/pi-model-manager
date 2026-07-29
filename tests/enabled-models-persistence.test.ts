import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, beforeEach } from "node:test";

const rootDir = join(tmpdir(), `pi-model-manager-enabled-models-${process.pid}`);
const agentDir = join(rootDir, "agent");
const cwd = join(rootDir, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	enableModelForNextPiStart,
	removeModelFromNextPiStart,
	removeProviderFromNextPiStart,
	replaceProviderInEnabledModelsForNextPiStart,
} = await import("../models-json-sync.ts");

interface TestSettingsFileLock {
	lock(path: string, options: { realpath: false }): Promise<() => Promise<void>>;
}

const require = createRequire(import.meta.url);
const settingsFileLock = require("proper-lockfile") as TestSettingsFileLock;

beforeEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
});

after(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<any> {
	return JSON.parse(await readFile(path, "utf8"));
}

test("并发 enabledModels 更新在配置锁内重读，不丢失先完成的写入", async () => {
	const globalPath = join(agentDir, "settings.json");
	await writeJson(globalPath, { enabledModels: ["seed/model"] });

	await Promise.all([
		enableModelForNextPiStart(cwd, "managed/alpha"),
		enableModelForNextPiStart(cwd, "managed/beta"),
	]);

	const settings = await readJson(globalPath);
	assert.equal(settings.enabledModels[0], "seed/model");
	assert.deepEqual(new Set(settings.enabledModels.slice(1)), new Set(["managed/alpha", "managed/beta"]));
	await assert.rejects(access(join(cwd, ".pi")), { code: "ENOENT" });
});

test("enabledModels 写入遵守 Pi 使用的 proper-lockfile", async () => {
	const globalPath = join(agentDir, "settings.json");
	await writeJson(globalPath, { enabledModels: ["seed/model"] });
	const release = await settingsFileLock.lock(globalPath, { realpath: false });
	let completed = false;
	const update = enableModelForNextPiStart(cwd, "managed/locked").then((outcome) => {
		completed = true;
		return outcome;
	});
	await delay(50);
	assert.equal(completed, false);
	await release();
	assert.deepEqual(await update, { mode: "updated", scope: "global" });
	assert.deepEqual((await readJson(globalPath)).enabledModels, ["seed/model", "managed/locked"]);
});

test("项目 enabledModels 存在时只更新项目作用域并保留未知设置", async () => {
	const globalPath = join(agentDir, "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	await writeJson(globalPath, { enabledModels: ["global/model"], globalExtension: true });
	await writeJson(projectPath, {
		enabledModels: ["old/model:high", "other/*"],
		projectExtension: { keep: true },
	});

	const outcome = await replaceProviderInEnabledModelsForNextPiStart(cwd, "old", "new");
	assert.deepEqual(outcome, { mode: "updated", scope: "project" });
	assert.deepEqual((await readJson(projectPath)).enabledModels, ["new/model:high", "other/*"]);
	assert.deepEqual((await readJson(projectPath)).projectExtension, { keep: true });
	assert.deepEqual((await readJson(globalPath)).enabledModels, ["global/model"]);
});

test("删除精确 Model 条目时保留通配符与其它设置", async () => {
	const globalPath = join(agentDir, "settings.json");
	await writeJson(globalPath, {
		enabledModels: ["managed/remove:medium", "managed/*", "other/model"],
		unknownSetting: "keep",
	});

	const outcome = await removeModelFromNextPiStart(cwd, "managed/remove");
	assert.deepEqual(outcome, { mode: "updated", scope: "global" });
	const settings = await readJson(globalPath);
	assert.deepEqual(settings.enabledModels, ["managed/*", "other/model"]);
	assert.equal(settings.unknownSetting, "keep");
});

test("删除 Provider 时清理其精确条目与通配符", async () => {
	const globalPath = join(agentDir, "settings.json");
	await writeJson(globalPath, {
		enabledModels: ["managed/one", "managed/two:high", "managed/*", "managed/gpt-*", "other/model"],
	});

	const outcome = await removeProviderFromNextPiStart(cwd, "managed");
	assert.deepEqual(outcome, { mode: "updated", scope: "global" });
	assert.deepEqual((await readJson(globalPath)).enabledModels, ["other/model"]);
});
