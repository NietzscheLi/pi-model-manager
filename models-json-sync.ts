// models-json-sync.ts
//
// 将插件自有 state 中的接入/模型同步到 Pi 原生配置：
// - models.json 承载模型定义，供 /model、--list-models、workflow 子代理等原生路径读取。
// - settings.json 的 enabledModels 只在用户已经启用模型范围过滤时追加新模型；未配置时保持“全部启用”。

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { atomicWriteText } from "./atomic-write.ts";
import { cloneJson, formatUnknownError, isObjectRecord, stringifyJson, stripJsonNoise } from "./common.ts";
import { withConfigurationLock } from "./configuration-lock.ts";
import { readStableTextFileSnapshot } from "./file-snapshot.ts";
import {
	deleteModelInDoc,
	deleteProviderInDoc,
	markProviderEntryAsPluginManaged,
	setModelInDoc,
	setProviderInDoc,
	type ModelsJsonDocument,
	type ModelsJsonModelEntry,
	type ModelsJsonProviderEntry,
} from "./models-json-manager.ts";
import { buildModelRequestHeaders } from "./provider-registrar.ts";
import type {
	BuiltInClientHeaderProfileId,
	StateDocument,
	StoredClientHeaderCapture,
	StoredModel,
	StoredProvider,
	StoredRequestHeaderProfile,
} from "./types.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface NativeModelVerification {
	ok: boolean;
	warnings: string[];
}

export interface EnabledModelUpdate {
	mode: "all-enabled" | "updated" | "unchanged";
	scope?: "global" | "project";
}

function copyRecord(value: unknown): Record<string, unknown> | undefined {
	return isObjectRecord(value) ? cloneJson(value) : undefined;
}

function copyStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isObjectRecord(value)) return undefined;
	const record: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") record[key] = item;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

function copyCost(value: StoredModel["cost"]): ModelsJsonModelEntry["cost"] {
	return cloneJson(value);
}

function copyInput(value: StoredModel["input"]): ModelsJsonModelEntry["input"] {
	return [...value];
}

function buildModelsJsonModelEntry(
	provider: StoredProvider,
	model: StoredModel,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
	existing?: ModelsJsonModelEntry,
): ModelsJsonModelEntry {
	const next: ModelsJsonModelEntry = existing ? { ...existing } : { id: model.id };
	next.id = model.id;
	if (model.name) next.name = model.name;
	else delete next.name;
	if (model.api) next.api = model.api;
	else delete next.api;
	if (model.baseUrl) next.baseUrl = model.baseUrl;
	else delete next.baseUrl;
	next.reasoning = model.reasoning;
	if (model.thinkingLevelMap) next.thinkingLevelMap = { ...model.thinkingLevelMap };
	else delete next.thinkingLevelMap;
	next.input = copyInput(model.input);
	next.contextWindow = model.contextWindow;
	next.maxTokens = model.maxTokens;
	next.cost = copyCost(model.cost);
	const headers = buildModelRequestHeaders(provider, model, requestHeaderProfiles, clientHeaderCaptures);
	if (headers) next.headers = headers;
	else delete next.headers;
	if (model.compat) next.compat = copyRecord(model.compat);
	else delete next.compat;
	return next;
}

function buildModelsJsonProviderEntry(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
	existing?: ModelsJsonProviderEntry,
): ModelsJsonProviderEntry {
	const next: ModelsJsonProviderEntry = existing ? { ...existing } : {};
	if (provider.name) next.name = provider.name;
	else delete next.name;
	next.baseUrl = provider.baseUrl;
	next.api = provider.api;
	if (provider.apiKey) next.apiKey = provider.apiKey;
	else delete next.apiKey;
	if (provider.authHeader !== undefined) next.authHeader = provider.authHeader;
	else delete next.authHeader;
	const providerHeaders = copyStringRecord(provider.headers);
	if (providerHeaders) next.headers = providerHeaders;
	else delete next.headers;
	if (provider.compat) next.compat = copyRecord(provider.compat);
	else delete next.compat;
	if (provider.modelOverrides) next.modelOverrides = cloneJson(provider.modelOverrides);
	else delete next.modelOverrides;
	const existingModels = new Map((existing?.models ?? []).map((model) => [model.id, model]));
	next.models = provider.models.map((model) => buildModelsJsonModelEntry(
		provider,
		model,
		requestHeaderProfiles,
		clientHeaderCaptures,
		existingModels.get(model.id),
	));
	return markProviderEntryAsPluginManaged(next);
}

export function buildSynchronizedModelsDocument(
	document: StateDocument,
	sourceDocument: ModelsJsonDocument,
	removedProviderIds: string[] = [],
	changedProviderIds: string[] = document.managedProviderIds,
): ModelsJsonDocument {
	let nextDocument = sourceDocument;
	for (const providerId of removedProviderIds) {
		nextDocument = deleteProviderInDoc(nextDocument, providerId);
	}
	for (const providerId of [...new Set(changedProviderIds)]) {
		const provider = document.providers[providerId];
		if (!provider || provider.models.length === 0) {
			nextDocument = deleteProviderInDoc(nextDocument, providerId);
			continue;
		}
		const entry = buildModelsJsonProviderEntry(
			provider,
			document.requestHeaderProfiles,
			document.clientHeaderCaptures,
			nextDocument.providers[providerId],
		);
		nextDocument = setProviderInDoc(nextDocument, providerId, entry);
	}
	return nextDocument;
}

export function buildModelsDocumentWithSynchronizedModel(
	document: StateDocument,
	sourceDocument: ModelsJsonDocument,
	providerId: string,
	modelId: string,
	replacedModelId?: string,
): ModelsJsonDocument {
	const provider = document.providers[providerId];
	if (!provider) throw new Error(`接入不存在：${providerId}`);
	const model = provider.models.find((candidate) => candidate.id === modelId);
	if (!model) throw new Error(`模型不存在：${providerId}/${modelId}`);
	const sourceModel = sourceDocument.providers[providerId]?.models?.find(
		(candidate) => candidate.id === modelId || candidate.id === replacedModelId,
	);
	const entry = buildModelsJsonModelEntry(
		provider,
		model,
		document.requestHeaderProfiles,
		document.clientHeaderCaptures,
		sourceModel,
	);
	return setModelInDoc(sourceDocument, providerId, entry, replacedModelId);
}

export function buildModelsDocumentWithoutModel(
	document: StateDocument,
	sourceDocument: ModelsJsonDocument,
	providerId: string,
	modelId: string,
): ModelsJsonDocument {
	return document.providers[providerId]
		? deleteModelInDoc(sourceDocument, providerId, modelId)
		: deleteProviderInDoc(sourceDocument, providerId);
}
function splitThinkingSuffix(pattern: string): { base: string; suffix: string } {
	const index = pattern.lastIndexOf(":");
	if (index < 0) return { base: pattern, suffix: "" };
	const maybeLevel = pattern.slice(index + 1);
	if (!THINKING_LEVELS.has(maybeLevel)) return { base: pattern, suffix: "" };
	return { base: pattern.slice(0, index), suffix: pattern.slice(index) };
}

function dedupeModelPatterns(patterns: string[]): string[] {
	const seen = new Set<string>();
	const next: string[] = [];
	for (const pattern of patterns) {
		const base = splitThinkingSuffix(pattern).base.toLowerCase();
		if (seen.has(base)) continue;
		seen.add(base);
		next.push(pattern);
	}
	return next;
}

function enabledModelPatternMatches(pattern: string, fullModelId: string): boolean {
	const slashIndex = fullModelId.indexOf("/");
	const modelId = slashIndex >= 0 ? fullModelId.slice(slashIndex + 1) : fullModelId;
	return minimatch(fullModelId, pattern, { nocase: true })
		|| minimatch(modelId, pattern, { nocase: true });
}

function sameModelPatternBase(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function upsertEnabledModelPattern(patterns: string[], fullModelId: string, replacedFullModelId?: string): string[] {
	let covered = patterns.some((pattern) => enabledModelPatternMatches(splitThinkingSuffix(pattern).base, fullModelId));
	const next = patterns.map((pattern) => {
		const { base, suffix } = splitThinkingSuffix(pattern);
		if (replacedFullModelId && sameModelPatternBase(base, replacedFullModelId)) {
			covered = true;
			return `${fullModelId}${suffix}`;
		}
		return pattern;
	});
	if (!covered) next.push(fullModelId);
	return dedupeModelPatterns(next);
}

function removeEnabledModelPatterns(patterns: string[], fullModelIds: readonly string[]): string[] {
	const removedIds = new Set(fullModelIds.map((fullModelId) => fullModelId.toLowerCase()));
	return patterns.filter((pattern) => !removedIds.has(splitThinkingSuffix(pattern).base.toLowerCase()));
}

function removeEnabledProviderPatterns(patterns: string[], providerId: string): string[] {
	const providerPrefix = `${providerId}/`.toLowerCase();
	return patterns.filter((pattern) => !splitThinkingSuffix(pattern).base.toLowerCase().startsWith(providerPrefix));
}

interface SettingsFileLock {
	lock(path: string, options: {
		realpath: false;
		retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
	}): Promise<() => Promise<void>>;
}

const require = createRequire(import.meta.url);
const settingsFileLock = require("proper-lockfile") as SettingsFileLock;

interface LockedSettingsUpdate {
	configured: boolean;
	outcome: EnabledModelUpdate;
}

async function updateLockedSettings(
	path: string,
	scope: "global" | "project",
	update: (patterns: string[]) => string[],
): Promise<LockedSettingsUpdate> {
	const initialSnapshot = await readStableTextFileSnapshot(path);
	if (initialSnapshot.source === undefined) {
		return { configured: false, outcome: { mode: "all-enabled" } };
	}
	const release = await settingsFileLock.lock(path, {
		realpath: false,
		retries: { retries: 10, factor: 1, minTimeout: 20, maxTimeout: 20 },
	});
	try {
		const snapshot = await readStableTextFileSnapshot(path);
		const settings = snapshot.source === undefined ? {} : JSON.parse(stripJsonNoise(snapshot.source));
		if (!isObjectRecord(settings)) throw new Error(`${path} 根节点必须是对象`);
		const current = settings.enabledModels;
		if (!Array.isArray(current)) return { configured: false, outcome: { mode: "all-enabled" } };
		const patterns = current.filter((item): item is string => typeof item === "string");
		if (patterns.length === 0) return { configured: true, outcome: { mode: "all-enabled" } };
		const next = update(patterns);
		if (JSON.stringify(next) === JSON.stringify(patterns)) {
			return { configured: true, outcome: { mode: "unchanged", scope } };
		}
		const currentSnapshot = await readStableTextFileSnapshot(path);
		if (currentSnapshot.contentHash !== snapshot.contentHash) {
			throw new Error(`${path} 已被未遵守 Pi 文件锁的编辑器修改；已取消 enabledModels 同步，请重试。`);
		}
		settings.enabledModels = next;
		await atomicWriteText(path, stringifyJson(settings));
		return { configured: true, outcome: { mode: "updated", scope } };
	} finally {
		await release();
	}
}

async function updateEnabledModelsForNextPiStart(
	cwd: string,
	update: (patterns: string[]) => string[],
): Promise<EnabledModelUpdate> {
	const projectUpdate = await updateLockedSettings(join(cwd, CONFIG_DIR_NAME, "settings.json"), "project", update);
	if (projectUpdate.configured) return projectUpdate.outcome;
	return (await updateLockedSettings(join(getAgentDir(), "settings.json"), "global", update)).outcome;
}

export async function enableModelForNextPiStart(
	cwd: string,
	fullModelId: string,
	replacedFullModelId?: string,
): Promise<EnabledModelUpdate> {
	return withConfigurationLock(() => updateEnabledModelsForNextPiStart(
		cwd,
		(patterns) => upsertEnabledModelPattern(patterns, fullModelId, replacedFullModelId),
	));
}

export async function removeModelFromNextPiStart(cwd: string, fullModelId: string): Promise<EnabledModelUpdate> {
	return withConfigurationLock(() => updateEnabledModelsForNextPiStart(
		cwd,
		(patterns) => removeEnabledModelPatterns(patterns, [fullModelId]),
	));
}

export async function removeProviderFromNextPiStart(cwd: string, providerId: string): Promise<EnabledModelUpdate> {
	return withConfigurationLock(() => updateEnabledModelsForNextPiStart(
		cwd,
		(patterns) => removeEnabledProviderPatterns(patterns, providerId),
	));
}

function replaceEnabledProviderPatterns(
	patterns: string[],
	oldProviderId: string,
	newProviderId: string,
): string[] {
	const oldPrefix = `${oldProviderId}/`;
	let changed = false;
	const next = patterns.map((pattern) => {
		const { base, suffix } = splitThinkingSuffix(pattern);
		if (!base.toLowerCase().startsWith(oldPrefix.toLowerCase())) return pattern;
		changed = true;
		return `${newProviderId}/${base.slice(oldPrefix.length)}${suffix}`;
	});
	return changed ? dedupeModelPatterns(next) : patterns;
}


export async function replaceProviderInEnabledModelsForNextPiStart(
	cwd: string,
	oldProviderId: string,
	newProviderId: string,
): Promise<EnabledModelUpdate> {
	if (oldProviderId === newProviderId) return { mode: "unchanged" };
	return withConfigurationLock(() => updateEnabledModelsForNextPiStart(
		cwd,
		(patterns) => replaceEnabledProviderPatterns(patterns, oldProviderId, newProviderId),
	));
}

async function verifyRegistryModel(
	label: string,
	registry: ModelRegistry,
	providerId: string,
	modelId: string,
): Promise<string[]> {
	const warnings: string[] = [];
	const model = registry.find(providerId, modelId);
	if (!model) {
		warnings.push(`${label} 未找到模型 ${providerId}/${modelId}`);
		return warnings;
	}
	if (!registry.hasConfiguredAuth(model)) {
		warnings.push(`${label} 找到模型 ${providerId}/${modelId}，但 API key 未配置或不可解析`);
		return warnings;
	}
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) warnings.push(`${label} 请求认证解析失败：${auth.error}`);
	return warnings;
}

// 当前 registry 已在持久化边界 reload；独立 runtime 校验保证下次启动仍可从原生 models.json 解析。
export async function verifyNativeModelAvailable(
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
): Promise<NativeModelVerification> {
	const warnings: string[] = [];
	warnings.push(...await verifyRegistryModel("当前会话 registry", ctx.modelRegistry, providerId, modelId));
	try {
		const agentDir = getAgentDir();
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		warnings.push(...await verifyRegistryModel("原生 models.json registry", registry, providerId, modelId));
	} catch (error) {
		warnings.push(`原生 models.json registry 校验失败：${formatUnknownError(error)}`);
	}
	return { ok: warnings.length === 0, warnings };
}
