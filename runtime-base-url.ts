// runtime-base-url.ts
//
// 将用户在 TUI 中填写的 Base URL 转成 pi 各内置 SDK 实际需要的 baseUrl。
// 约定：state.json 保存用户输入；注册到 pi 和 bootstrap 到 models.json 时使用运行时 URL。

import type { ApiKind } from "./types.ts";

function trimTrailingSlashes(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function stripTrailingV1(baseUrl: string): string {
	const trimmed = trimTrailingSlashes(baseUrl);
	return trimmed.toLowerCase().endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function hasRootPathWithoutQueryOrHash(url: URL): boolean {
	return (url.pathname === "" || url.pathname === "/") && !url.search && !url.hash;
}

function appendV1ForRootUrl(baseUrl: string): string {
	const trimmed = trimTrailingSlashes(baseUrl);
	try {
		const parsed = new URL(trimmed);
		if (hasRootPathWithoutQueryOrHash(parsed)) {
			return `${trimmed}/v1`;
		}
	} catch {
		return trimmed;
	}
	return trimmed;
}

function appendGoogleGenerativeApiVersionForRootUrl(baseUrl: string): string {
	const trimmed = trimTrailingSlashes(baseUrl);
	try {
		const parsed = new URL(trimmed);
		// Google Generative Language 的根域名不是可直接请求的模型 API 根路径；
		// pi 的 google-generative-ai 适配器需要带版本段的 baseUrl。
		if (parsed.hostname === "generativelanguage.googleapis.com" && hasRootPathWithoutQueryOrHash(parsed)) {
			return `${trimmed}/v1beta`;
		}
	} catch {
		return trimmed;
	}
	return trimmed;
}

export function resolveRuntimeBaseUrl(api: ApiKind, baseUrl: string): string {
	if (api === "anthropic-messages") return stripTrailingV1(baseUrl);
	if (api === "openai-completions" || api === "openai-responses") return appendV1ForRootUrl(baseUrl);
	if (api === "google-generative-ai") return appendGoogleGenerativeApiVersionForRootUrl(baseUrl);
	return trimTrailingSlashes(baseUrl);
}
