import assert from "node:assert/strict";
import test from "node:test";
import { findPresetForApi, switchProviderDraftApiPreset } from "../presets/providers.ts";
import { appendUrlPath, resolveRuntimeBaseUrl } from "../runtime-base-url.ts";
import type { ProviderDraft } from "../types.ts";

function createDraft(): ProviderDraft {
	const preset = findPresetForApi("openai-responses");
	return {
		providerId: "custom",
		providerName: "custom",
		api: preset.api,
		baseUrl: preset.baseUrl,
		apiKey: preset.apiKey,
		authHeader: preset.authHeader,
		clientHeaderProfile: "recommended",
		customClientHeaders: {},
		httpProxyEnabled: false,
		httpProxyUrl: "http://127.0.0.1:7890",
		selectedIndex: 0,
	};
}

test("协议切换仅替换旧协议默认预设", () => {
	const draft = createDraft();
	switchProviderDraftApiPreset(draft, "anthropic-messages");
	assert.equal(draft.api, "anthropic-messages");
	assert.equal(draft.baseUrl, "https://api.anthropic.com");
	assert.equal(draft.apiKey, "$ANTHROPIC_API_KEY");
});

test("协议切换保留明文 key、自定义引用、命令和自定义 URL", () => {
	for (const apiKey of ["sk-plaintext", "$MY_PRIVATE_KEY", "!secret-tool read provider"]) {
		const draft = createDraft();
		draft.baseUrl = "https://gateway.example.com/tenant-a/openai/v1?region=cn";
		draft.apiKey = apiKey;
		switchProviderDraftApiPreset(draft, "google-generative-ai");
		assert.equal(draft.baseUrl, "https://gateway.example.com/tenant-a/openai/v1?region=cn");
		assert.equal(draft.apiKey, apiKey);
	}
});

test("旧预设 URL 的尾斜杠不阻止安全替换", () => {
	const draft = createDraft();
	draft.baseUrl = "https://api.openai.com/v1/";
	switchProviderDraftApiPreset(draft, "anthropic-messages");
	assert.equal(draft.baseUrl, "https://api.anthropic.com");
});

test("运行时 URL 路径变换保留 query 并在 query 前追加路径", () => {
	const runtimeUrl = resolveRuntimeBaseUrl("openai-responses", "https://gateway.example.com?tenant=a");
	const modelListUrl = new URL(appendUrlPath(runtimeUrl, "models"));
	assert.equal(modelListUrl.pathname, "/v1/models");
	assert.equal(modelListUrl.search, "?tenant=a");

	const anthropicUrl = new URL(resolveRuntimeBaseUrl("anthropic-messages", "https://gateway.example.com/v1?tenant=a"));
	assert.equal(anthropicUrl.pathname, "/");
	assert.equal(anthropicUrl.search, "?tenant=a");

	const googleUrl = new URL(resolveRuntimeBaseUrl("google-generative-ai", "https://generativelanguage.googleapis.com?tenant=a"));
	assert.equal(googleUrl.pathname, "/v1beta");
	assert.equal(googleUrl.search, "?tenant=a");
});
