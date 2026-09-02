import assert from "node:assert/strict";
import test from "node:test";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import {
	showPersistentFormMenu,
	showPersistentShortcutMenu,
	type MenuCursor,
	type MenuRow,
	type MenuShortcut,
	type PersistentMenuOptions,
} from "../tui/persistent-menu.ts";

interface MenuHarness {
	component: {
		focused: boolean;
		handleInput(input: string): void;
		render(width: number): string[];
	};
	outcome: Promise<unknown>;
}

function openMenu(
	rows: MenuRow[],
	cursor: MenuCursor,
	shortcuts: MenuShortcut<string>[] = [],
	options: PersistentMenuOptions = {},
	terminalRows = 0,
): MenuHarness {
	let component: MenuHarness["component"] | undefined;
	const ctx = {
		ui: {
			custom(factory: any) {
				return new Promise((resolve) => {
					component = factory(
						{ requestRender() {}, ...(terminalRows > 0 ? { terminal: { rows: terminalRows } } : {}) },
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
		},
	} as any;
	const outcome = showPersistentShortcutMenu(ctx, "测试菜单", "", rows, cursor, shortcuts, {
		emptyLabel: "暂无条目",
		...options,
	});
	assert.ok(component, "菜单组件应同步创建");
	return { component, outcome };
}

test("搜索组件暴露 Focusable 光标并支持中文光标内编辑", async () => {
	const menu = openMenu([{ id: "model", label: "模型 Alpha" }], { index: 0 });
	menu.component.focused = true;
	menu.component.handleInput("/");
	menu.component.handleInput("模型");
	assert.match(menu.component.render(80).join("\n"), /模型<CURSOR>/);

	menu.component.handleInput(Key.left);
	menu.component.handleInput("新");
	assert.match(menu.component.render(80).join("\n"), /模新<CURSOR>▌型/);

	menu.component.handleInput(Key.escape);
	menu.component.handleInput(Key.escape);
	assert.deepEqual(await menu.outcome, { type: "cancel" });
});

test("长搜索词在窄终端中保持输入光标可见", async () => {
	const menu = openMenu([{ id: "model", label: "模型" }], { index: 0 });
	menu.component.focused = true;
	menu.component.handleInput("/");
	menu.component.handleInput("这是一个很长的中文搜索关键词");
	const searchLine = menu.component.render(16).find((line) => line.includes("搜索："));
	assert.ok(searchLine);
	assert.match(searchLine, /<CURSOR>/);
	assert.ok(visibleWidth(searchLine) <= 16);
	menu.component.handleInput(Key.escape);
	menu.component.handleInput(Key.escape);
	assert.deepEqual(await menu.outcome, { type: "cancel" });
});

test("过滤时优先保留当前条目，不匹配时回退到首项", async () => {
	const cursor = { index: 1 };
	const retained = openMenu([
		{ id: "alpha", label: "Alpha" },
		{ id: "beta", label: "Beta" },
	], cursor);
	retained.component.handleInput("/");
	retained.component.handleInput("a");
	retained.component.handleInput(Key.enter);
	assert.deepEqual(await retained.outcome, { type: "pick", id: "beta" });
	assert.equal(cursor.index, 1);

	const fallback = openMenu([
		{ id: "alpha", label: "Alpha" },
		{ id: "beta", label: "Beta" },
	], cursor);
	fallback.component.handleInput("/");
	fallback.component.handleInput("al");
	fallback.component.handleInput(Key.enter);
	assert.deepEqual(await fallback.outcome, { type: "pick", id: "alpha" });
	assert.equal(cursor.index, 0);
});

test("空结果有明确反馈，搜索激活后单字母不触发快捷键", async () => {
	const empty = openMenu([{ id: "alpha", label: "Alpha" }], { index: 0 });
	empty.component.handleInput("/");
	empty.component.handleInput("不存在");
	assert.match(empty.component.render(80).join("\n"), /无匹配项：不存在/);
	empty.component.handleInput(Key.escape);
	empty.component.handleInput(Key.escape);
	assert.deepEqual(await empty.outcome, { type: "cancel" });

	const shortcut = [{ input: "n", shortcut: "new" }];
	const direct = openMenu([{ id: "n-row", label: "n row" }], { index: 0 }, shortcut);
	direct.component.handleInput("n");
	assert.deepEqual(await direct.outcome, { type: "shortcut", shortcut: "new" });

	const searching = openMenu([{ id: "n-row", label: "n row" }], { index: 0 }, shortcut);
	searching.component.handleInput("/");
	searching.component.handleInput("n");
	searching.component.handleInput(Key.enter);
	assert.deepEqual(await searching.outcome, { type: "pick", id: "n-row" });
});

test("搜索匹配未截断的 searchText，而不是列宽截断后的表格文本", async () => {
	const menu = openMenu([{
		id: "0",
		// label 模拟被列宽截断后的表格行：后半段 ID 不在其中
		label: "生产网关 (azure-…  Responses",
		searchText: "azure-prod-eastus-gateway-2024 生产网关",
	}], { index: 0 });
	menu.component.handleInput("/");
	menu.component.handleInput("2024");
	const rendered = menu.component.render(80).join("\n");
	assert.doesNotMatch(rendered, /无匹配项/);
	assert.match(rendered, /生产网关/);

	menu.component.handleInput(Key.escape);
	menu.component.handleInput(Key.escape);
	assert.deepEqual(await menu.outcome, { type: "cancel" });
});

test("Tab 退出输入态但保留过滤，此时单字母恢复为快捷键", async () => {
	const menu = openMenu(
		[{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }],
		{ index: 0 },
		[{ input: "n", shortcut: "new" }],
	);
	menu.component.handleInput("/");
	menu.component.handleInput("bet");
	menu.component.handleInput(Key.tab);

	const rendered = menu.component.render(80).join("\n");
	assert.match(rendered, /过滤：bet/, "退出输入态后仍要显示过滤词");
	assert.doesNotMatch(rendered, /Alpha/, "过滤结果必须保留");

	menu.component.handleInput("n");
	assert.deepEqual(await menu.outcome, { type: "shortcut", shortcut: "new" });
});

test("底部提示在窄终端折行而不是被截断丢失", () => {
	const menu = openMenu([{ id: "a", label: "A" }], { index: 0 }, [], {
		hints: [
			{ key: "↑↓", label: "选择" },
			{ key: "Enter", label: "进入" },
			{ key: "n", label: "新建接入" },
			{ key: "d", label: "删除接入" },
			{ key: "Esc", label: "退出" },
		],
	});
	const lines = menu.component.render(40);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 40, `渲染行超出宽度：${line}`);
	}
	const rendered = lines.join("\n");
	for (const hint of ["选择", "进入", "新建接入", "删除接入", "退出"]) {
		assert.match(rendered, new RegExp(hint), `窄终端下丢失了提示：${hint}`);
	}
	menu.component.handleInput(Key.escape);
});

test("超出可视行数时显示滚动条与位置，且不超出宽度", () => {
	const rows = Array.from({ length: 25 }, (_, index) => ({ id: `${index}`, label: `row-${index}` }));
	const menu = openMenu(rows, { index: 0 });
	const lines = menu.component.render(40);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 40, `渲染行超出宽度：${line}`);
	}
	const rendered = lines.join("\n");
	assert.match(rendered, /█/, "应显示滚动条滑块");
	assert.match(rendered, /1-18 \/ 25/, "应显示当前窗口位置");
	menu.component.handleInput(Key.escape);
});

test("矮终端优先保留快捷键提示，详情与摘要依次让位", () => {
	const rows = Array.from({ length: 8 }, (_, index) => ({ id: `${index}`, label: `provider-${index}` }));
	const menuOptions: PersistentMenuOptions = {
		summaryLines: ["8 接入 · 7 模型"],
		tableHeader: "  接入        API",
		getDetailLines: () => ["Relay (relay)", "  endpoint  https://api.example.com/v1", "  proxy     direct"],
		hints: [
			{ key: "↑↓", label: "选择" },
			{ key: "Enter", label: "进入" },
			{ key: "N", label: "新建接入" },
			{ key: "Esc", label: "退出" },
		],
	};

	// pi 在菜单下方还有输入框，组件必须把总行数压在 terminalRows - 3 以内。
	for (const terminalRows of [24, 20, 16, 12]) {
		const menu = openMenu(rows, { index: 0 }, [], menuOptions, terminalRows);
		const lines = menu.component.render(90);
		assert.ok(
			lines.length <= terminalRows - 3,
			`终端 ${terminalRows} 行时渲染了 ${lines.length} 行，会把底部提示顶出屏幕`,
		);
		assert.match(lines.join("\n"), /Esc 退出/, `终端 ${terminalRows} 行时丢失了快捷键提示`);
		menu.component.handleInput(Key.escape);
	}

	// 高度足够时详情区必须回来。
	const roomy = openMenu(rows, { index: 0 }, [], menuOptions, 40);
	assert.match(roomy.component.render(90).join("\n"), /endpoint/);
	roomy.component.handleInput(Key.escape);
});

test("快捷键提示显示为大写，Shift 组合命中同一动作", async () => {
	const menu = openMenu([{ id: "a", label: "A" }], { index: 0 }, [{ input: "n", shortcut: "new" }]);
	menu.component.handleInput("N");
	assert.deepEqual(await menu.outcome, { type: "shortcut", shortcut: "new" });
});

test("横向切换在组件内完成，不销毁重建菜单", async () => {
	let visionEnabled = false;
	let thinkingEnabled = false;
	let adaptiveToggled = false;
	// [喵喵喵]: Thinking 开启后才出现 Adaptive 行，用来盯住“新出现的开关行也必须可调整”。
	const buildFormRows = (): MenuRow[] => [
		{ id: "visionInput", label: `视觉支持        ${visionEnabled ? "开启" : "关闭"}`, adjustable: true },
		{ id: "reasoning", label: `Thinking        ${thinkingEnabled ? "开启" : "关闭"}`, adjustable: true },
		...(thinkingEnabled ? [{ id: "adaptive", label: "Adaptive        Adaptive", adjustable: true }] : []),
		{ id: "modelId", label: "模型 ID       gpt-5.6-sol" },
	];

	let component: MenuHarness["component"] | undefined;
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
		},
	} as any;

	const outcome = showPersistentFormMenu(ctx, "编辑模型", "", buildFormRows(), { index: 0 }, {
		onAdjust: (id) => {
			if (id === "visionInput") visionEnabled = !visionEnabled;
			else if (id === "reasoning") thinkingEnabled = !thinkingEnabled;
			else if (id === "adaptive") adaptiveToggled = true;
			else return undefined;
			return buildFormRows();
		},
	});
	assert.ok(component, "表单菜单应同步创建");
	assert.match(component.render(80).join("\n"), /视觉支持\s+关闭/);

	component.handleInput(Key.right);

	// 早期实现在这里 done() 结束组件，由调用方重开一个新组件，终端上表现为闪烁。
	const pending = Symbol("pending");
	const settled = await Promise.race([
		outcome,
		new Promise((resolve) => { setImmediate(() => resolve(pending)); }),
	]);
	assert.equal(settled, pending, "横向切换不应结束组件");
	assert.match(component.render(80).join("\n"), /视觉支持\s+开启/, "切换后应就地刷新为新值");

	// 开启 Thinking 会新增 Adaptive 行；可调整集合若在创建时固定，新行按 ←→ 就会没反应。
	component.handleInput(Key.down);
	component.handleInput(Key.right);
	assert.match(component.render(80).join("\n"), /Adaptive/, "开启 Thinking 后应出现 Adaptive 行");
	component.handleInput(Key.down);
	component.handleInput(Key.right);
	assert.ok(adaptiveToggled, "行重建后新出现的开关行也必须能用 ←→ 调整");

	component.handleInput(Key.escape);
	assert.deepEqual(await outcome, { type: "cancel" });
});
