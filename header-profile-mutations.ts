// header-profile-mutations.ts
//
// 自定义请求头 profile 的事务层：集中处理 state/models.json 持久化和 runtime provider 刷新。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { persistManagedConfiguration } from "./configuration-persistence.ts";
import { t } from "./i18n.ts";
import { registerAllFromState } from "./provider-registrar.ts";
import { deleteRequestHeaderProfileFromDocument, upsertRequestHeaderProfileInDocument } from "./state-document.ts";
import type { RequestHeaderProfileDraft, StateDocument, StoredProvider } from "./types.ts";

function providerReferencesProfile(provider: StoredProvider, profileId: string): boolean {
	return provider.requestHeaderProfileId === profileId
		|| provider.models.some((model) => model.requestHeaderProfileId === profileId);
}

function findProfileProviderIds(
	document: StateDocument,
	profileIds: string[],
): string[] {
	const ids = new Set(profileIds);
	return Object.entries(document.providers)
		.filter(([, provider]) => provider.managed && [...ids].some((profileId) => providerReferencesProfile(provider, profileId)))
		.map(([providerId]) => providerId);
}

function notifyHeaderProfileRefresh(
	ctx: ExtensionCommandContext,
	successMessage: string,
	warnings: string[],
): void {
	if (warnings.length === 0) {
		ctx.ui.notify(successMessage, "info");
		return;
	}
	ctx.ui.notify(t("{successMessage}，但以下接入未能刷新，已保留上一版 runtime：\n- {warnings}", { successMessage, warnings: warnings.join("\n- ") }), "warning");
}

export async function saveRequestHeaderProfileConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	_state: StateDocument,
	draft: RequestHeaderProfileDraft,
	oldProfileId: string | undefined,
): Promise<void> {
	const profileId = draft.profileId.trim();
	const nextState = await persistManagedConfiguration(ctx, (latest) => ({
		document: upsertRequestHeaderProfileInDocument(latest, oldProfileId, draft),
		changedProviderIds: findProfileProviderIds(latest, [profileId, ...(oldProfileId ? [oldProfileId] : [])]),
		removedProviderIds: [],
	}));
	const warnings = await registerAllFromState(pi, nextState);
	notifyHeaderProfileRefresh(ctx, t("已保存请求头 {profileId}", { profileId: draft.profileId.trim() }), warnings);
}

export async function deleteRequestHeaderProfileConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	_state: StateDocument,
	profileId: string,
): Promise<void> {
	const nextState = await persistManagedConfiguration(ctx, (latest) => ({
		document: deleteRequestHeaderProfileFromDocument(latest, profileId),
		changedProviderIds: findProfileProviderIds(latest, [profileId]),
		removedProviderIds: [],
	}));
	const warnings = await registerAllFromState(pi, nextState);
	notifyHeaderProfileRefresh(ctx, t("已删除请求头 {profileId}", { profileId }), warnings);
}
