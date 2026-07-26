// local-proxy-service.ts
//
// 插件内置的按接入点代理转发层。
// 不修改 pi 本体：开启代理的接入点在运行时注册为 127.0.0.1 本地地址，
// 本服务再通过用户配置的 HTTP/HTTPS 代理转发到真实上游。

import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { StoredProvider } from "./types.ts";
import { DEFAULT_PROVIDER_HTTP_PROXY_URL } from "./types.ts";

export interface ProviderProxyRoute {
	upstreamOrigin: string;
	proxyUrl: string;
}

export interface TemporaryLocalProxyRoute {
	url: string;
	close(): void;
}

const ROUTES = new Map<string, ProviderProxyRoute>();
let server: http.Server | undefined;
let listenPromise: Promise<number> | undefined;
let listenPort: number | undefined;
let temporaryRouteSequence = 0;

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function normalizeHttpProxyUrl(proxyUrl: string | undefined): string {
	return proxyUrl?.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL;
}

export function isProviderHttpProxyEnabled(provider: StoredProvider): boolean {
	return provider.httpProxyEnabled === true;
}

export function getProviderHttpProxyUrl(provider: StoredProvider): string {
	return normalizeHttpProxyUrl(provider.httpProxyUrl);
}

function stripHopByHopHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
	const next: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
		next[name] = value;
	}
	return next;
}

function getUrlPort(url: URL): number {
	if (url.port) return Number.parseInt(url.port, 10);
	return url.protocol === "https:" ? 443 : 80;
}

function getHostHeader(url: URL): string {
	return url.host;
}

function ensureSupportedProxyProtocol(proxy: URL): void {
	if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
		throw new Error("代理地址目前只支持 http:// 或 https:// 代理");
	}
}

function pipeResponse(upstreamResponse: IncomingMessage, response: ServerResponse): void {
	const headers = stripHopByHopHeaders(upstreamResponse.headers);
	response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
	// 尽快把 SSE 响应头交给本地客户端，后续 body 由 Node 的 HTTP 栈处理 chunked/backpressure。
	response.flushHeaders();
	upstreamResponse.on("error", (error) => {
		if (!response.destroyed) response.destroy(error);
	});
	upstreamResponse.pipe(response);
}


function formatProxyError(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message) return message;
		const cause = (error as Error & { code?: string }).code;
		if (cause) return `代理请求失败：${cause}`;
		if (error.stack?.trim()) return error.stack.trim().split("\n", 1)[0] ?? "未知代理错误";
		return `${error.name || "Error"}（无错误消息）`;
	}
	const message = String(error).trim();
	return message || "未知代理错误";
}

function writeProxyError(response: ServerResponse, error: unknown): void {
	if (response.headersSent) {
		response.destroy(error instanceof Error ? error : undefined);
		return;
	}
	response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
	response.end(`[pi-model-manager proxy] ${formatProxyError(error)}`);
}

function buildForwardRequestHeaders(target: URL, request: IncomingMessage): Record<string, string | string[]> {
	const headers = stripHopByHopHeaders(request.headers);
	headers.host = getHostHeader(target);
	return headers;
}

function bindClientAbort(request: IncomingMessage, response: ServerResponse, upstreamRequest: http.ClientRequest): void {
	const destroyUpstream = () => {
		if (!upstreamRequest.destroyed) upstreamRequest.destroy();
	};
	const destroyUpstreamWithError = (error: Error) => {
		if (!upstreamRequest.destroyed) upstreamRequest.destroy(error);
	};
	const onResponseClose = () => {
		if (!response.writableEnded) destroyUpstream();
	};
	const cleanup = () => {
		request.off("aborted", destroyUpstream);
		request.off("error", destroyUpstreamWithError);
		response.off("close", onResponseClose);
	};
	request.once("aborted", destroyUpstream);
	request.once("error", destroyUpstreamWithError);
	response.once("close", onResponseClose);
	upstreamRequest.once("close", cleanup);
}

function writeUpstreamRequestError(response: ServerResponse, error: Error): void {
	if (response.destroyed || response.writableEnded) return;
	writeProxyError(response, error);
}

function forwardPlainHttp(target: URL, proxy: URL, request: IncomingMessage, response: ServerResponse): void {
	ensureSupportedProxyProtocol(proxy);
	const headers = buildForwardRequestHeaders(target, request);
	const agent = new HttpProxyAgent(proxy);
	const upstreamRequest = http.request({
		hostname: target.hostname,
		port: getUrlPort(target),
		method: request.method,
		path: `${target.pathname}${target.search}`,
		headers,
		agent,
	}, (upstreamResponse) => pipeResponse(upstreamResponse, response));
	upstreamRequest.once("close", () => agent.destroy());
	bindClientAbort(request, response, upstreamRequest);
	upstreamRequest.on("error", (error) => writeUpstreamRequestError(response, error));
	// [喵喵喵]: 请求体直接流向上游，避免图像等大 payload 在本地代理中形成完整内存副本 (2026-07-17)
	request.pipe(upstreamRequest);
}

function forwardHttps(target: URL, proxy: URL, request: IncomingMessage, response: ServerResponse): void {
	ensureSupportedProxyProtocol(proxy);
	const headers = buildForwardRequestHeaders(target, request);
	const agent = new HttpsProxyAgent(proxy);
	const upstreamRequest = https.request({
		hostname: target.hostname,
		port: getUrlPort(target),
		method: request.method,
		path: `${target.pathname}${target.search}`,
		headers,
		agent,
	}, (upstreamResponse) => pipeResponse(upstreamResponse, response));
	upstreamRequest.once("close", () => agent.destroy());
	bindClientAbort(request, response, upstreamRequest);
	upstreamRequest.on("error", (error) => writeUpstreamRequestError(response, error));
	request.pipe(upstreamRequest);
}

function forwardRequest(route: ProviderProxyRoute, request: IncomingMessage, response: ServerResponse, routePath: string): void {
	const target = new URL(routePath, route.upstreamOrigin);
	const proxy = new URL(route.proxyUrl);
	if (target.protocol === "http:") {
		forwardPlainHttp(target, proxy, request, response);
		return;
	}
	if (target.protocol === "https:") {
		forwardHttps(target, proxy, request, response);
		return;
	}
	throw new Error(`不支持的上游协议：${target.protocol}`);
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
	void (async () => {
		try {
			const localUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			const [, encodedProviderId, ...rest] = localUrl.pathname.split("/");
			if (!encodedProviderId) {
				response.writeHead(404);
				response.end("missing provider id");
				return;
			}
			const providerId = decodeURIComponent(encodedProviderId);
			const route = ROUTES.get(providerId);
			if (!route) {
				response.writeHead(404);
				response.end(`unknown provider: ${providerId}`);
				return;
			}
			const path = `/${rest.join("/")}${localUrl.search}`;
			await forwardRequest(route, request, response, path);
		} catch (error) {
			writeProxyError(response, error);
		}
	})();
}

async function ensureServer(): Promise<number> {
	if (listenPort !== undefined) return listenPort;
	if (listenPromise) return listenPromise;
	server = http.createServer(handleRequest);
	listenPromise = new Promise((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(0, "127.0.0.1", () => {
			const address = server!.address();
			if (!address || typeof address === "string") {
				reject(new Error("本地代理转发服务监听地址异常"));
				return;
			}
			listenPort = address.port;
			server!.off("error", reject);
			server!.unref();
			resolve(address.port);
		});
	});
	return listenPromise;
}

export async function getLocalProxyBaseUrl(routeId: string, upstreamRuntimeBaseUrl: string, proxyUrl: string): Promise<string> {
	const upstream = new URL(upstreamRuntimeBaseUrl);
	const proxy = new URL(normalizeHttpProxyUrl(proxyUrl));
	ensureSupportedProxyProtocol(proxy);
	const port = await ensureServer();
	ROUTES.set(routeId, {
		upstreamOrigin: upstream.origin,
		proxyUrl: proxy.toString(),
	});
	const basePath = trimTrailingSlashes(upstream.pathname || "");
	return `http://127.0.0.1:${port}/${encodeURIComponent(routeId)}${basePath}${upstream.search}`;
}

export async function openTemporaryLocalProxyRoute(
	providerId: string,
	upstreamUrl: string,
	proxyUrl: string,
): Promise<TemporaryLocalProxyRoute> {
	const upstream = new URL(upstreamUrl);
	const proxy = new URL(normalizeHttpProxyUrl(proxyUrl));
	ensureSupportedProxyProtocol(proxy);
	const port = await ensureServer();
	const routeId = `${providerId}/model-list/${++temporaryRouteSequence}`;
	const route = { upstreamOrigin: upstream.origin, proxyUrl: proxy.toString() };
	ROUTES.set(routeId, route);
	return {
		url: `http://127.0.0.1:${port}/${encodeURIComponent(routeId)}${upstream.pathname}${upstream.search}`,
		close(): void {
			if (ROUTES.get(routeId) === route) ROUTES.delete(routeId);
		},
	};
}

function isProviderRouteId(routeId: string, providerId: string): boolean {
	return routeId === providerId || routeId.startsWith(`${providerId}/`);
}

export function snapshotProviderLocalProxyRoutes(providerId: string): Map<string, ProviderProxyRoute> {
	return new Map(
		[...ROUTES.entries()]
			.filter(([routeId]) => isProviderRouteId(routeId, providerId))
			.map(([routeId, route]): [string, ProviderProxyRoute] => [routeId, { ...route }]),
	);
}

export function restoreProviderLocalProxyRoutes(
	providerId: string,
	snapshot: ReadonlyMap<string, ProviderProxyRoute>,
): void {
	removeProviderLocalProxyRoutes(providerId);
	for (const [routeId, route] of snapshot) ROUTES.set(routeId, { ...route });
}

export function removeProviderLocalProxyRoutes(providerId: string): void {
	for (const routeId of ROUTES.keys()) {
		if (isProviderRouteId(routeId, providerId)) ROUTES.delete(routeId);
	}
}

export async function closeLocalProxyServer(): Promise<void> {
	ROUTES.clear();
	listenPromise = undefined;
	listenPort = undefined;
	const current = server;
	server = undefined;
	if (!current) return;
	await new Promise<void>((resolve, reject) => {
		current.close((error) => error ? reject(error) : resolve());
	});
}
