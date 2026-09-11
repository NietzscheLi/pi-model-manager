import assert from "node:assert/strict";
import test from "node:test";
import { buildSynchronizedModelsDocument } from "../models-json-sync.ts";
import { createEmptyMetadata } from "../state-metadata-store.ts";
import { buildModelFromDraft, createModelDraftFromStoredModel } from "../state-document.ts";
import { buildStateDocumentFromModelsJson } from "../state-store.ts";
import type { ApiKind, StateDocument, StoredModel, StoredProvider } from "../types.ts";
import type { ModelsJsonDocument } from "../models-json-manager.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function model(id: string, api?: ApiKind): StoredModel {
	return { id, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 16_384, cost, ...(api ? { api } : {}) };
}

function provider(overrides: Partial<StoredProvider> = {}): StoredProvider {
	return {
		name: "Managed",
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		managed: true,
		clientHeaderProfile: "recommended",
		models: [model("m")],
		...overrides,
	};
}

function state(stored: StoredProvider): StateDocument {
	return {
		version: 2,
		providers: { managed: stored },
		managedProviderIds: ["managed"],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
}

test("模型协议默认继承供应商，未覆盖时不写入 model.api", () => {
	const stored = provider({ models: [model("inherited")] });
	const draft = createModelDraftFromStoredModel("managed", stored, stored.models[0]!);
	assert.equal(draft.providerApi, "openai-responses");
	assert.equal(draft.api, "openai-responses");
	assert.equal(draft.apiOverride, undefined);

	const built = buildModelFromDraft(stored.models[0], draft, stored.compat);
	assert.equal("api" in built, false);
});

test("模型级协议覆盖写入 model.api，切回继承后移除", () => {
	const stored = provider({ models: [model("claude", "anthropic-messages")] });
	const draft = createModelDraftFromStoredModel("managed", stored, stored.models[0]!);
	assert.equal(draft.providerApi, "openai-responses");
	assert.equal(draft.apiOverride, "anthropic-messages");
	assert.equal(draft.api, "anthropic-messages");
	assert.equal(buildModelFromDraft(stored.models[0], draft, stored.compat).api, "anthropic-messages");

	draft.apiOverride = undefined;
	draft.api = draft.providerApi;
	assert.equal("api" in buildModelFromDraft(stored.models[0], draft, stored.compat), false);
});

test("模型级协议覆盖写回 models.json 时补 native baseUrl，并可往返恢复", async () => {
	const stored = provider({ models: [model("claude", "anthropic-messages")] });
	const document = buildSynchronizedModelsDocument(state(stored), { providers: {} } satisfies ModelsJsonDocument);
	const entry = document.providers.managed!;
	assert.equal(entry.models![0]!.api, "anthropic-messages");
	assert.equal(entry.models![0]!.baseUrl, "https://example.test");

	const metadata = { ...createEmptyMetadata(), managedProviderIds: ["managed"] };
	const roundTripped = await buildStateDocumentFromModelsJson(document, metadata);
	const restored = roundTripped.providers.managed!;
	assert.equal(restored.models[0]!.api, "anthropic-messages");
	assert.equal(restored.managed, true);

	const draft = createModelDraftFromStoredModel("managed", restored, restored.models[0]!);
	assert.equal(draft.providerApi, "openai-responses");
	assert.equal(draft.apiOverride, "anthropic-messages");
	assert.equal(draft.api, "anthropic-messages");
});
