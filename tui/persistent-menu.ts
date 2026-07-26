// tui/persistent-menu.ts
//
// 共享的"光标记忆"菜单组件，用 ctx.ui.custom 实现。
// 调用方在循环间持有 cursor: { index } 引用，菜单进出时光标位置不丢。
//
// 设计：列表页保留 KISS 的键盘模型，同时支持摘要、列头、详情区、底部快捷键。
// 表单页另有 Ctrl+S 保存；列表页可注册单键快捷操作，并用 / 做轻量过滤。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface MenuRow {
	id: string;
	label: string;
	description?: string | readonly string[];
}

export interface PersistentMenuOptions {
	summaryLines?: readonly string[];
	tableHeader?: string;
	getDetailLines?: (selectedRow: MenuRow | undefined) => readonly string[];
	footer?: string;
	emptyLabel?: string;
	visibleRows?: number;
	searchable?: boolean;
}

export interface PersistentFormMenuOptions extends PersistentMenuOptions {
	adjustableRowIds?: readonly string[];
}

export type MenuAction =
	| { type: "pick"; id: string }
	| { type: "cancel" };

export type HorizontalDirection = "left" | "right";
export type FormMenuAction = MenuAction | { type: "save" } | { type: "adjust"; id: string; direction: HorizontalDirection };

export type ShortcutMenuAction<TShortcut extends string = string> = MenuAction | { type: "shortcut"; shortcut: TShortcut };

export interface MenuShortcut<TShortcut extends string = string> {
	input: string;
	shortcut: TShortcut;
}

export interface MenuCursor {
	index: number;
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.min(Math.max(0, index), length - 1);
}

function padToVisibleWidth(text: string, targetWidth: number): string {
	const pad = Math.max(0, targetWidth - visibleWidth(text));
	return text + " ".repeat(pad);
}

export function padLabel(label: string, columns: number): string {
	return padToVisibleWidth(label, columns);
}

function getDescriptionLines(row: MenuRow): string[] {
	const source = row.description;
	return typeof source === "string" ? source.split("\n") : [...(source ?? [])];
}

function getSearchText(row: MenuRow): string {
	return [row.id, row.label, ...getDescriptionLines(row)].join("\n").toLocaleLowerCase();
}

function filterRows(rows: MenuRow[], query: string): MenuRow[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return rows;
	return rows.filter((row) => getSearchText(row).includes(needle));
}

function isSearchTextInput(data: string): boolean {
	return data.length > 0 && !data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data);
}

function createPersistentMenu<TAction extends MenuAction | FormMenuAction | ShortcutMenuAction>(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	createSaveAction: (() => TAction) | undefined,
	shortcuts: MenuShortcut[],
	createAdjustAction: ((id: string, direction: HorizontalDirection) => TAction) | undefined = undefined,
	adjustableRowIds: ReadonlySet<string> = new Set(),
	options: PersistentMenuOptions = {},
): Promise<TAction> {
	cursor.index = clampIndex(cursor.index, rows.length);
	return ctx.ui.custom<TAction>((tui, theme, _keybindings, done) => {
		let selectedIndex = clampIndex(cursor.index, rows.length);
		let searchActive = false;
		let searchQuery = "";
		const visibleRows = options.visibleRows ?? 18;
		const searchable = options.searchable ?? false;

		const getActiveRows = (): MenuRow[] => searchable ? filterRows(rows, searchQuery) : rows;

		const syncCursor = (activeRows: MenuRow[]): void => {
			const row = activeRows[selectedIndex];
			cursor.index = row ? rows.indexOf(row) : rows.length;
		};

		const requestRender = (): void => {
			const activeRows = getActiveRows();
			selectedIndex = clampIndex(selectedIndex, activeRows.length);
			syncCursor(activeRows);
			tui.requestRender();
		};

		const clearSearch = (): boolean => {
			if (!searchable || (!searchActive && !searchQuery)) return false;
			searchActive = false;
			searchQuery = "";
			selectedIndex = clampIndex(cursor.index, rows.length);
			requestRender();
			return true;
		};

		const pickSelected = (): void => {
			const activeRows = getActiveRows();
			const row = activeRows[selectedIndex];
			if (!row) return;
			syncCursor(activeRows);
			done({ type: "pick", id: row.id } as TAction);
		};

		const moveSelection = (nextIndex: number): void => {
			selectedIndex = nextIndex;
			requestRender();
		};

		return {
			invalidate(): void {},
			handleInput(data: string): void {
				if (createSaveAction && matchesKey(data, Key.ctrl("s"))) {
					syncCursor(getActiveRows());
					done(createSaveAction());
					return;
				}
				const horizontalDirection: HorizontalDirection | undefined = matchesKey(data, Key.left)
					? "left"
					: matchesKey(data, Key.right)
						? "right"
						: undefined;
				if (horizontalDirection && createAdjustAction) {
					const row = getActiveRows()[selectedIndex];
					if (row && adjustableRowIds.has(row.id)) {
						syncCursor(getActiveRows());
						done(createAdjustAction(row.id, horizontalDirection));
					}
					return;
				}

				if (searchable && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
					if (clearSearch()) return;
					done({ type: "cancel" } as TAction);
					return;
				}

				// 搜索激活后，可打印字符必须进入查询，不能触发同名的菜单快捷键。
				if (searchable && searchActive) {
					if (matchesKey(data, Key.backspace)) {
						searchQuery = searchQuery.slice(0, -1);
						selectedIndex = 0;
						requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						pickSelected();
						return;
					}
					if (isSearchTextInput(data)) {
						searchQuery += data;
						selectedIndex = 0;
						requestRender();
						return;
					}
				}

				const shortcut = shortcuts.find((candidate) => candidate.input === data);
				if (shortcut) {
					syncCursor(getActiveRows());
					done({ type: "shortcut", shortcut: shortcut.shortcut } as TAction);
					return;
				}
				if (searchable && data === "/") {
					searchActive = true;
					requestRender();
					return;
				}

				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done({ type: "cancel" } as TAction);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					pickSelected();
					return;
				}

				const activeRows = getActiveRows();
				if (matchesKey(data, Key.up)) {
					moveSelection(Math.max(0, selectedIndex - 1));
					return;
				}
				if (matchesKey(data, Key.down)) {
					moveSelection(Math.min(activeRows.length - 1, selectedIndex + 1));
					return;
				}
				if (matchesKey(data, Key.pageUp)) {
					moveSelection(Math.max(0, selectedIndex - visibleRows));
					return;
				}
				if (matchesKey(data, Key.pageDown)) {
					moveSelection(Math.min(activeRows.length - 1, selectedIndex + visibleRows));
					return;
				}
				if (matchesKey(data, Key.home)) {
					moveSelection(0);
					return;
				}
				if (matchesKey(data, Key.end)) {
					moveSelection(activeRows.length - 1);
					return;
				}
			},
			render(width: number): string[] {
				const activeRows = getActiveRows();
				selectedIndex = clampIndex(selectedIndex, activeRows.length);
				syncCursor(activeRows);
				const windowStart = Math.max(
					0,
					Math.min(selectedIndex - Math.floor(visibleRows / 2), Math.max(0, activeRows.length - visibleRows)),
				);
				const shownRows = activeRows.slice(windowStart, windowStart + visibleRows);

				const border = theme.fg("borderMuted", "─".repeat(Math.max(0, Math.min(width, 100))));
				const summaryLines = options.summaryLines ?? (help ? help.split("\n") : []);
				const lines: string[] = [
					border,
					truncateToWidth(theme.fg("accent", theme.bold(title)), width),
				];

				for (const line of summaryLines) {
					lines.push(truncateToWidth(theme.fg("dim", line), width));
				}
				if (searchable && searchActive) {
					lines.push(truncateToWidth(theme.fg("accent", `搜索：${searchQuery || "<输入关键词>"}`), width));
				}
				lines.push("");

				if (options.tableHeader) {
					lines.push(truncateToWidth(theme.fg("dim", options.tableHeader), width));
				}

				if (shownRows.length === 0) {
					const emptyLabel = searchQuery ? `无匹配项：${searchQuery}` : options.emptyLabel ?? "暂无条目";
					lines.push(truncateToWidth(theme.fg("dim", `  ${emptyLabel}`), width));
				} else {
					for (let i = 0; i < shownRows.length; i += 1) {
						const absoluteIndex = windowStart + i;
						const row = shownRows[i]!;
						const selected = absoluteIndex === selectedIndex;
						const prefix = selected ? "❯ " : "  ";
						const line = `${prefix}${row.label}`;
						lines.push(truncateToWidth(selected ? theme.fg("accent", line) : line, width));
						for (const description of getDescriptionLines(row)) {
							lines.push(truncateToWidth(theme.fg("dim", `    ${description}`), width));
						}
					}
				}

				const detailLines = options.getDetailLines?.(activeRows[selectedIndex]) ?? [];
				if (detailLines.length > 0) {
					lines.push("", border);
					for (const line of detailLines) {
						lines.push(truncateToWidth(theme.fg("dim", line), width));
					}
				}

				const footerLines = options.footer ? options.footer.split("\n") : [];
				if (searchable) {
					footerLines.push(searchActive ? `/ 搜索：${searchQuery || "<输入关键词>"}   Backspace 删除   Esc 清空` : "/ 搜索");
				}
				if (footerLines.length > 0) {
					lines.push("");
					for (const line of footerLines) {
						lines.push(truncateToWidth(theme.fg("dim", line), width));
					}
				}

				lines.push(border);
				return lines.map((line) => truncateToWidth(line, width));
			},
		};
	});
}

export async function showPersistentMenu(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	options: PersistentMenuOptions = {},
): Promise<MenuAction> {
	return createPersistentMenu<MenuAction>(ctx, title, help, rows, cursor, undefined, [], undefined, undefined, options);
}

export async function showPersistentFormMenu(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	options: PersistentFormMenuOptions = {},
): Promise<FormMenuAction> {
	return createPersistentMenu<FormMenuAction>(
		ctx,
		title,
		help,
		rows,
		cursor,
		() => ({ type: "save" }),
		[],
		(id, direction) => ({ type: "adjust", id, direction }),
		new Set(options.adjustableRowIds ?? []),
		options,
	);
}

export async function showPersistentShortcutMenu<TShortcut extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	shortcuts: MenuShortcut<TShortcut>[],
	options: PersistentMenuOptions = {},
): Promise<ShortcutMenuAction<TShortcut>> {
	return createPersistentMenu<ShortcutMenuAction<TShortcut>>(ctx, title, help, rows, cursor, undefined, shortcuts, undefined, undefined, { searchable: true, ...options });
}
