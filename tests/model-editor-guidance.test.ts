import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "@earendil-works/pi-tui";
import { editModel } from "../tui/editor-model.ts";
import type { ModelDraft } from "../types.ts";

interface MenuComponent {
	handleInput(input: string): void;
	render(width: number): string[];
}

interface InputCall {
	title: string;
	placeholder?: string;
}

function createDraft(): ModelDraft {
	return {
		providerId: "gateway",
		providerName: "Gateway",
		api: "anthropic-messages",
		baseUrl: "https://gateway.example.test",
		apiKey: "test-key",
		authHeader: false,
		clientHeaderProfile: "recommended",
		customClientHeaders: {},
		httpProxyEnabled: false,
		httpProxyUrl: "http://127.0.0.1:7890",
		modelId: "claude-sonnet-5",
		modelName: "",
		inputKinds: ["text"],
		providerApi: "anthropic-messages",
		metadataSource: "manual",
		reasoningMode: "disabled",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		selectedIndex: 0,
	};
}

function createEditorContext(inputCalls: InputCall[]): { ctx: any; getComponent: () => MenuComponent | undefined } {
	let component: MenuComponent | undefined;
	const ctx = {
		ui: {
			custom(factory: any) {
				return new Promise((resolve) => {
					component = factory(
						{ requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{},
						resolve,
					);
				});
			},
			input(title: string, placeholder?: string) {
				inputCalls.push({ title, placeholder });
				return Promise.resolve(undefined);
			},
			notify() {},
			editor() {
				return Promise.resolve(undefined);
			},
		},
	} as any;
	return { ctx, getComponent: () => component };
}

// `editModel` 在 Enter 之后会异步重建菜单；让出宏任务再断言新一轮的组件。
function flushAsyncWork(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// 行序：modelId/fetch/modelName/apiOverride/metadataSource/visionInput/reasoning/contextWindow/maxTokens/…
function selectRow(menu: MenuComponent, index: number): void {
	for (let step = 0; step < index; step += 1) menu.handleInput(Key.down);
}

test("缓存预热·短 行给出推荐值与留空语义，输入标题同样带上常见值", async () => {
	const inputCalls: InputCall[] = [];
	const { ctx, getComponent } = createEditorContext(inputCalls);
	const draft = createDraft();
	const outcome = editModel(ctx, draft, "编辑模型");
	const menu = getComponent();
	assert.ok(menu, "编辑器应同步创建");

	selectRow(menu, 9);
	const rendered = menu.render(100).join("\n");
	assert.match(rendered, /缓存预热·短\(秒\)/);
	assert.match(rendered, /Anthropic 短缓存通常 300（5 分钟）/);
	assert.match(rendered, /拿不准留空 = 不预热/);
	assert.match(rendered, /cost 元数据/);

	// 80 列是常见终端宽度；行内说明被截断就等于没说。
	const narrow = menu.render(80).join("\n");
	assert.match(narrow, /拿不准留空 = 不预热。/);
	assert.match(narrow, /才真正预热。/);

	menu.handleInput(Key.enter);
	await flushAsyncWork();
	assert.equal(inputCalls.length, 1, "Enter 后应弹出秒数输入框");
	assert.match(inputCalls[0]!.title, /常见 300/);
	assert.match(inputCalls[0]!.title, /当前：未设置/);
	assert.match(inputCalls[0]!.title, /留空关闭该层级预热/);
	assert.equal(inputCalls[0]!.placeholder, "300");

	const rebuilt = getComponent();
	assert.ok(rebuilt, "编辑后应重建菜单");
	rebuilt.handleInput(Key.ctrl("s"));
	assert.deepEqual(await outcome, { action: "save", draft });
});

test("缓存预热·长 行给出 3600 与 long 层级出处", async () => {
	const { ctx, getComponent } = createEditorContext([]);
	const outcome = editModel(ctx, createDraft(), "编辑模型");
	const menu = getComponent();
	assert.ok(menu, "编辑器应同步创建");

	selectRow(menu, 10);
	const rendered = menu.render(100).join("\n");
	assert.match(rendered, /缓存预热·长\(秒\)/);
	assert.match(rendered, /Anthropic 扩展缓存通常 3600（1 小时）/);
	assert.match(rendered, /PI_CACHE_RETENTION=long/);

	menu.handleInput(Key.ctrl("s"));
	await outcome;
});

test("inputLimits 与 compat 行给出可照抄的 JSON 示例与适用时机", async () => {
	const { ctx, getComponent } = createEditorContext([]);
	const outcome = editModel(ctx, createDraft(), "编辑模型");
	const menu = getComponent();
	assert.ok(menu, "编辑器应同步创建");

	selectRow(menu, 11);
	const inputLimits = menu.render(80).join("\n");
	assert.match(inputLimits, /只在上游限制图片或请求体积时才需要/);
	assert.match(inputLimits, /只是元数据。/);
	assert.match(inputLimits, /\{"images":\{"resize":\{"maxWidth":1568,"maxHeight":1568,"jpegQuality":75\}\}\}/);

	menu.handleInput(Key.down);
	const compat = menu.render(80).join("\n");
	assert.match(compat, /只填已在真实上游验证过的差异项/);
	assert.match(compat, /"supportsMidConvoEffort":true/);

	menu.handleInput(Key.ctrl("s"));
	await outcome;
});
