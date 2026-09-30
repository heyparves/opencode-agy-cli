interface StoreEntry {
    conversationId: string | null;
    prevOutput: string;
}
export interface AcquireLockOptions {
    staleTimeoutMs?: number;
    isAlive?: (pid: number) => boolean;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
}
export declare function tryAcquireLock(lockPath: string, options?: AcquireLockOptions): Promise<(() => Promise<void>) | null>;
export declare class SessionStore {
    private stateFile;
    constructor(stateFile?: string);
    /**
     * Acquires a global lock for the bind-while-running phase.
     * Prevents concurrent agy instances from creating ambiguous .pb files.
     */
    static acquireBindingLock(options?: AcquireLockOptions): Promise<() => Promise<void>>;
    getEntry(sessionId: string): Promise<StoreEntry | null>;
    set(sessionId: string, conversationId: string | null, prevOutput?: string): Promise<void>;
    private loadStore;
    private loadStoreUnlocked;
}
export {};
