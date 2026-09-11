import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fetchModelIds, type FetchModelIdsParams } from "../tui/model-list-fetch.ts";
import type { ApiKind } from "../types.ts";

const realRuntime = process.env.PI_MODEL_MANAGER_REAL_RUNTIME === "1";

test("真实 Pi：四协议发现保留端点和显式头，失败不猜地址，取消可传递", { skip: !realRuntime, timeout: 20_000 }, async () => {
	const captured: { url: string; headers: Record<string, unknown> }[] = [];
	let api: ApiKind = "anthropic-messages";
	let status = 200;
	let holdResponse = false;
	let onRequest = () => {};
	const server = createServer((req, res) => {
		const headers = { ...req.headers };
		const url = String(headers["x-test-target-url"] ?? req.url);
		for (const name of ["x-test-target-url", "host", "connection", "proxy-connection", "content-length", "transfer-encoding"]) delete headers[name];
		captured.push({ url, headers });
		onRequest();
		if (holdResponse) return;
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(status === 200
			? api === "google-generative-ai" ? { models: [{ name: "models/test-model" }] } : { data: [{ id: "test-model" }] }
			: { error: "fixture error fake-gateway-key" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const localUrl = `http://127.0.0.1:${(server.address() as any).port}`;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.hostname === "127.0.0.1") return originalFetch(request);
		assert.equal(url.hostname, "gateway.invalid");
		const local = new Request(`${localUrl}${url.pathname}${url.search}`, request);
		local.headers.set("x-test-target-url", request.url);
		return originalFetch(local);
	};
	const params: FetchModelIdsParams = {
		providerId: "discovery-fixture", api, baseUrl: "http://gateway.invalid/tenant/xxx", apiKey: "fake-gateway-key", authHeader: true,
		clientHeaderProfile: "custom", customClientHeaders: { "Anthropic-Version": "2023-06-01", "ANTHROPIC-BETA": "custom-beta", "User-Agent": "list-fixture" },
	};
	try {
		for (api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as ApiKind[]) {
			const outcome = await fetchModelIds({ ...params, api });
			assert.deepEqual(outcome, { status: "loaded", modelIds: ["test-model"] }, api);
			const request = captured.at(-1)!;
			assert.equal(request.url, "http://gateway.invalid/tenant/xxx/models");
			assert.equal(request.headers["user-agent"], "list-fixture");
			assert.equal(request.headers["anthropic-beta"], "custom-beta");
			assert.equal(request.headers.authorization, "Bearer fake-gateway-key");
			if (api === "anthropic-messages") assert.equal(request.headers["x-api-key"], "fake-gateway-key");
			if (api === "google-generative-ai") assert.equal(request.headers["x-goog-api-key"], "fake-gateway-key");
		}
		api = "anthropic-messages";
		for (status of [401, 404, 429, 503]) {
			const before = captured.length;
			const outcome = await fetchModelIds(params);
			assert.equal(captured.length, before + 1, "每个错误只请求配置的列表端点一次");
			assert.equal(outcome.status, "failed");
			if (outcome.status === "failed") {
				assert.ok(outcome.message.includes(`HTTP ${status}`));
				assert.ok(!outcome.message.includes("fake-gateway-key"));
				if (status === 404) assert.match(outcome.message, /手动/);
			}
		}
		const beforeInvalid = captured.length;
		for (const suffix of ["?tenant=a", "#fragment"]) {
			assert.equal((await fetchModelIds({ ...params, baseUrl: params.baseUrl + suffix })).status, "failed");
		}
		assert.equal(captured.length, beforeInvalid);
		holdResponse = true;
		const received = Promise.withResolvers<void>();
		onRequest = received.resolve;
		const controller = new AbortController();
		const pending = fetchModelIds(params, controller.signal);
		await received.promise;
		controller.abort();
		assert.deepEqual(await pending, { status: "cancelled" });
	} finally {
		globalThis.fetch = originalFetch;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
