// provider-registrar.ts
//
// StoredProvider → pi 的 ProviderConfig → pi.registerProvider 的统一桥梁。
//
// 设计要点：
//   - factory 阶段与 session_start 都直接以 stored 配置注册 runtime provider；保存后的完整同步入口是 reconcileProvider。
//   - reconcileProvider 是保存后的完整 runtime 同步入口，统一处理 register/unregister 与回滚。
//   - getClientHeadersForProfile 在这里调，把客户端请求头 profile 翻译成模型级 headers。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBuiltinProviderId } from "./builtin-model-catalog.ts";
import { mergeCompatSettings } from "./compat-settings.ts";
import { formatUnknownError } from "./common.ts";
import { t } from "./i18n.ts";
import {
	getClientHeadersForProfile,
	mergeModelRequestHeaders,
} from "./presets/client-headers.ts";
import { resolveRuntimeBaseUrl } from "./runtime-base-url.ts";
import type { ApiKind, BuiltInClientHeaderProfileId, StateDocument, StoredClientHeaderCapture, StoredModel, StoredProvider, StoredRequestHeaderProfile } from "./types.ts";

// pi 的 ProviderConfig 类型从 d.ts 拿；这里用结构兼容 + as any 避免拉太多内部类型。
// 关键字段：name / baseUrl / apiKey / api / authHeader / models
type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[number];

const REGISTERED_PROVIDER_CONFIGS = new Map<string, ProviderConfig>();

function buildProviderConfig(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): ProviderConfig {
	const runtimeBaseUrl = resolveRuntimeBaseUrl(provider.api, provider.baseUrl);
	const apiKey = provider.apiKey?.trim();
	return {
		name: provider.name,
		baseUrl: runtimeBaseUrl,
		...(apiKey ? { apiKey } : {}),
		api: provider.api,
		headers: provider.headers,
		authHeader: provider.authHeader,
		models: provider.models.map((model) => buildModelConfig(
			provider,
			model,
			requestHeaderProfiles,
			clientHeaderCaptures,
		)),
	};
}

async function buildRuntimeProviderConfig(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): Promise<ProviderConfig> {
	return buildProviderConfig(provider, requestHeaderProfiles, clientHeaderCaptures);
}

function asManagedApi(value: string | undefined, fallback: ApiKind): ApiKind {
	if (value === "openai-completions" || value === "openai-responses"
		|| value === "anthropic-messages" || value === "google-generative-ai") return value;
	return fallback;
}

function resolveModelRuntimeBaseUrl(provider: StoredProvider, model: StoredModel): string | undefined {
	if (!model.baseUrl) return undefined;
	return resolveRuntimeBaseUrl(asManagedApi(model.api, provider.api), model.baseUrl);
}

export function buildModelRequestHeaders(
	provider: StoredProvider,
	model: StoredModel,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Record<string, string> | undefined {
	if (!provider.managed) return model.headers ? { ...model.headers } : undefined;
	const customHeaders = provider.clientHeaderProfile === "custom"
		? resolveProviderCustomHeaders(provider, requestHeaderProfiles)
		: {};
	const effectiveApi = asManagedApi(model.api, provider.api);
	const effectiveCompat = mergeCompatSettings(provider.compat, model.compat);
	const profileHeaders = getClientHeadersForProfile(
		provider.clientHeaderProfile,
		effectiveApi,
		customHeaders,
		clientHeaderCaptures,
		effectiveCompat,
	);
	return mergeModelRequestHeaders(model.headers, profileHeaders);
}

function buildModelConfig(
	provider: StoredProvider,
	model: StoredModel,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: model.api as ProviderModelConfig["api"],
		baseUrl: resolveModelRuntimeBaseUrl(provider, model),
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: buildModelRequestHeaders(provider, model, requestHeaderProfiles, clientHeaderCaptures),
		compat: mergeCompatSettings(provider.compat, model.compat) as ProviderModelConfig["compat"],
	};
}

function resolveProviderCustomHeaders(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Record<string, string> {
	const profileId = provider.requestHeaderProfileId;
	if (profileId && requestHeaderProfiles[profileId]) return requestHeaderProfiles[profileId].headers;
	return provider.customClientHeaders ?? {};
}

/** 注销本扩展实际注册的动态 provider。 */
export function unregisterManagedProvider(pi: ExtensionAPI, providerId: string): void {
	const wasRegistered = REGISTERED_PROVIDER_CONFIGS.delete(providerId);
	if (wasRegistered) pi.unregisterProvider(providerId);
}

async function canRegisterManagedProvider(providerId: string, provider: StoredProvider): Promise<boolean> {
	return provider.managed && provider.models.length > 0 && !(await isBuiltinProviderId(providerId));
}

function replaceManagedProviderConfig(
	pi: ExtensionAPI,
	providerId: string,
	nextConfig: ProviderConfig,
): void {
	const previousConfig = REGISTERED_PROVIDER_CONFIGS.get(providerId);
	try {
		if (previousConfig) pi.unregisterProvider(providerId);
		pi.registerProvider(providerId, nextConfig);
		REGISTERED_PROVIDER_CONFIGS.set(providerId, nextConfig);
	} catch (error) {
		let rollbackError: unknown;
		try {
			if (previousConfig) {
				pi.unregisterProvider(providerId);
				pi.registerProvider(providerId, previousConfig);
				REGISTERED_PROVIDER_CONFIGS.set(providerId, previousConfig);
			} else {
				REGISTERED_PROVIDER_CONFIGS.delete(providerId);
			}
		} catch (restoreError) {
			rollbackError = restoreError;
		}
		const rollbackNote = rollbackError
			? t("；恢复上一版 runtime 也失败：{error}", { error: formatUnknownError(rollbackError) })
			: previousConfig
				? t("；已恢复上一版 runtime")
				: t("；新配置未注册到当前 runtime");
		throw new Error(`${formatUnknownError(error)}${rollbackNote}`);
	}
}

/** 同步一个 provider 到当前会话 transport。新配置会先完整构建；替换失败时恢复上一版动态配置。 */
export async function reconcileProvider(
	pi: ExtensionAPI,
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): Promise<void> {
	// registerProvider 的 models 会整体替换目录；内置 provider 必须保留 Pi 已合成的完整目录。
	if (!(await canRegisterManagedProvider(providerId, provider))) {
		unregisterManagedProvider(pi, providerId);
		return;
	}

	const nextConfig = await buildRuntimeProviderConfig(provider, requestHeaderProfiles, clientHeaderCaptures);
	replaceManagedProviderConfig(pi, providerId, nextConfig);
}

async function reconcileProviderCatalog(
	pi: ExtensionAPI,
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Promise<void> {
	if (!(await canRegisterManagedProvider(providerId, provider))) {
		unregisterManagedProvider(pi, providerId);
		return;
	}
	const nextConfig = buildProviderConfig(provider, requestHeaderProfiles, clientHeaderCaptures);
	replaceManagedProviderConfig(pi, providerId, nextConfig);
}

type StateProviderReconciler = (
	pi: ExtensionAPI,
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
) => Promise<void>;

async function reconcileAllFromState(
	pi: ExtensionAPI,
	document: StateDocument,
	reconcile: StateProviderReconciler,
): Promise<string[]> {
	const warnings: string[] = [];
	const activeProviderIds = new Set(
		[...document.managedProviderIds].filter((providerId) => document.providers[providerId]?.managed),
	);
	for (const providerId of REGISTERED_PROVIDER_CONFIGS.keys()) {
		if (!activeProviderIds.has(providerId)) unregisterManagedProvider(pi, providerId);
	}
	for (const [providerId, provider] of Object.entries(document.providers)) {
		try {
			await reconcile(pi, providerId, provider, document.requestHeaderProfiles, document.clientHeaderCaptures);
		} catch (error) {
			warnings.push(`${providerId}: ${formatUnknownError(error)}`);
		}
	}
	return warnings;
}

/** factory 阶段仅注册模型 catalog。 */
export async function registerCatalogFromState(pi: ExtensionAPI, document: StateDocument): Promise<string[]> {
	return reconcileAllFromState(pi, document, reconcileProviderCatalog);
}

/** session_start 激活当前 state 的完整 provider transport。 */
export async function registerAllFromState(pi: ExtensionAPI, document: StateDocument): Promise<string[]> {
	return reconcileAllFromState(pi, document, reconcileProvider);
}
