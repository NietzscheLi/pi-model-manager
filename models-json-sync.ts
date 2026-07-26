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
	SettingsManager,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { atomicWriteText } from "./atomic-write.ts";
import { cloneJson, formatUnknownError, isObjectRecord, stringifyJson, stripJsonNoise } from "./common.ts";
import {
	deleteProviderInDoc,
	readModelsJsonSnapshot,
	renameModelInDoc,
	renameProviderInDoc,
	setProviderInDoc,
	writeModelsJsonSnapshot,
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

export function buildModelsJsonProviderEntry(
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
	return next;
}

export function buildSynchronizedModelsDocument(
	document: StateDocument,
	sourceDocument: ModelsJsonDocument,
	removedProviderIds: string[] = [],
): ModelsJsonDocument {
	let nextDocument = sourceDocument;
	for (const providerId of removedProviderIds) {
		nextDocument = deleteProviderInDoc(nextDocument, providerId);
	}
	for (const [providerId, provider] of Object.entries(document.providers)) {
		if (provider.models.length === 0) {
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

export async function syncStateToModelsJson(document: StateDocument, removedProviderIds: string[] = []): Promise<void> {
	const snapshot = await readModelsJsonSnapshot();
	const nextDocument = buildSynchronizedModelsDocument(document, snapshot.document, removedProviderIds);
	await writeModelsJsonSnapshot(snapshot, nextDocument);
}

export async function syncProviderRenameToModelsJson(
	document: StateDocument,
	oldProviderId: string,
	newProviderId: string,
): Promise<void> {
	const snapshot = await readModelsJsonSnapshot();
	const renamedDocument = renameProviderInDoc(snapshot.document, oldProviderId, newProviderId);
	const nextDocument = buildSynchronizedModelsDocument(document, renamedDocument);
	await writeModelsJsonSnapshot(snapshot, nextDocument);
}

export async function syncModelRenameToModelsJson(
	document: StateDocument,
	providerId: string,
	oldModelId: string,
	newModelId: string,
): Promise<void> {
	const snapshot = await readModelsJsonSnapshot();
	const renamedDocument = renameModelInDoc(snapshot.document, providerId, oldModelId, newModelId);
	const nextDocument = buildSynchronizedModelsDocument(document, renamedDocument);
	await writeModelsJsonSnapshot(snapshot, nextDocument);
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

function removeEnabledModelPattern(patterns: string[], fullModelId: string): string[] {
	return patterns.filter((pattern) => !sameModelPatternBase(splitThinkingSuffix(pattern).base, fullModelId));
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await atomicWriteText(path, stringifyJson(value));
}

async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
	const source = await readFile(path, "utf8");
	const parsed = JSON.parse(stripJsonNoise(source));
	if (!isObjectRecord(parsed)) throw new Error(`${path} 根节点必须是对象`);
	return parsed;
}

async function updateProjectEnabledModels(cwd: string, update: (patterns: string[]) => string[]): Promise<EnabledModelUpdate> {
	const path = join(cwd, CONFIG_DIR_NAME, "settings.json");
	const settings = await readSettingsFile(path);
	const current = settings.enabledModels;
	if (!Array.isArray(current)) return { mode: "all-enabled" };
	const patterns = current.filter((item): item is string => typeof item === "string");
	if (patterns.length === 0) return { mode: "all-enabled" };
	const next = update(patterns);
	if (JSON.stringify(next) === JSON.stringify(patterns)) return { mode: "unchanged", scope: "project" };
	settings.enabledModels = next;
	await atomicWriteJson(path, settings);
	return { mode: "updated", scope: "project" };
}

async function flushGlobalSettingsWrite(settings: SettingsManager): Promise<void> {
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		const detail = errors.map((entry) => `${entry.scope}: ${entry.error.message}`).join("; ");
		throw new Error(`settings.json enabledModels 写入失败：${detail}`);
	}
}

async function updateGlobalEnabledModels(cwd: string, update: (patterns: string[]) => string[]): Promise<EnabledModelUpdate> {
	const settings = SettingsManager.create(cwd, getAgentDir());
	const current = settings.getGlobalSettings().enabledModels;
	if (!Array.isArray(current) || current.length === 0) return { mode: "all-enabled" };
	const patterns = current.filter((item): item is string => typeof item === "string");
	if (patterns.length === 0) return { mode: "all-enabled" };
	const next = update(patterns);
	if (JSON.stringify(next) === JSON.stringify(patterns)) return { mode: "unchanged", scope: "global" };
	settings.setEnabledModels(next);
	await flushGlobalSettingsWrite(settings);
	return { mode: "updated", scope: "global" };
}

export async function enableModelForNextPiStart(
	cwd: string,
	fullModelId: string,
	replacedFullModelId?: string,
): Promise<EnabledModelUpdate> {
	const settings = SettingsManager.create(cwd, getAgentDir());
	const projectEnabled = settings.getProjectSettings().enabledModels;
	const update = (patterns: string[]) => upsertEnabledModelPattern(patterns, fullModelId, replacedFullModelId);
	if (Array.isArray(projectEnabled)) {
		return updateProjectEnabledModels(cwd, update);
	}
	return updateGlobalEnabledModels(cwd, update);
}

export async function removeModelFromNextPiStart(cwd: string, fullModelId: string): Promise<EnabledModelUpdate> {
	const settings = SettingsManager.create(cwd, getAgentDir());
	const projectEnabled = settings.getProjectSettings().enabledModels;
	const update = (patterns: string[]) => removeEnabledModelPattern(patterns, fullModelId);
	if (Array.isArray(projectEnabled)) {
		return updateProjectEnabledModels(cwd, update);
	}
	return updateGlobalEnabledModels(cwd, update);
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
	const settings = SettingsManager.create(cwd, getAgentDir());
	const projectEnabled = settings.getProjectSettings().enabledModels;
	const update = (patterns: string[]) => replaceEnabledProviderPatterns(patterns, oldProviderId, newProviderId);
	if (Array.isArray(projectEnabled)) {
		return updateProjectEnabledModels(cwd, update);
	}
	return updateGlobalEnabledModels(cwd, update);
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
