import assert from "node:assert/strict";
import test from "node:test";
import { buildSynchronizedModelsDocument } from "../models-json-sync.ts";
import { createEmptyMetadata } from "../state-metadata-store.ts";
import {
	buildModelFromDraft,
	createModelDraftFromStoredModel,
	createProviderDraftFromStored,
	upsertModelInDocument,
	upsertProviderInDocument,
	validateModelDraft,
} from "../state-document.ts";
import { buildStateDocumentFromModelsJson } from "../state-store.ts";
import type { ModelInputLimits, StateDocument, StoredModel, StoredProvider } from "../types.ts";
import type { ModelsJsonDocument } from "../models-json-manager.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function metadataWith(providerIds: string[] = ["managed"]) {
	return { ...createEmptyMetadata(), managedProviderIds: providerIds };
}

function model(overrides: Partial<StoredModel> = {}): StoredModel {
	return {
		id: "m",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost,
		...overrides,
	};
}

function provider(overrides: Partial<StoredProvider> = {}): StoredProvider {
	return {
		name: "Managed",
		api: "anthropic-messages",
		baseUrl: "https://example.test/v1",
		managed: true,
		clientHeaderProfile: "recommended",
		models: [model()],
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

test("models.json 的 promptCache/inputLimits 读入 StoredModel（保留未知子字段）", async () => {
	const document: ModelsJsonDocument = {
		providers: {
			managed: {
				name: "Managed",
				api: "anthropic-messages",
				baseUrl: "https://example.test/v1",
				models: [{
					id: "m",
					reasoning: false,
					input: ["text", "image"],
					contextWindow: 128_000,
					maxTokens: 16_384,
					promptCache: { short: 300, long: 3600, experimental: 5 },
					inputLimits: {
						maxRequestBytes: 10_000_000,
						images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 524_288, jpegQuality: 75 }, maxPerMessage: 4 },
						futureField: { nested: true },
					},
				}],
			},
		},
	};
	const parsed = await buildStateDocumentFromModelsJson(document, metadataWith());
	const stored = parsed.providers.managed!.models[0]!;
	assert.deepEqual(stored.promptCache, { short: 300, long: 3600, experimental: 5 });
	assert.deepEqual(stored.inputLimits, {
		maxRequestBytes: 10_000_000,
		images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 524_288, jpegQuality: 75 }, maxPerMessage: 4 },
		futureField: { nested: true },
	});
});

test("draft 编辑 promptCache/inputLimits/compat 写回 models.json 并可往返恢复", async () => {
	const stored = provider();
	const source = buildSynchronizedModelsDocument(state(stored), { providers: {} } satisfies ModelsJsonDocument);
	assert.equal(source.providers.managed!.models![0]!.promptCache, undefined);

	const meta = metadataWith();
	const restored = (await buildStateDocumentFromModelsJson(source, meta)).providers.managed!;
	const draft = createModelDraftFromStoredModel("managed", restored, restored.models[0]!);
	assert.equal(draft.promptCache, undefined);
	assert.equal(draft.inputLimits, undefined);

	draft.promptCache = { short: 300, long: 3600, experimental: 5 };
	draft.inputLimits = { images: { resize: { maxWidth: 1024, maxHeight: 1024 } } };
	draft.compat = { supportsMidConvoEffort: true };

	const edited = upsertModelInDocument(state(restored), draft);
	const nextDocument = buildSynchronizedModelsDocument(edited, source);
	const entry = nextDocument.providers.managed!.models![0]!;
	assert.deepEqual(entry.promptCache, { short: 300, long: 3600, experimental: 5 });
	assert.deepEqual(entry.inputLimits, { images: { resize: { maxWidth: 1024, maxHeight: 1024 } } });
	assert.deepEqual(entry.compat, { supportsMidConvoEffort: true });

	const roundTripped = (await buildStateDocumentFromModelsJson(nextDocument, meta)).providers.managed!.models[0]!;
	assert.deepEqual(roundTripped.promptCache, { short: 300, long: 3600, experimental: 5 });
	assert.deepEqual(roundTripped.inputLimits, { images: { resize: { maxWidth: 1024, maxHeight: 1024 } } });
});

test("清空 promptCache/compat 后从 models.json 移除", async () => {
	const stored = provider({
		models: [model({ promptCache: { short: 300 }, compat: { supportsMidConvoEffort: true } })],
	});
	const meta = metadataWith();
	const source = buildSynchronizedModelsDocument(state(stored), { providers: {} } satisfies ModelsJsonDocument);
	assert.deepEqual(source.providers.managed!.models![0]!.promptCache, { short: 300 });

	const restored = (await buildStateDocumentFromModelsJson(source, meta)).providers.managed!;
	const draft = createModelDraftFromStoredModel("managed", restored, restored.models[0]!);
	draft.promptCache = undefined;
	draft.compat = undefined;

	const edited = upsertModelInDocument(state(restored), draft);
	const nextDocument = buildSynchronizedModelsDocument(edited, source);
	const entry = nextDocument.providers.managed!.models![0]!;
	assert.equal(entry.promptCache, undefined);
	assert.equal(entry.compat, undefined);
});

test("接入编辑器的 compat/modelOverrides JSON 覆盖写回 models.json，清空即删除", () => {
	const stored = provider({
		compat: { supportsStrictTools: false },
		modelOverrides: { m: { promptCache: { short: 60 } } },
	});
	const draft = createProviderDraftFromStored("managed", stored);
	assert.deepEqual(draft.compat, { supportsStrictTools: false });
	assert.deepEqual(draft.modelOverrides, { m: { promptCache: { short: 60 } } });

	draft.compat = { allowedFallbackModels: [] };
	draft.modelOverrides = { m: { promptCache: { long: 3600 } } };
	const edited = upsertProviderInDocument(state(stored), "managed", draft);
	const document = buildSynchronizedModelsDocument(edited, { providers: {} } satisfies ModelsJsonDocument);
	assert.deepEqual(document.providers.managed!.compat, { allowedFallbackModels: [] });
	assert.deepEqual(document.providers.managed!.modelOverrides, { m: { promptCache: { long: 3600 } } });

	draft.compat = {};
	draft.modelOverrides = undefined;
	const cleared = upsertProviderInDocument(edited, "managed", draft);
	const clearedDocument = buildSynchronizedModelsDocument(cleared, document);
	assert.equal("compat" in clearedDocument.providers.managed!, false);
	assert.equal("modelOverrides" in clearedDocument.providers.managed!, false);
});

test("promptCache 非正整数在保存前被校验拒绝", () => {
	const stored = provider();
	const draft = createModelDraftFromStoredModel("managed", stored, stored.models[0]!);
	draft.promptCache = { short: 0 };
	const errors = validateModelDraft(draft, state(stored));
	assert.ok(errors.some((error) => error.includes("缓存存活时间必须是正整数：short")), errors.join("; "));
});

test("非法 inputLimits 在保存前被校验拒绝", () => {
	const stored = provider();
	const draft = createModelDraftFromStoredModel("managed", stored, stored.models[0]!);
	// 字符串 maxWidth：pi 的 models.json schema 会拒绝并导致整个文件不加载。
	draft.inputLimits = { images: { resize: { maxWidth: "1568" } } } as unknown as ModelInputLimits;
	assert.ok(
		validateModelDraft(draft, state(stored)).some((error) => error.includes("inputLimits.images.resize.maxWidth")),
		"maxWidth 字符串未被拦截",
	);

	draft.inputLimits = { images: { resize: { jpegQuality: 101 } } };
	assert.ok(
		validateModelDraft(draft, state(stored)).some((error) => error.includes("jpegQuality")),
		"jpegQuality 越界未被拦截",
	);

	draft.inputLimits = { images: "resize" } as unknown as ModelInputLimits;
	assert.ok(
		validateModelDraft(draft, state(stored)).some((error) => error.includes("inputLimits.images 必须是 JSON 对象")),
		"images 非对象未被拦截",
	);
});

test("buildModelFromDraft 未触碰字段时不改变已有提示缓存配置", () => {
	const existing = model({ promptCache: { long: 3600 }, inputLimits: { maxRequestBytes: 1_000_000 } });
	const draft = createModelDraftFromStoredModel("managed", provider(), existing);
	const built = buildModelFromDraft(existing, draft);
	assert.deepEqual(built.promptCache, { long: 3600 });
	assert.deepEqual(built.inputLimits, { maxRequestBytes: 1_000_000 });
});
