import assert from "node:assert/strict";
import test from "node:test";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import {
	showPersistentShortcutMenu,
	type MenuCursor,
	type MenuRow,
	type MenuShortcut,
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
): MenuHarness {
	let component: MenuHarness["component"] | undefined;
	const ctx = {
		ui: {
			custom(factory: any) {
				return new Promise((resolve) => {
					component = factory(
						{ requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
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
