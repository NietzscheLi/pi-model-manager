// 小型配置文件的稳定读取与强内容签名。

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { t } from "./i18n.ts";

export interface FileSignature {
	exists: boolean;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
}

export interface StableTextFileSnapshot {
	source: string | undefined;
	signature: FileSignature;
	contentHash: string;
}

const MISSING_FILE_SIGNATURE: FileSignature = { exists: false, mtimeMs: 0, ctimeMs: 0, size: -1, ino: 0 };

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function hashTextContent(source: string | undefined): string {
	const hash = createHash("sha256");
	hash.update(source === undefined ? "missing\0" : "present\0");
	if (source !== undefined) hash.update(source);
	return hash.digest("hex");
}

export async function readFileSignature(path: string): Promise<FileSignature> {
	try {
		const stats = await stat(path);
		return { exists: true, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size, ino: stats.ino };
	} catch (error) {
		if (isNotFound(error)) return MISSING_FILE_SIGNATURE;
		throw error;
	}
}

export function sameFileSignature(left: FileSignature, right: FileSignature): boolean {
	return left.exists === right.exists
		&& left.mtimeMs === right.mtimeMs
		&& left.ctimeMs === right.ctimeMs
		&& left.size === right.size
		&& left.ino === right.ino;
}

/** 文件在读取窗口内变化时重试，避免把旧内容和新签名组合成同一个 snapshot。 */
export async function readStableTextFileSnapshot(path: string): Promise<StableTextFileSnapshot> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const before = await readFileSignature(path);
		if (!before.exists) {
			const after = await readFileSignature(path);
			if (sameFileSignature(before, after)) {
				return { source: undefined, signature: after, contentHash: hashTextContent(undefined) };
			}
			continue;
		}

		let source: string;
		try {
			source = await readFile(path, "utf8");
		} catch (error) {
			if (isNotFound(error)) continue;
			throw error;
		}
		const after = await readFileSignature(path);
		if (sameFileSignature(before, after)) {
			return { source, signature: after, contentHash: hashTextContent(source) };
		}
	}
	throw new Error(t("{path} 在读取期间持续变化；请停止其它写入后重试。", { path }));
}
