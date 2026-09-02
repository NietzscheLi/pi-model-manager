import assert from "node:assert/strict";
import test from "node:test";
import { extractValidatedModelIds, readBoundedResponseText } from "../tui/model-list-validation.ts";

test("模型列表去重排序并规范 Google models/ 前缀", () => {
	assert.deepEqual(
		extractValidatedModelIds({ models: [{ name: "models/zeta" }, { name: "models/alpha" }, { name: "models/zeta" }] }, "google-generative-ai"),
		["alpha", "zeta"],
	);
});

test("模型 ID 拒绝 ANSI、控制字符和超长内容", () => {
	assert.throws(
		() => extractValidatedModelIds({ data: [{ id: "safe\u001b[31m" }] }, "openai-responses"),
		/控制字符/,
	);
	assert.throws(
		() => extractValidatedModelIds({ data: [{ id: "x".repeat(257) }] }, "openai-responses"),
		/长度/,
	);
});

test("模型数量和响应体大小均有硬上限", async () => {
	assert.throws(
		() => extractValidatedModelIds({ data: Array.from({ length: 5_001 }, (_, index) => ({ id: `model-${index}` })) }, "openai-responses"),
		/超过上限/,
	);
	const response = new Response("small", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } });
	await assert.rejects(readBoundedResponseText(response, new AbortController().signal), /响应体超过/);
});

test("无 Content-Length 时仍按实际流量限制响应", async () => {
	const response = new Response("x".repeat(2 * 1024 * 1024 + 1));
	await assert.rejects(readBoundedResponseText(response, new AbortController().signal), /响应体超过/);
});
