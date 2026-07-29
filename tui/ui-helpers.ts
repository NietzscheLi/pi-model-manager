// tui/ui-helpers.ts
//
// 共用展示助手：把 stored / draft 数据格式化成 UI 字符串。
//
// dashboard 行设计准则：信息密度千万不要满。
//   - 主列表使用固定列 + 选中详情；行内只放扫描所需信息
//   - api 用短标签（Responses / Claude），详情区再显示完整上下文
//   - auth 状态文本化为 key/env/cmd/auth?，避免把可选的外部认证误报成缺失
//   - contextWindow 用 K/M 简写

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getApiKeyEnvVarName, getAuthStatusText, getProviderDisplayName } from "../state-document.ts";
import { CLIENT_HEADER_PROFILE_LABELS, getClientHeaderProfileDisplay, resolveClientHeaderProfile } from "../presets/client-headers.ts";
import { redactUrlForDisplay } from "../sensitive-redaction.ts";
import type {
	ApiKind,
	ClientHeaderProfileId,
	ModelInputKind,
	StoredModel,
	StoredProvider,
	StoredRequestHeaderProfile,
} from "../types.ts";

export function maskSecret(value: string | undefined): string {
	if (!value) return "<未填写>";
	if (getApiKeyEnvVarName(value) || value.startsWith("!")) return value;
	return "********";
}
function formatContextWindow(contextWindow: number): string {
	if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(contextWindow % 1_000_000 === 0 ? 0 : 1)}M`;
	if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K`;
	return String(contextWindow);
}


type ColumnAlign = "left" | "right";

interface FixedColumn {
	text: string;
	width: number;
	align?: ColumnAlign;
}

export function fitColumn(text: string, columns: number, align: ColumnAlign = "left"): string {
	const clipped = truncateToWidth(text, columns, "…");
	const pad = " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
	return align === "right" ? pad + clipped : clipped + pad;
}

function joinFixedColumns(columns: readonly FixedColumn[], gap = "  "): string {
	return columns.map((column) => fitColumn(column.text, column.width, column.align)).join(gap).trimEnd();
}

function formatTableHeader(line: string): string {
	return `  ${line}`;
}

export function formatApiShort(api: ApiKind): string {
	if (api === "openai-responses") return "Responses";
	if (api === "openai-completions") return "Chat";
	if (api === "anthropic-messages") return "Claude";
	if (api === "google-generative-ai") return "Gemini";
	return api;
}

function getAuthKind(apiKey: string | undefined): string {
	const status = getAuthStatusText(apiKey);
	if (status === "no apiKey") return "auth?";
	if (status === "command apiKey") return "cmd";
	if (status.startsWith("env missing:")) return "miss";
	if (status.startsWith("env ")) return "env";
	return "key";
}

function getProviderStatus(provider: StoredProvider): string {
	const auth = getAuthKind(provider.apiKey);
	return auth === "miss" || auth === "auth?" ? "check" : "ready";
}

function getProviderProxyText(provider: StoredProvider): string {
	return provider.httpProxyEnabled ? "proxy" : "direct";
}

function formatProviderHeaderProfile(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string {
	if (provider.clientHeaderProfile === "recommended") {
		const resolved = resolveClientHeaderProfile(provider.clientHeaderProfile, provider.api);
		return `Auto→${CLIENT_HEADER_PROFILE_LABELS[resolved]}`;
	}
	if (provider.clientHeaderProfile === "disabled") return "Off";
	if (provider.clientHeaderProfile === "custom") {
		if (provider.requestHeaderProfileId) {
			const profile = requestHeaderProfiles[provider.requestHeaderProfileId];
			return profile ? `Custom:${profile.name}` : `Custom:${provider.requestHeaderProfileId}`;
		}
		const inlineCount = Object.keys(provider.customClientHeaders ?? {}).length;
		return inlineCount > 0 ? `Inline(${inlineCount})` : "Custom?";
	}
	return CLIENT_HEADER_PROFILE_LABELS[provider.clientHeaderProfile];
}

interface ProviderConsoleCells {
	provider: string;
	api: string;
	models: string;
	headers: string;
	proxy: string;
	auth: string;
	status: string;
}

function getProviderConsoleColumns(cells: ProviderConsoleCells, availableWidth: number): FixedColumn[] {
	if (availableWidth >= 81) {
		return [
			{ text: cells.provider, width: 22 },
			{ text: cells.api, width: 9 },
			{ text: cells.models, width: 6, align: "right" },
			{ text: cells.headers, width: 15 },
			{ text: cells.proxy, width: 6 },
			{ text: cells.auth, width: 6 },
			{ text: cells.status, width: 5 },
		];
	}
	if (availableWidth >= 64) {
		return [
			{ text: cells.provider, width: 20 },
			{ text: cells.api, width: 9 },
			{ text: cells.models, width: 6, align: "right" },
			{ text: cells.proxy, width: 6 },
			{ text: cells.auth, width: 6 },
			{ text: cells.status, width: 5 },
		];
	}
	if (availableWidth >= 48) {
		return [
			{ text: cells.provider, width: 20 },
			{ text: cells.api, width: 9 },
			{ text: cells.models, width: 6, align: "right" },
			{ text: cells.status, width: 5 },
		];
	}
	return [
		{ text: cells.provider, width: Math.max(10, availableWidth - 26) },
		{ text: cells.api, width: 9 },
		{ text: cells.models, width: 6, align: "right" },
		{ text: cells.status, width: 5 },
	];
}

export function formatProviderConsoleHeader(menuWidth: number): string {
	return formatTableHeader(joinFixedColumns(getProviderConsoleColumns({
		provider: "接入",
		api: "API",
		models: "模型",
		headers: "请求头",
		proxy: "代理",
		auth: "认证",
		status: "状态",
	}, Math.max(0, menuWidth - 2))));
}

export function formatProviderConsoleRow(
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	availableWidth = 81,
): string {
	const name = getProviderDisplayName(providerId, provider);
	const displayName = name === providerId ? providerId : `${name} (${providerId})`;
	return joinFixedColumns(getProviderConsoleColumns({
		provider: displayName,
		api: formatApiShort(provider.api),
		models: String(provider.models.length),
		headers: formatProviderHeaderProfile(provider, requestHeaderProfiles),
		proxy: getProviderProxyText(provider),
		auth: getAuthKind(provider.apiKey),
		status: getProviderStatus(provider),
	}, availableWidth));
}

export function formatProviderDetailLines(
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string[] {
	const name = getProviderDisplayName(providerId, provider);
	const title = name === providerId ? providerId : `${name} (${providerId})`;
	const modelIds = provider.models.map((model) => model.id).join(", ") || "<无模型>";
	return [
		title,
		`  endpoint  ${redactUrlForDisplay(provider.baseUrl)}`,
		`  proxy     ${provider.httpProxyEnabled ? redactUrlForDisplay(provider.httpProxyUrl ?? "http://127.0.0.1:7890") : "direct"}`,
		`  api       ${formatApiShort(provider.api)} · headers ${formatProviderHeaderProfile(provider, requestHeaderProfiles)} · auth ${getAuthKind(provider.apiKey)}`,
		`  models    ${modelIds}`,
	];
}

export function formatProviderSummaryLine(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string {
	return `${formatApiShort(provider.api)} · ${provider.models.length} 模型 · headers ${formatProviderHeaderProfile(provider, requestHeaderProfiles)} · proxy ${getProviderProxyText(provider)} · auth ${getAuthKind(provider.apiKey)}`;
}

export function formatProviderEndpointLine(provider: StoredProvider): string {
	const proxy = provider.httpProxyEnabled ? ` · proxy ${redactUrlForDisplay(provider.httpProxyUrl ?? "http://127.0.0.1:7890")}` : "";
	return `endpoint  ${redactUrlForDisplay(provider.baseUrl)}${proxy}`;
}

function formatModelNameCell(model: StoredModel): string {
	return model.name && model.name !== model.id ? model.name : "默认";
}

function formatModelInputCell(model: StoredModel): string {
	return model.input.includes("image") ? "文本,视觉" : "文本";
}

function formatModelThinkingCell(model: StoredModel): string {
	return model.reasoning ? "开" : "关";
}

interface ModelListCells {
	modelId: string;
	name: string;
	input: string;
	thinking: string;
	context: string;
	output: string;
	fast: string;
}

function getModelListColumns(provider: StoredProvider, cells: ModelListCells, availableWidth: number): FixedColumn[] {
	const fullWidth = provider.api === "openai-responses" ? 98 : 88;
	if (availableWidth >= fullWidth) {
		const columns: FixedColumn[] = [
			{ text: cells.modelId, width: 30 },
			{ text: cells.name, width: 16 },
			{ text: cells.input, width: 10 },
			{ text: cells.thinking, width: 8 },
			{ text: cells.context, width: 7, align: "right" },
			{ text: cells.output, width: 7, align: "right" },
		];
		if (provider.api === "openai-responses") columns.push({ text: cells.fast, width: 8 });
		return columns;
	}
	if (availableWidth >= 75) {
		return [
			{ text: cells.modelId, width: 28 },
			{ text: cells.name, width: 14 },
			{ text: cells.input, width: 10 },
			{ text: cells.thinking, width: 8 },
			{ text: cells.context, width: 7, align: "right" },
		];
	}
	if (availableWidth >= 57) {
		return [
			{ text: cells.modelId, width: 26 },
			{ text: cells.input, width: 10 },
			{ text: cells.thinking, width: 8 },
			{ text: cells.context, width: 7, align: "right" },
		];
	}
	return [
		{ text: cells.modelId, width: Math.max(10, availableWidth - 22) },
		{ text: cells.input, width: 10 },
		{ text: cells.thinking, width: 8 },
	];
}

function getModelListCells(model?: StoredModel): ModelListCells {
	return model
		? {
			modelId: model.id,
			name: formatModelNameCell(model),
			input: formatModelInputCell(model),
			thinking: formatModelThinkingCell(model),
			context: formatContextWindow(model.contextWindow),
			output: formatContextWindow(model.maxTokens),
			fast: model.openAIServiceTier === "priority" ? "priority" : "off",
		}
		: {
			modelId: "模型 ID",
			name: "显示名",
			input: "输入",
			thinking: "Thinking",
			context: "上下文",
			output: "输出",
			fast: "Fast",
		};
}

export function formatModelListHeader(provider: StoredProvider, menuWidth = 100): string {
	return formatTableHeader(joinFixedColumns(getModelListColumns(provider, getModelListCells(), Math.max(0, menuWidth - 2))));
}

export function formatModelListRow(provider: StoredProvider, model: StoredModel, availableWidth = 98): string {
	return joinFixedColumns(getModelListColumns(provider, getModelListCells(model), availableWidth));
}

export const API_CHOICES: { id: ApiKind; label: string }[] = [
	{ id: "openai-responses", label: "OpenAI Responses · 标准 instructions/input wire" },
	{ id: "openai-completions", label: "OpenAI Chat · 传统 chat/completions 兼容" },
	{ id: "anthropic-messages", label: "Anthropic Messages · Claude / Claude Code 兼容" },
	{ id: "google-generative-ai", label: "Google Gemini · Gemini 原生 API" },
];

export const BUILT_IN_PROFILE_CHOICES: { id: Exclude<ClientHeaderProfileId, "custom">; label: string }[] = [
	{ id: "recommended", label: "自动推荐" },
	{ id: "disabled", label: "不添加" },
	{ id: "claude-code", label: "ClaudeCode" },
	{ id: "codex-cli", label: "Codex" },
];

export function describeProfile(
	profile: ClientHeaderProfileId,
	api: ApiKind,
	requestHeaderProfileId?: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string {
	if (profile !== "custom") return getClientHeaderProfileDisplay(profile, api);
	if (!requestHeaderProfileId) return "自定义请求头（未选择）";
	const selected = requestHeaderProfiles[requestHeaderProfileId];
	return selected ? `${selected.name} (${requestHeaderProfileId})` : `自定义请求头缺失：${requestHeaderProfileId}`;
}

export const VISION_INPUT_CHOICES: { enabled: boolean; kinds: ModelInputKind[]; label: string }[] = [
	{ enabled: false, kinds: ["text"], label: "关闭 — 仅文本输入" },
	{ enabled: true, kinds: ["text", "image"], label: "开启 — 支持视觉（文本 + 图片）" },
];

export function supportsVisionInput(kinds: ModelInputKind[]): boolean {
	return kinds.includes("image");
}

export function describeVisionInput(kinds: ModelInputKind[]): string {
	return supportsVisionInput(kinds) ? "开启 · 支持视觉" : "关闭 · 仅文本";
}
