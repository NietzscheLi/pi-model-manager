// models-json-manager.ts
//
// 管理 pi 的 ~/.pi/agent/models.json：读 / 写 / 增 / 删 / 改。
//
// 主保存流程通过 models-json-sync.ts 同步 StateDocument；原始节点 mutation 在这里保留未知字段。
// 写入后由调用方执行 ctx.modelRegistry.refresh()，保持 pi 原生 models.json 语义。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "./atomic-write.ts";
import { cloneJson, isObjectRecord, stringifyJson, stripJsonNoise } from "./common.ts";
import type { TokenCost } from "./types.ts";

export const MODELS_JSON_PATH = join(getAgentDir(), "models.json");

// ========== schema ==========

export interface ModelsJsonModelEntry {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: TokenCost;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ModelsJsonProviderEntry {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	models?: ModelsJsonModelEntry[];
	modelOverrides?: Record<string, unknown>;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ModelsJsonDocument {
	providers: Record<string, ModelsJsonProviderEntry>;
	[key: string]: unknown;
}

export interface FileSignature {
	exists: boolean;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
}

export interface ModelsJsonSnapshot {
	document: ModelsJsonDocument;
	signature: FileSignature;
}

export interface StableTextFileSnapshot {
	source: string | undefined;
	signature: FileSignature;
}

// ========== IO ==========

function createEmpty(): ModelsJsonDocument {
	return { providers: {} };
}

const MISSING_FILE_SIGNATURE: FileSignature = { exists: false, mtimeMs: 0, ctimeMs: 0, size: -1, ino: 0 };

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readFileSignature(path: string): Promise<FileSignature> {
	try {
		const stats = await stat(path);
		return { exists: true, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size, ino: stats.ino };
	} catch (error) {
		if (isNotFound(error)) return MISSING_FILE_SIGNATURE;
		throw error;
	}
}

export function sameFileSignature(a: FileSignature, b: FileSignature): boolean {
	return a.exists === b.exists
		&& a.mtimeMs === b.mtimeMs
		&& a.ctimeMs === b.ctimeMs
		&& a.size === b.size
		&& a.ino === b.ino;
}

/** 文件在读取窗口内变化时重试，避免把旧内容和新签名组合成同一个 snapshot。 */
export async function readStableTextFileSnapshot(path: string): Promise<StableTextFileSnapshot> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const before = await readFileSignature(path);
		if (!before.exists) {
			const after = await readFileSignature(path);
			if (sameFileSignature(before, after)) return { source: undefined, signature: after };
			continue;
		}
		let source: string;
		try {
			source = await readFile(path, "utf8");
		} catch (error) {
			if (isNotFound(error)) continue;
			throw error;
		}
		const after = await readFileSignature(path);
		if (sameFileSignature(before, after)) return { source, signature: after };
	}
	throw new Error(`${path} 在读取期间持续变化；请停止其它写入后重试。`);
}

function parseModelsJson(source: string): ModelsJsonDocument {
	const parsed = JSON.parse(stripJsonNoise(source));
	if (!isObjectRecord(parsed)) throw new Error("models.json 根节点必须是对象");
	const providers = isObjectRecord(parsed.providers) ? parsed.providers : {};
	return { ...parsed, providers: providers as Record<string, ModelsJsonProviderEntry> };
}

export async function readModelsJsonSnapshot(): Promise<ModelsJsonSnapshot> {
	const snapshot = await readStableTextFileSnapshot(MODELS_JSON_PATH);
	return {
		document: snapshot.source === undefined ? createEmpty() : parseModelsJson(snapshot.source),
		signature: snapshot.signature,
	};
}

export async function readModelsJson(): Promise<ModelsJsonDocument> {
	return (await readModelsJsonSnapshot()).document;
}

export async function writeModelsJson(doc: ModelsJsonDocument): Promise<void> {
	await atomicWriteText(MODELS_JSON_PATH, stringifyJson(doc));
}

export async function writeModelsJsonSnapshot(snapshot: ModelsJsonSnapshot, doc: ModelsJsonDocument): Promise<void> {
	const current = await readFileSignature(MODELS_JSON_PATH);
	if (!sameFileSignature(snapshot.signature, current)) {
		throw new Error("models.json 已被其它进程或编辑器修改；请重新打开 /model-manager 后再保存。");
	}
	await writeModelsJson(doc);
}

export function getModelsJsonPath(): string {
	return MODELS_JSON_PATH;
}

// ========== 文档操作（纯函数，深拷贝后改） ==========

export function setProviderInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	entry: ModelsJsonProviderEntry,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	next.providers[providerId] = entry;
	return next;
}

export function deleteProviderInDoc(doc: ModelsJsonDocument, providerId: string): ModelsJsonDocument {
	const next = cloneJson(doc);
	delete next.providers[providerId];
	return next;
}

/** [喵喵喵]: 重命名直接移动原始节点，避免未知原生字段在 StateDocument 往返时丢失 (2026-07-17) */
export function renameProviderInDoc(
	doc: ModelsJsonDocument,
	oldProviderId: string,
	newProviderId: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	if (oldProviderId === newProviderId) return next;
	const source = next.providers[oldProviderId];
	if (!source) throw new Error(`models.json 中不存在待重命名接入：${oldProviderId}`);
	if (next.providers[newProviderId]) throw new Error(`models.json 中已存在接入：${newProviderId}`);
	next.providers[newProviderId] = source;
	delete next.providers[oldProviderId];
	return next;
}

export function setModelInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	model: ModelsJsonModelEntry,
	replacedModelId?: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	const provider = next.providers[providerId];
	if (!provider) throw new Error(`models.json 中不存在接入：${providerId}`);
	const retained = (provider.models ?? []).filter(
		(m) => m.id !== model.id && m.id !== replacedModelId,
	);
	provider.models = [...retained, model];
	return next;
}

export function renameModelInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	oldModelId: string,
	newModelId: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	if (oldModelId === newModelId) return next;
	const provider = next.providers[providerId];
	if (!provider) throw new Error(`models.json 中不存在接入：${providerId}`);
	const models = provider.models ?? [];
	const source = models.find((model) => model.id === oldModelId);
	if (!source) throw new Error(`models.json 中不存在待重命名模型：${providerId}/${oldModelId}`);
	if (models.some((model) => model.id === newModelId)) {
		throw new Error(`models.json 中已存在模型：${providerId}/${newModelId}`);
	}
	source.id = newModelId;
	return next;
}

export function deleteModelInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	modelId: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	const provider = next.providers[providerId];
	if (!provider) return next;
	provider.models = (provider.models ?? []).filter((m) => m.id !== modelId);
	return next;
}
