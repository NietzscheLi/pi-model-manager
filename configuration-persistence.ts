// 模型管理保存边界：models.json 是模型权威源，state.json 仅承载插件 metadata。
// 两个文件无法组成单一原子事务；写入完成后必须 reload 当前 registry，清除旧 models.json 配置层。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "./common.ts";
import {
	syncModelRenameToModelsJson,
	syncProviderRenameToModelsJson,
	syncStateToModelsJson,
} from "./models-json-sync.ts";
import { invalidateStateCache } from "./state-cache.ts";
import { writeState } from "./state-store.ts";
import type { StateDocument } from "./types.ts";

async function persistModelsThenMetadata(
	ctx: ExtensionCommandContext,
	document: StateDocument,
	writeModelsJson: () => Promise<void>,
): Promise<void> {
	try {
		await writeModelsJson();
		invalidateStateCache();
	} catch (error) {
		throw new Error(`models.json 未写入：${formatUnknownError(error)}`);
	}
	try {
		await writeState(document);
		invalidateStateCache();
	} catch (error) {
		throw new Error(`models.json 已写入，但 state.json metadata 写入失败：${formatUnknownError(error)}`);
	}
	try {
		await ctx.modelRegistry.refresh();
	} catch (error) {
		throw new Error(`models.json/state.json 已写入，但当前会话 registry 重载失败：${formatUnknownError(error)}。可执行 /reload 重试。`);
	}
}

export async function persistManagedConfiguration(
	ctx: ExtensionCommandContext,
	document: StateDocument,
	removedProviderIds: string[] = [],
): Promise<void> {
	await persistModelsThenMetadata(ctx, document, () => syncStateToModelsJson(document, removedProviderIds));
}

export async function persistProviderRenameConfiguration(
	ctx: ExtensionCommandContext,
	document: StateDocument,
	oldProviderId: string,
	newProviderId: string,
): Promise<void> {
	await persistModelsThenMetadata(
		ctx,
		document,
		() => syncProviderRenameToModelsJson(document, oldProviderId, newProviderId),
	);
}

export async function persistModelRenameConfiguration(
	ctx: ExtensionCommandContext,
	document: StateDocument,
	providerId: string,
	oldModelId: string,
	newModelId: string,
): Promise<void> {
	await persistModelsThenMetadata(
		ctx,
		document,
		() => syncModelRenameToModelsJson(document, providerId, oldModelId, newModelId),
	);
}
