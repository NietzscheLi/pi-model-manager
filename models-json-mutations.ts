// models-json-mutations.ts
//
// 原生 models.json 面板的事务层：集中处理 models.json 写入、插件 metadata 回写、
// runtime registry 刷新、enabledModels 清理和模型救援。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "./common.ts";
import { deleteModelInDoc, deleteProviderInDoc, readModelsJsonSnapshot, writeModelsJsonSnapshot } from "./models-json-manager.ts";
import { removeModelFromNextPiStart } from "./models-json-sync.ts";
import { reconcileProvider, unregisterManagedProvider } from "./provider-registrar.ts";
import { withModelRescue } from "./rescue.ts";
import { getModelFullId } from "./state-document.ts";
import { invalidateStateCache } from "./state-cache.ts";
import { readState, writeState } from "./state-store.ts";
import type { StateDocument } from "./types.ts";

async function refreshMetadataAfterNativeWrite(operation: string): Promise<StateDocument> {
	try {
		const state = await readState();
		await writeState(state);
		invalidateStateCache();
		return state;
	} catch (error) {
		throw new Error(`${operation} 已写入 models.json，但 state.json metadata 清理失败：${formatUnknownError(error)}`);
	}
}

async function refreshNativeMutationRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	operation: string,
	state: StateDocument,
	providerId: string,
): Promise<void> {
	try {
		await ctx.modelRegistry.refresh();
		const provider = state.providers[providerId];
		if (provider) await reconcileProvider(pi, providerId, provider, state.requestHeaderProfiles, state.clientHeaderCaptures);
		else unregisterManagedProvider(pi, providerId);
	} catch (error) {
		throw new Error(`${operation} 已写入 models.json/state.json，但当前会话 registry 刷新失败：${formatUnknownError(error)}。可执行 /reload 重试。`);
	}
}

export async function deleteModelsJsonProviderConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
): Promise<void> {
	const snapshot = await readModelsJsonSnapshot();
	const doc = snapshot.document;
	const removedModels = [...(doc.providers[providerId]?.models ?? [])].map((model) => model.id);
	await writeModelsJsonSnapshot(snapshot, deleteProviderInDoc(doc, providerId));
	invalidateStateCache();
	const state = await refreshMetadataAfterNativeWrite(`删除 ${providerId}`);
	await refreshNativeMutationRuntime(pi, ctx, `删除 ${providerId}`, state, providerId);
	try {
		for (const modelId of removedModels) {
			await removeModelFromNextPiStart(ctx.cwd, getModelFullId(providerId, modelId));
		}
	} catch (error) {
		ctx.ui.notify(`已删除 ${providerId}，但 enabledModels 清理失败：${formatUnknownError(error)}`, "warning");
	}
	ctx.ui.notify(`已删除 ${providerId}`, "info");
	await withModelRescue(ctx, pi, { providerId }, { reason: `models.json 中的 ${providerId} 已删除` });
}

export async function deleteModelsJsonModelConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
): Promise<void> {
	const fullId = getModelFullId(providerId, modelId);
	const snapshot = await readModelsJsonSnapshot();
	const doc = snapshot.document;
	let nextDoc = deleteModelInDoc(doc, providerId, modelId);
	if ((nextDoc.providers[providerId]?.models?.length ?? 0) === 0) nextDoc = deleteProviderInDoc(nextDoc, providerId);
	await writeModelsJsonSnapshot(snapshot, nextDoc);
	invalidateStateCache();
	const state = await refreshMetadataAfterNativeWrite(`删除 ${fullId}`);
	await refreshNativeMutationRuntime(pi, ctx, `删除 ${fullId}`, state, providerId);
	try {
		await removeModelFromNextPiStart(ctx.cwd, fullId);
	} catch (error) {
		ctx.ui.notify(`已删除 ${fullId}，但 enabledModels 清理失败：${formatUnknownError(error)}`, "warning");
	}
	ctx.ui.notify(`已删除 ${fullId}`, "info");
	await withModelRescue(ctx, pi, { providerId, modelId }, { reason: `models.json 中的 ${fullId} 已删除` });
}
