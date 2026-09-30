import { readFile, writeFile, rename, mkdir, open, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const DEFAULT_STALE_TIMEOUT_MS = 30_000;
function defaultStateFile() {
    return join(homedir(), ".opencode-agy-plugin", "sessions.json");
}
function defaultBindingLockPath() {
    return join(homedir(), ".opencode-agy-plugin", "binding.lock");
}
function abortError(signal) {
    const reason = signal.reason;
    const error = new Error(reason instanceof Error ? reason.message : "The operation was aborted");
    error.name = "AbortError";
    if (reason instanceof Error && reason.stack) {
        error.stack = reason.stack;
    }
    return error;
}
function timeoutError() {
    const error = new Error("Timed out acquiring lock");
    error.name = "TimeoutError";
    return error;
}
function throwIfCancelled(signal, deadline) {
    if (signal?.aborted) {
        throw abortError(signal);
    }
    if (deadline !== undefined && Date.now() >= deadline) {
        throw timeoutError();
    }
}
function sleep(ms, signal, deadline) {
    const delay = deadline === undefined ? ms : Math.min(ms, Math.max(0, deadline - Date.now()));
    return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(abortError(signal));
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        timer = setTimeout(() => {
            cleanup();
            if (deadline !== undefined && Date.now() >= deadline) {
                reject(timeoutError());
            }
            else {
                resolve();
            }
        }, delay);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function errCode(error) {
    if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}
function defaultIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return errCode(error) === "EPERM";
    }
}
function parseLock(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed &&
            typeof parsed === "object" &&
            typeof parsed.token === "string" &&
            typeof parsed.pid === "number") {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
async function createLockFile(lockPath, token) {
    let fh;
    try {
        fh = await open(lockPath, "wx");
    }
    catch (error) {
        if (errCode(error) === "EEXIST") {
            return "exists";
        }
        throw error;
    }
    try {
        await fh.writeFile(JSON.stringify({ token, pid: process.pid }));
        const info = await fh.stat();
        await fh.close().catch(() => { });
        return { token, dev: info.dev, ino: info.ino };
    }
    catch (error) {
        await unlink(lockPath).catch(() => { });
        await fh.close().catch(() => { });
        throw error;
    }
}
async function maybeStealStaleLock(lockPath, staleTimeoutMs, isAlive) {
    try {
        const parsed = parseLock(await readFile(lockPath, "utf-8"));
        if (parsed) {
            if (!isAlive(parsed.pid)) {
                await unlink(lockPath);
            }
            return;
        }
        const stats = await stat(lockPath);
        if (Date.now() - stats.mtimeMs >= staleTimeoutMs) {
            await unlink(lockPath);
        }
    }
    catch {
        return;
    }
}
function releaseLock(lockPath, identity) {
    return async () => {
        try {
            const pathStat = await stat(lockPath);
            if (pathStat.dev !== identity.dev || pathStat.ino !== identity.ino) {
                return;
            }
            const current = parseLock(await readFile(lockPath, "utf-8"));
            if (!current || current.token !== identity.token) {
                return;
            }
            await unlink(lockPath);
        }
        catch {
            return;
        }
    };
}
export async function tryAcquireLock(lockPath, options = {}) {
    const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    const isAlive = options.isAlive ?? defaultIsAlive;
    const token = randomUUID();
    await mkdir(dirname(lockPath), { recursive: true });
    const first = await createLockFile(lockPath, token);
    if (first !== "exists") {
        return releaseLock(lockPath, first);
    }
    await maybeStealStaleLock(lockPath, staleTimeoutMs, isAlive);
    const second = await createLockFile(lockPath, token);
    if (second === "exists") {
        return null;
    }
    return releaseLock(lockPath, second);
}
async function acquireLock(lockPath, options = {}) {
    let backoff = 1;
    const maxBackoff = 500;
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    for (;;) {
        throwIfCancelled(options.abortSignal, deadline);
        const got = await tryAcquireLock(lockPath, options);
        if (got) {
            try {
                throwIfCancelled(options.abortSignal, deadline);
            }
            catch (error) {
                await got();
                throw error;
            }
            return got;
        }
        await sleep(backoff, options.abortSignal, deadline);
        backoff = Math.min(backoff * 2, maxBackoff);
    }
}
export class SessionStore {
    stateFile;
    constructor(stateFile) {
        this.stateFile = stateFile ?? defaultStateFile();
    }
    /**
     * Acquires a global lock for the bind-while-running phase.
     * Prevents concurrent agy instances from creating ambiguous .pb files.
     */
    static acquireBindingLock(options = {}) {
        return acquireLock(defaultBindingLockPath(), options);
    }
    async getEntry(sessionId) {
        const store = await this.loadStore();
        return store.sessions[sessionId] ?? null;
    }
    async set(sessionId, conversationId, prevOutput = "") {
        const stateDir = dirname(this.stateFile);
        await mkdir(stateDir, { recursive: true });
        const lockPath = this.stateFile + ".lock";
        const release = await acquireLock(lockPath);
        try {
            const store = await this.loadStoreUnlocked();
            store.sessions[sessionId] = {
                conversationId,
                prevOutput,
            };
            const tmpPath = this.stateFile + ".tmp";
            await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
            await rename(tmpPath, this.stateFile);
        }
        finally {
            await release();
        }
    }
    async loadStore() {
        const stateDir = dirname(this.stateFile);
        await mkdir(stateDir, { recursive: true });
        const lockPath = this.stateFile + ".lock";
        const release = await acquireLock(lockPath);
        try {
            return await this.loadStoreUnlocked();
        }
        finally {
            await release();
        }
    }
    async loadStoreUnlocked() {
        let raw;
        try {
            raw = await readFile(this.stateFile, "utf-8");
        }
        catch (err) {
            if (err.code === "ENOENT") {
                return { sessions: {} };
            }
            throw err;
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed) ||
            typeof parsed.sessions !== "object" ||
            parsed.sessions === null ||
            Array.isArray(parsed.sessions)) {
            throw new Error("Invalid session store state format");
        }
        const sessions = parsed.sessions;
        for (const [key, entry] of Object.entries(sessions)) {
            if (typeof entry !== "object" ||
                entry === null ||
                Array.isArray(entry)) {
                throw new Error(`Invalid session store state format: entry "${key}" must be an object`);
            }
            const { conversationId, processedMessages, prevOutput } = entry;
            if (typeof conversationId !== "string" && conversationId !== null) {
                throw new Error(`Invalid session store state format: entry "${key}" conversationId must be a string or null`);
            }
            if (processedMessages !== undefined &&
                (typeof processedMessages !== "number" ||
                    !Number.isInteger(processedMessages) ||
                    processedMessages < 0)) {
                throw new Error(`Invalid session store state format: entry "${key}" processedMessages must be a non-negative integer`);
            }
            if (typeof prevOutput !== "string") {
                throw new Error(`Invalid session store state format: entry "${key}" prevOutput must be a string`);
            }
        }
        return { sessions: sessions };
    }
}
