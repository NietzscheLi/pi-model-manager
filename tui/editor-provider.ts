// tui/editor-provider.ts
//
// 接入编辑器：问答式表单（custom menu + input/select 拼装）。
// 用户可以反复编辑字段；Ctrl+S 保存，Esc 返回。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasStringRecordEntries } from "../common.ts";
import { switchProviderDraftApiPreset } from "../presets/providers.ts";
import { redactUrlForDisplay } from "../sensitive-redaction.ts";
import { resolveRuntimeBaseUrl } from "../runtime-base-url.ts";
import { DEFAULT_PROVIDER_HTTP_PROXY_URL } from "../types.ts";
import { showOptionPicker, showPersistentFormMenu, padLabel, type MenuCursor } from "./persistent-menu.ts";
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
	// 开关类字段可用 ←→ 就地切换；其余字段需要 Enter 进入输入或选择器。
	adjustable?: boolean;
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
		{ id: "httpProxyEnabled", label: "本机代理", value: draft.httpProxyEnabled ? "开启" : "关闭", adjustable: true },
		{ id: "httpProxyUrl", label: "代理地址", value: draft.httpProxyEnabled ? redactUrlForDisplay(draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL) : "关闭时不使用" },
		{ id: "apiKey", label: "API key", value: maskSecret(draft.apiKey) },
		{ id: "authHeader", label: "认证头", value: draft.authHeader ? "Bearer" : "默认" },
		{ id: "clientHeaderProfile", label: "请求头", value: profileDisplay },
	];
}



// 开关字段在两个方向上都是取反，因此不看 direction；返回是否真的切换了字段。
function applyHorizontalToggle(draft: ProviderDraft, fieldId: string): boolean {
	if (fieldId !== "httpProxyEnabled") return false;
	draft.httpProxyEnabled = !draft.httpProxyEnabled;
	if (draft.httpProxyEnabled && !draft.httpProxyUrl.trim()) draft.httpProxyUrl = DEFAULT_PROVIDER_HTTP_PROXY_URL;
	return true;
}

async function editClientHeaderProfile(
	ctx: ExtensionCommandContext,
	draft: ProviderDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Promise<void> {
	const choices = [
		...BUILT_IN_PROFILE_CHOICES.map((choice) => ({ id: choice.id as string, label: choice.label })),
		...Object.entries(requestHeaderProfiles)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([profileId, profile]) => ({
				id: `custom:${profileId}`,
				label: `自定义:${profileId} — ${profile.name}`,
			})),
	];
	const currentId = draft.clientHeaderProfile === "custom" && draft.requestHeaderProfileId
		? `custom:${draft.requestHeaderProfileId}`
		: draft.clientHeaderProfile;
	const choice = await showOptionPicker(ctx, "请求头", choices, currentId);
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
		const choice = await showOptionPicker(ctx, "选择 API 协议", API_CHOICES, draft.api);
		if (choice) switchProviderDraftApiPreset(draft, choice.id);
		return;
	}
	if (fieldId === "authHeader") {
		const choice = await showOptionPicker(
			ctx,
			"认证头（API key 放在哪里）",
			[
				{ id: "default", label: "默认 — 交给协议 SDK / 接入默认行为" },
				{ id: "bearer", label: "Bearer — 强制 Authorization: Bearer <apiKey>" },
			],
			draft.authHeader ? "bearer" : "default",
		);
		if (choice) draft.authHeader = choice.id === "bearer";
		return;
	}
	if (fieldId === "clientHeaderProfile") {
		await editClientHeaderProfile(ctx, draft, requestHeaderProfiles);
		return;
	}
	if (fieldId === "httpProxyEnabled") {
		const choice = await showOptionPicker(
			ctx,
			"本机代理（仅当前接入点）",
			[
				{ id: "disabled", label: "关闭 — 请求直连上游" },
				{ id: "enabled", label: `开启 — 通过 ${redactUrlForDisplay(draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL)}` },
			],
			draft.httpProxyEnabled ? "enabled" : "disabled",
		);
		if (!choice) return;
		draft.httpProxyEnabled = choice.id === "enabled";
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
	if (fieldId === "httpProxyUrl") {
		const currentLabel = redactUrlForDisplay(draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL);
		const value = await ctx.ui.input(`代理地址（http/https；当前：${currentLabel}，留空保持原值）`, "");
		if (value?.trim()) draft.httpProxyUrl = value.trim();
		return;
	}
	if (fieldId === "apiKey") {
		const currentLabel = draft.apiKey ? maskSecret(draft.apiKey) : "<空>";
		const value = await ctx.ui.input(`API key（可选；明文 / $ENV_VAR / !command；当前：${currentLabel}，留空清除）`, "");
		if (value === undefined) return;
		draft.apiKey = value.trim();
		return;
	}
	// [喵喵喵]: baseUrl 是唯一走通用文本输入的字段，显式列出才能保持 draft 的类型检查。
	if (fieldId !== "baseUrl") return;
	const value = await ctx.ui.input(`Base URL（http/https）（当前：${draft.baseUrl || "<空>"}，留空保持原值）`, draft.baseUrl);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	// [喵喵喵]: 当场归一化成 SDK 可直接使用的根地址，让 models.json 存的就是最终请求地址；
	// 否则插件未加载时 pi 会用未补全的值直接请求，补全结果也无法在界面上核对。
	draft.baseUrl = resolveRuntimeBaseUrl(draft.api, trimmed);
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
		// [喵喵喵]: 字段行的排版在开关切换后要原样重建，抽成函数避免两处写法飘移。
		const toMenuRows = (fieldRows: FieldRow[]) => fieldRows.map((row) => ({
			id: row.id,
			label: `${padLabel(row.label, 16)}${row.value}`,
			adjustable: row.adjustable,
		}));
		const rows = buildRows(draft, requestHeaderProfiles);
		const menuRows = toMenuRows(rows);
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				summaryLines: [
					`API ${formatApiShort(draft.api)} · 请求头 ${describeProfile(draft.clientHeaderProfile, draft.api, draft.requestHeaderProfileId, requestHeaderProfiles)}`,
					"接入 ID 必填，且不能与已有或 pi 内置接入重复",
					"Ctrl+S 保存并同步 models.json；不切换当前会话模型",
				],
				onAdjust: (id) => {
					if (!applyHorizontalToggle(draft, id)) return undefined;
					return toMenuRows(buildRows(draft, requestHeaderProfiles));
				},
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "←→", label: "切换选项" },
					{ key: "Enter", label: "编辑" },
					{ key: "Ctrl+S", label: "保存并同步" },
					{ key: "Esc", label: "返回" },
				],
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		await editField(ctx, draft, action.id, requestHeaderProfiles);
	}
}
