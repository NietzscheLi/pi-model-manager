// model-mutations.ts
//
// /model-manager 的模型配置事务层。这里集中处理 models.json/state.json 持久化、
// Pi runtime provider 注册同步、enabledModels 同步和模型救援；TUI 只负责收集用户意图。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "./common.ts";
import {
	persistManagedConfiguration,
	persistModelRenameConfiguration,
	persistProviderRenameConfiguration,
} from "./configuration-persistence.ts";
import {
	enableModelForNextPiStart,
	removeModelFromNextPiStart,
	replaceProviderInEnabledModelsForNextPiStart,
	verifyNativeModelAvailable,
} from "./models-json-sync.ts";
import { reconcileProvider, unregisterManagedProvider } from "./provider-registrar.ts";
import { withModelRescue } from "./rescue.ts";
import { deleteModelFromDocument, deleteProviderFromDocument, getModelFullId, upsertModelInDocument, upsertProviderInDocument } from "./state-document.ts";
import { readState } from "./state-store.ts";
import type { StateDocument, StoredProvider } from "./types.ts";
import type { createModelDraftForStoredProvider, createProviderDraft } from "./state-document.ts";

type ProviderDraft = ReturnType<typeof createProviderDraft>;
type ModelDraft = ReturnType<typeof createModelDraftForStoredProvider>;

function formatEnableNote(mode: "all-enabled" | "updated" | "unchanged", scope?: "global" | "project"): string {
	if (mode === "all-enabled") return "当前未限制 enabledModels，重启后默认可选";
	if (mode === "updated") return `已写入${scope === "project" ? "项目" : "全局"} enabledModels`;
	return "已在 enabledModels 中";
}

async function notifyModelAvailability(
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
	replacedFullId?: string,
	messagePrefix = "已保存并启用模型",
): Promise<void> {
	const fullId = getModelFullId(providerId, modelId);
	try {
		const enableOutcome = await enableModelForNextPiStart(ctx.cwd, fullId, replacedFullId);
		const verification = await verifyNativeModelAvailable(ctx, providerId, modelId);
		const enableNote = formatEnableNote(enableOutcome.mode, enableOutcome.scope);
		if (verification.ok) {
			ctx.ui.notify(`${messagePrefix} ${fullId}（${enableNote}）`, "info");
		} else {
			ctx.ui.notify(`已保存模型 ${fullId}，但启用校验有警告：\n- ${verification.warnings.join("\n- ")}`, "warning");
		}
	} catch (error) {
		ctx.ui.notify(`已保存模型 ${fullId}，但启用同步/校验失败：${formatUnknownError(error)}`, "warning");
	}
}

async function reconcilePersistedProviderRuntime(
	pi: ExtensionAPI,
	providerId: string,
	provider: StoredProvider,
	document: StateDocument,
): Promise<void> {
	try {
		await reconcileProvider(pi, providerId, provider, document.requestHeaderProfiles, document.clientHeaderCaptures);
	} catch (error) {
		throw new Error(`models.json/state.json 已保存，但当前会话接入刷新失败：${formatUnknownError(error)}。可执行 /reload 重试。`);
	}
}

export async function saveProviderConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: StateDocument,
	draft: ProviderDraft,
	oldProviderId: string | undefined,
): Promise<void> {
	const nextState = upsertProviderInDocument(state, oldProviderId, draft);
	const stored = nextState.providers[draft.providerId]!;
	const renamedCurrentModelId = oldProviderId
		&& oldProviderId !== draft.providerId
		&& ctx.model?.provider === oldProviderId
		&& stored.models.some((model) => model.id === ctx.model?.id)
		? ctx.model.id
		: undefined;
	if (oldProviderId && oldProviderId !== draft.providerId) {
		await persistProviderRenameConfiguration(ctx, nextState, oldProviderId, draft.providerId);
	} else {
		await persistManagedConfiguration(ctx, nextState);
	}
	await reconcilePersistedProviderRuntime(pi, draft.providerId, stored, nextState);
	if (oldProviderId && oldProviderId !== draft.providerId) unregisterManagedProvider(pi, oldProviderId);

	ctx.ui.notify(`已保存接入 ${draft.providerId}`, "info");

	if (oldProviderId && oldProviderId !== draft.providerId) {
		try {
			const outcome = await replaceProviderInEnabledModelsForNextPiStart(
				ctx.cwd,
				oldProviderId,
				draft.providerId,
			);
			if (outcome.mode === "updated") {
				ctx.ui.notify(`已同步${outcome.scope === "project" ? "项目" : "全局"} enabledModels 中的接入重命名`, "info");
			}
		} catch (error) {
			ctx.ui.notify(`接入已保存，但 enabledModels 同步失败：${formatUnknownError(error)}`, "warning");
		}
		await withModelRescue(ctx, pi, { providerId: oldProviderId }, {
			reason: `接入 ${oldProviderId} 已重命名为 ${draft.providerId}`,
			preferred: renamedCurrentModelId
				? { providerId: draft.providerId, modelId: renamedCurrentModelId }
				: undefined,
		});
	}
}

export async function saveModelConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: StateDocument,
	draft: ModelDraft,
	replacedModelId: string | undefined,
): Promise<void> {
	const nextState = upsertModelInDocument(state, draft, { replacedModelId });
	const stored = nextState.providers[draft.providerId]!;
	const newModelId = draft.modelId.trim();
	const oldFullId = replacedModelId && replacedModelId !== newModelId
		? getModelFullId(draft.providerId, replacedModelId)
		: undefined;
	if (oldFullId && replacedModelId) {
		await persistModelRenameConfiguration(ctx, nextState, draft.providerId, replacedModelId, newModelId);
	} else {
		await persistManagedConfiguration(ctx, nextState);
	}
	await reconcilePersistedProviderRuntime(pi, draft.providerId, stored, nextState);
	const newFullId = getModelFullId(draft.providerId, newModelId);
	await notifyModelAvailability(ctx, draft.providerId, newModelId, oldFullId);

	if (oldFullId && replacedModelId) {
		await withModelRescue(
			ctx,
			pi,
			{ providerId: draft.providerId, modelId: replacedModelId },
			{
				reason: `模型 ${oldFullId} 已重命名为 ${newFullId}`,
				preferred: { providerId: draft.providerId, modelId: draft.modelId.trim() },
			},
		);
	}
}

export async function saveNewProviderWithModelConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerState: StateDocument,
	providerDraft: ProviderDraft,
	modelDraft: ModelDraft,
): Promise<void> {
	const nextState = upsertModelInDocument(providerState, modelDraft);
	const stored = nextState.providers[providerDraft.providerId]!;
	await persistManagedConfiguration(ctx, nextState);
	await reconcilePersistedProviderRuntime(pi, providerDraft.providerId, stored, nextState);
	await notifyModelAvailability(ctx, providerDraft.providerId, modelDraft.modelId.trim(), undefined, "已创建并启用模型");
}

export async function deleteProviderConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	provider: StoredProvider,
): Promise<void> {
	const state = await readState();
	const nextState = deleteProviderFromDocument(state, providerId);
	await persistManagedConfiguration(ctx, nextState, [providerId]);
	try {
		for (const model of provider.models) {
			await removeModelFromNextPiStart(ctx.cwd, getModelFullId(providerId, model.id));
		}
	} catch (error) {
		ctx.ui.notify(`接入已删除，但 enabledModels 清理失败：${formatUnknownError(error)}`, "warning");
	}
	unregisterManagedProvider(pi, providerId);
	ctx.ui.notify(`已删除接入 ${providerId}`, "info");
	await withModelRescue(ctx, pi, { providerId }, { reason: `接入 ${providerId} 已删除` });
}

export async function deleteModelConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
): Promise<void> {
	const fullId = getModelFullId(providerId, modelId);
	const state = await readState();
	const nextState = deleteModelFromDocument(state, providerId, modelId);
	if ((nextState.providers[providerId]?.models.length ?? 0) === 0) {
		delete nextState.providers[providerId];
	}
	const stored = nextState.providers[providerId];
	await persistManagedConfiguration(ctx, nextState, stored ? [] : [providerId]);
	try {
		await removeModelFromNextPiStart(ctx.cwd, fullId);
	} catch (error) {
		ctx.ui.notify(`模型已删除，但 enabledModels 清理失败：${formatUnknownError(error)}`, "warning");
	}
	if (stored) await reconcilePersistedProviderRuntime(pi, providerId, stored, nextState);
	else unregisterManagedProvider(pi, providerId);
	ctx.ui.notify(`已删除模型 ${fullId}`, "info");
	await withModelRescue(ctx, pi, { providerId, modelId }, { reason: `模型 ${fullId} 已删除` });
}
