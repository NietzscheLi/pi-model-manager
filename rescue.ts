// rescue.ts
//
// 当前会话模型在以下场景可能失效：
//   1) 模型被删除（unregister）
//   2) 模型被改名（同接入内 id 变更）
//   3) 接入被改名 / 删除
//   4) 接入的 baseUrl/apiKey 变更后 in-memory 模型 stale
//
// withModelRescue 统一处理：
//   - 优先切换到调用方指定的 preferred（rename 场景）
//   - 否则切到 modelRegistry.getAvailable()[0]
//   - 都不行则只 notify warning
// 调用方负责先同步 registry/runtime，避免救援阶段再次触发全目录刷新。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface AffectedRef {
	providerId: string;
	modelId?: string;
}

export interface RescueOptions {
	reason: string;
	preferred?: { providerId: string; modelId: string };
}

export async function withModelRescue(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	affected: AffectedRef,
	options: RescueOptions,
): Promise<void> {
	const current = ctx.model;
	if (!current) return;

	const isAffected = current.provider === affected.providerId
		&& (affected.modelId === undefined || current.id === affected.modelId);
	const isUsable = !!ctx.modelRegistry.find(current.provider, current.id)
		&& ctx.modelRegistry.hasConfiguredAuth(current);

	if (!isAffected && isUsable) return;

	if (options.preferred) {
		const replacement = ctx.modelRegistry.find(options.preferred.providerId, options.preferred.modelId);
		if (replacement && ctx.modelRegistry.hasConfiguredAuth(replacement)) {
			if (await pi.setModel(replacement)) {
				ctx.ui.notify(
					`${options.reason}，已切换到 ${options.preferred.providerId}/${options.preferred.modelId}`,
					"info",
				);
				return;
			}
		}
	}

	const fallback = ctx.modelRegistry.getAvailable()[0];
	if (fallback && await pi.setModel(fallback)) {
		ctx.ui.notify(
			`${options.reason}，已自动切换到 ${fallback.provider}/${fallback.id}`,
			"info",
		);
		return;
	}

	ctx.ui.notify(
		`${options.reason}，但当前没有其它可用模型。请使用 /model-manager 添加模型或 /login 配置认证。`,
		"warning",
	);
}
