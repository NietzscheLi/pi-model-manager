// header-profile-mutations.ts
//
// 自定义请求头 profile 的事务层：集中处理 state/models.json 持久化和 runtime provider 刷新。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { persistManagedConfiguration } from "./configuration-persistence.ts";
import { registerAllFromState } from "./provider-registrar.ts";
import { deleteRequestHeaderProfileFromDocument, upsertRequestHeaderProfileInDocument } from "./state-document.ts";
import type { RequestHeaderProfileDraft, StateDocument } from "./types.ts";

function notifyHeaderProfileRefresh(
	ctx: ExtensionCommandContext,
	successMessage: string,
	warnings: string[],
): void {
	if (warnings.length === 0) {
		ctx.ui.notify(successMessage, "info");
		return;
	}
	ctx.ui.notify(`${successMessage}，但以下接入未能刷新，已保留上一版 runtime：\n- ${warnings.join("\n- ")}`, "warning");
}

export async function saveRequestHeaderProfileConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: StateDocument,
	draft: RequestHeaderProfileDraft,
	oldProfileId: string | undefined,
): Promise<void> {
	const nextState = upsertRequestHeaderProfileInDocument(state, oldProfileId, draft);
	await persistManagedConfiguration(ctx, nextState);
	const warnings = await registerAllFromState(pi, nextState);
	notifyHeaderProfileRefresh(ctx, `已保存请求头 ${draft.profileId.trim()}`, warnings);
}

export async function deleteRequestHeaderProfileConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: StateDocument,
	profileId: string,
): Promise<void> {
	const nextState = deleteRequestHeaderProfileFromDocument(state, profileId);
	await persistManagedConfiguration(ctx, nextState);
	const warnings = await registerAllFromState(pi, nextState);
	notifyHeaderProfileRefresh(ctx, `已删除请求头 ${profileId}`, warnings);
}
