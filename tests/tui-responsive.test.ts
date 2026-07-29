import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatModelListHeader,
	formatModelListRow,
	formatProviderConsoleHeader,
	formatProviderConsoleRow,
} from "../tui/ui-helpers.ts";
import type { StoredModel, StoredProvider } from "../types.ts";

const model: StoredModel = {
	id: "long-model-id-for-responsive-layout",
	name: "Responsive Model",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 128_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	openAIServiceTier: "priority",
};

const provider: StoredProvider = {
	name: "Responsive Provider",
	api: "openai-responses",
	baseUrl: "https://example.test/v1",
	apiKey: "plaintext-key",
	managed: true,
	clientHeaderProfile: "recommended",
	httpProxyEnabled: true,
	httpProxyUrl: "http://127.0.0.1:7890",
	models: [model],
};

test("Provider 表格在 60/80/100 列按宽度降级且保留核心字段", () => {
	for (const menuWidth of [60, 80, 100]) {
		const rowWidth = menuWidth - 2;
		const header = formatProviderConsoleHeader(menuWidth);
		const row = formatProviderConsoleRow("responsive", provider, {}, rowWidth);
		assert.ok(visibleWidth(header) <= menuWidth, `${menuWidth} 列 Header 溢出`);
		assert.ok(visibleWidth(row) <= rowWidth, `${menuWidth} 列 Row 溢出`);
		assert.match(header, /接入/);
		assert.match(header, /API/);
		assert.match(header, /模型/);
		assert.match(header, /状态/);
	}
	assert.doesNotMatch(formatProviderConsoleHeader(60), /请求头/);
	assert.match(formatProviderConsoleHeader(80), /代理/);
	assert.match(formatProviderConsoleHeader(100), /请求头/);
});

test("Model 表格在 60/80/100 列保留 ID、输入、Thinking 并逐步增加次要列", () => {
	for (const menuWidth of [60, 80, 100]) {
		const rowWidth = menuWidth - 2;
		const header = formatModelListHeader(provider, menuWidth);
		const row = formatModelListRow(provider, model, rowWidth);
		assert.ok(visibleWidth(header) <= menuWidth, `${menuWidth} 列 Header 溢出`);
		assert.ok(visibleWidth(row) <= rowWidth, `${menuWidth} 列 Row 溢出`);
		assert.match(header, /模型 ID/);
		assert.match(header, /输入/);
		assert.match(header, /Thinking/);
	}
	assert.doesNotMatch(formatModelListHeader(provider, 60), /显示名/);
	assert.match(formatModelListHeader(provider, 80), /显示名/);
	assert.doesNotMatch(formatModelListHeader(provider, 80), /输出/);
	assert.match(formatModelListHeader(provider, 100), /输出/);
	assert.match(formatModelListHeader(provider, 100), /Fast/);
});
