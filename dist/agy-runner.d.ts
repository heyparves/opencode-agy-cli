export interface RunAgyInput {
    prompt: string;
    cwd: string;
    conversationId?: string;
    model?: string;
    effort?: string;
    binary?: string;
    extraArgs?: string[];
    timeoutMs?: number;
    abortSignal?: AbortSignal;
}
export interface RunAgyResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    conversationId?: string;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}
export type AgyStreamEvent = {
    type: "text";
    text: string;
} | {
    type: "conversation";
    id: string;
};
export declare function runAgyStream(input: RunAgyInput, onEvent: (event: AgyStreamEvent) => void): Promise<RunAgyResult>;
export declare function runAgy(input: RunAgyInput): Promise<RunAgyResult>;
