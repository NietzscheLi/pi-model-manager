// tui/models-json-panel.ts
//
// 二级面板：查看 / 管理 pi 的 ~/.pi/agent/models.json。
//
// 说明：models.json 是 provider/model 定义权威源；本面板是高级入口。
// 删除扩展管理中的同名条目时，会同步清理插件元数据、enabledModels 与当前运行时注册。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "../common.ts";
import {
	MODELS_JSON_PATH,
	readModelsJson,
	type ModelsJsonDocument,
	type ModelsJsonModelEntry,
	type ModelsJsonProviderEntry,
} from "../models-json-manager.ts";
import { deleteModelsJsonModelConfiguration, deleteModelsJsonProviderConfiguration } from "../models-json-mutations.ts";
import { getModelFullId } from "../state-document.ts";
import { readState } from "../state-store.ts";
import { showPersistentShortcutMenu, type MenuCursor } from "./persistent-menu.ts";
import { formatTableHeader, joinFixedColumns } from "./ui-helpers.ts";

interface ProviderRow {
	providerId: string;
	label: string;
}

interface ProviderMenuRow {
	modelId: string;
	model: ModelsJsonModelEntry;
	label: string;
}

function modelCount(entry: ModelsJsonProviderEntry): number {
	return Array.isArray(entry.models) ? entry.models.length : 0;
}

function formatApiLabel(api: string | undefined): string {
	if (api === "openai-responses") return "Responses";
	if (api === "openai-completions") return "Chat";
	if (api === "anthropic-messages") return "Claude";
	if (api === "google-generative-ai") return "Gemini";
	return api ?? "未知";
}

function formatTokenLimit(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(value);
}

function sanitizeEndpoint(value: string | undefined): string {
	return (value ?? "<未配置>").replace(/([?&](?:key|api_key|api-key)=)[^&]+/gi, "$1REDACTED");
}

function formatModelInput(input: unknown): string {
	return Array.isArray(input) && input.includes("image") ? "文本,视觉" : "文本";
}

function formatNativeModelNameCell(model: ModelsJsonModelEntry): string {
	return model.name && model.name !== model.id ? model.name : "默认";
}

function formatNativeModelThinkingCell(model: ModelsJsonModelEntry): string {
	return model.reasoning === true ? "开" : "关";
}

const NATIVE_PROVIDER_HEADER = formatTableHeader(joinFixedColumns([
	{ text: "Provider", width: 24 },
	{ text: "API", width: 9 },
	{ text: "Models", width: 6, align: "right" },
	{ text: "Source", width: 8 },
]));

const NATIVE_MODEL_HEADER = formatTableHeader(joinFixedColumns([
	{ text: "模型 ID", width: 30 },
	{ text: "显示名", width: 16 },
	{ text: "输入", width: 10 },
	{ text: "Thinking", width: 8 },
	{ text: "上下文", width: 7, align: "right" },
	{ text: "输出", width: 7, align: "right" },
	{ text: "Headers", width: 8, align: "right" },
]));

function formatNativeModelRow(model: ModelsJsonModelEntry): string {
	return joinFixedColumns([
		{ text: model.id, width: 30 },
		{ text: formatNativeModelNameCell(model), width: 16 },
		{ text: formatModelInput(model.input), width: 10 },
		{ text: formatNativeModelThinkingCell(model), width: 8 },
		{ text: formatTokenLimit(model.contextWindow), width: 7, align: "right" },
		{ text: formatTokenLimit(model.maxTokens), width: 7, align: "right" },
		{ text: String(Object.keys(model.headers ?? {}).length), width: 8, align: "right" },
	]);
}

function formatProviderRow(providerId: string, entry: ModelsJsonProviderEntry, managedInState: boolean): string {
	return joinFixedColumns([
		{ text: providerId, width: 24 },
		{ text: formatApiLabel(entry.api), width: 9 },
		{ text: String(modelCount(entry)), width: 6, align: "right" },
		{ text: managedInState ? "managed" : "native", width: 8 },
	]);
}

function formatProviderDetailLines(providerId: string, entry: ModelsJsonProviderEntry, managedInState: boolean): string[] {
	const title = entry.name && entry.name !== providerId ? `${entry.name} (${providerId})` : providerId;
	return [
		title,
		`  endpoint  ${sanitizeEndpoint(entry.baseUrl)}`,
		`  api       ${formatApiLabel(entry.api)} · ${modelCount(entry)} models · ${managedInState ? "extension metadata" : "native only"}`,
		`  source    ${MODELS_JSON_PATH}`,
	];
}

function buildProviderRows(document: ModelsJsonDocument, managedIds: ReadonlySet<string>): ProviderRow[] {
	return Object.keys(document.providers)
		.sort((a, b) => a.localeCompare(b))
		.map((providerId) => ({
			providerId,
			label: formatProviderRow(providerId, document.providers[providerId]!, managedIds.has(providerId)),
		}));
}

function buildProviderMenuRows(entry: ModelsJsonProviderEntry): ProviderMenuRow[] {
	return [...(entry.models ?? [])]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((model) => ({
			modelId: model.id,
			model,
			label: formatNativeModelRow(model),
		}));
}


async function deleteProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string): Promise<void> {
	const ok = await ctx.ui.confirm(`删除 ${providerId}`, "将从 models.json 删除整个接入，并同步清理插件元数据与 enabledModels。");
	if (!ok) return;
	try {
		await deleteModelsJsonProviderConfiguration(pi, ctx, providerId);
	} catch (error) {
		ctx.ui.notify(`删除失败：${formatUnknownError(error)}`, "error");
	}
}

async function deleteModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string, modelId: string): Promise<void> {
	const fullId = getModelFullId(providerId, modelId);
	const docForPrompt = await readModelsJson();
	const modelCount = docForPrompt.providers[providerId]?.models?.length ?? 0;
	const ok = await ctx.ui.confirm(
		`删除 ${fullId}`,
		modelCount <= 1 ? "这是该接入下最后一个模型；删除后该接入也会从 models.json 中移除。" : "只从 models.json 的模型列表移除该模型。",
	);
	if (!ok) return;
	try {
		await deleteModelsJsonModelConfiguration(pi, ctx, providerId, modelId);
	} catch (error) {
		ctx.ui.notify(`删除失败：${formatUnknownError(error)}`, "error");
	}
}

type ModelsJsonProviderShortcut = "delete-model";

async function showProviderMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	managedInState: boolean,
): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const doc = await readModelsJson();
		const entry = doc.providers[providerId];
		if (!entry) {
			ctx.ui.notify(`接入不存在：${providerId}`, "warning");
			return;
		}
		const rows = buildProviderMenuRows(entry);
		const action = await showPersistentShortcutMenu<ModelsJsonProviderShortcut>(
			ctx,
			`/model-manager / 原生配置 / ${providerId}`,
			"",
			rows.map((row, index) => ({ id: `${index}`, label: row.label })),
			cursor,
			[{ input: "d", shortcut: "delete-model" }],
			{
				summaryLines: formatProviderDetailLines(providerId, entry, managedInState).slice(1, 3),
				tableHeader: NATIVE_MODEL_HEADER,
				visibleRows: Math.min(12, Math.max(1, rows.length)),
				footer: "↑↓ 选择   d 删除模型   Esc 返回",
				emptyLabel: "暂无模型；返回上一级可删除接入",
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut") {
			const selectedModelId = rows[cursor.index]?.modelId;
			if (!selectedModelId) {
				ctx.ui.notify("没有可删除的模型；删除接入请返回上一级按 d。", "info");
				continue;
			}
			await deleteModel(pi, ctx, providerId, selectedModelId);
			continue;
		}
		ctx.ui.notify("models.json 模型只能删除；请按 d 删除选中模型。", "info");
	}
}

type ModelsJsonShortcut = "delete-provider";

export async function runModelsJsonPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		let document: ModelsJsonDocument;
		let managedIds: Set<string>;
		try {
			document = await readModelsJson();
			managedIds = await readState()
				.then((state) => new Set(Object.keys(state.providers)))
				.catch(() => new Set<string>());
		} catch (error) {
			ctx.ui.notify(`读取 models.json 失败：${formatUnknownError(error)}`, "error");
			return;
		}

		const rows = buildProviderRows(document, managedIds);
		const menuRows = rows.map((row, index) => ({ id: `${index}`, label: row.label }));
		const action = await showPersistentShortcutMenu<ModelsJsonShortcut>(
			ctx,
			"/model-manager / 原生配置",
			"",
			menuRows,
			cursor,
			[{ input: "d", shortcut: "delete-provider" }],
			{
				summaryLines: [
					"Pi / workflow 直接读取的最终模型配置",
					MODELS_JSON_PATH,
				],
				tableHeader: NATIVE_PROVIDER_HEADER,
				getDetailLines: (selectedRow) => {
					const row = rows[Number.parseInt(selectedRow?.id ?? "", 10)];
					const entry = row ? document.providers[row.providerId] : undefined;
					return row && entry ? formatProviderDetailLines(row.providerId, entry, managedIds.has(row.providerId)) : [];
				},
				footer: "↑↓ 选择   Enter 查看接入   d 删除接入   Esc 返回",
				emptyLabel: "models.json 中暂无接入",
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut") {
			const selectedProviderId = rows[cursor.index]?.providerId;
			if (!selectedProviderId) {
				ctx.ui.notify("没有可删除的接入。", "info");
				continue;
			}
			await deleteProvider(pi, ctx, selectedProviderId);
			continue;
		}
		const index = Number.parseInt(action.id, 10);
		if (!Number.isFinite(index) || index < 0 || index >= rows.length) continue;
		const row = rows[index]!;
		await showProviderMenu(pi, ctx, row.providerId, managedIds.has(row.providerId));
	}
}

export function getModelsJsonPanelPath(): string {
	return MODELS_JSON_PATH;
}
