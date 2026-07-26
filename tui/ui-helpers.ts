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

function authIcon(apiKey: string | undefined): string {
	const status = getAuthStatusText(apiKey);
	if (status === "no apiKey") return "?";
	if (status === "command apiKey") return "$";
	if (status.startsWith("env missing:")) return "⚠";
	if (status.startsWith("env ")) return "✓";
	return "•";
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

export function joinFixedColumns(columns: readonly FixedColumn[], gap = "  "): string {
	return columns.map((column) => fitColumn(column.text, column.width, column.align)).join(gap).trimEnd();
}

export function formatTableHeader(line: string): string {
	return `  ${line}`;
}

function sanitizeEndpoint(value: string): string {
	return value.replace(/([?&](?:key|api_key|api-key)=)[^&]+/gi, "$1REDACTED");
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

export function formatProviderHeaderProfile(
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

export const PROVIDER_CONSOLE_HEADER = formatTableHeader(joinFixedColumns([
	{ text: "接入", width: 22 },
	{ text: "API", width: 9 },
	{ text: "模型", width: 6, align: "right" },
	{ text: "请求头", width: 15 },
	{ text: "代理", width: 6 },
	{ text: "认证", width: 6 },
	{ text: "状态", width: 5 },
]));

function getModelListColumns(provider: StoredProvider): FixedColumn[] {
	const columns: FixedColumn[] = [
		{ text: "模型 ID", width: 30 },
		{ text: "显示名", width: 16 },
		{ text: "输入", width: 10 },
		{ text: "Thinking", width: 8 },
		{ text: "上下文", width: 7, align: "right" },
		{ text: "输出", width: 7, align: "right" },
	];
	if (provider.api === "openai-responses") columns.push({ text: "Fast", width: 8 });
	return columns;
}

export function formatModelListHeader(provider: StoredProvider): string {
	return formatTableHeader(joinFixedColumns(getModelListColumns(provider)));
}

export function formatProviderConsoleRow(
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string {
	const name = getProviderDisplayName(providerId, provider);
	const displayName = name === providerId ? providerId : `${name} (${providerId})`;
	return joinFixedColumns([
		{ text: displayName, width: 22 },
		{ text: formatApiShort(provider.api), width: 9 },
		{ text: String(provider.models.length), width: 6, align: "right" },
		{ text: formatProviderHeaderProfile(provider, requestHeaderProfiles), width: 15 },
		{ text: getProviderProxyText(provider), width: 6 },
		{ text: getAuthKind(provider.apiKey), width: 6 },
		{ text: getProviderStatus(provider), width: 5 },
	]);
}
export function formatProviderRow(providerId: string, provider: StoredProvider): string {
	const name = getProviderDisplayName(providerId, provider);
	const head = name === providerId ? providerId : `${name} (${providerId})`;
	return `${head} · ${provider.api} · ${provider.models.length}模型 · ${authIcon(provider.apiKey)}`;
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
		`  endpoint  ${sanitizeEndpoint(provider.baseUrl)}`,
		`  proxy     ${provider.httpProxyEnabled ? sanitizeEndpoint(provider.httpProxyUrl ?? "http://127.0.0.1:7890") : "direct"}`,
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
	const proxy = provider.httpProxyEnabled ? ` · proxy ${sanitizeEndpoint(provider.httpProxyUrl ?? "http://127.0.0.1:7890")}` : "";
	return `endpoint  ${sanitizeEndpoint(provider.baseUrl)}${proxy}`;
}

function getThinkingFlag(model: StoredModel): string | undefined {
	if (!model.reasoning) return undefined;
	const map = model.thinkingLevelMap;
	if (map?.max === "max" && map.xhigh === "xhigh") return "think:xhigh/max";
	if (map?.max === "max") return "think:max";
	return "think";
}

export function formatModelRow(model: StoredModel): string {
	const flags: string[] = [];
	const thinkingFlag = getThinkingFlag(model);
	if (thinkingFlag) flags.push(thinkingFlag);
	flags.push(model.input.includes("image") ? "视觉" : "文本");
	flags.push(`${formatContextWindow(model.contextWindow)}ctx`);
	const suffix = model.name && model.name !== model.id ? ` “${model.name}”` : "";
	return `${model.id}${suffix} · ${flags.join(" · ")}`;
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

export function formatModelConsoleRow(model: StoredModel): string {
	return joinFixedColumns([
		{ text: model.id, width: 34 },
		{ text: formatModelInputCell(model), width: 12 },
		{ text: formatModelThinkingCell(model), width: 8 },
		{ text: formatContextWindow(model.contextWindow), width: 7, align: "right" },
		{ text: formatContextWindow(model.maxTokens), width: 7, align: "right" },
		{ text: model.openAIServiceTier === "priority" ? "priority" : "-", width: 8 },
	]);
}

export function formatModelListRow(provider: StoredProvider, model: StoredModel): string {
	const columns: FixedColumn[] = [
		{ text: model.id, width: 30 },
		{ text: formatModelNameCell(model), width: 16 },
		{ text: formatModelInputCell(model), width: 10 },
		{ text: formatModelThinkingCell(model), width: 8 },
		{ text: formatContextWindow(model.contextWindow), width: 7, align: "right" },
		{ text: formatContextWindow(model.maxTokens), width: 7, align: "right" },
	];
	if (provider.api === "openai-responses") {
		columns.push({ text: model.openAIServiceTier === "priority" ? "priority" : "off", width: 8 });
	}
	return joinFixedColumns(columns);
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
