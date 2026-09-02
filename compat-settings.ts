// Pi 会把 provider 级 compat 作为默认值，再由模型级 compat 覆盖。
// 动态 registerProvider 不接受 provider.compat，因此插件注册前在这里复现相同合并语义。

import { isObjectRecord } from "./common.ts";
import type { CompatSettings } from "./types.ts";

const NESTED_COMPAT_FIELDS = ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs"] as const;

export function mergeCompatSettings(
	providerCompat: CompatSettings | undefined,
	modelCompat: CompatSettings | undefined,
): CompatSettings | undefined {
	if (!providerCompat && !modelCompat) return undefined;
	const merged: CompatSettings = { ...providerCompat, ...modelCompat };
	for (const field of NESTED_COMPAT_FIELDS) {
		const providerValue = providerCompat?.[field];
		const modelValue = modelCompat?.[field];
		if (!isObjectRecord(providerValue) && !isObjectRecord(modelValue)) continue;
		merged[field] = {
			...(isObjectRecord(providerValue) ? providerValue : {}),
			...(isObjectRecord(modelValue) ? modelValue : {}),
		};
	}
	return merged;
}
