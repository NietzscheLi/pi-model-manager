import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatModelListHeader,
	formatModelListRow,
	formatProviderConsoleHeader,
	formatProviderConsoleRow,
	getModelColumnWidths,
	getProviderDisplayLabel,
	getProviderNameColumnWidth,
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
		const row = formatProviderConsoleRow("responsive", provider, rowWidth);
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

test("列宽按当前数据收敛，且表头与数据行使用同一列定义", () => {
	const shortModel: StoredModel = { ...model, id: "gpt-5", name: "gpt-5" };
	const widths = getModelColumnWidths([shortModel]);
	const header = formatModelListHeader(provider, 100, widths);
	const row = formatModelListRow(provider, shortModel, 98, widths);

	// 短 ID 不应该再占满 30 列；收敛后后续列整体左移。
	assert.ok(widths.modelIdWidth < 30, "模型 ID 列应按数据收敛");
	// 表头带 2 空格前缀，数据行的前缀由菜单补；去掉前缀后列起点的可见宽度必须相同。
	const headerColumns = header.slice(2);
	assert.equal(
		visibleWidth(headerColumns.slice(0, headerColumns.indexOf("输入"))),
		visibleWidth(row.slice(0, row.indexOf("文本"))),
		"表头与数据行的列起点必须一致",
	);

	// 长 ID 仍受列宽上限保护，不会撞坏右侧列。
	const longWidths = getModelColumnWidths([{ ...model, id: "a".repeat(80) }]);
	assert.equal(longWidths.modelIdWidth, 30);
	assert.ok(visibleWidth(formatModelListRow(provider, model, 98, longWidths)) <= 98);
});

test("接入列宽收敛后仍不超过终端宽度", () => {
	const nameWidth = getProviderNameColumnWidth([getProviderDisplayLabel("responsive", provider)]);
	for (const menuWidth of [60, 80, 100]) {
		const rowWidth = menuWidth - 2;
		assert.ok(visibleWidth(formatProviderConsoleHeader(menuWidth, { nameWidth })) <= menuWidth);
		assert.ok(visibleWidth(formatProviderConsoleRow("responsive", provider, rowWidth, { nameWidth })) <= rowWidth);
	}
});
