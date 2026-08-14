// tui/editor-model.ts
//
// 模型编辑器：与 editor-provider 同款问答式表单。
// 关键差异：
//   - 请求头已经收敛到接入级；模型编辑器只编辑模型自身能力
//   - 提供"从上游拉取模型 ID 列表"入口（OpenAI/Anthropic/Google）
//   - 视觉支持用开关式 select，保存时仍映射为 text / text,image

import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AnthropicThinkingProtocol, BuiltInClientHeaderProfileId, ModelDraft, ModelListFetchOutcome, ReasoningMode, StoredClientHeaderCapture, StoredRequestHeaderProfile } from "../types.ts";
import { fetchModelIds } from "./model-list-fetch.ts";
import { pickModelIdFromList } from "./model-picker.ts";
import { showOptionPicker, showPersistentFormMenu, padLabel, type MenuCursor } from "./persistent-menu.ts";
import {
	describeVisionInput,
	formatApiShort,
	supportsVisionInput,
	VISION_INPUT_CHOICES,
} from "./ui-helpers.ts";

interface FieldRow {
	id: string;
	label: string;
	value: string;
	// 开关类字段可用 ←→ 就地切换；其余字段需要 Enter 进入输入或选择器。
	adjustable?: boolean;
}


function shouldShowOpenAIServiceTier(draft: ModelDraft): boolean {
	return draft.api === "openai-responses";
}

function shouldShowAnthropicThinkingProtocol(draft: ModelDraft): boolean {
	return draft.reasoningMode === "enabled" && draft.anthropicThinkingProtocol !== undefined;
}


function describeReasoningMode(mode: ReasoningMode): string {
	return mode === "enabled" ? "开启" : "关闭";
}

function describeAnthropicThinkingProtocol(protocol: AnthropicThinkingProtocol): string {
	return protocol === "adaptive" ? "开启 · 新版协议" : "关闭 · Legacy";
}

function describeOpenAIServiceTier(draft: ModelDraft): string {
	return draft.openAIServiceTier === "priority" ? "开启 · priority" : "关闭";
}

function getIntegerFieldLabel(field: "contextWindow" | "maxTokens"): string {
	return field === "contextWindow" ? "上下文窗口" : "最大输出";
}


// 开关字段在两个方向上都是取反，因此不看 direction；返回是否真的切换了字段。
function applyHorizontalToggle(draft: ModelDraft, fieldId: string): boolean {
	if (fieldId === "visionInput") {
		draft.inputKinds = supportsVisionInput(draft.inputKinds) ? ["text"] : ["text", "image"];
		return true;
	}
	if (fieldId === "reasoning") {
		draft.reasoningMode = draft.reasoningMode === "enabled" ? "disabled" : "enabled";
		return true;
	}
	if (fieldId === "anthropicThinkingProtocol") {
		draft.anthropicThinkingProtocol = draft.anthropicThinkingProtocol === "adaptive" ? "legacy" : "adaptive";
		return true;
	}
	if (fieldId === "openAIServiceTier") {
		draft.openAIServiceTier = draft.openAIServiceTier === "priority" ? undefined : "priority";
		return true;
	}
	return false;
}

function buildRows(draft: ModelDraft): FieldRow[] {
	const rows: FieldRow[] = [
		{ id: "modelId", label: "模型 ID", value: draft.modelId || "<未填写>" },
		{ id: "fetch", label: "重新拉取", value: "上游模型列表" },
		{ id: "modelName", label: "显示名称", value: draft.modelName || "默认 = 模型 ID" },
		{ id: "visionInput", label: "视觉支持", value: describeVisionInput(draft.inputKinds), adjustable: true },
		{ id: "reasoning", label: "Thinking", value: describeReasoningMode(draft.reasoningMode), adjustable: true },
	];
	if (shouldShowAnthropicThinkingProtocol(draft)) {
		rows.push({
			id: "anthropicThinkingProtocol",
			label: "Adaptive",
			value: describeAnthropicThinkingProtocol(draft.anthropicThinkingProtocol!),
			adjustable: true,
		});
	}
	if (shouldShowOpenAIServiceTier(draft)) {
		rows.push({ id: "openAIServiceTier", label: "Fast mode", value: describeOpenAIServiceTier(draft), adjustable: true });
	}
	rows.push(
		{ id: "contextWindow", label: "上下文窗口", value: String(draft.contextWindow) },
		{ id: "maxTokens", label: "最大输出", value: String(draft.maxTokens) },
	);
	return rows;
}

function getSelectedCustomHeaders(
	draft: ModelDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Record<string, string> {
	if (draft.clientHeaderProfile !== "custom" || !draft.requestHeaderProfileId) return {};
	return requestHeaderProfiles[draft.requestHeaderProfileId]?.headers ?? {};
}

async function pickModelFromUpstream(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Promise<void> {
	const params = {
		providerId: draft.providerId,
		api: draft.api,
		baseUrl: draft.baseUrl,
		apiKey: draft.apiKey,
		authHeader: draft.authHeader,
		clientHeaderProfile: draft.clientHeaderProfile,
		customClientHeaders: getSelectedCustomHeaders(draft, requestHeaderProfiles),
		httpProxyEnabled: draft.httpProxyEnabled,
		httpProxyUrl: draft.httpProxyUrl,
		clientHeaderCaptures,
	};
	const outcome = await ctx.ui.custom<ModelListFetchOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "正在拉取模型列表，总计最多 10 秒…", { cancellable: true });
		let settled = false;
		const finish = (result: ModelListFetchOutcome) => {
			if (settled) return;
			settled = true;
			done(result);
		};
		loader.onAbort = () => finish({ status: "cancelled" });
		fetchModelIds(params, loader.signal)
			.then(finish)
			.catch((error) => finish({ status: "failed", message: error instanceof Error ? error.message : String(error) }));
		return loader;
	});
	if (outcome.status === "cancelled") return;
	if (outcome.status === "failed") {
		ctx.ui.notify(`拉取失败：${outcome.message}`, "warning");
		const fallback = await ctx.ui.input(`手动输入模型 ID（当前：${draft.modelId || "<空>"}）`, draft.modelId);
		if (fallback !== undefined) {
			draft.modelId = fallback.trim() || draft.modelId;
		}
		return;
	}
	if (outcome.modelIds.length === 0) {
		ctx.ui.notify("上游返回空列表", "warning");
		return;
	}
	const picked = await pickModelIdFromList(
		ctx,
		`选择模型 ID（共 ${outcome.modelIds.length} 个）`,
		outcome.modelIds,
		draft.modelId,
	);
	if (picked) {
		draft.modelId = picked;
	}
}

async function editIntField(ctx: ExtensionCommandContext, draft: ModelDraft, field: "contextWindow" | "maxTokens"): Promise<void> {
	const label = getIntegerFieldLabel(field);
	const current = String(draft[field]);
	const value = await ctx.ui.input(`${label}（当前：${current}，留空保持原值）`, current);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		ctx.ui.notify(`${label} 必须是正整数`, "warning");
		return;
	}
	draft[field] = parsed;
}

async function editField(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	fieldId: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Promise<void> {
	if (fieldId === "modelId") {
		const value = await ctx.ui.input(`模型 ID（当前：${draft.modelId || "<空>"}，传给上游 API 的模型字段）`, draft.modelId);
		if (value !== undefined) {
			const trimmed = value.trim();
			if (trimmed) {
				draft.modelId = trimmed;
			}
		}
		return;
	}
	if (fieldId === "fetch") {
		await pickModelFromUpstream(ctx, draft, requestHeaderProfiles, clientHeaderCaptures);
		return;
	}
	if (fieldId === "modelName") {
		const value = await ctx.ui.input(`显示名称（当前：${draft.modelName || "<空>"}，可空默认用模型 ID；输入空格清空）`, draft.modelName);
		if (value !== undefined) draft.modelName = value.trim();
		return;
	}
	if (fieldId === "visionInput") {
		const choices = VISION_INPUT_CHOICES.map((choice) => ({
			id: choice.enabled ? "enabled" : "disabled",
			label: choice.label,
			kinds: choice.kinds,
		}));
		const choice = await showOptionPicker(ctx, "视觉支持", choices, supportsVisionInput(draft.inputKinds) ? "enabled" : "disabled");
		if (choice) draft.inputKinds = [...choice.kinds];
		return;
	}
	if (fieldId === "reasoning") {
		const choice = await showOptionPicker(
			ctx,
			"Thinking",
			[
				{ id: "disabled" as ReasoningMode, label: "关闭 — 不发送模型推理参数" },
				{ id: "enabled" as ReasoningMode, label: "开启 — 启用模型推理参数" },
			],
			draft.reasoningMode,
		);
		if (choice) draft.reasoningMode = choice.id;
		return;
	}
	if (fieldId === "anthropicThinkingProtocol") {
		const choice = await showOptionPicker(
			ctx,
			"Adaptive",
			[
				{ id: "adaptive" as AnthropicThinkingProtocol, label: "开启：新版模型，发送 thinking.type=adaptive 和 output_config.effort" },
				{ id: "legacy" as AnthropicThinkingProtocol, label: "关闭：旧版接口，发送 thinking.type=enabled 和 budget_tokens" },
			],
			draft.anthropicThinkingProtocol ?? "legacy",
		);
		if (choice) draft.anthropicThinkingProtocol = choice.id;
		return;
	}
	if (fieldId === "openAIServiceTier") {
		const choice = await showOptionPicker(
			ctx,
			"Fast mode",
			[
				{ id: "disabled", tier: undefined, label: "关闭 — 不发送 service_tier（默认）" },
				{ id: "priority", tier: "priority", label: "开启 — service_tier=priority，可能消耗 Fast / priority 额度" },
			] as const satisfies readonly { id: string; tier: ModelDraft["openAIServiceTier"]; label: string }[],
			draft.openAIServiceTier === "priority" ? "priority" : "disabled",
		);
		if (choice) draft.openAIServiceTier = choice.tier;
		return;
	}
	if (fieldId === "contextWindow" || fieldId === "maxTokens") {
		await editIntField(ctx, draft, fieldId);
	}
}

export type ModelEditOutcome =
	| { action: "save"; draft: ModelDraft }
	| { action: "cancel" };

export async function editModel(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	titlePrefix: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): Promise<ModelEditOutcome> {
	if (!draft.modelId.trim()) {
		await pickModelFromUpstream(ctx, draft, requestHeaderProfiles, clientHeaderCaptures);
	}
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		// [喵喵喵]: 字段行的排版在开关切换后要原样重建，抽成函数避免两处写法飘移。
		const toMenuRows = (fieldRows: FieldRow[]) => fieldRows.map((row) => ({
			id: row.id,
			label: `${padLabel(row.label, 16)}${row.value}`,
			adjustable: row.adjustable,
		}));
		const rows = buildRows(draft);
		const menuRows = toMenuRows(rows);
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				summaryLines: [
					`接入 ${draft.providerId} · API ${formatApiShort(draft.api)}`,
					"Ctrl+S 保存并启用模型；不切换当前会话模型",
				],
				onAdjust: (id) => {
					if (!applyHorizontalToggle(draft, id)) return undefined;
					return toMenuRows(buildRows(draft));
				},
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "←→", label: "切换选项" },
					{ key: "Enter", label: "编辑" },
					{ key: "Ctrl+S", label: "保存并启用" },
					{ key: "Esc", label: "返回" },
				],
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		await editField(ctx, draft, action.id, requestHeaderProfiles, clientHeaderCaptures);
	}
}
