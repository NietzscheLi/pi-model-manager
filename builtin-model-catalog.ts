// Pi 内置模型 catalog 边界。
//
// [喵喵喵]: Pi 0.80.8 移除 AuthStorage 且目录运行时异步化，必须隔离读取内置目录 (2026-07-17)
// 仅为读取 Pi 内置目录创建运行时，不读取用户 auth.json/models.json，
// 也不允许目录读取触发模型网络请求。

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ApiKind } from "./types.ts";

interface BuiltinProviderDefaults {
	api?: ApiKind;
	baseUrl?: string;
}

interface BuiltinCatalogModel {
	provider: string;
	api: string;
	baseUrl: string;
}

const SUPPORTED_API_KINDS = new Set<ApiKind>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

const emptyCredentialStore = {
	async read(): Promise<undefined> {
		return undefined;
	},
	async list(): Promise<readonly []> {
		return [];
	},
	async modify(): Promise<undefined> {
		return undefined;
	},
	async delete(): Promise<void> {
		return undefined;
	},
};

let builtinModelsPromise: Promise<readonly BuiltinCatalogModel[]> | undefined;
let builtinProviderIdsPromise: Promise<ReadonlySet<string>> | undefined;

function getBuiltinModels(): Promise<readonly BuiltinCatalogModel[]> {
	builtinModelsPromise ??= ModelRuntime.create({
		credentials: emptyCredentialStore,
		modelsPath: null,
		allowModelNetwork: false,
	}).then((runtime) =>
		runtime.getModels().map((model) => ({
			provider: String(model.provider),
			api: String(model.api),
			baseUrl: model.baseUrl,
		})),
	);

	return builtinModelsPromise;
}

export function getBuiltinProviderIds(): Promise<ReadonlySet<string>> {
	builtinProviderIdsPromise ??= getBuiltinModels().then(
		(models) => new Set(models.map((model) => model.provider)),
	);

	return builtinProviderIdsPromise;
}

export async function isBuiltinProviderId(providerId: string): Promise<boolean> {
	return (await getBuiltinProviderIds()).has(providerId);
}

function asSupportedApiKind(value: string | undefined): ApiKind | undefined {
	return value && SUPPORTED_API_KINDS.has(value as ApiKind)
		? (value as ApiKind)
		: undefined;
}

export async function getBuiltinProviderDefaults(
	providerId: string,
): Promise<BuiltinProviderDefaults | undefined> {
	const firstModel = (await getBuiltinModels()).find(
		(model) => model.provider === providerId,
	);
	if (!firstModel) return undefined;

	return {
		api: asSupportedApiKind(firstModel.api),
		baseUrl: firstModel.baseUrl,
	};
}
