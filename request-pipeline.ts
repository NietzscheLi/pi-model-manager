// request-pipeline.ts
//
// 统一协调 before_provider_request payload transform。每个请求内共享一次
// StateDocument；跨请求由 state-cache.ts 按配置文件签名复用状态。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { injectClaudeCodeMetadata } from "./claude-code-compat.ts";
import { formatUnknownError } from "./common.ts";
import { normalizeManagedOpenAIResponsesPayload } from "./openai-responses-payload.ts";
import { injectOpenAIServiceTier } from "./openai-service-tier.ts";
import { readCachedState } from "./state-cache.ts";
import type { StateDocument } from "./types.ts";

type StateLoader = () => Promise<StateDocument>;

type RequestTransform = {
	id: string;
	warning: string;
	run(payload: unknown, ctx: ExtensionContext, loadState: StateLoader): Promise<unknown | undefined> | unknown | undefined;
};

function createRequestStateLoader(): StateLoader {
	let statePromise: Promise<StateDocument> | undefined;
	return () => {
		statePromise ??= readCachedState();
		return statePromise;
	};
}

const REQUEST_TRANSFORMS: RequestTransform[] = [
	{
		id: "claude-code-metadata",
		warning: "ClaudeCode metadata 注入失败，本次请求仅使用请求头",
		async run(payload, ctx, loadState) {
			if (!ctx.model || ctx.model.api !== "anthropic-messages") return undefined;
			return injectClaudeCodeMetadata(payload, ctx.model, await loadState());
		},
	},
	{
		id: "openai-responses-instructions",
		warning: "OpenAI Responses instructions 标准化失败，本次请求使用原始 payload",
		async run(payload, ctx, loadState) {
			if (!ctx.model || ctx.model.api !== "openai-responses") return undefined;
			return normalizeManagedOpenAIResponsesPayload(payload, ctx.model, await loadState());
		},
	},
	{
		id: "openai-service-tier",
		warning: "Fast mode 状态读取失败，本次请求未注入 service_tier",
		async run(payload, ctx, loadState) {
			if (!ctx.model || ctx.model.api !== "openai-responses") return undefined;
			return injectOpenAIServiceTier(payload, ctx.model, await loadState());
		},
	},
];

export interface RequestPipeline {
	transform(payload: unknown, ctx: ExtensionContext): Promise<unknown | undefined>;
}

export function createRequestPipeline(): RequestPipeline {
	const notifiedTransformErrors = new Set<string>();

	return {
		async transform(initialPayload, ctx) {
			let payload = initialPayload;
			let changed = false;
			const loadState = createRequestStateLoader();

			for (const transform of REQUEST_TRANSFORMS) {
				try {
					const nextPayload = await transform.run(payload, ctx, loadState);
					if (nextPayload !== undefined) {
						payload = nextPayload;
						changed = true;
					}
				} catch (error) {
					if (!notifiedTransformErrors.has(transform.id) && ctx.hasUI) {
						notifiedTransformErrors.add(transform.id);
						ctx.ui.notify(`[pi-model-manager] ${transform.warning}：${formatUnknownError(error)}`, "warning");
					}
				}
			}

			return changed ? payload : undefined;
		},
	};
}
