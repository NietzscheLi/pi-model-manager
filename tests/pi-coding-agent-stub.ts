import { tmpdir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(tmpdir(), `pi-model-manager-stub-${process.pid}`);
}

export class ModelRuntime {
	private configs = new Map<string, any>();
	static async create(): Promise<ModelRuntime> { return new ModelRuntime(); }
	registerProvider(id: string, config: any): void { this.configs.set(id, config); }
	getModels(providerId?: string): any[] {
		return [...this.configs].filter(([id]) => !providerId || id === providerId).flatMap(([id, config]) =>
			(config.models ?? []).map((model: any) => ({ ...model, provider: id, api: model.api ?? config.api, baseUrl: model.baseUrl ?? config.baseUrl })));
	}
	getModel(providerId: string, modelId: string): any { return this.getModels(providerId).find((model) => model.id === modelId); }
	getProvider(id: string): any {
		const config = this.configs.get(id);
		if (!config) return undefined;
		return {
			id, name: config.name,
			getModels: () => this.getModels(id),
			auth: {},
			stream() { throw new Error("协议请求必须使用真实 Pi 测试加载器"); },
			streamSimple() { throw new Error("协议请求必须使用真实 Pi 测试加载器"); },
		};
	}
	async getAuth(model: any): Promise<any> {
		const config = this.configs.get(model.provider);
		return { auth: { apiKey: config.apiKey, headers: config.headers } };
	}
}

export class ModelRegistry {
	constructor(_runtime: unknown) {}
}

// 只有「重新拉取模型列表 / 连通性自检」会真的用到 BorderedLoader；
// 单测不发起真实请求，这里提供构造、取消回调与信号所需的形状。
export class BorderedLoader {
	onAbort?: () => void;
	readonly signal: AbortSignal = new AbortController().signal;
	constructor(..._args: unknown[]) {}
}

export class SettingsManager {
	static create(): never {
		throw new Error("当前测试不应访问 SettingsManager");
	}
}
