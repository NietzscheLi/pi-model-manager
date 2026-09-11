// 单测只验证插件边界；协议序列化探针使用真实 Pi 实现。
export function lazyStream(model: { id: string }, setup: () => Promise<any>): any {
	const pending = setup();
	return {
		async result() {
			try { return await (await pending).result(); }
			catch (error) { return { stopReason: "error", errorMessage: String(error), model: model.id }; }
		},
		async *[Symbol.asyncIterator]() { yield* await pending; },
	};
}
