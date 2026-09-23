// tui/editor-model.ts
//
// 模型编辑器：与 editor-provider 同款问答式表单。
// 关键差异：
//   - 请求头已经收敛到接入级；模型编辑器只编辑模型自身能力
//   - 提供"从上游拉取模型 ID 列表"入口（OpenAI/Anthropic/Google）
//   - 视觉支持用开关式 select，保存时仍映射为 text / text,image

import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.ts";
import type { AnthropicThinkingProtocol, ApiKind, BuiltInClientHeaderProfileId, ModelDraft, ModelInputLimits, ModelListFetchOutcome, ReasoningMode, StoredClientHeaderCapture, StoredRequestHeaderProfile } from "../types.ts";
import { fetchModelIds } from "./model-list-fetch.ts";
import { editJsonObjectField } from "./json-field.ts";
import { pickModelIdFromList } from "./model-picker.ts";
import { showOptionPicker, showPersistentFormMenu, padLabel, type MenuCursor } from "./persistent-menu.ts";
import {
	describeVisionInput,
	formatApiShort,
	getApiChoices,
	getCompatExample,
	getVisionInputChoices,
	supportsVisionInput,
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
	return mode === "enabled" ? t("开启") : t("关闭");
}

function describeModelApi(draft: ModelDraft): string {
	return draft.apiOverride
		? formatApiShort(draft.api)
		: t("继承供应商（{api}）", { api: formatApiShort(draft.providerApi) });
}

// 模型级协议只改变该模型的 wire 格式；派生字段按新协议收敛，避免保存后残留不适用字段。
function applyModelApiChange(draft: ModelDraft, override: ApiKind | undefined): void {
	const nextApi = override ?? draft.providerApi;
	draft.apiOverride = override;
	if (draft.api === nextApi) return;
	draft.api = nextApi;
	if (nextApi === "anthropic-messages") draft.anthropicThinkingProtocol ??= "adaptive";
	else draft.anthropicThinkingProtocol = undefined;
	if (nextApi !== "openai-responses") draft.openAIServiceTier = undefined;
}

function describeAnthropicThinkingProtocol(protocol: AnthropicThinkingProtocol): string {
	return protocol === "adaptive" ? t("开启 · 新版协议") : t("关闭 · Legacy");
}

function describeOpenAIServiceTier(draft: ModelDraft): string {
	return draft.openAIServiceTier === "priority" ? t("开启 · priority") : t("关闭");
}

function getIntegerFieldLabel(field: "contextWindow" | "maxTokens"): string {
	return field === "contextWindow" ? t("上下文窗口") : t("最大输出");
}

function describePromptCache(value: unknown): string {
	return typeof value === "number" && value > 0 ? t("{count} 秒", { count: value }) : t("未设置");
}

// promptCache 的值就是「上游缓存能活多久」，只能抄上游真实 TTL；这里只用主流口径当输入提示。
const PROMPT_CACHE_SUGGESTED_SECONDS = { short: 300, long: 3600 } as const;
const INPUT_LIMITS_EXAMPLE = `{"images":{"resize":{"maxWidth":1568,"maxHeight":1568,"jpegQuality":75}}}`;

// 新增的高级字段只给入口等于让用户猜值；选中行时把语义、推荐值和留空后果一并摊开。
function getFieldDetailLines(draft: ModelDraft, fieldId: string): string[] {
	switch (fieldId) {
		case "promptCacheShort":
			return [
				t("「短」层级的缓存存活秒数（默认层级）；pi 会在到期前重发请求保活。"),
				t("Anthropic 短缓存通常 300（5 分钟）；填真实 TTL，拿不准留空 = 不预热。"),
				t("还需模型有 cost 元数据、pi 预计省 ≥ $0.05 才真正预热。"),
			];
		case "promptCacheLong":
			return [
				t("「长」层级的缓存存活秒数；仅当请求走 long 保留层级时生效。"),
				t("Anthropic 扩展缓存通常 3600（1 小时）；常见短/长一起填 300 / 3600。"),
				t("long 层级来自 PI_CACHE_RETENTION=long；留空 = 该层级不预热。"),
			];
		case "inputLimits":
			return [
				t("只在上游限制图片或请求体积时才需要；pi 只用 images.resize 压缩新图片。"),
				t("留空 = 默认 2000×2000、4.5 MiB、质量 80；maxRequestBytes 等硬上限只是元数据。"),
				t("例：{example}", { example: INPUT_LIMITS_EXAMPLE }),
			];
		case "compat": {
			const example = getCompatExample(draft.api);
			if (example) {
				return [
					t("只填已在真实上游验证过的差异项；不确定就留空，用 pi 的自动判断。"),
					t("示例（{api}）：{example}", { api: formatApiShort(draft.api), example }),
				];
			}
			return [
				t("只填已在真实上游验证过的差异项；不确定就留空，用 pi 的自动判断。"),
				t("当前协议（{api}）没有可用的 compat 项，请保持留空。", { api: formatApiShort(draft.api) }),
			];
		}
		default:
			return [];
	}
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
		{ id: "modelId", label: t("模型 ID"), value: draft.modelId || t("<未填写>") },
		{ id: "fetch", label: t("重新拉取"), value: t("上游模型列表") },
		{ id: "modelName", label: t("显示名称"), value: draft.modelName || t("默认 = 模型 ID") },
		{ id: "apiOverride", label: t("API 协议"), value: describeModelApi(draft) },
		{ id: "metadataSource", label: t("元数据源"), value: draft.metadataSource === "manual" ? t("关闭（保留手工值）") : draft.metadataSource },
		{ id: "visionInput", label: t("视觉支持"), value: describeVisionInput(draft.inputKinds), adjustable: true },
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
		{ id: "contextWindow", label: t("上下文窗口"), value: String(draft.contextWindow) },
		{ id: "maxTokens", label: t("最大输出"), value: String(draft.maxTokens) },
		{ id: "promptCacheShort", label: t("缓存预热·短(秒)"), value: describePromptCache(draft.promptCache?.short) },
		{ id: "promptCacheLong", label: t("缓存预热·长(秒)"), value: describePromptCache(draft.promptCache?.long) },
		{ id: "inputLimits", label: t("图片与请求限制"), value: draft.inputLimits ? t("已配置") : t("未设置") },
		{ id: "compat", label: t("高级 compat"), value: draft.compat && Object.keys(draft.compat).length > 0 ? t("已配置") : t("未设置") },
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
		const loader = new BorderedLoader(tui, theme, t("正在拉取模型列表，总计最多 10 秒…"), { cancellable: true });
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
		ctx.ui.notify(t("拉取失败：{error}", { error: outcome.message }), "warning");
		const fallback = await ctx.ui.input(t("手动输入模型 ID（当前：{current}）", { current: draft.modelId || t("<空>") }), draft.modelId);
		if (fallback !== undefined) {
			draft.modelId = fallback.trim() || draft.modelId;
		}
		return;
	}
	if (outcome.modelIds.length === 0) {
		ctx.ui.notify(t("上游返回空列表"), "warning");
		return;
	}
	const picked = await pickModelIdFromList(
		ctx,
		t("选择模型 ID（共 {count} 个）", { count: outcome.modelIds.length }),
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
	const value = await ctx.ui.input(t("{label}（当前：{current}，留空保持原值）", { label, current }), current);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		ctx.ui.notify(t("{label} 必须是正整数", { label }), "warning");
		return;
	}
	draft[field] = parsed;
}

async function editPromptCacheField(ctx: ExtensionCommandContext, draft: ModelDraft, key: "short" | "long"): Promise<void> {
	const label = key === "short" ? t("缓存预热·短") : t("缓存预热·长");
	const suggestion = PROMPT_CACHE_SUGGESTED_SECONDS[key];
	const current = draft.promptCache?.[key];
	// [喵喵喵]: pi 0.87 的 ctx.ui.input 会忽略 placeholder（ExtensionInputComponent 收下不用），
	// 推荐值必须写进一定可见的标题里，placeholder 只作旧版/未来版本的兜底。
	const value = await ctx.ui.input(
		t("{label}（秒；常见 {suggestion}；当前：{current}；留空关闭该层级预热）", {
			label,
			suggestion: String(suggestion),
			current: describePromptCache(current),
		}),
		current ? String(current) : String(suggestion),
	);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) {
		if (draft.promptCache) {
			delete draft.promptCache[key];
			if (Object.keys(draft.promptCache).length === 0) draft.promptCache = undefined;
		}
		return;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		ctx.ui.notify(t("缓存存活时间必须是正整数：{key}", { key: label }), "warning");
		return;
	}
	draft.promptCache = { ...draft.promptCache, [key]: parsed };
}

async function editField(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	fieldId: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Promise<void> {
	if (fieldId === "modelId") {
		const value = await ctx.ui.input(t("模型 ID（当前：{current}，传给上游 API 的模型字段）", { current: draft.modelId || t("<空>") }), draft.modelId);
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
		const value = await ctx.ui.input(t("显示名称（当前：{current}，可空默认用模型 ID；输入空格清空）", { current: draft.modelName || t("<空>") }), draft.modelName);
		if (value !== undefined) draft.modelName = value.trim();
		return;
	}
	if (fieldId === "apiOverride") {
		const choice = await showOptionPicker(ctx, t("选择 API 协议"), [
			{ id: "inherit", label: t("继承供应商（{api}）", { api: formatApiShort(draft.providerApi) }) },
			...getApiChoices(),
		], draft.apiOverride ?? "inherit");
		if (!choice) return;
		applyModelApiChange(draft, choice.id === "inherit" ? undefined : choice.id as ApiKind);
		return;
	}
	if (fieldId === "metadataSource") {
		const choice = await showOptionPicker(ctx, t("选择模型元数据源"), [
			{ id: "models.dev", label: "models.dev" },
			{ id: "openrouter", label: "OpenRouter" },
			{ id: "manual", label: t("关闭（保留手工值）") },
		], draft.metadataSource);
		if (choice) draft.metadataSource = choice.id as ModelDraft["metadataSource"];
		return;
	}
	if (fieldId === "visionInput") {
		const choices = getVisionInputChoices().map((choice) => ({
			id: choice.enabled ? "enabled" : "disabled",
			label: choice.label,
			kinds: choice.kinds,
		}));
		const choice = await showOptionPicker(ctx, t("视觉支持"), choices, supportsVisionInput(draft.inputKinds) ? "enabled" : "disabled");
		if (choice) draft.inputKinds = [...choice.kinds];
		return;
	}
	if (fieldId === "reasoning") {
		const choice = await showOptionPicker(
			ctx,
			"Thinking",
			[
				{ id: "disabled" as ReasoningMode, label: t("关闭 — 不发送模型推理参数") },
				{ id: "enabled" as ReasoningMode, label: t("开启 — 启用模型推理参数") },
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
				{ id: "adaptive" as AnthropicThinkingProtocol, label: t("开启：新版模型，发送 thinking.type=adaptive 和 output_config.effort") },
				{ id: "legacy" as AnthropicThinkingProtocol, label: t("关闭：旧版接口，发送 thinking.type=enabled 和 budget_tokens") },
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
				{ id: "disabled", tier: undefined, label: t("关闭 — 不发送 service_tier（默认）") },
				{ id: "priority", tier: "priority", label: t("开启 — service_tier=priority，可能消耗 Fast / priority 额度") },
			] as const satisfies readonly { id: string; tier: ModelDraft["openAIServiceTier"]; label: string }[],
			draft.openAIServiceTier === "priority" ? "priority" : "disabled",
		);
		if (choice) draft.openAIServiceTier = choice.tier;
		return;
	}
	if (fieldId === "contextWindow" || fieldId === "maxTokens") {
		await editIntField(ctx, draft, fieldId);
		return;
	}
	if (fieldId === "promptCacheShort" || fieldId === "promptCacheLong") {
		await editPromptCacheField(ctx, draft, fieldId === "promptCacheShort" ? "short" : "long");
		return;
	}
	if (fieldId === "inputLimits") {
		const outcome = await editJsonObjectField(
			ctx,
			t("图片与请求限制"),
			draft.inputLimits,
			t("inputLimits 常用键：images.resize（maxWidth/maxHeight/maxBytes/jpegQuality）、maxRequestBytes、images.maxPerMessage / maxPerRequest；示例：{example}", { example: INPUT_LIMITS_EXAMPLE }),
		);
		if (outcome.action === "save") draft.inputLimits = outcome.value as ModelInputLimits | undefined;
		return;
	}
	if (fieldId === "compat") {
		const outcome = await editJsonObjectField(
			ctx,
			t("高级 compat"),
			draft.compat,
			getFieldDetailLines(draft, "compat").join(" "),
		);
		if (outcome.action === "save") draft.compat = outcome.value;
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
					t("接入 {providerId} · API {api}", { providerId: draft.providerId, api: formatApiShort(draft.api) }),
					t("Ctrl+S 保存并启用模型；不切换当前会话模型"),
				],
				getDetailLines: (selectedRow, theme) =>
					getFieldDetailLines(draft, selectedRow?.id ?? "").map((line) => theme.fg("dim", `  ${line}`)),
				onAdjust: (id) => {
					if (!applyHorizontalToggle(draft, id)) return undefined;
					return toMenuRows(buildRows(draft));
				},
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "←→", label: t("切换选项") },
					{ key: "Enter", label: t("编辑") },
					{ key: "Ctrl+S", label: t("保存并启用") },
					{ key: "Esc", label: t("返回") },
				],
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		await editField(ctx, draft, action.id, requestHeaderProfiles, clientHeaderCaptures);
	}
}
