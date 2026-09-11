// openai-responses-payload.ts
//
// 为受管理的 Responses 接入提取首条系统规则，保持顶层 instructions 的接入约定。

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


function normalizeOpenAIResponsesInstructionsPayload(payload: unknown): PayloadRecord | undefined {
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.instructions !== undefined) return undefined;

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

	const provider = state.providers[model.provider];
	if (!provider?.managed) return undefined;
	const storedModel = provider.models.find((candidate) => candidate.id === model.id);
	if (!storedModel || (storedModel.api ?? provider.api) !== model.api) return undefined;

	return normalizeOpenAIResponsesInstructionsPayload(payload);
}
