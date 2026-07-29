// tui/header-profiles-panel.ts
//
// 管理可复用的客户端请求头。接入编辑器只选择已存在的请求头，
// 不在模型内部新增一次性 JSON，避免配置分散。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError, parseStringRecordJson } from "../common.ts";
import { deleteRequestHeaderProfileConfiguration, saveRequestHeaderProfileConfiguration } from "../header-profile-mutations.ts";
import { CLAUDE_CODE_CLIENT_HEADERS, CODEX_CLI_CLIENT_HEADERS } from "../presets/builtin-client-headers.ts";
import {
	countModelsUsingRequestHeaderProfile,
	createRequestHeaderProfileDraft,
	createRequestHeaderProfileDraftFromStored,
	validateRequestHeaderProfileDraft,
} from "../state-document.ts";
import { readState } from "../state-store.ts";
import type { RequestHeaderProfileDraft, StoredClientHeaderCapture, StoredRequestHeaderProfile } from "../types.ts";
import { padLabel, showPersistentFormMenu, showPersistentShortcutMenu, type MenuCursor } from "./persistent-menu.ts";
import { fitColumn } from "./ui-helpers.ts";

interface ProfileRow {
	profileId: string;
	label: string;
}

interface FieldRow {
	id: string;
	label: string;
	value: string;
}

interface HeaderTemplate {
	id: string;
	label: string;
	description: string;
	headers: Record<string, string>;
}

const HEADER_TEMPLATES: HeaderTemplate[] = [
	{
		id: "codex-cli",
		label: "Codex",
		description: "OpenAI 兼容端点使用的终端 Codex TUI 请求头。",
		headers: CODEX_CLI_CLIENT_HEADERS,
	},
	{
		id: "claude-code",
		label: "ClaudeCode",
		description: "Anthropic 兼容端点常用的 ClaudeCode 请求头。",
		headers: CLAUDE_CODE_CLIENT_HEADERS,
	},
	{
		id: "empty",
		label: "清空",
		description: "清空当前请求头，重新手动填写。",
		headers: {},
	},
];

function buildRows(profileIds: string[]): ProfileRow[] {
	return profileIds.map((profileId) => ({ profileId, label: "" }));
}

function formatCapturedAt(capturedAt: string): string {
	return capturedAt.replace("T", " ").replace(/\.\d{3}Z$/, "Z").slice(0, 19);
}

function formatCaptureLine(label: string, capture: StoredClientHeaderCapture | undefined): string {
	if (!capture) return `  ${padLabel(label, 12)} 未抓包`;
	return `  ${padLabel(label, 12)} 已抓包 ${formatCapturedAt(capture.capturedAt)} · ${Object.keys(capture.headers).length} headers`;
}

interface ProfileTableCells {
	profileId: string;
	headers: string;
	used: string;
	name: string;
}

function formatProfileTableRow(cells: ProfileTableCells, availableWidth: number): string {
	if (availableWidth >= 64) {
		return [
			fitColumn(cells.profileId, 22),
			fitColumn(cells.headers, 12),
			fitColumn(cells.used, 10),
			fitColumn(cells.name, Math.max(10, availableWidth - 47)),
		].join(" ");
	}
	if (availableWidth >= 46) {
		return [fitColumn(cells.profileId, 22), fitColumn(cells.headers, 12), fitColumn(cells.used, 10)].join(" ");
	}
	if (availableWidth >= 33) {
		return [fitColumn(cells.profileId, 20), fitColumn(cells.headers, 12)].join(" ");
	}
	return [
		fitColumn(cells.profileId, Math.max(8, availableWidth - 11)),
		fitColumn(cells.headers, 10),
	].join(" ");
}

function formatProfileRow(
	profileId: string,
	profile: StoredRequestHeaderProfile,
	usedCount: number,
	availableWidth = 78,
): string {
	return formatProfileTableRow({
		profileId,
		headers: `${Object.keys(profile.headers).length} headers`,
		used: `${usedCount} models`,
		name: profile.name,
	}, availableWidth);
}

function formatProfileTableHeader(menuWidth: number): string {
	return `  ${formatProfileTableRow({
		profileId: "自定义 ID",
		headers: "Headers",
		used: "Used",
		name: "名称",
	}, Math.max(0, menuWidth - 2))}`;
}

function formatProfileDetailLines(profileId: string, profile: StoredRequestHeaderProfile, usedCount: number): string[] {
	const headerNames = Object.keys(profile.headers);
	const preview = headerNames.length > 0
		? headerNames.slice(0, 6).join(", ") + (headerNames.length > 6 ? ", ..." : "")
		: "<empty>";
	return [
		`${profile.name} (${profileId})`,
		`  usage     ${usedCount} models`,
		`  headers   ${preview}`,
	];
}

function buildEditorRows(draft: RequestHeaderProfileDraft): FieldRow[] {
	return [
		{ id: "profileId", label: "请求头 ID", value: draft.profileId || "<未填写>" },
		{ id: "profileName", label: "请求头名称", value: draft.profileName || "<未填写>" },
		{ id: "template", label: "快速模板", value: "选择后填充" },
		{ id: "headers", label: "请求头 JSON", value: Object.keys(draft.headers).length > 0 ? `${Object.keys(draft.headers).length}项` : "未配置" },
	];
}

function notifyValidationErrors(ctx: ExtensionCommandContext, errors: string[]): void {
	ctx.ui.notify(`请求头无效：\n${errors.map((error) => `- ${error}`).join("\n")}`, "warning");
}

function formatHeadersEditorText(headers: Record<string, string>): string {
	if (Object.keys(headers).length > 0) return JSON.stringify(headers, null, 2);
	return `{
  // 可先返回上一级选择“快速模板”，也可在这里填写：
  // "user-agent": "custom-client/1.0"
}
`;
}

async function editHeaders(ctx: ExtensionCommandContext, draft: RequestHeaderProfileDraft): Promise<void> {
	ctx.ui.notify("结构：JSON 对象；key 是客户端 header 名，value 是字符串。复杂示例请用“快速模板”。", "info");
	while (true) {
		const answer = await ctx.ui.editor("请求头 JSON", formatHeadersEditorText(draft.headers));
		if (answer === undefined) return;
		try {
			draft.headers = parseStringRecordJson(answer, "请求头");
			return;
		} catch (error) {
			ctx.ui.notify(`请求头 JSON 无效：${formatUnknownError(error)}`, "warning");
		}
	}
}

async function applyTemplate(ctx: ExtensionCommandContext, draft: RequestHeaderProfileDraft): Promise<void> {
	const labels = HEADER_TEMPLATES.map((template) => `${template.label} — ${template.description}`);
	const picked = await ctx.ui.select("选择请求头模板", labels);
	if (!picked) return;
	const index = labels.indexOf(picked);
	if (index < 0) return;
	const template = HEADER_TEMPLATES[index]!;
	draft.headers = { ...template.headers };
	ctx.ui.notify(
		template.id === "empty"
			? "已清空请求头"
			: `已填充模板：${template.label}，可继续进入“请求头 JSON”微调。`,
		"info",
	);
}

async function editField(ctx: ExtensionCommandContext, draft: RequestHeaderProfileDraft, fieldId: string): Promise<void> {
	if (fieldId === "profileId") {
		const value = await ctx.ui.input("请求头 ID（接入引用这个 ID；字母/数字/._-）", draft.profileId);
		if (value !== undefined) draft.profileId = value.trim();
		return;
	}
	if (fieldId === "profileName") {
		const value = await ctx.ui.input("请求头名称（显示用）", draft.profileName);
		if (value !== undefined) draft.profileName = value.trim();
		return;
	}
	if (fieldId === "template") {
		await applyTemplate(ctx, draft);
		return;
	}
	if (fieldId === "headers") {
		await editHeaders(ctx, draft);
		return;
	}
}

async function editProfile(
	ctx: ExtensionCommandContext,
	draft: RequestHeaderProfileDraft,
	titlePrefix: string,
): Promise<{ action: "save"; draft: RequestHeaderProfileDraft } | { action: "cancel" }> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows = buildEditorRows(draft);
		const menuRows = rows.map((row) => ({ id: row.id, label: `${padLabel(row.label, 16)}${row.value}` }));
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				summaryLines: [
					"认证类敏感 header 会被拒绝；API key 请放在接入配置中",
				],
				footer: "↑↓ 选择   Enter 编辑   Ctrl+S 保存并同步   Esc 返回",
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		await editField(ctx, draft, action.id);
	}
}

async function saveProfile(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: RequestHeaderProfileDraft,
	oldProfileId: string | undefined,
): Promise<boolean> {
	const state = await readState();
	const errors = validateRequestHeaderProfileDraft(draft, state, oldProfileId);
	if (errors.length > 0) {
		notifyValidationErrors(ctx, errors);
		return false;
	}
	try {
		await saveRequestHeaderProfileConfiguration(pi, ctx, state, draft, oldProfileId);
		return true;
	} catch (error) {
		ctx.ui.notify(`保存失败：${formatUnknownError(error)}`, "error");
		return false;
	}
}

async function deleteProfile(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string): Promise<boolean> {
	const state = await readState();
	const profile = state.requestHeaderProfiles[profileId];
	if (!profile) {
		ctx.ui.notify(`请求头不存在：${profileId}`, "warning");
		return true;
	}
	const affected = countModelsUsingRequestHeaderProfile(state, profileId);
	const ok = await ctx.ui.confirm(
		`删除请求头 ${profileId}`,
		`将删除 ${profile.name}。${affected > 0 ? `\n${affected} 个模型会自动改回“自动推荐”。` : ""}`,
	);
	if (!ok) return false;
	try {
		await deleteRequestHeaderProfileConfiguration(pi, ctx, state, profileId);
		return true;
	} catch (error) {
		ctx.ui.notify(`删除失败：${formatUnknownError(error)}`, "error");
		return false;
	}
}

async function editStoredProfile(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string): Promise<boolean> {
	const state = await readState();
	const profile = state.requestHeaderProfiles[profileId];
	if (!profile) {
		ctx.ui.notify(`请求头不存在：${profileId}`, "warning");
		return true;
	}
	const outcome = await editProfile(ctx, createRequestHeaderProfileDraftFromStored(profileId, profile), `编辑请求头 ${profileId}`);
	if (outcome.action !== "save") return false;
	return saveProfile(pi, ctx, outcome.draft, profileId);
}

type HeaderProfileShortcut = "new-profile" | "delete-profile";

export async function runHeaderProfilesPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const state = await readState();
		const profileIds = Object.keys(state.requestHeaderProfiles).sort((a, b) => a.localeCompare(b));
		const rows = buildRows(profileIds).map((row) => {
			const profile = state.requestHeaderProfiles[row.profileId]!;
			const usedCount = countModelsUsingRequestHeaderProfile(state, row.profileId);
			return {
				...row,
				label: formatProfileRow(row.profileId, profile, usedCount),
			};
		});
		const action = await showPersistentShortcutMenu<HeaderProfileShortcut>(
			ctx,
			"/model-manager / 请求头",
			"",
			rows.map((row, index) => ({ id: `${index}`, label: row.label })),
			cursor,
			[
				{ input: "n", shortcut: "new-profile" },
				{ input: "d", shortcut: "delete-profile" },
			],
			{
				summaryLines: [
					"Built-in captures",
					formatCaptureLine("ClaudeCode", state.clientHeaderCaptures["claude-code"]),
					formatCaptureLine("Codex", state.clientHeaderCaptures["codex-cli"]),
					`Custom profiles: ${rows.length}`,
				],
				tableHeader: formatProfileTableHeader,
				formatRow: (menuRow, width) => {
					const row = rows[Number.parseInt(menuRow.id, 10)];
					const profile = row ? state.requestHeaderProfiles[row.profileId] : undefined;
					return row && profile
						? formatProfileRow(row.profileId, profile, countModelsUsingRequestHeaderProfile(state, row.profileId), width)
						: menuRow.label;
				},
				getDetailLines: (selectedRow) => {
					const row = rows[Number.parseInt(selectedRow?.id ?? "", 10)];
					const profile = row ? state.requestHeaderProfiles[row.profileId] : undefined;
					return row && profile
						? formatProfileDetailLines(row.profileId, profile, countModelsUsingRequestHeaderProfile(state, row.profileId))
						: [];
				},
				footer: "↑↓ 选择   Enter 编辑请求头   n 新建自定义   d 删除   Esc 返回",
				emptyLabel: "暂无自定义请求头；按 n 新建",
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut") {
			if (action.shortcut === "new-profile") {
				const outcome = await editProfile(ctx, createRequestHeaderProfileDraft(), "新建请求头");
				if (outcome.action === "save") await saveProfile(pi, ctx, outcome.draft, undefined);
				continue;
			}
			const selectedProfileId = rows[cursor.index]?.profileId;
			if (!selectedProfileId) {
				ctx.ui.notify("没有可删除的请求头。", "info");
				continue;
			}
			await deleteProfile(pi, ctx, selectedProfileId);
			continue;
		}
		const row = rows[Number.parseInt(action.id, 10)];
		if (!row) return;
		await editStoredProfile(pi, ctx, row.profileId);
	}
}
