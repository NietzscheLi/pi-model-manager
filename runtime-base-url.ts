// 将用户填写的 Base URL 转成各协议实际请求根地址，并提供保留 query/hash 的路径追加。

import type { ApiKind } from "./types.ts";

function trimTrailingSlashes(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function parseBaseUrl(baseUrl: string): URL | undefined {
	try {
		return new URL(baseUrl.trim());
	} catch {
		return undefined;
	}
}

function trimPathTrailingSlashes(pathname: string): string {
	const trimmed = pathname.replace(/\/+$/, "");
	return trimmed || "/";
}

function hasRootPath(url: URL): boolean {
	return trimPathTrailingSlashes(url.pathname) === "/";
}

function appendPathSegments(url: URL, segments: string[]): string {
	const basePath = trimPathTrailingSlashes(url.pathname);
	const suffix = segments.map((segment) => segment.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
	url.pathname = `${basePath === "/" ? "" : basePath}/${suffix}` || "/";
	return url.toString();
}

export function appendUrlPath(baseUrl: string, ...segments: string[]): string {
	const parsed = parseBaseUrl(baseUrl);
	if (parsed) return appendPathSegments(parsed, segments);
	const suffix = segments.map((segment) => segment.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
	return `${trimTrailingSlashes(baseUrl)}/${suffix}`;
}

function stripTrailingV1(baseUrl: string): string {
	const parsed = parseBaseUrl(baseUrl);
	if (!parsed) {
		const trimmed = trimTrailingSlashes(baseUrl);
		return trimmed.toLowerCase().endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
	}
	const path = trimPathTrailingSlashes(parsed.pathname);
	if (path.toLowerCase().endsWith("/v1")) {
		parsed.pathname = path.slice(0, -3) || "/";
	} else {
		parsed.pathname = path;
	}
	return parsed.toString();
}

function appendV1ForRootUrl(baseUrl: string): string {
	const parsed = parseBaseUrl(baseUrl);
	if (!parsed) return trimTrailingSlashes(baseUrl);
	if (hasRootPath(parsed)) return appendPathSegments(parsed, ["v1"]);
	parsed.pathname = trimPathTrailingSlashes(parsed.pathname);
	return parsed.toString();
}

function appendGoogleGenerativeApiVersionForRootUrl(baseUrl: string): string {
	const parsed = parseBaseUrl(baseUrl);
	if (!parsed) return trimTrailingSlashes(baseUrl);
	// Google Generative Language 的根域名不是可直接请求的模型 API 根路径。
	if (parsed.hostname === "generativelanguage.googleapis.com" && hasRootPath(parsed)) {
		return appendPathSegments(parsed, ["v1beta"]);
	}
	parsed.pathname = trimPathTrailingSlashes(parsed.pathname);
	return parsed.toString();
}

// [喵喵喵]: URL.toString() 对根路径会补出尾斜杠，归一化结果现在会落盘到 models.json，
// 多一个斜杠会让本来正确的配置被判定为需要迁移，白白改写用户配置。
function stripRootTrailingSlash(url: string): string {
	return url.replace(/^(https?:\/\/[^/?#]+)\/(?=$|[?#])/i, "$1");
}

export function resolveRuntimeBaseUrl(api: ApiKind, baseUrl: string): string {
	if (api === "anthropic-messages") return stripRootTrailingSlash(stripTrailingV1(baseUrl));
	if (api === "openai-completions" || api === "openai-responses") return stripRootTrailingSlash(appendV1ForRootUrl(baseUrl));
	if (api === "google-generative-ai") return stripRootTrailingSlash(appendGoogleGenerativeApiVersionForRootUrl(baseUrl));
	return trimTrailingSlashes(baseUrl);
}
