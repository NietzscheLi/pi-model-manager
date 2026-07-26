// tui/editor-provider.ts
//
// 接入编辑器：问答式表单（custom menu + input/select 拼装）。
// 用户可以反复编辑字段；Ctrl+S 保存，Esc 返回。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasStringRecordEntries } from "../common.ts";
import { findPresetForApi } from "../presets/providers.ts";
import { DEFAULT_PROVIDER_HTTP_PROXY_URL } from "../types.ts";
import { showPersistentFormMenu, padLabel, type HorizontalDirection, type MenuCursor } from "./persistent-menu.ts";
import {
	API_CHOICES,
	BUILT_IN_PROFILE_CHOICES,
	describeProfile,
	formatApiShort,
	maskSecret,
} from "./ui-helpers.ts";
import type { ClientHeaderProfileId, ProviderDraft, StoredRequestHeaderProfile } from "../types.ts";

interface FieldRow {
	id: string;
	label: string;
	value: string;
}

function buildRows(
	draft: ProviderDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): FieldRow[] {
	const inlineCustomProfile = draft.clientHeaderProfile === "custom"
		&& !draft.requestHeaderProfileId
		&& hasStringRecordEntries(draft.customClientHeaders);
	const profileDisplay = inlineCustomProfile
		? `内联自定义请求头（${Object.keys(draft.customClientHeaders).length}项）`
		: describeProfile(draft.clientHeaderProfile, draft.api, draft.requestHeaderProfileId, requestHeaderProfiles);
	return [
		{ id: "api", label: "API 协议", value: draft.api },
		{ id: "providerId", label: "接入 ID（必填）", value: draft.providerId || "<必填>" },
		{ id: "providerName", label: "名称", value: draft.providerName || "<空>" },
		{ id: "baseUrl", label: "Base URL", value: draft.baseUrl },
		{ id: "httpProxyEnabled", label: "本机代理", value: draft.httpProxyEnabled ? "开启" : "关闭" },
		{ id: "httpProxyUrl", label: "代理地址", value: draft.httpProxyEnabled ? (draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL) : "关闭时不使用" },
		{ id: "apiKey", label: "API key", value: maskSecret(draft.apiKey) },
		{ id: "authHeader", label: "认证头", value: draft.authHeader ? "Bearer" : "默认" },
		{ id: "clientHeaderProfile", label: "请求头", value: profileDisplay },
	];
}

async function selectChoice<T extends { id: string; label: string }>(
	ctx: ExtensionCommandContext,
	title: string,
	choices: T[],
	currentId: string,
): Promise<T | undefined> {
	const labels = choices.map((c) => c.id === currentId ? `${c.label}  ← 当前` : c.label);
	const picked = await ctx.ui.select(title, labels);
	if (!picked) return undefined;
	const index = labels.indexOf(picked);
	return index >= 0 ? choices[index] : undefined;
}

function cycleSwitchState(current: boolean, direction: HorizontalDirection): boolean {
	const states = [false, true];
	const currentIndex = current ? 1 : 0;
	const delta = direction === "right" ? 1 : -1;
	return states[(currentIndex + delta + states.length) % states.length]!;
}

function applyHorizontalToggle(draft: ProviderDraft, fieldId: string, direction: HorizontalDirection): boolean {
	if (fieldId !== "httpProxyEnabled") return false;
	draft.httpProxyEnabled = cycleSwitchState(draft.httpProxyEnabled, direction);
	if (draft.httpProxyEnabled && !draft.httpProxyUrl.trim()) draft.httpProxyUrl = DEFAULT_PROVIDER_HTTP_PROXY_URL;
	return true;
}

async function editClientHeaderProfile(
	ctx: ExtensionCommandContext,
	draft: ProviderDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Promise<void> {
	const choices = [
		...BUILT_IN_PROFILE_CHOICES.map((choice) => ({
			id: choice.id,
			label: draft.clientHeaderProfile === choice.id ? `${choice.label}  ← 当前` : choice.label,
		})),
		...Object.entries(requestHeaderProfiles)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([profileId, profile]) => ({
				id: `custom:${profileId}`,
				label: draft.clientHeaderProfile === "custom" && draft.requestHeaderProfileId === profileId
					? `自定义:${profileId} — ${profile.name}  ← 当前`
					: `自定义:${profileId} — ${profile.name}`,
			})),
	];
	const picked = await ctx.ui.select("请求头", choices.map((choice) => choice.label));
	if (!picked) return;
	const choice = choices.find((candidate) => candidate.label === picked);
	if (!choice) return;
	if (choice.id.startsWith("custom:")) {
		draft.clientHeaderProfile = "custom";
		draft.requestHeaderProfileId = choice.id.slice("custom:".length);
		return;
	}
	draft.clientHeaderProfile = choice.id as ClientHeaderProfileId;
	delete draft.requestHeaderProfileId;
}

async function editField(
	ctx: ExtensionCommandContext,
	draft: ProviderDraft,
	fieldId: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Promise<void> {
	if (fieldId === "api") {
		const choice = await selectChoice(ctx, "选择 API 协议", API_CHOICES, draft.api);
		if (choice) {
			draft.api = choice.id;
			const preset = findPresetForApi(draft.api);
			if (!draft.baseUrl.trim()) draft.baseUrl = preset.baseUrl;
		}
		return;
	}
	if (fieldId === "authHeader") {
		const choice = await ctx.ui.select("认证头（API key 放在哪里）", [
			"默认 — 交给协议 SDK / 接入默认行为",
			"Bearer — 强制 Authorization: Bearer <apiKey>",
		]);
		if (choice) draft.authHeader = choice.startsWith("Bearer");
		return;
	}
	if (fieldId === "clientHeaderProfile") {
		await editClientHeaderProfile(ctx, draft, requestHeaderProfiles);
		return;
	}
	if (fieldId === "httpProxyEnabled") {
		const choice = await ctx.ui.select("本机代理（仅当前接入点）", [
			"关闭 — 请求直连上游",
			`开启 — 通过 ${draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL}`,
		]);
		if (!choice) return;
		draft.httpProxyEnabled = choice.startsWith("开启");
		if (draft.httpProxyEnabled && !draft.httpProxyUrl.trim()) draft.httpProxyUrl = DEFAULT_PROVIDER_HTTP_PROXY_URL;
		return;
	}
	if (fieldId === "providerId") {
		const value = await ctx.ui.input(
			`接入 ID（必填，最多 48 个字符；仅字母、数字、点、下划线和连字符；当前：${draft.providerId || "<空>"}）`,
			draft.providerId,
		);
		if (value !== undefined) draft.providerId = value.trim();
		return;
	}
	if (fieldId === "providerName") {
		const value = await ctx.ui.input(`名称（显示用，可留空；当前：${draft.providerName || "<空>"}）`, draft.providerName);
		if (value !== undefined) draft.providerName = value.trim();
		return;
	}
	if (fieldId === "apiKey") {
		const currentLabel = draft.apiKey ? maskSecret(draft.apiKey) : "<空>";
		const value = await ctx.ui.input(`API key（可选；明文 / $ENV_VAR / !command；当前：${currentLabel}，留空清除）`, "");
		if (value === undefined) return;
		draft.apiKey = value.trim();
		return;
	}
	const prompt = ({
		baseUrl: "Base URL（http/https）",
		httpProxyUrl: "代理地址（http://host:port 或 https://host:port）",
		apiKey: "API key（可选；明文 / $ENV_VAR / !command）",
	} as Record<string, string>)[fieldId];
	const current = (draft as any)[fieldId] as string;
	const value = await ctx.ui.input(`${prompt ?? fieldId}（当前：${current || "<空>"}，留空保持原值）`, current);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	(draft as any)[fieldId] = trimmed;
}

export type ProviderEditOutcome =
	| { action: "save"; draft: ProviderDraft }
	| { action: "cancel" };

export async function editProvider(
	ctx: ExtensionCommandContext,
	draft: ProviderDraft,
	titlePrefix: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): Promise<ProviderEditOutcome> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows = buildRows(draft, requestHeaderProfiles);
		const menuRows = rows.map((r) => ({
			id: r.id,
			label: `${padLabel(r.label, 16)}${r.value}`,
		}));
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				adjustableRowIds: ["httpProxyEnabled"],
				summaryLines: [
					`API ${formatApiShort(draft.api)} · 请求头 ${describeProfile(draft.clientHeaderProfile, draft.api, draft.requestHeaderProfileId, requestHeaderProfiles)}`,
					"接入 ID 必填，且不能与已有或 pi 内置接入重复",
					"Ctrl+S 保存并同步 models.json；不切换当前会话模型",
				],
				footer: "↑↓ 选择   ←→ 切换选项   Enter 编辑   Ctrl+S 保存并同步   Esc 返回",
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		if (action.type === "adjust") {
			applyHorizontalToggle(draft, action.id, action.direction);
			continue;
		}
		await editField(ctx, draft, action.id, requestHeaderProfiles);
	}
}
