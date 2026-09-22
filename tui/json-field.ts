// tui/json-field.ts
//
// 高级字段的通用 JSON 对象编辑：用 pi 的多行 editor 打开原始 JSON。
// 留空 = 清除该字段；解析失败或不是对象只提示，不落盘。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isObjectRecord } from "../common.ts";
import { t } from "../i18n.ts";

export type JsonObjectEditOutcome =
	| { action: "cancel" }
	| { action: "save"; value: Record<string, unknown> | undefined };

export async function editJsonObjectField(
	ctx: ExtensionCommandContext,
	label: string,
	current: unknown,
	hint: string,
): Promise<JsonObjectEditOutcome> {
	const prefill = isObjectRecord(current) && Object.keys(current).length > 0
		? JSON.stringify(current, null, 2)
		: "";
	ctx.ui.notify(hint, "info");
	const text = await ctx.ui.editor(t("{label}（JSON 对象；留空清除）", { label }), prefill);
	if (text === undefined) return { action: "cancel" };
	const trimmed = text.trim();
	if (!trimmed) return { action: "save", value: undefined };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		ctx.ui.notify(t("JSON 解析失败：{error}", { error: error instanceof Error ? error.message : String(error) }), "warning");
		return { action: "cancel" };
	}
	if (!isObjectRecord(parsed)) {
		ctx.ui.notify(t("{label} 必须是 JSON 对象", { label }), "warning");
		return { action: "cancel" };
	}
	return { action: "save", value: parsed };
}
