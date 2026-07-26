// Windows 友好的配置文件持久化写入。
//
// 目标文件可能被正在运行的 pi、编辑器、杀软或索引器短暂占用。
// 直接 rename(tmp, target) 在 Windows 上会留下 tmp 且正式配置不变；这里统一
// 处理重试、降级覆盖与失败时的可恢复临时文件提示。

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;
const TRANSIENT_REPLACE_ERROR_CODES = new Set(["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function isTransientReplaceError(error: unknown): boolean {
	const code = getErrorCode(error);
	return code !== undefined && TRANSIENT_REPLACE_ERROR_CODES.has(code);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function removeTempFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// 清理失败不应掩盖真实保存结果；失败场景会把 tmp 路径报告给用户用于恢复。
	}
}

async function renameWithRetry(sourcePath: string, targetPath: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			await rename(sourcePath, targetPath);
			return;
		} catch (error) {
			lastError = error;
			if (!isTransientReplaceError(error) || attempt === REPLACE_RETRY_DELAYS_MS.length) break;
			await sleep(REPLACE_RETRY_DELAYS_MS[attempt]!);
		}
	}
	throw lastError;
}

async function copyOverTargetWithRetry(sourcePath: string, targetPath: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			await copyFile(sourcePath, targetPath);
			await removeTempFile(sourcePath);
			return;
		} catch (error) {
			lastError = error;
			if (!isTransientReplaceError(error) || attempt === REPLACE_RETRY_DELAYS_MS.length) break;
			await sleep(REPLACE_RETRY_DELAYS_MS[attempt]!);
		}
	}
	throw lastError;
}

async function replaceTargetFile(sourcePath: string, targetPath: string): Promise<void> {
	try {
		await renameWithRetry(sourcePath, targetPath);
	} catch (renameError) {
		if (process.platform !== "win32" || !isTransientReplaceError(renameError)) throw renameError;
		// [喵喵喵]: Windows 上 rename 覆盖会被短暂文件锁拦截；重试后降级 copyFile，避免配置保存停留在 tmp (2026-06-21)
		try {
			await copyOverTargetWithRetry(sourcePath, targetPath);
		} catch (copyError) {
			throw new Error(`rename 失败：${formatError(renameError)}；copy 覆盖也失败：${formatError(copyError)}`);
		}
	}
}

export async function atomicWriteText(targetPath: string, content: string): Promise<void> {
	await mkdir(dirname(targetPath), { recursive: true });
	const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	let tempHasCompleteContent = false;

	try {
		await writeFile(tempPath, content, "utf8");
		tempHasCompleteContent = true;
		await replaceTargetFile(tempPath, targetPath);
	} catch (error) {
		if (!tempHasCompleteContent) await removeTempFile(tempPath);
		const recoveryNote = tempHasCompleteContent ? `；完整内容已保留在临时文件：${tempPath}` : "";
		throw new Error(`写入 ${targetPath} 失败${recoveryNote}：${formatError(error)}`);
	}
}
