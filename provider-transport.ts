// 在 Pi 已构造请求后选择传输路线；协议判断始终使用真实网关地址。

import { lazyStream, type Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mergeModelRequestHeaders } from "./presets/client-headers.ts";
import { t } from "./i18n.ts";
import { getProviderHttpProxyUrl, openTemporaryLocalProxyRoute } from "./local-proxy-service.ts";
import { appendUrlPath, resolveRuntimeBaseUrl, validateRequestBaseUrl } from "./runtime-base-url.ts";
import type { ApiKind, StoredProvider } from "./types.ts";

export function createProviderTransport(runtime: ModelRuntime, native: Provider, provider: StoredProvider): Provider {
	const endpoints = new Map(provider.models.map((model) => {
		const api = model.api ?? provider.api;
		const baseUrl = resolveRuntimeBaseUrl(api as ApiKind, model.baseUrl ?? provider.baseUrl);
		return [model.id, { api, baseUrl }];
	}));
	const proxyUrl = provider.httpProxyEnabled ? getProviderHttpProxyUrl(provider) : undefined;

	const wrap = (stream: Provider["streamSimple"]): Provider["streamSimple"] => (model, context, options) => lazyStream(model, async () => {
		const endpoint = endpoints.get(model.id);
		if (!endpoint || endpoint.api !== model.api) throw new Error(t("请求模型不属于当前接入配置：{modelId}", { modelId: model.id }));
		validateRequestBaseUrl(endpoint.baseUrl);
		// [喵喵喵]: Pi 的模型级请求头解析属于 ModelRuntime，不包含在 getProvider() 返回值里；使用已解析的 key 只补齐本接入的显式配置。
		const resolved = await runtime.getAuth(model, { apiKey: options?.apiKey, env: options?.env, signal: options?.signal });
		if (!resolved) throw new Error(t("请求认证解析失败"));
		options = { ...options, headers: mergeModelRequestHeaders(options?.headers, resolved.auth.headers) };
		// [喵喵喵]: models.json 会叠加在动态 provider 之上；还原用户侧 API 根地址，不能让原生持久化形式参与路径拼接。
		const upstreamModel = { ...model, baseUrl: endpoint.baseUrl };
		if (model.api === "google-generative-ai") {
			// [喵喵喵]: Google 适配器先按精确键拼入默认 User-Agent，再构造 Headers；使用该拼写才能覆盖而不是合并成两个值。
			if (options.headers?.["user-agent"] !== undefined) {
				const { "user-agent": userAgent, ...headers } = options.headers;
				options = { ...options, headers: { ...headers, "User-Agent": userAgent } };
			}
			if (!proxyUrl) return stream(upstreamModel, context, options);
			const route = await openTemporaryLocalProxyRoute(native.id, endpoint.baseUrl, proxyUrl);
			try {
				// [喵喵喵]: Google 不支持请求级 fetch，只有发送副本使用本地地址；其模型能力判断基于模型 ID。
				const result = stream({ ...upstreamModel, baseUrl: route.url }, context, options);
				void result.result().then(() => route.close(), () => route.close());
				return result;
			} catch (error) {
				route.close();
				throw error;
			}
		}
		if (model.api !== "openai-completions" && model.api !== "openai-responses" && model.api !== "anthropic-messages") {
			if (proxyUrl) throw new Error(t("该协议尚不支持接入级代理：{api}", { api: model.api }));
			return stream(upstreamModel, context, options);
		}
		if (!proxyUrl && model.api !== "anthropic-messages") return stream(upstreamModel, context, options);
		const fetchImpl = options?.fetch ?? globalThis.fetch;
		const transportFetch: typeof fetch = async (input, init) => {
			let request = new Request(input, init);
			if (model.api === "anthropic-messages") {
				const url = new URL(request.url);
				const sdkEndpoint = new URL(appendUrlPath(endpoint.baseUrl, "v1", "messages"));
				if (url.origin !== sdkEndpoint.origin || url.pathname !== sdkEndpoint.pathname) {
					throw new Error(t("Anthropic 请求路径与当前适配契约不符"));
				}
				// [喵喵喵]: 仅替换 SDK 明确追加的端点路径，保留 beta 等请求参数，不对 URL 做全局 /v1 替换。
				url.pathname = new URL(appendUrlPath(endpoint.baseUrl, "messages")).pathname;
				request = new Request(url, request);
			}
			if (!proxyUrl) return fetchImpl(request);
			const route = await openTemporaryLocalProxyRoute(native.id, request.url, proxyUrl);
			try {
				return await fetchImpl(new Request(route.url, request));
			} finally {
				// [喵喵喵]: 收到响应头时转发端已经取得路由；删除查找项不会中断已建立的 SSE 流。
				route.close();
			}
		};
		return stream(upstreamModel, context, { ...options, fetch: transportFetch });
	});

	return {
		...native,
		stream: wrap(native.stream.bind(native)) as Provider["stream"],
		streamSimple: wrap(native.streamSimple.bind(native)),
	};
}
