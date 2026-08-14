// 跨 Pi 进程的配置 mutation 锁。只约束遵守本锁的插件写入，外部编辑器冲突另由内容签名检测。

import { hostname } from "node:os";
import { open, mkdir, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { t } from "./i18n.ts";
import { STATE_DIR } from "./state-metadata-store.ts";

interface ConfigurationLockRecord {
	token: string;
	pid: number;
	hostname: string;
	startedAt: string;
}

interface HeldConfigurationLock {
	handle: FileHandle;
	record: ConfigurationLockRecord;
}

const LOCK_PATH = join(STATE_DIR, "config.lock");
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const INVALID_LOCK_STALE_MS = 30_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function parseLockRecord(source: string): ConfigurationLockRecord | undefined {
	try {
		const parsed = JSON.parse(source) as Partial<ConfigurationLockRecord>;
		if (typeof parsed.token !== "string" || !parsed.token) return undefined;
		if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return undefined;
		if (typeof parsed.hostname !== "string" || !parsed.hostname) return undefined;
		if (typeof parsed.startedAt !== "string" || !parsed.startedAt) return undefined;
		return parsed as ConfigurationLockRecord;
	} catch {
		return undefined;
	}
}

function isSameHostProcessRunning(record: ConfigurationLockRecord): boolean {
	if (record.hostname !== hostname()) return true;
	try {
		process.kill(record.pid, 0);
		return true;
	} catch (error) {
		return getErrorCode(error) !== "ESRCH";
	}
}

async function removeInactiveLock(): Promise<boolean> {
	let source: string;
	try {
		source = await readFile(LOCK_PATH, "utf8");
	} catch (error) {
		return getErrorCode(error) === "ENOENT";
	}
	const record = parseLockRecord(source);
	if (record && isSameHostProcessRunning(record)) return false;
	if (!record) {
		try {
			const lockStats = await stat(LOCK_PATH);
			if (Date.now() - lockStats.mtimeMs < INVALID_LOCK_STALE_MS) return false;
		} catch (error) {
			return getErrorCode(error) === "ENOENT";
		}
	}
	try {
		await unlink(LOCK_PATH);
		return true;
	} catch (error) {
		return getErrorCode(error) === "ENOENT";
	}
}

async function acquireConfigurationLock(): Promise<HeldConfigurationLock> {
	await mkdir(STATE_DIR, { recursive: true });
	const record: ConfigurationLockRecord = {
		token: randomUUID(),
		pid: process.pid,
		hostname: hostname(),
		startedAt: new Date().toISOString(),
	};

	for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			const handle = await open(LOCK_PATH, "wx");
			try {
				await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
				await handle.sync();
				return { handle, record };
			} catch (error) {
				await handle.close().catch(() => undefined);
				await unlink(LOCK_PATH).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			if (getErrorCode(error) !== "EEXIST") throw error;
			if (await removeInactiveLock()) continue;
			if (attempt === LOCK_RETRY_DELAYS_MS.length) break;
			await sleep(LOCK_RETRY_DELAYS_MS[attempt]!);
		}
	}
	throw new Error(t("另一个 Pi 进程正在保存模型配置；无法在限定时间内获取锁：{path}", { path: LOCK_PATH }));
}

async function releaseConfigurationLock(lock: HeldConfigurationLock): Promise<void> {
	await lock.handle.close();
	let current: ConfigurationLockRecord | undefined;
	try {
		current = parseLockRecord(await readFile(LOCK_PATH, "utf8"));
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return;
		throw error;
	}
	if (current?.token !== lock.record.token) {
		throw new Error(t("配置锁所有权在释放前发生变化，已保留锁文件供检查：{path}", { path: LOCK_PATH }));
	}
	await unlink(LOCK_PATH);
}

export async function withConfigurationLock<T>(operation: () => Promise<T>): Promise<T> {
	const lock = await acquireConfigurationLock();
	try {
		return await operation();
	} finally {
		await releaseConfigurationLock(lock);
	}
}
