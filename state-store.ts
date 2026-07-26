// state-store.ts
//
// StateDocument 合成层：从 Pi 原生 models.json 读取模型定义，再叠加
// state.json 中的插件私有元数据，提供 TUI 与运行时注册使用的统一视图。

import { getBuiltinProviderDefaults } from "./builtin-model-catalog.ts";
import { mergeCompatSettings } from "./compat-settings.ts";
import { cloneJson, hasStringRecordEntries, isObjectRecord } from "./common.ts";
import { readModelsJson, type ModelsJsonDocument, type ModelsJsonModelEntry, type ModelsJsonProviderEntry } from "./models-json-manager.ts";
import {
	getClientHeadersForProfile,
	stripManagedClientHeaders,
} from "./presets/client-headers.ts";
import { normalizeThinkingLevelMap } from "./presets/thinking.ts";
import {
	getStatePath as getMetadataStatePath,
	readMetadataStateFile,
	writeMetadataState,
	type MetadataDocument,
} from "./state-metadata-store.ts";
import type {
	ApiKind,
	CompatSettings,
	ModelInputKind,
	StateDocument,
	StoredModel,
	StoredProvider,
	ThinkingLevelMap,
	TokenCost,
	TokenCostTier,
} from "./types.ts";
import { ZERO_COST } from "./types.ts";

export { STATE_PATH } from "./state-metadata-store.ts";

const API_KINDS = new Set<ApiKind>(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const INPUT_KINDS = new Set<ModelInputKind>(["text", "image"]);

function createEmptyStateDocument(): StateDocument {
	return { version: 1, providers: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} };
}

function asApiKind(value: unknown): ApiKind | undefined {
	return typeof value === "string" && API_KINDS.has(value as ApiKind) ? value as ApiKind : undefined;
}

function getFullModelId(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

function readNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readCostTier(value: unknown): TokenCostTier | undefined {
	if (!isObjectRecord(value)) return undefined;
	const inputTokensAbove = value.inputTokensAbove;
	if (typeof inputTokensAbove !== "number" || !Number.isFinite(inputTokensAbove) || inputTokensAbove < 0) return undefined;
	return {
		inputTokensAbove,
		input: readNonNegativeNumber(value.input),
		output: readNonNegativeNumber(value.output),
		cacheRead: readNonNegativeNumber(value.cacheRead),
		cacheWrite: readNonNegativeNumber(value.cacheWrite),
	};
}

function readModelCost(model: ModelsJsonModelEntry): TokenCost {
	const cost = model.cost;
	if (!cost) return { ...ZERO_COST };
	const stored: TokenCost = {
		input: readNonNegativeNumber(cost.input),
		output: readNonNegativeNumber(cost.output),
		cacheRead: readNonNegativeNumber(cost.cacheRead),
		cacheWrite: readNonNegativeNumber(cost.cacheWrite),
	};
	const tiers = cost.tiers?.map(readCostTier).filter((tier): tier is TokenCostTier => Boolean(tier));
	if (tiers && tiers.length > 0) stored.tiers = tiers;
	return stored;
}

function readModelInput(model: ModelsJsonModelEntry): ModelInputKind[] {
	const input = model.input?.filter((item): item is ModelInputKind => INPUT_KINDS.has(item as ModelInputKind));
	return input && input.length > 0 ? [...new Set(input)] : ["text"];
}

function resolveProviderCustomHeaders(
	providerMetadata: MetadataDocument["providers"][string] | undefined,
	metadata: MetadataDocument,
): Record<string, string> {
	const profileId = providerMetadata?.requestHeaderProfileId;
	if (profileId && metadata.requestHeaderProfiles[profileId]) return metadata.requestHeaderProfiles[profileId].headers;
	return providerMetadata?.customClientHeaders ?? {};
}

function buildStoredModelFromModelsJson(
	providerId: string,
	providerApi: ApiKind,
	providerBaseUrl: string,
	providerCompat: CompatSettings | undefined,
	clientHeaderProfile: StoredProvider["clientHeaderProfile"],
	customClientHeaders: Record<string, string>,
	model: ModelsJsonModelEntry,
	metadata: MetadataDocument,
): StoredModel | undefined {
	if (!model.id || typeof model.id !== "string") return undefined;
	const explicitApi = typeof model.api === "string" && model.api ? model.api : undefined;
	const effectiveApi = asApiKind(explicitApi) ?? providerApi;
	const modelCompat = model.compat ? cloneJson(model.compat) : undefined;
	const effectiveCompat = mergeCompatSettings(providerCompat, modelCompat);
	const profileHeaders = getClientHeadersForProfile(
		clientHeaderProfile,
		effectiveApi,
		customClientHeaders,
		metadata.clientHeaderCaptures,
		effectiveCompat,
	);
	const nativeHeaders = stripManagedClientHeaders(model.headers, profileHeaders);
	const stored: StoredModel = {
		id: model.id,
		reasoning: model.reasoning ?? false,
		input: readModelInput(model),
		contextWindow: model.contextWindow && model.contextWindow > 0 ? model.contextWindow : 128000,
		maxTokens: model.maxTokens && model.maxTokens > 0 ? model.maxTokens : 16384,
		cost: readModelCost(model),
	};
	if (explicitApi && explicitApi !== providerApi) stored.api = explicitApi;
	if (model.baseUrl && model.baseUrl !== providerBaseUrl) stored.baseUrl = model.baseUrl;
	if (nativeHeaders) stored.headers = nativeHeaders;
	if (model.name) stored.name = model.name;
	const storedThinkingLevelMap = model.thinkingLevelMap ? cloneJson(model.thinkingLevelMap) as ThinkingLevelMap : undefined;
	const thinkingLevelMap = normalizeThinkingLevelMap(effectiveApi, stored.reasoning, storedThinkingLevelMap);
	if (thinkingLevelMap) stored.thinkingLevelMap = thinkingLevelMap;
	if (modelCompat) stored.compat = modelCompat;
	const modelMetadata = metadata.models[getFullModelId(providerId, model.id)];
	if (effectiveApi === "openai-responses" && modelMetadata?.openAIServiceTier) {
		stored.openAIServiceTier = modelMetadata.openAIServiceTier;
	}
	return stored;
}

async function buildStoredProviderFromModelsJson(
	providerId: string,
	entry: ModelsJsonProviderEntry,
	metadata: MetadataDocument,
): Promise<StoredProvider | undefined> {
	const rawModels = entry.models ?? [];
	if (rawModels.length === 0) return undefined;

	const firstModel = rawModels[0];
	const builtInDefaults = await getBuiltinProviderDefaults(providerId);
	const api = asApiKind(entry.api) ?? asApiKind(firstModel?.api) ?? asApiKind(builtInDefaults?.api);
	const baseUrl = entry.baseUrl ?? firstModel?.baseUrl ?? builtInDefaults?.baseUrl;
	if (!api || !baseUrl) return undefined;

	const providerMetadata = metadata.providers[providerId];
	const clientHeaderProfile = providerMetadata?.clientHeaderProfile ?? "recommended";
	const customClientHeaders = clientHeaderProfile === "custom"
		? resolveProviderCustomHeaders(providerMetadata, metadata)
		: {};
	const providerCompat = entry.compat ? cloneJson(entry.compat) : undefined;
	const models = rawModels
		.map((model) => buildStoredModelFromModelsJson(
			providerId,
			api,
			baseUrl,
			providerCompat,
			clientHeaderProfile,
			customClientHeaders,
			model,
			metadata,
		))
		.filter((model): model is StoredModel => Boolean(model));
	if (models.length === 0) return undefined;

	const provider: StoredProvider = {
		name: entry.name || providerId,
		api,
		baseUrl,
		clientHeaderProfile,
		models,
	};
	if (entry.apiKey) provider.apiKey = entry.apiKey;
	if (entry.authHeader !== undefined) provider.authHeader = entry.authHeader;
	if (entry.headers !== undefined) provider.headers = cloneJson(entry.headers);
	if (providerCompat) provider.compat = providerCompat;
	if (entry.modelOverrides !== undefined) provider.modelOverrides = cloneJson(entry.modelOverrides);
	if (provider.clientHeaderProfile === "custom" && providerMetadata?.requestHeaderProfileId) {
		provider.requestHeaderProfileId = providerMetadata.requestHeaderProfileId;
	}
	if (provider.clientHeaderProfile === "custom" && hasStringRecordEntries(providerMetadata?.customClientHeaders)) {
		provider.customClientHeaders = cloneJson(providerMetadata!.customClientHeaders!);
	}
	if (providerMetadata?.httpProxyEnabled !== undefined) provider.httpProxyEnabled = providerMetadata.httpProxyEnabled;
	if (providerMetadata?.httpProxyUrl !== undefined) provider.httpProxyUrl = providerMetadata.httpProxyUrl;
	return provider;
}

export async function buildStateDocumentFromModelsJson(
	document: ModelsJsonDocument,
	metadata: MetadataDocument,
): Promise<StateDocument> {
	const providers: StateDocument["providers"] = {};
	for (const [providerId, entry] of Object.entries(document.providers)) {
		const provider = await buildStoredProviderFromModelsJson(providerId, entry, metadata);
		if (provider) providers[providerId] = provider;
	}
	return {
		version: 1,
		providers,
		requestHeaderProfiles: metadata.requestHeaderProfiles,
		clientHeaderCaptures: metadata.clientHeaderCaptures,
	};
}

export async function readState(): Promise<StateDocument> {
	const { metadata, legacyProviders } = await readMetadataStateFile();
	const state = await buildStateDocumentFromModelsJson(
		await readModelsJson(),
		metadata,
	);
	for (const [providerId, provider] of Object.entries(legacyProviders)) {
		if (!state.providers[providerId]) state.providers[providerId] = provider;
	}
	return state;
}

export async function writeState(state: StateDocument): Promise<void> {
	await writeMetadataState(state);
}

export function getStatePath(): string {
	return getMetadataStatePath();
}

export function createEmptyState(): StateDocument {
	return createEmptyStateDocument();
}
