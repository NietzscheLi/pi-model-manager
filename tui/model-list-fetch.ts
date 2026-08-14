// 从上游 API 拉取模型列表（OpenAI / Anthropic / Google）。
// 整次发现共享一个 10 秒 AbortSignal，并限制响应体、模型数量与终端不安全字符。

import { ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "../common.ts";
import { t } from "../i18n.ts";
import { openTemporaryLocalProxyRoute, type TemporaryLocalProxyRoute } from "../local-proxy-service.ts";
import { getClientHeadersForProfile } from "../presets/client-headers.ts";
import { appendUrlPath, resolveRuntimeBaseUrl } from "../runtime-base-url.ts";
import { isSensitiveHeaderName, redactSensitiveText } from "../sensitive-redaction.ts";
import type { ApiKind, BuiltInClientHeaderProfileId, ClientHeaderProfileId, ModelListFetchOutcome, StoredClientHeaderCapture } from "../types.ts";
import { extractValidatedModelIds, readBoundedResponseText } from "./model-list-validation.ts";

const MODEL_LIST_TIMEOUT_MS = 10_000;
const TEMP_PROVIDER_ID = "pi-model-manager-fetch";
const TEMP_MODEL_ID = "__model_list_probe__";

// 临时 runtime 只解析本次表单中的认证，不得读取或写入用户认证文件。
const emptyCredentialStore = {
	async read(): Promise<undefined> {
		return undefined;
	},
	async list(): Promise<readonly []> {
		return [];
	},
	async modify(): Promise<undefined> {
		return undefined;
	},
	async delete(): Promise<void> {
		return undefined;
	},
};

function hasRootPath(baseUrl: string): boolean {
	try {
		const pathname = new URL(baseUrl.trim()).pathname.replace(/\/+$/, "");
		return pathname === "";
	} catch {
		return false;
	}
}

function buildOpenAIUrl(baseUrl: string, api: Extract<ApiKind, "openai-completions" | "openai-responses">): string {
	return appendUrlPath(resolveRuntimeBaseUrl(api, baseUrl), "models");
}

function buildAnthropicUrl(baseUrl: string): string {
	return hasRootPath(baseUrl)
		? appendUrlPath(baseUrl, "v1", "models")
		: appendUrlPath(baseUrl, "models");
}

function buildOriginOpenAIUrl(baseUrl: string): string {
	const parsed = new URL(baseUrl.trim());
	parsed.pathname = "/v1/models";
	parsed.hash = "";
	return parsed.toString();
}

function buildGoogleUrl(baseUrl: string, apiKey: string): string {
	const url = new URL(appendUrlPath(baseUrl, "models"));
	url.searchParams.set("key", apiKey);
	return url.toString();
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error(t("模型发现已取消"));
}

function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(t("模型发现已取消")));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

interface ResolvedFetchAuth {
	apiKey: string;
	headers: Record<string, string>;
	redactionSecrets: string[];
}

function collectSensitiveHeaderValues(headers: Record<string, string> | undefined): string[] {
	if (!headers) return [];
	return Object.entries(headers)
		.filter(([name]) => isSensitiveHeaderName(name))
		.map(([, value]) => value);
}

async function resolveFetchAuth(
	params: FetchModelIdsParams,
	profileHeaders: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<ResolvedFetchAuth> {
	const providerConfig: ProviderConfig = {
		name: "pi-model-manager model list probe",
		baseUrl: resolveRuntimeBaseUrl(params.api, params.baseUrl),
		apiKey: params.apiKey.trim(),
		api: params.api,
		authHeader: params.authHeader,
		headers: profileHeaders,
		models: [{
			id: TEMP_MODEL_ID,
			name: TEMP_MODEL_ID,
			api: params.api,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		}],
	};

	const runtime = await waitWithSignal(ModelRuntime.create({
		credentials: emptyCredentialStore,
		modelsPath: null,
		allowModelNetwork: false,
	}), signal);
	runtime.registerProvider(TEMP_PROVIDER_ID, providerConfig);
	const model = runtime.getModel(TEMP_PROVIDER_ID, TEMP_MODEL_ID);
	if (!model) throw new Error(t("临时模型注册失败，无法解析模型列表认证"));
	const resolvedAuth = await waitWithSignal(runtime.getAuth(model), signal);
	if (!resolvedAuth) throw new Error(t("请求认证解析失败"));
	const apiKey = resolvedAuth.auth.apiKey;
	if (!apiKey) throw new Error(t("API key 未配置或解析为空，无法拉取模型列表"));

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(resolvedAuth.auth.headers ?? {})) {
		if (typeof value === "string") headers[name] = value;
	}
	return {
		apiKey,
		headers,
		redactionSecrets: [params.apiKey.trim(), apiKey, ...collectSensitiveHeaderValues(headers)].filter(Boolean),
	};
}

interface ModelListProxyConfig {
	providerId: string;
	proxyUrl: string;
}

async function openProxyRouteWithSignal(
	proxyConfig: ModelListProxyConfig,
	url: string,
	signal: AbortSignal,
): Promise<TemporaryLocalProxyRoute> {
	const routePromise = openTemporaryLocalProxyRoute(proxyConfig.providerId, url, proxyConfig.proxyUrl);
	try {
		return await waitWithSignal(routePromise, signal);
	} catch (error) {
		routePromise.then((route) => route.close(), () => undefined);
		throw error;
	}
}

async function requestModelIds(
	url: string,
	headers: Record<string, string>,
	api: ApiKind,
	proxyConfig: ModelListProxyConfig | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	throwIfAborted(signal);
	let temporaryProxyRoute: TemporaryLocalProxyRoute | undefined;
	try {
		temporaryProxyRoute = proxyConfig
			? await openProxyRouteWithSignal(proxyConfig, url, signal)
			: undefined;
		const response = await fetch(temporaryProxyRoute?.url ?? url, { headers, signal });
		const text = await readBoundedResponseText(response, signal);
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
		return extractValidatedModelIds(JSON.parse(text), api);
	} finally {
		temporaryProxyRoute?.close();
	}
}

export interface FetchModelIdsParams {
	providerId: string;
	api: ApiKind;
	baseUrl: string;
	apiKey: string;
	authHeader?: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	customClientHeaders: Record<string, string>;
	httpProxyEnabled: boolean;
	httpProxyUrl: string;
	clientHeaderCaptures?: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>;
}

async function fetchModelIdsWithSignal(
	params: FetchModelIdsParams,
	signal: AbortSignal,
	redactionSecrets: string[],
): Promise<ModelListFetchOutcome> {
	const profileHeaders = getClientHeadersForProfile(
		params.clientHeaderProfile,
		params.api,
		params.customClientHeaders,
		params.clientHeaderCaptures ?? {},
	);
	const auth = await resolveFetchAuth(params, profileHeaders, signal);
	redactionSecrets.push(...auth.redactionSecrets);
	const headers: Record<string, string> = { Accept: "application/json", ...auth.headers };
	const proxyConfig = params.httpProxyEnabled
		? { providerId: params.providerId, proxyUrl: params.httpProxyUrl }
		: undefined;

	if (params.api === "google-generative-ai") {
		const modelIds = await requestModelIds(
			buildGoogleUrl(resolveRuntimeBaseUrl(params.api, params.baseUrl), auth.apiKey),
			headers,
			params.api,
			proxyConfig,
			signal,
		);
		return { status: "loaded", modelIds };
	}

	if (params.api === "anthropic-messages") {
		const anthropicVersion = headers["anthropic-version"] ?? "2023-06-01";
		const apiKeyHeaders = { ...headers, "x-api-key": auth.apiKey, "anthropic-version": anthropicVersion };
		try {
			const modelIds = await requestModelIds(buildAnthropicUrl(params.baseUrl), apiKeyHeaders, params.api, proxyConfig, signal);
			return { status: "loaded", modelIds };
		} catch {
			throwIfAborted(signal);
		}
		const bearerHeaders: Record<string, string> = { ...headers, Authorization: `Bearer ${auth.apiKey}`, "anthropic-version": anthropicVersion };
		delete bearerHeaders["x-api-key"];
		try {
			const modelIds = await requestModelIds(buildAnthropicUrl(params.baseUrl), bearerHeaders, params.api, proxyConfig, signal);
			return { status: "loaded", modelIds };
		} catch {
			throwIfAborted(signal);
		}
		const fallbackHeaders = { ...headers, Authorization: `Bearer ${auth.apiKey}` };
		const modelIds = await requestModelIds(buildOriginOpenAIUrl(params.baseUrl), fallbackHeaders, params.api, proxyConfig, signal);
		return { status: "loaded", modelIds };
	}

	const modelIds = await requestModelIds(
		buildOpenAIUrl(params.baseUrl, params.api),
		{ ...headers, Authorization: `Bearer ${auth.apiKey}` },
		params.api,
		proxyConfig,
		signal,
	);
	return { status: "loaded", modelIds };
}

export async function fetchModelIds(
	params: FetchModelIdsParams,
	cancellationSignal?: AbortSignal,
): Promise<ModelListFetchOutcome> {
	const controller = new AbortController();
	let timedOut = false;
	const cancel = () => controller.abort(cancellationSignal?.reason ?? new Error(t("模型发现已取消")));
	if (cancellationSignal?.aborted) cancel();
	else cancellationSignal?.addEventListener("abort", cancel, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(t("模型列表请求总计超时（10 秒）")));
	}, MODEL_LIST_TIMEOUT_MS);
	const redactionSecrets = [params.apiKey.trim()].filter(Boolean);
	try {
		return await fetchModelIdsWithSignal(params, controller.signal, redactionSecrets);
	} catch (error) {
		if (cancellationSignal?.aborted) return { status: "cancelled" };
		const message = timedOut
			? t("模型列表请求总计超时（10 秒）")
			: redactSensitiveText(formatUnknownError(error), redactionSecrets);
		return { status: "failed", message };
	} finally {
		clearTimeout(timeout);
		cancellationSignal?.removeEventListener("abort", cancel);
	}
}
