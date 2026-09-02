// openai-responses-payload.ts
//
// 将 pi 内置 openai-responses 的 system/developer input 形态调整为标准
// OpenAI Responses wire format：顶层 instructions + 纯对话 input。

import { isObjectRecord } from "./common.ts";
import type { StateDocument } from "./types.ts";

type ActiveModelRef = {
	provider: string;
	id: string;
	api: string;
};

type PayloadRecord = Record<string, unknown>;

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return isObjectRecord(payload);
}

function isPromptRole(role: unknown): role is "developer" | "system" {
	return role === "developer" || role === "system";
}

function extractTextInstruction(content: unknown): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed ? content : undefined;
	}
	if (!Array.isArray(content)) return undefined;

	const parts: string[] = [];
	for (const item of content) {
		if (!isObjectRecord(item)) return undefined;
		const type = item.type;
		if (type !== "input_text" && type !== "text") return undefined;
		if (typeof item.text !== "string") return undefined;
		if (item.text.trim()) parts.push(item.text);
	}
	const instruction = parts.join("\n");
	return instruction.trim() ? instruction : undefined;
}

function hasNonEmptyInstructions(payload: PayloadRecord): boolean {
	return typeof payload.instructions === "string" && payload.instructions.trim().length > 0;
}

function normalizeOpenAIResponsesInstructionsPayload(payload: unknown): PayloadRecord | undefined {
	if (!isPayloadRecord(payload)) return undefined;
	if (hasNonEmptyInstructions(payload)) return undefined;

	const input = payload.input;
	if (!Array.isArray(input) || input.length === 0) return undefined;

	const leadingItem = input[0];
	if (!isObjectRecord(leadingItem) || !isPromptRole(leadingItem.role)) return undefined;

	const instructions = extractTextInstruction(leadingItem.content);
	if (!instructions) return undefined;

	return {
		...payload,
		instructions,
		input: input.slice(1),
	};
}

export function normalizeManagedOpenAIResponsesPayload(
	payload: unknown,
	model: ActiveModelRef | undefined,
	state: StateDocument,
): PayloadRecord | undefined {
	if (!model || model.api !== "openai-responses") return undefined;
	if (!isPayloadRecord(payload) || payload.model !== model.id) return undefined;

	const storedModel = state.providers[model.provider]?.models.find((candidate) => candidate.id === model.id);
	if (!storedModel) return undefined;

	return normalizeOpenAIResponsesInstructionsPayload(payload);
}
