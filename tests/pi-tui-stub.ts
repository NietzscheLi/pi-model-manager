export const CURSOR_MARKER = "<CURSOR>";

export const Key = {
	escape: "<ESC>",
	backspace: "<BACKSPACE>",
	delete: "<DELETE>",
	left: "<LEFT>",
	right: "<RIGHT>",
	up: "<UP>",
	down: "<DOWN>",
	pageUp: "<PAGE_UP>",
	pageDown: "<PAGE_DOWN>",
	home: "<HOME>",
	end: "<END>",
	enter: "<ENTER>",
	tab: "<TAB>",
	ctrl: (key: string) => `<CTRL_${key}>`,
} as const;

export function matchesKey(input: string, key: string): boolean {
	return input === key;
}
function characterWidth(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint >= 0x1100 ? 2 : 1;
}

export function visibleWidth(text: string): number {
	return Array.from(text.replaceAll(CURSOR_MARKER, ""))
		.reduce((width, character) => width + characterWidth(character), 0);
}

export function truncateToWidth(text: string, width: number, ellipsis = ""): string {
	if (visibleWidth(text) <= width) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	let output = "";
	let used = 0;
	for (let index = 0; index < text.length;) {
		if (text.startsWith(CURSOR_MARKER, index)) {
			output += CURSOR_MARKER;
			index += CURSOR_MARKER.length;
			continue;
		}
		const character = String.fromCodePoint(text.codePointAt(index)!);
		const nextWidth = characterWidth(character);
		if (used + nextWidth + ellipsisWidth > width) break;
		output += character;
		used += nextWidth;
		index += character.length;
	}
	return `${output}${ellipsisWidth <= width ? ellipsis : ""}`;
}
