// provider-registrar.ts
//
// StoredProvider → pi 的 ProviderConfig → pi.registerProvider 的统一桥梁。
//
// 设计要点：
//   - factory 阶段只注册无需本地 server 的 catalog 配置；session_start 再激活代理 transport。
//   - reconcileProvider 是保存后的完整 runtime 同步入口，统一处理 register/unregister 与回滚。
//   - getClientHeadersForProfile 在这里调，把客户端请求头 profile 翻译成模型级 headers。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBuiltinProviderId } from "./builtin-model-catalog.ts";
import { mergeCompatSettings } from "./compat-settings.ts";
import { formatUnknownError } from "./common.ts";
import {
	getLocalProxyBaseUrl,
	getProviderHttpProxyUrl,
	isProviderHttpProxyEnabled,
	removeProviderLocalProxyRoutes,
	restoreProviderLocalProxyRoutes,
	snapshotProviderLocalProxyRoutes,
	type ProviderProxyRoute,
} from "./local-proxy-service.ts";
import { getClientHeadersForProfile, mergeModelRequestHeaders } from "./presets/client-headers.ts";
import { resolveRuntimeBaseUrl } from "./runtime-base-url.ts";
import type { ApiKind, BuiltInClientHeaderProfileId, StateDocument, StoredClientHeaderCapture, StoredModel, StoredProvider, StoredRequestHeaderProfile } from "./types.ts";

// pi 的 ProviderConfig 类型从 d.ts 拿；这里用结构兼容 + as any 避免拉太多内部类型。
// 关键字段：name / baseUrl / apiKey / api / authHeader / models
type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[number];

const REGISTERED_PROVIDER_CONFIGS = new Map<string, ProviderConfig>();

export function buildProviderConfig(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): ProviderConfig {
	const runtimeBaseUrl = resolveRuntimeBaseUrl(provider.api, provider.baseUrl);
	return buildProviderConfigWithBaseUrl(provider, runtimeBaseUrl, requestHeaderProfiles, clientHeaderCaptures);
}

function buildProviderConfigWithBaseUrl(
	provider: StoredProvider,
	runtimeBaseUrl: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
	modelRuntimeBaseUrls: ReadonlyMap<string, string> = new Map(),
): ProviderConfig {
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
			modelRuntimeBaseUrls.get(model.id),
		)),
	};
}

async function buildRuntimeProviderConfig(
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): Promise<ProviderConfig> {
	const upstreamRuntimeBaseUrl = resolveRuntimeBaseUrl(provider.api, provider.baseUrl);
	removeProviderLocalProxyRoutes(providerId);
	if (!isProviderHttpProxyEnabled(provider)) {
		return buildProviderConfigWithBaseUrl(provider, upstreamRuntimeBaseUrl, requestHeaderProfiles, clientHeaderCaptures);
	}

	const proxyUrl = getProviderHttpProxyUrl(provider);
	const runtimeBaseUrl = await getLocalProxyBaseUrl(providerId, upstreamRuntimeBaseUrl, proxyUrl);
	const modelRuntimeBaseUrls = new Map<string, string>();
	for (const model of provider.models) {
		const upstreamModelBaseUrl = resolveModelRuntimeBaseUrl(provider, model);
		if (!upstreamModelBaseUrl) continue;
		const routeId = `${providerId}/model/${model.id}`;
		modelRuntimeBaseUrls.set(model.id, await getLocalProxyBaseUrl(routeId, upstreamModelBaseUrl, proxyUrl));
	}
	return buildProviderConfigWithBaseUrl(
		provider,
		runtimeBaseUrl,
		requestHeaderProfiles,
		clientHeaderCaptures,
		modelRuntimeBaseUrls,
	);
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
	runtimeBaseUrl?: string,
): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: model.api as ProviderModelConfig["api"],
		baseUrl: runtimeBaseUrl ?? resolveModelRuntimeBaseUrl(provider, model),
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

/** 注销本扩展实际注册的动态 provider，并同步清理代理路由和回滚快照。 */
export function unregisterManagedProvider(pi: ExtensionAPI, providerId: string): void {
	removeProviderLocalProxyRoutes(providerId);
	const wasRegistered = REGISTERED_PROVIDER_CONFIGS.delete(providerId);
	if (wasRegistered) pi.unregisterProvider(providerId);
}

async function canRegisterManagedProvider(providerId: string, provider: StoredProvider): Promise<boolean> {
	return provider.models.length > 0 && !(await isBuiltinProviderId(providerId));
}

function replaceManagedProviderConfig(
	pi: ExtensionAPI,
	providerId: string,
	nextConfig: ProviderConfig,
	previousRoutes: ReadonlyMap<string, ProviderProxyRoute>,
): void {
	const previousConfig = REGISTERED_PROVIDER_CONFIGS.get(providerId);
	try {
		if (previousConfig) pi.unregisterProvider(providerId);
		pi.registerProvider(providerId, nextConfig);
		REGISTERED_PROVIDER_CONFIGS.set(providerId, nextConfig);
	} catch (error) {
		restoreProviderLocalProxyRoutes(providerId, previousRoutes);
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
			? `；恢复上一版 runtime 也失败：${formatUnknownError(rollbackError)}`
			: previousConfig
				? "；已恢复上一版 runtime"
				: "；新配置未注册到当前 runtime";
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

	const previousRoutes = snapshotProviderLocalProxyRoutes(providerId);
	let nextConfig: ProviderConfig;
	try {
		nextConfig = await buildRuntimeProviderConfig(providerId, provider, requestHeaderProfiles, clientHeaderCaptures);
	} catch (error) {
		restoreProviderLocalProxyRoutes(providerId, previousRoutes);
		throw error;
	}
	replaceManagedProviderConfig(pi, providerId, nextConfig, previousRoutes);
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
	const previousRoutes = snapshotProviderLocalProxyRoutes(providerId);
	removeProviderLocalProxyRoutes(providerId);
	const nextConfig = buildProviderConfig(provider, requestHeaderProfiles, clientHeaderCaptures);
	replaceManagedProviderConfig(pi, providerId, nextConfig, previousRoutes);
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
	for (const [providerId, provider] of Object.entries(document.providers)) {
		try {
			await reconcile(pi, providerId, provider, document.requestHeaderProfiles, document.clientHeaderCaptures);
		} catch (error) {
			warnings.push(`${providerId}: ${formatUnknownError(error)}`);
		}
	}
	return warnings;
}

/** factory 阶段仅注册模型 catalog，不启动长生命周期本地代理。 */
export async function registerCatalogFromState(pi: ExtensionAPI, document: StateDocument): Promise<string[]> {
	return reconcileAllFromState(pi, document, reconcileProviderCatalog);
}

/** session_start 激活当前 state 的完整 provider transport。 */
export async function registerAllFromState(pi: ExtensionAPI, document: StateDocument): Promise<string[]> {
	return reconcileAllFromState(pi, document, reconcileProvider);
}
