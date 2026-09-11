import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { createProviderTransport } from "../provider-transport.ts";
import {
	createModelDraftFromStoredModel,
	createProviderDraft,
	createProviderDraftFromStored,
	upsertModelInDocument,
	upsertProviderInDocument,
	validateModelDraft,
	validateProviderDraft,
} from "../state-document.ts";
import type { ApiKind, StateDocument, StoredModel, StoredProvider } from "../types.ts";
import type { ModelsJsonDocument } from "../models-json-manager.ts";

const agentDir = await mkdtemp(resolve(".test-provider-api-keys-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const metadataStore = await import("../state-metadata-store.ts");
const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
const { buildSynchronizedModelsDocument } = await import("../models-json-sync.ts");
const { readState } = await import("../state-store.ts");

after(async () => { await rm(agentDir, { recursive: true, force: true }); });

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function model(id: string, apiKeyId?: string): StoredModel {
	return { id, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 16_384, cost, ...(apiKeyId ? { apiKeyId } : {}) };
}

function provider(overrides: Partial<StoredProvider> = {}): StoredProvider {
	return {
		name: "Managed",
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		managed: true,
		apiKey: "$DEFAULT_KEY",
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

test("命名 API key 与模型级选择经 state.json 元数据往返保真", async () => {
	const stored = provider({
		apiKeys: [{ id: "alt", value: "$ALT_KEY" }, { id: "backup", label: "Backup", value: "!echo backup" }],
		models: [model("with-key", "alt"), model("inherit")],
	});
	const document = state(stored);
	await mkdir(metadataStore.STATE_DIR, { recursive: true });
	await writeFile(MODELS_JSON_PATH, `${JSON.stringify(buildSynchronizedModelsDocument(document, { providers: {} } satisfies ModelsJsonDocument), null, 2)}\n`);
	await writeFile(metadataStore.STATE_PATH, metadataStore.serializeMetadataState(document));

	const restored = await readState();
	const restoredProvider = restored.providers.managed!;
	assert.deepEqual(restoredProvider.apiKeys, [
		{ id: "alt", value: "$ALT_KEY" },
		{ id: "backup", label: "Backup", value: "!echo backup" },
	]);
	assert.equal(restoredProvider.models.find((candidate) => candidate.id === "with-key")!.apiKeyId, "alt");
	assert.equal(restoredProvider.models.find((candidate) => candidate.id === "inherit")!.apiKeyId, undefined);
	// models.json 只保存默认 key，命名 key 不落盘。
	const rawModels = JSON.parse(await (await import("node:fs/promises")).readFile(MODELS_JSON_PATH, "utf8"));
	assert.equal(rawModels.providers.managed.apiKey, "$DEFAULT_KEY");
	assert.equal(rawModels.providers.managed.apiKeys, undefined);
});

test("删除命名 key 时清理模型引用", () => {
	const document = state(provider({
		apiKeys: [{ id: "alt", value: "$ALT_KEY" }],
		models: [model("with-key", "alt"), model("inherit")],
	}));
	const draft = createProviderDraftFromStored("managed", document.providers.managed!);
	assert.deepEqual(draft.apiKeys, [{ id: "alt", value: "$ALT_KEY" }]);

	draft.apiKeys = [];
	const next = upsertProviderInDocument(document, "managed", draft);
	assert.equal(next.providers.managed!.apiKeys, undefined);
	assert.equal(next.providers.managed!.models[0]!.apiKeyId, undefined);
});

test("模型草稿保存 key 选择，并校验引用必须存在", () => {
	const stored = provider({ apiKeys: [{ id: "alt", value: "$ALT_KEY" }] });
	const document = state(stored);
	const draft = createModelDraftFromStoredModel("managed", stored, stored.models[0]!);
	assert.deepEqual(draft.apiKeys, [{ id: "alt", value: "$ALT_KEY" }]);
	assert.equal(draft.apiKeyId, undefined);

	draft.apiKeyId = "alt";
	const next = upsertModelInDocument(document, draft);
	assert.equal(next.providers.managed!.models[0]!.apiKeyId, "alt");

	draft.apiKeyId = "missing";
	assert.match(validateModelDraft(draft, document).join("\n"), /API key 不存在/);
});

test("供应商 key 校验拒绝空 ID、重复 ID 和空值", () => {
	const draft = createProviderDraft("openai-completions");
	draft.providerId = "gateway";
	draft.apiKeys = [
		{ id: "", value: "$A" },
		{ id: "dup", value: "$B" },
		{ id: "dup", value: "  " },
		{ id: "bad id", value: "$C" },
	];
	const errors = validateProviderDraft(draft, state(provider()), new Set()).join("\n");
	assert.match(errors, /key ID 不能为空/);
	assert.match(errors, /key ID 重复/);
	assert.match(errors, /key 值不能为空/);
	assert.match(errors, /key ID 只能包含字母、数字、点、下划线和连字符/);
});

test("模型级命名 key 在请求期覆盖供应商默认 key", async () => {
	const captured: (string | undefined)[] = [];
	const runtime = {
		getAuth: async (_model: unknown, options: any) => {
			captured.push(options?.apiKey);
			return { auth: { headers: {} } };
		},
	};
	const consume = (_model: unknown, _context: unknown, options: any) => ({
		result: async () => (await options.fetch("http://gateway.invalid/v1/chat/completions")).text(),
	});
	const native = { id: "keys-wire", name: "Keys", api: "openai-completions", models: [], stream: consume, streamSimple: consume } as any;
	const stored = provider({
		apiKeys: [{ id: "alt", value: "$ALT_KEY" }],
		models: [model("with-key", "alt"), model("inherit")],
	});
	const transport = createProviderTransport(runtime as any, native, stored);

	for (const candidate of stored.models) {
		const wireModel = { ...candidate, api: "openai-completions" as ApiKind, baseUrl: stored.baseUrl };
		await transport.streamSimple(wireModel as any, {} as any, { fetch: async () => new Response("ok") }).result();
	}

	assert.deepEqual(captured, ["$ALT_KEY", undefined]);
});
