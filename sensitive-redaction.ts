// URL、错误文本与 Header 名称的统一敏感信息边界。

const SENSITIVE_NAME_PATTERN = /(?:authorization|api[-_]?key|token|secret|credential|cookie|password|passwd|proxy[-_]?authorization|access[-_]?key)/i;
const SENSITIVE_EXACT_NAMES = new Set(["key", "pwd"]);

function isSensitiveName(name: string): boolean {
	return SENSITIVE_EXACT_NAMES.has(name.trim().toLowerCase()) || SENSITIVE_NAME_PATTERN.test(name);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSensitiveHeaderName(name: string): boolean {
	return isSensitiveName(name);
}

export function redactUrlForDisplay(value: string): string {
	try {
		const url = new URL(value);
		if (url.username || url.password) {
			url.username = "REDACTED";
			url.password = "REDACTED";
		}
		for (const name of [...url.searchParams.keys()]) {
			if (isSensitiveName(name)) url.searchParams.set(name, "REDACTED");
		}
		return redactSensitiveText(url.toString());
	} catch {
		return redactSensitiveText(value);
	}
}

export function redactSensitiveText(value: string, secrets: readonly string[] = []): string {
	let redacted = value;
	for (const secret of secrets) {
		if (secret.length < 3) continue;
		redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "REDACTED");
	}
	redacted = redacted.replace(/([a-z][a-z\d+.-]*:\/\/)[^@\s/?#]+@/gi, "$1REDACTED@");
	redacted = redacted.replace(/(^|[\s("'=])[^@\s/?#]+:[^@\s/?#]+@/g, "$1REDACTED@");
	redacted = redacted.replace(/([?&](?:authorization|api[-_]?key|key|token|secret|credential|cookie|password|passwd|pwd|proxy[-_]?authorization|access[-_]?key)=)[^&#\s]+/gi, "$1REDACTED");
	redacted = redacted.replace(/((?:authorization|proxy[-_]?authorization)\s*[:=]\s*(?:Bearer|Basic)?\s*)[^\s,;]+/gi, "$1REDACTED");
	redacted = redacted.replace(/((?:x-api-key|api[-_]?key|key|token|secret|credential|cookie|password|passwd|pwd)\s*[:=]\s*)[^\s,;]+/gi, "$1REDACTED");
	return redacted;
}
