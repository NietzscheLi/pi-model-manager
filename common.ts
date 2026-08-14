// 通用小工具：JSON 解析、字符串处理、错误格式化、克隆。
// 与 pi-model-add/common.ts 等价；后续 step 不再依赖旧插件。

import { t } from "./i18n.ts";
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stripJsonNoise(source: string): string {
	return source
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match.startsWith('"') ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match.startsWith('"') ? match : ""));
}

export function trimOrFallback(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed ? trimmed : fallback;
}

export function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function cloneStringRecord(record: Record<string, string> | undefined): Record<string, string> {
	return { ...(record ?? {}) };
}

export function hasStringRecordEntries(record: Record<string, string> | undefined): boolean {
	return record !== undefined && Object.keys(record).length > 0;
}

export function parseStringRecordJson(source: string, label: string): Record<string, string> {
	const parsed = JSON.parse(stripJsonNoise(source));
	if (!isObjectRecord(parsed)) throw new Error(t("{label} JSON 必须是对象", { label }));
	const record: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string") throw new Error(t("{label} {key} 的值必须是字符串", { label, key }));
		const trimmedKey = key.trim();
		if (trimmedKey) record[trimmedKey] = value;
	}
	return record;
}

export function stringifyJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function cloneJson<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
