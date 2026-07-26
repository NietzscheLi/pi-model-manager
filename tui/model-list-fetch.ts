// 从上游 API 拉取模型列表（OpenAI / Anthropic / Google）。
// 拉取失败 / 取消时给用户 fallback 到手动输入。

import { ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { formatUnknownError, isObjectRecord } from "../common.ts";
import { openTemporaryLocalProxyRoute, type TemporaryLocalProxyRoute } from "../local-proxy-service.ts";
import { getClientHeadersForProfile } from "../presets/client-headers.ts";
import { resolveRuntimeBaseUrl } from "../runtime-base-url.ts";
import type { ApiKind, BuiltInClientHeaderProfileId, ClientHeaderProfileId, ModelListFetchOutcome, StoredClientHeaderCapture } from "../types.ts";

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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSecrets(message: string, secrets: string[]): string {
	let redacted = message;
	for (const secret of secrets) {
		if (secret.length < 3) continue;
		redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "REDACTED");
	}
	redacted = redacted.replace(/([?&]key=)[^&\s]+/gi, "$1REDACTED");
	redacted = redacted.replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1REDACTED");
	redacted = redacted.replace(/((?:x-api-key|api-key)\s*[:=]\s*)[^\s,;]+/gi, "$1REDACTED");
	return redacted;
}

function buildOpenAIUrl(baseUrl: string, api: Extract<ApiKind, "openai-completions" | "openai-responses">): string {
	return `${resolveRuntimeBaseUrl(api, baseUrl)}/models`;
}

function buildAnthropicUrl(baseUrl: string): string {
	// 根路径（无 path）追加 /v1/models，自定义后缀直接追加 /models
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	try {
		const parsed = new URL(trimmed);
		if ((parsed.pathname === "" || parsed.pathname === "/") && !parsed.search && !parsed.hash) {
			return `${trimmed}/v1/models`;
		}
	} catch {
		return `${trimmed}/models`;
	}
	return `${trimmed}/models`;
}

/** 从 baseUrl 提取主机根路径（不含路径部分）。
 *  例："https://api.deepseek.com/anthropic" → "https://api.deepseek.com" */
function deriveOrigin(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return url;
	}
}

function buildGoogleUrl(baseUrl: string, apiKey: string): string {
	const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
	url.searchParams.set("key", apiKey);
	return url.toString();
}

function extractModelIds(envelope: unknown, api: ApiKind): string[] {
	if (!isObjectRecord(envelope)) return [];
	if (api === "google-generative-ai") {
		const models = envelope.models;
		if (!Array.isArray(models)) return [];
		return models
			.map((m) => isObjectRecord(m) && typeof m.name === "string" ? m.name.replace(/^models\//, "") : undefined)
			.filter((id): id is string => Boolean(id));
	}
	const data = envelope.data;
	if (!Array.isArray(data)) return [];
	return data
		.map((m) => isObjectRecord(m) && typeof m.id === "string" ? m.id : undefined)
		.filter((id): id is string => Boolean(id));
}

interface ResolvedFetchAuth {
	apiKey: string;
	headers: Record<string, string>;
	redactionSecrets: string[];
}

function collectSensitiveHeaderValues(headers: Record<string, string> | undefined): string[] {
	if (!headers) return [];
	return Object.entries(headers)
		.filter(([name]) => /authorization|cookie|api-key|x-api-key|secret|token|key/i.test(name))
		.map(([, value]) => value);
}

async function resolveFetchAuth(
	params: FetchModelIdsParams,
	profileHeaders: Record<string, string> | undefined,
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

	const runtime = await ModelRuntime.create({
		credentials: emptyCredentialStore,
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider(TEMP_PROVIDER_ID, providerConfig);
	const model = runtime.getModel(TEMP_PROVIDER_ID, TEMP_MODEL_ID);
	if (!model) throw new Error("临时模型注册失败，无法解析模型列表认证");

	const resolvedAuth = await runtime.getAuth(model);
	if (!resolvedAuth) throw new Error("请求认证解析失败");
	const apiKey = resolvedAuth.auth.apiKey;
	if (!apiKey) throw new Error("API key 未配置或解析为空，无法拉取模型列表");

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

async function requestModelIds(
	url: string,
	headers: Record<string, string>,
	api: ApiKind,
	proxyConfig: ModelListProxyConfig | undefined,
): Promise<string[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("模型列表请求超时")), MODEL_LIST_TIMEOUT_MS);
	let temporaryProxyRoute: TemporaryLocalProxyRoute | undefined;
	try {
		temporaryProxyRoute = proxyConfig
			? await openTemporaryLocalProxyRoute(proxyConfig.providerId, url, proxyConfig.proxyUrl)
			: undefined;
		const response = await fetch(temporaryProxyRoute?.url ?? url, { headers, signal: controller.signal });
		const text = await response.text();
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
		return extractModelIds(JSON.parse(text), api).sort((a, b) => a.localeCompare(b));
	} finally {
		temporaryProxyRoute?.close();
		clearTimeout(timeout);
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


export async function fetchModelIds(params: FetchModelIdsParams): Promise<ModelListFetchOutcome> {
	const redactionSecrets = [params.apiKey.trim()].filter(Boolean);
	try {
		const profileHeaders = getClientHeadersForProfile(
			params.clientHeaderProfile,
			params.api,
			params.customClientHeaders,
			params.clientHeaderCaptures ?? {},
		);
		const auth = await resolveFetchAuth(params, profileHeaders);
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
			);
			return { status: "loaded", modelIds };
		}
		if (params.api === "anthropic-messages") {
			// 优先 x-api-key（多数 Anthropic 兼容端点），失败 fallback 到 Bearer
			const apiKeyHeaders = { ...headers, "x-api-key": auth.apiKey, "anthropic-version": headers["anthropic-version"] ?? "2023-06-01" };
			try {
				const modelIds = await requestModelIds(buildAnthropicUrl(params.baseUrl), apiKeyHeaders, params.api, proxyConfig);
				return { status: "loaded", modelIds };
			} catch {
				const bearerHeaders = { ...headers, Authorization: `Bearer ${auth.apiKey}`, "anthropic-version": headers["anthropic-version"] ?? "2023-06-01" };
				delete (bearerHeaders as any)["x-api-key"];
				try {
					const modelIds = await requestModelIds(buildAnthropicUrl(params.baseUrl), bearerHeaders, params.api, proxyConfig);
					return { status: "loaded", modelIds };
				} catch {
					// 最终 fallback：尝试派生主机根路径，用 OpenAI 格式 /v1/models 拉取
					// 兼容 DeepSeek 等同时提供 Anthropic 代理 + OpenAI 模型列表端点的服务
					const origin = deriveOrigin(params.baseUrl);
					const fallbackUrl = `${origin}/v1/models`;
					const fallbackHeaders = { ...headers, Authorization: `Bearer ${auth.apiKey}` };
					const modelIds = await requestModelIds(fallbackUrl, fallbackHeaders, params.api, proxyConfig);
					return { status: "loaded", modelIds };
				}
			}
		}
		// openai-completions / openai-responses
		const modelIds = await requestModelIds(
			buildOpenAIUrl(params.baseUrl, params.api),
			{ ...headers, Authorization: `Bearer ${auth.apiKey}` },
			params.api,
			proxyConfig,
		);
		return { status: "loaded", modelIds };
	} catch (error) {
		return { status: "failed", message: redactSecrets(formatUnknownError(error), redactionSecrets) };
	}
}
