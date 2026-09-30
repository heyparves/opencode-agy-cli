export declare function defaultConversationsDir(): string;
export declare function snapshot(dir: string): Promise<Set<string>>;
export declare function findNewConversation(before: Set<string>, dir: string): Promise<string | null>;
