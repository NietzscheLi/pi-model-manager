// state-document.ts
//
// 纯函数模块：draft ↔ stored 转换、validate、upsert/delete、显示用助手。
// 不做 IO，不依赖 ctx/pi；测试时直接喂 fixture 即可。
//
// 设计原则：
//   - 所有 upsert/delete 都返回新 StateDocument（不可变，深拷贝再改）
//   - validate 返回 string[]（空数组 = 通过）
//   - builtInProviderIds 由调用方传入，校验“接入 ID 不与 pi 内置 id 冲突”
//     （由调用方从 catalog 边界传入，避免本纯函数模块依赖 Pi 运行时 API）

import { cloneJson, cloneStringRecord, hasStringRecordEntries, trimOrFallback } from "./common.ts";
import {
	getConfigValueEnvVarNames,
	getSingleConfigValueEnvVarName,
	isCommandConfigValue,
} from "./config-value-reference.ts";
import { joinLocalizedList, t } from "./i18n.ts";
import { findPresetForApi } from "./presets/providers.ts";
import { normalizeThinkingLevelMap } from "./presets/thinking.ts";
import { isSensitiveHeaderName } from "./sensitive-redaction.ts";
import { fromNativeBaseUrl, resolveRuntimeBaseUrl, validateRequestBaseUrl } from "./runtime-base-url.ts";
import type {
	ApiKind,
	CompatSettings,
	OpenAIChatCompatibilityMode,
	ModelDraft,
	ProviderDraft,
	RequestHeaderProfileDraft,
	StateDocument,
	StoredModel,
	StoredProvider,
	StoredRequestHeaderProfile,
	StoredApiKey,
} from "./types.ts";
import { DEFAULT_API_KEY_ID, DEFAULT_PROVIDER_HTTP_PROXY_URL, ZERO_COST, resolveDefaultApiKeyId, resolveDefaultApiKeyValue } from "./types.ts";

// ========== 小工具 ==========

const API_KINDS: ApiKind[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_PROVIDER_ID_LENGTH = 48;
const RESERVED_REQUEST_HEADER_PROFILE_IDS = new Set(["claude-code", "codex-cli", "claude-code-live", "codex-cli-live"]);

function isApiKind(value: unknown): value is ApiKind {
	return typeof value === "string" && API_KINDS.includes(value as ApiKind);
}

function getOpenAIChatCompatibilityMode(compat: CompatSettings | undefined): OpenAIChatCompatibilityMode {
	return compat?.supportsDeveloperRole === false ? "compatible" : "standard";
}

export function getModelFullId(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

export function getProviderDisplayName(providerId: string, provider: StoredProvider): string {
	return trimOrFallback(provider.name, providerId.replace(/^custom-/, ""));
}


export function getApiKeyEnvVarName(apiKey: string): string | undefined {
	return getSingleConfigValueEnvVarName(apiKey);
}

export function getAuthStatusText(apiKey: string | undefined): string {
	if (!apiKey) return "no apiKey";
	if (isCommandConfigValue(apiKey)) return "command apiKey";
	const envVarNames = getConfigValueEnvVarNames(apiKey);
	if (envVarNames.length === 0) return "literal apiKey";
	const missingNames = envVarNames.filter((name) => !process.env[name]);
	if (missingNames.length > 0) return `env missing: ${missingNames.join(", ")}`;
	const singleEnvVarName = getApiKeyEnvVarName(apiKey);
	return singleEnvVarName ? `env ${singleEnvVarName}` : `env template: ${envVarNames.join(", ")}`;
}


// ========== draft 工厂 ==========

export function createProviderDraft(api: ApiKind = "openai-responses"): ProviderDraft {
	const preset = findPresetForApi(api);
	const apiKeys: StoredApiKey[] = preset.apiKey ? [{ id: DEFAULT_API_KEY_ID, value: preset.apiKey }] : [];
	return {
		providerId: "",
		providerName: preset.defaultProviderName,
		api,
		openAIChatCompatibilityMode: "standard",
		baseUrl: preset.baseUrl,
		authHeader: preset.authHeader,
		clientHeaderProfile: "recommended",
		customClientHeaders: {},
		apiKeys,
		defaultApiKeyId: apiKeys.length > 0 ? DEFAULT_API_KEY_ID : undefined,
		httpProxyEnabled: false,
		httpProxyUrl: DEFAULT_PROVIDER_HTTP_PROXY_URL,
		openAIResponsesStreamCompletionMode: "standard",
		selectedIndex: 0,
	};
}

export function createProviderDraftFromStored(providerId: string, stored: StoredProvider): ProviderDraft {
	const api = isApiKind(stored.api) ? stored.api : "openai-completions";
	const preset = findPresetForApi(api);
	return {
		providerId,
		providerName: stored.name ?? (providerId.replace(/^custom-/, "") || preset.defaultProviderName),
		api,
		openAIChatCompatibilityMode: getOpenAIChatCompatibilityMode(stored.compat),
		baseUrl: stored.managed ? stored.baseUrl : fromNativeBaseUrl(api, stored.baseUrl),
		authHeader: stored.authHeader ?? preset.authHeader,
		clientHeaderProfile: stored.clientHeaderProfile ?? "recommended",
		requestHeaderProfileId: stored.requestHeaderProfileId,
		customClientHeaders: cloneStringRecord(stored.customClientHeaders),
		apiKeys: cloneJson(stored.apiKeys ?? []),
		defaultApiKeyId: resolveDefaultApiKeyId(stored),
		httpProxyEnabled: stored.httpProxyEnabled ?? false,
		httpProxyUrl: stored.httpProxyUrl?.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL,
		openAIResponsesStreamCompletionMode: stored.openAIResponsesStreamCompletionMode ?? "standard",
		selectedIndex: 0,
	};
}

function createModelDraftFromProvider(providerDraft: ProviderDraft): ModelDraft {
	const preset = findPresetForApi(providerDraft.api);
	return {
		providerId: providerDraft.providerId,
		providerName: providerDraft.providerName,
		api: providerDraft.api,
		providerApi: providerDraft.api,
		apiOverride: undefined,
		baseUrl: providerDraft.baseUrl,
		authHeader: providerDraft.authHeader,
		clientHeaderProfile: providerDraft.clientHeaderProfile,
		requestHeaderProfileId: providerDraft.requestHeaderProfileId,
		customClientHeaders: cloneStringRecord(providerDraft.customClientHeaders),
		apiKeys: cloneJson(providerDraft.apiKeys ?? []),
		apiKeyId: undefined,
		defaultApiKeyId: providerDraft.defaultApiKeyId,
		httpProxyEnabled: providerDraft.httpProxyEnabled,
		httpProxyUrl: providerDraft.httpProxyUrl,
		modelId: "",
		modelName: "",
		// 新建模型默认开启视觉输入；不支持图片的模型可在编辑器里关闭。
		inputKinds: ["text", "image"],
		metadataSource: "models.dev",
		reasoningMode: preset.defaultReasoning ? "enabled" : "disabled",
		thinkingLevelMap: undefined,
		cost: { ...ZERO_COST },
		anthropicThinkingProtocol: providerDraft.api === "anthropic-messages" ? "adaptive" : undefined,
		contextWindow: preset.contextWindow,
		maxTokens: preset.maxTokens,
		openAIServiceTier: undefined,
		selectedIndex: 0,
	};
}

export function createModelDraftForStoredProvider(providerId: string, stored: StoredProvider): ModelDraft {
	return createModelDraftFromProvider(createProviderDraftFromStored(providerId, stored));
}

export function createModelDraftFromStoredModel(
	providerId: string,
	stored: StoredProvider,
	model: StoredModel,
): ModelDraft {
	const providerApi = isApiKind(stored.api) ? stored.api : "openai-completions";
	const effectiveApi = isApiKind(model.api) ? model.api : providerApi;
	const preset = findPresetForApi(effectiveApi);
	const reasoning = model.reasoning ?? preset.defaultReasoning;
	const modelAdaptiveOverride = model.compat?.forceAdaptiveThinking;
	const usesAdaptiveThinking = modelAdaptiveOverride === true
		|| (modelAdaptiveOverride === undefined && stored.compat?.forceAdaptiveThinking === true);
	return {
		providerId,
		providerName: stored.name ?? (providerId.replace(/^custom-/, "") || preset.defaultProviderName),
		api: effectiveApi,
		providerApi,
		apiOverride: isApiKind(model.api) ? model.api : undefined,
		baseUrl: stored.managed
			? model.baseUrl ?? stored.baseUrl
			: fromNativeBaseUrl(effectiveApi, model.baseUrl ?? stored.baseUrl),
		authHeader: stored.authHeader ?? preset.authHeader,
		clientHeaderProfile: stored.clientHeaderProfile ?? "recommended",
		requestHeaderProfileId: stored.requestHeaderProfileId,
		customClientHeaders: cloneStringRecord(stored.customClientHeaders),
		apiKeys: cloneJson(stored.apiKeys ?? []),
		apiKeyId: model.apiKeyId,
		defaultApiKeyId: resolveDefaultApiKeyId(stored),
		httpProxyEnabled: stored.httpProxyEnabled ?? false,
		httpProxyUrl: stored.httpProxyUrl?.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL,
		modelId: model.id,
		modelName: model.name ?? "",
		inputKinds: [...(model.input ?? preset.inputKinds)],
		metadataSource: "models.dev",
		reasoningMode: reasoning ? "enabled" : "disabled",
		thinkingLevelMap: cloneJson(model.thinkingLevelMap),
		cost: cloneJson(model.cost) ?? { ...ZERO_COST },
		anthropicThinkingProtocol: effectiveApi === "anthropic-messages"
			? (usesAdaptiveThinking ? "adaptive" : "legacy")
			: undefined,
		contextWindow: model.contextWindow ?? preset.contextWindow,
		maxTokens: model.maxTokens ?? preset.maxTokens,
		openAIServiceTier: effectiveApi === "openai-responses" ? model.openAIServiceTier : undefined,
		selectedIndex: 0,
	};
}

// ========== validate ==========

function validateUrl(url: string, label: string, errors: string[]): void {
	try {
		validateRequestBaseUrl(url);
	} catch (error) {
		errors.push(error instanceof TypeError ? t("{label} 不是有效 URL", { label }) : (error as Error).message);
	}
}

function validateHttpProxyUrl(url: string, errors: string[]): void {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") errors.push(t("代理地址目前只支持 http:// 或 https:// 代理"));
		if (!parsed.hostname) errors.push(t("代理地址必须包含主机名"));
	} catch {
		errors.push(t("代理地址不是有效 URL"));
	}
}

export function validateProviderDraft(
	draft: ProviderDraft,
	document: StateDocument,
	builtInProviderIds: ReadonlySet<string>,
	oldProviderId?: string,
): string[] {
	const errors: string[] = [];
	const id = draft.providerId.trim();

	if (!id) errors.push(t("接入 ID 不能为空"));
	else if (!ID_PATTERN.test(id)) errors.push(t("接入 ID 只能包含字母、数字、点、下划线和连字符"));
	else if (id.length > MAX_PROVIDER_ID_LENGTH) errors.push(t("接入 ID 最多 {count} 个字符", { count: MAX_PROVIDER_ID_LENGTH }));

	if (id && oldProviderId !== id && document.providers[id]) {
		errors.push(t("接入 ID 已存在：{id}", { id }));
	}
	if (id && builtInProviderIds.has(id)) {
		errors.push(t("接入 ID 与 pi 内置接入冲突：{id}（请改用其它 ID）", { id }));
	}

	if (!draft.baseUrl.trim()) errors.push(t("Base URL 不能为空"));
	else validateUrl(draft.baseUrl.trim(), "Base URL", errors);


	if (draft.clientHeaderProfile === "custom") {
		const profileId = draft.requestHeaderProfileId?.trim();
		if (!profileId && !hasStringRecordEntries(draft.customClientHeaders)) errors.push(t("请选择一个自定义请求头"));
		else if (profileId && !document.requestHeaderProfiles[profileId]) errors.push(t("自定义请求头不存在：{profileId}", { profileId }));
	}

	if (draft.httpProxyEnabled) {
		const proxyUrl = draft.httpProxyUrl.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL;
		validateHttpProxyUrl(proxyUrl, errors);
	}

	const seenApiKeyIds = new Set<string>();
	for (const key of draft.apiKeys) {
		const keyId = key.id.trim();
		if (!keyId) errors.push(t("key ID 不能为空"));
		else if (!/^[A-Za-z0-9._-]+$/.test(keyId)) errors.push(t("key ID 只能包含字母、数字、点、下划线和连字符"));
		else if (seenApiKeyIds.has(keyId)) errors.push(t("key ID 重复：{keyId}", { keyId }));
		seenApiKeyIds.add(keyId);
		if (!key.value.trim()) errors.push(t("key 值不能为空：{keyId}", { keyId: keyId || "?" }));
	}
	if (draft.defaultApiKeyId && !draft.apiKeys.some((key) => key.id === draft.defaultApiKeyId)) {
		errors.push(t("默认 key 不存在：{keyId}", { keyId: draft.defaultApiKeyId }));
	}

	return errors;
}

export function validateModelDraft(
	draft: ModelDraft,
	document: StateDocument,
	replacedModelId?: string,
): string[] {
	const errors: string[] = [];
	if (!draft.providerId.trim()) errors.push(t("接入 ID 不能为空"));
	if (!draft.modelId.trim()) errors.push(t("模型 ID 不能为空"));

	const provider = document.providers[draft.providerId];
	if (!provider) errors.push(t("接入配置不存在：{providerId}", { providerId: draft.providerId }));

	if (!draft.baseUrl.trim()) errors.push(t("Base URL 不能为空"));
	else validateUrl(draft.baseUrl.trim(), "Base URL", errors);


	if (!Number.isInteger(draft.contextWindow) || draft.contextWindow <= 0)
		errors.push(t("上下文窗口必须是正整数"));
	if (!Number.isInteger(draft.maxTokens) || draft.maxTokens <= 0)
		errors.push(t("最大输出必须是正整数"));

	const duplicate = (provider?.models ?? []).find((m) => m.id === draft.modelId.trim());
	if (duplicate && duplicate.id !== replacedModelId)
		errors.push(t("模型已存在：{modelId}", { modelId: draft.modelId.trim() }));

	if (draft.apiKeyId && !(provider?.apiKeys ?? draft.apiKeys).some((key) => key.id === draft.apiKeyId)) {
		errors.push(t("API key 不存在：{keyId}", { keyId: draft.apiKeyId }));
	}

	return errors;
}

export function getProviderChangeWarnings(
	current: StoredProvider | undefined,
	draft: ProviderDraft,
): string[] {
	if (!current) return [];
	const affected = current.models?.length ?? 0;
	if (affected === 0) return [];
	const changes: string[] = [];
	if ((current.baseUrl ?? "") !== draft.baseUrl.trim()) changes.push("Base URL");
	if (resolveDefaultApiKeyValue(current) !== resolveDefaultApiKeyValue(draft)) changes.push("API key");
	if ((current.api ?? "") !== draft.api) changes.push(t("API 协议"));
	if ((current.authHeader ?? false) !== draft.authHeader) changes.push(t("认证头"));
	if (draft.api === "openai-completions"
		&& getOpenAIChatCompatibilityMode(current.compat) !== (draft.openAIChatCompatibilityMode ?? "standard")) {
		changes.push(t("协议兼容"));
	}
	if (draft.api === "openai-responses"
		&& (current.openAIResponsesStreamCompletionMode ?? "standard") !== (draft.openAIResponsesStreamCompletionMode ?? "standard")) {
		changes.push(t("流结束兼容"));
	}
	if ((current.clientHeaderProfile ?? "recommended") !== draft.clientHeaderProfile
		|| (current.requestHeaderProfileId ?? "") !== (draft.requestHeaderProfileId ?? ""))
		changes.push(t("请求头"));
	if ((current.httpProxyEnabled ?? false) !== draft.httpProxyEnabled
		|| (current.httpProxyUrl?.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL) !== (draft.httpProxyUrl.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL)) {
		changes.push(t("本机代理"));
	}
	if (JSON.stringify(current.apiKeys ?? []) !== JSON.stringify(draft.apiKeys)
		|| (current.defaultApiKeyId ?? "") !== (draft.defaultApiKeyId ?? "")) changes.push(t("API keys"));
	if (changes.length === 0) return [];
	return [t("将修改接入级配置：{changes}，会影响该接入下 {count} 个模型。", { changes: joinLocalizedList(changes), count: affected })];
}

// ========== build：draft → stored ==========

function stripLegacyModelHeaderProfile(model: StoredModel): StoredModel {
	const {
		clientHeaderProfile: _clientHeaderProfile,
		requestHeaderProfileId: _requestHeaderProfileId,
		customClientHeaders: _customClientHeaders,
		...rest
	} = model;
	return rest;
}

function keepModelFieldsSupportedByApi(model: StoredModel, providerApi: ApiKind, providerApiChanged: boolean): StoredModel {
	const normalized = stripLegacyModelHeaderProfile(model);
	const effectiveApi = isApiKind(normalized.api) ? normalized.api : providerApi;
	const next = effectiveApi === "openai-responses"
		? normalized
		: (() => {
			const { openAIServiceTier: _openAIServiceTier, ...rest } = normalized;
			return rest;
		})();
	const thinkingLevelMap = normalizeThinkingLevelMap(
		effectiveApi,
		next.reasoning,
		providerApiChanged && !normalized.api ? undefined : next.thinkingLevelMap,
	);
	if (thinkingLevelMap) next.thinkingLevelMap = thinkingLevelMap;
	else delete next.thinkingLevelMap;
	return next;
}

function buildProviderFromDraft(
	current: StoredProvider | undefined,
	draft: ProviderDraft,
): StoredProvider {
	const apiChanged = Boolean(current && current.api !== draft.api);
	const next: StoredProvider = {
		...(current ?? { models: [] }),
		name: trimOrFallback(draft.providerName, draft.providerId.trim()),
		api: draft.api,
		baseUrl: draft.baseUrl.trim(),
		managed: true,
		authHeader: draft.authHeader,
		clientHeaderProfile: draft.clientHeaderProfile,
		models: (current?.models ?? []).map((model) => {
			const nextModel = keepModelFieldsSupportedByApi(model, draft.api, apiChanged);
			if (current && !current.managed && (model.baseUrl
				|| (!apiChanged && draft.baseUrl === fromNativeBaseUrl(current.api, current.baseUrl)))) {
				const api = model.api ?? current.api;
				const baseUrl = fromNativeBaseUrl(api, model.baseUrl ?? current.baseUrl);
				if (baseUrl !== draft.baseUrl) nextModel.baseUrl = baseUrl;
				else delete nextModel.baseUrl;
			}
			if (nextModel.apiKeyId && !draft.apiKeys.some((key) => key.id === nextModel.apiKeyId)) delete nextModel.apiKeyId;
			return nextModel;
		}),
	};
	if (draft.apiKeys.length > 0) next.apiKeys = draft.apiKeys.map((key) => ({ ...key }));
	else delete next.apiKeys;
	const defaultApiKeyId = resolveDefaultApiKeyId(draft);
	if (defaultApiKeyId) next.defaultApiKeyId = defaultApiKeyId;
	else delete next.defaultApiKeyId;
	const httpProxyUrl = draft.httpProxyUrl.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL;
	if (draft.httpProxyEnabled) next.httpProxyEnabled = true;
	else delete next.httpProxyEnabled;
	if (draft.httpProxyEnabled || httpProxyUrl !== DEFAULT_PROVIDER_HTTP_PROXY_URL) next.httpProxyUrl = httpProxyUrl;
	else delete next.httpProxyUrl;
	if (draft.api === "openai-responses" && draft.openAIResponsesStreamCompletionMode === "terminal-event") {
		next.openAIResponsesStreamCompletionMode = "terminal-event";
	} else {
		delete next.openAIResponsesStreamCompletionMode;
	}
	if (draft.clientHeaderProfile === "custom" && draft.requestHeaderProfileId?.trim()) {
		next.requestHeaderProfileId = draft.requestHeaderProfileId.trim();
	} else {
		delete next.requestHeaderProfileId;
	}
	if (draft.clientHeaderProfile === "custom" && hasStringRecordEntries(draft.customClientHeaders)) {
		next.customClientHeaders = cloneStringRecord(draft.customClientHeaders);
	} else {
		delete next.customClientHeaders;
	}
	if (draft.api === "openai-completions" && draft.openAIChatCompatibilityMode !== undefined) {
		const compat: CompatSettings = cloneJson(next.compat) ?? {};
		if (draft.openAIChatCompatibilityMode === "standard") delete compat.supportsDeveloperRole;
		else compat.supportsDeveloperRole = false;
		if (Object.keys(compat).length > 0) next.compat = compat;
		else delete next.compat;
	}
	return next;
}

export function buildModelFromDraft(
	existing: StoredModel | undefined,
	draft: ModelDraft,
	providerCompat: CompatSettings | undefined = undefined,
): StoredModel {
	const modelId = draft.modelId.trim();
	const reasoning = draft.reasoningMode === "enabled";
	const compat: CompatSettings = cloneJson(existing?.compat) ?? {};
	const effectiveApi = draft.api;
	const storedThinkingLevelMap = cloneJson(existing?.thinkingLevelMap);
	const thinkingLevelMap = normalizeThinkingLevelMap(effectiveApi, reasoning, storedThinkingLevelMap);

	const next: StoredModel = {
		id: modelId,
		reasoning,
		input: [...draft.inputKinds],
		contextWindow: draft.contextWindow,
		maxTokens: draft.maxTokens,
		cost: cloneJson(existing?.cost) ?? { ...ZERO_COST },
	};
	if (draft.apiOverride) next.api = draft.apiOverride;
	else delete next.api;
	if (draft.apiKeyId) next.apiKeyId = draft.apiKeyId;
	else delete next.apiKeyId;
	if (existing?.baseUrl) next.baseUrl = existing.baseUrl;
	if (hasStringRecordEntries(existing?.headers)) next.headers = cloneStringRecord(existing?.headers);

	const name = draft.modelName.trim();
	if (name) next.name = name;

	if (thinkingLevelMap) next.thinkingLevelMap = thinkingLevelMap;

	if (effectiveApi === "openai-responses" && draft.openAIServiceTier === "priority") {
		next.openAIServiceTier = "priority";
	}

	if (effectiveApi === "anthropic-messages" && draft.anthropicThinkingProtocol) {
		const existingOverride = existing?.compat?.forceAdaptiveThinking;
		const providerForcesAdaptiveThinking = providerCompat?.forceAdaptiveThinking === true;
		if (draft.anthropicThinkingProtocol === "adaptive") {
			if (existingOverride === true || !providerForcesAdaptiveThinking) compat.forceAdaptiveThinking = true;
			else delete compat.forceAdaptiveThinking;
		} else if (existingOverride === false || providerForcesAdaptiveThinking) {
			compat.forceAdaptiveThinking = false;
		} else {
			delete compat.forceAdaptiveThinking;
		}
	}

	if (Object.keys(compat).length > 0) next.compat = compat;

	return next;
}

// ========== 请求头 ==========

export function createRequestHeaderProfileDraft(): RequestHeaderProfileDraft {
	return {
		profileId: "custom-headers",
		profileName: t("自定义请求头"),
		headers: {},
		selectedIndex: 0,
	};
}

export function createRequestHeaderProfileDraftFromStored(
	profileId: string,
	profile: StoredRequestHeaderProfile,
): RequestHeaderProfileDraft {
	return {
		profileId,
		profileName: profile.name,
		headers: cloneStringRecord(profile.headers),
		selectedIndex: 0,
	};
}


export function countModelsUsingRequestHeaderProfile(document: StateDocument, profileId: string): number {
	let count = 0;
	for (const provider of Object.values(document.providers)) {
		if (provider.clientHeaderProfile === "custom" && provider.requestHeaderProfileId === profileId) {
			count += provider.models.length;
		}
	}
	return count;
}

export function validateRequestHeaderProfileDraft(
	draft: RequestHeaderProfileDraft,
	document: StateDocument,
	oldProfileId?: string,
): string[] {
	const errors: string[] = [];
	const profileId = draft.profileId.trim();
	if (!profileId) errors.push(t("请求头 ID 不能为空"));
	else if (!ID_PATTERN.test(profileId)) errors.push(t("请求头 ID 只能包含字母、数字、点、下划线和连字符"));
	else if (RESERVED_REQUEST_HEADER_PROFILE_IDS.has(profileId)) errors.push(t("请求头 ID 是插件内置保留名：{profileId}", { profileId }));
	if (profileId && oldProfileId !== profileId && document.requestHeaderProfiles[profileId]) {
		errors.push(t("请求头 ID 已存在：{profileId}", { profileId }));
	}
	if (!draft.profileName.trim()) errors.push(t("请求头名称不能为空"));
	if (!hasStringRecordEntries(draft.headers)) errors.push(t("请求头至少需要 1 项"));
	const sensitiveHeaders = Object.keys(draft.headers).filter(isSensitiveHeaderName);
	if (sensitiveHeaders.length > 0) {
		errors.push(t("请求头包含会明文落盘的敏感字段：{headers}（请改用 provider API key / 环境变量 / !command）", { headers: joinLocalizedList(sensitiveHeaders) }));
	}
	return errors;
}

export function upsertRequestHeaderProfileInDocument(
	document: StateDocument,
	oldProfileId: string | undefined,
	draft: RequestHeaderProfileDraft,
): StateDocument {
	const next: StateDocument = cloneJson(document);
	const profileId = draft.profileId.trim();
	if (oldProfileId && oldProfileId !== profileId) {
		delete next.requestHeaderProfiles[oldProfileId];
		for (const provider of Object.values(next.providers)) {
			if (!provider.managed) continue;
			if (provider.requestHeaderProfileId === oldProfileId) provider.requestHeaderProfileId = profileId;
			for (const model of provider.models ?? []) {
				if (model.requestHeaderProfileId === oldProfileId) model.requestHeaderProfileId = profileId;
			}
		}
	}
	next.requestHeaderProfiles[profileId] = {
		name: draft.profileName.trim(),
		headers: cloneStringRecord(draft.headers),
	};
	return next;
}
// [喵喵喵]: 早期版本只在注册时补全 baseUrl，models.json 里留下的是半成品（如 openai 缺 /v1）。
// 插件未加载时 pi 会回落到 models.json 直接请求，因此需要把存量值一次性归一化。
// 只处理受管理接入；原生接入的 baseUrl 不是本插件写的，不能代为改写。
export function findProvidersNeedingBaseUrlNormalization(document: StateDocument): string[] {
	return Object.entries(document.providers)
		.filter(([, provider]) => provider.managed && provider.baseUrl)
		.filter(([, provider]) => resolveRuntimeBaseUrl(provider.api, provider.baseUrl) !== provider.baseUrl)
		.map(([providerId]) => providerId);
}

export function normalizeProviderBaseUrlsInDocument(
	document: StateDocument,
	providerIds: readonly string[],
): StateDocument {
	const next: StateDocument = cloneJson(document);
	for (const providerId of providerIds) {
		const provider = next.providers[providerId];
		if (!provider?.managed || !provider.baseUrl) continue;
		provider.baseUrl = resolveRuntimeBaseUrl(provider.api, provider.baseUrl);
	}
	return next;
}

export function deleteRequestHeaderProfileFromDocument(document: StateDocument, profileId: string): StateDocument {
	const next: StateDocument = cloneJson(document);
	delete next.requestHeaderProfiles[profileId];
	for (const provider of Object.values(next.providers)) {
		if (!provider.managed) continue;
		if (provider.requestHeaderProfileId === profileId) {
			provider.clientHeaderProfile = "recommended";
			delete provider.requestHeaderProfileId;
		}
		for (const model of provider.models ?? []) {
			if (model.requestHeaderProfileId !== profileId) continue;
			model.clientHeaderProfile = "recommended";
			delete model.requestHeaderProfileId;
		}
	}
	return next;
}

// ========== upsert / delete on document ==========

function upsertModel(models: StoredModel[], next: StoredModel, replacedId: string | undefined): StoredModel[] {
	const retained = models.filter((m) => m.id !== next.id && m.id !== replacedId);
	return [...retained, next];
}

export function upsertProviderInDocument(
	document: StateDocument,
	oldProviderId: string | undefined,
	draft: ProviderDraft,
): StateDocument {
	const next: StateDocument = cloneJson(document);
	const sourceProvider = oldProviderId
		? next.providers[oldProviderId]
		: next.providers[draft.providerId];
	const nextProvider = buildProviderFromDraft(sourceProvider, draft);
	if (oldProviderId && oldProviderId !== draft.providerId) {
		delete next.providers[oldProviderId];
		next.managedProviderIds = next.managedProviderIds.filter((providerId) => providerId !== oldProviderId);
	}
	next.providers[draft.providerId] = nextProvider;
	if (nextProvider.managed && !next.managedProviderIds.includes(draft.providerId)) {
		next.managedProviderIds.push(draft.providerId);
	}
	return next;
}

export function upsertModelInDocument(
	document: StateDocument,
	draft: ModelDraft,
	options: { replacedModelId?: string } = {},
): StateDocument {
	const next: StateDocument = cloneJson(document);
	const provider = next.providers[draft.providerId];
	if (!provider) throw new Error(t("upsertModel：接入不存在：{providerId}", { providerId: draft.providerId }));
	const existing = (provider.models ?? []).find(
		(m) => m.id === options.replacedModelId || m.id === draft.modelId.trim(),
	);
	const newModel = buildModelFromDraft(existing, draft, provider.compat);
	provider.models = upsertModel(provider.models ?? [], newModel, options.replacedModelId);
	return next;
}

export function deleteModelFromDocument(
	document: StateDocument,
	providerId: string,
	modelId: string,
): StateDocument {
	const next: StateDocument = cloneJson(document);
	const provider = next.providers[providerId];
	if (!provider) return next;
	provider.models = (provider.models ?? []).filter((m) => m.id !== modelId);
	return next;
}

export function deleteProviderFromDocument(
	document: StateDocument,
	providerId: string,
): StateDocument {
	const next: StateDocument = cloneJson(document);
	delete next.providers[providerId];
	next.managedProviderIds = next.managedProviderIds.filter((id) => id !== providerId);
	return next;
}
