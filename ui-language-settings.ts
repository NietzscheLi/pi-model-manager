import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "./atomic-write.ts";
import { DEFAULT_UI_LANGUAGE, isUiLanguage, t, type UiLanguage } from "./i18n.ts";
import { STATE_DIR } from "./state-metadata-store.ts";

export const UI_LANGUAGE_SETTINGS_PATH = join(STATE_DIR, "ui-settings.json");

interface UiLanguageSettingsDocument {
	version: 1;
	language: UiLanguage;
}

function getErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

export function parseUiLanguageSettings(source: string): UiLanguage {
	const parsed = JSON.parse(source) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(t("语言设置根节点必须是对象"));
	}
	const settings = parsed as { version?: unknown; language?: unknown };
	if (settings.version !== 1) {
		throw new Error(t("不支持的语言设置版本：{version}", { version: String(settings.version) }));
	}
	if (!isUiLanguage(settings.language)) {
		throw new Error(t("不支持的界面语言：{language}", { language: String(settings.language) }));
	}
	return settings.language;
}

export async function readUiLanguage(path = UI_LANGUAGE_SETTINGS_PATH): Promise<UiLanguage> {
	try {
		return parseUiLanguageSettings(await readFile(path, "utf8"));
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return DEFAULT_UI_LANGUAGE;
		throw error;
	}
}

export async function writeUiLanguage(language: UiLanguage, path = UI_LANGUAGE_SETTINGS_PATH): Promise<void> {
	const document: UiLanguageSettingsDocument = { version: 1, language };
	await atomicWriteText(path, `${JSON.stringify(document, null, 2)}\n`);
}
