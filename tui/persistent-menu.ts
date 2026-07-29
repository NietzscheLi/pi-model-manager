// tui/persistent-menu.ts
//
// 共享的"光标记忆"菜单组件，用 ctx.ui.custom 实现。
// 调用方在循环间持有 cursor: { index } 引用，菜单进出时光标位置不丢。
//
// 设计：列表页保留 KISS 的键盘模型，同时支持摘要、列头、详情区、底部快捷键。
// 表单页另有 Ctrl+S 保存；列表页可注册单键快捷操作，并用 / 做轻量过滤。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface MenuRow {
	id: string;
	label: string;
	description?: string | readonly string[];
}

export interface PersistentMenuOptions {
	summaryLines?: readonly string[];
	tableHeader?: string | ((width: number) => string);
	formatRow?: (row: MenuRow, width: number) => string;
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

function fitSearchQueryAroundCursor(query: string, cursor: number, cursorGlyph: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const characters = Array.from(query);
	const cursorWidth = visibleWidth(cursorGlyph);
	const textBudget = Math.max(0, maxWidth - cursorWidth);
	let beforeCursor = "";
	let beforeWidth = 0;
	for (let index = Math.min(cursor, characters.length) - 1; index >= 0; index -= 1) {
		const character = characters[index]!;
		const characterWidth = visibleWidth(character);
		if (beforeWidth + characterWidth > textBudget) break;
		beforeCursor = character + beforeCursor;
		beforeWidth += characterWidth;
	}
	let afterCursor = "";
	let afterWidth = 0;
	for (let index = Math.min(cursor, characters.length); index < characters.length; index += 1) {
		const character = characters[index]!;
		const characterWidth = visibleWidth(character);
		if (beforeWidth + afterWidth + characterWidth > textBudget) break;
		afterCursor += character;
		afterWidth += characterWidth;
	}
	return `${beforeCursor}${cursorGlyph}${afterCursor}`;
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
		let searchCursor = 0;
		let focused = false;
		const visibleRows = options.visibleRows ?? 18;
		const searchable = options.searchable ?? false;

		const getActiveRows = (): MenuRow[] => searchable ? filterRows(rows, searchQuery) : rows;

		const syncCursor = (activeRows: MenuRow[]): void => {
			const row = activeRows[selectedIndex];
			if (row) cursor.index = rows.indexOf(row);
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
			searchCursor = 0;
			selectedIndex = clampIndex(cursor.index, rows.length);
			requestRender();
			return true;
		};

		const replaceSearchQuery = (nextQuery: string, nextCursor: number): void => {
			const selectedRow = getActiveRows()[selectedIndex];
			searchQuery = nextQuery;
			searchCursor = clampIndex(nextCursor, Array.from(searchQuery).length + 1);
			const nextRows = getActiveRows();
			const retainedIndex = selectedRow ? nextRows.indexOf(selectedRow) : -1;
			selectedIndex = retainedIndex >= 0 ? retainedIndex : 0;
			requestRender();
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
			get focused(): boolean {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
			},
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

				if (searchable && searchActive) {
					const queryCharacters = Array.from(searchQuery);
					if (matchesKey(data, Key.backspace)) {
						if (searchCursor > 0) {
							queryCharacters.splice(searchCursor - 1, 1);
							replaceSearchQuery(queryCharacters.join(""), searchCursor - 1);
						}
						return;
					}
					if (matchesKey(data, Key.delete)) {
						if (searchCursor < queryCharacters.length) {
							queryCharacters.splice(searchCursor, 1);
							replaceSearchQuery(queryCharacters.join(""), searchCursor);
						}
						return;
					}
					if (matchesKey(data, Key.left)) {
						searchCursor = Math.max(0, searchCursor - 1);
						requestRender();
						return;
					}
					if (matchesKey(data, Key.right)) {
						searchCursor = Math.min(queryCharacters.length, searchCursor + 1);
						requestRender();
						return;
					}
					if (matchesKey(data, Key.home)) {
						searchCursor = 0;
						requestRender();
						return;
					}
					if (matchesKey(data, Key.end)) {
						searchCursor = queryCharacters.length;
						requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						pickSelected();
						return;
					}
					if (isSearchTextInput(data)) {
						queryCharacters.splice(searchCursor, 0, ...Array.from(data));
						replaceSearchQuery(queryCharacters.join(""), searchCursor + Array.from(data).length);
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
					searchCursor = Array.from(searchQuery).length;
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
					const cursorGlyph = focused ? `${CURSOR_MARKER}${theme.fg("accent", "▌")}` : "";
					const searchPrefix = theme.fg("accent", "搜索：");
					const queryWidth = Math.max(0, width - visibleWidth(searchPrefix));
					const queryDisplay = searchQuery
						? fitSearchQueryAroundCursor(searchQuery, searchCursor, cursorGlyph, queryWidth)
						: `${cursorGlyph}${theme.fg("dim", "<输入关键词>")}`;
					lines.push(truncateToWidth(`${searchPrefix}${queryDisplay}`, width, ""));
				}
				lines.push("");

				const tableHeader = typeof options.tableHeader === "function"
					? options.tableHeader(width)
					: options.tableHeader;
				if (tableHeader) lines.push(truncateToWidth(theme.fg("dim", tableHeader), width));

				if (shownRows.length === 0) {
					const emptyLabel = searchQuery ? `无匹配项：${searchQuery}` : options.emptyLabel ?? "暂无条目";
					lines.push(truncateToWidth(theme.fg("dim", `  ${emptyLabel}`), width));
				} else {
					for (let i = 0; i < shownRows.length; i += 1) {
						const absoluteIndex = windowStart + i;
						const row = shownRows[i]!;
						const selected = absoluteIndex === selectedIndex;
						const prefix = selected ? "❯ " : "  ";
						const rowLabel = options.formatRow?.(row, Math.max(0, width - visibleWidth(prefix))) ?? row.label;
						const line = `${prefix}${rowLabel}`;
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
