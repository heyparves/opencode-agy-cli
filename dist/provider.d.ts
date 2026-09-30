import type { ProviderV2, LanguageModelV2 } from "@ai-sdk/provider";
export interface AgyProviderOptions {
    binary?: string;
    conversationsDir?: string;
    stateFile?: string;
    extraArgs?: string[];
    timeoutMs?: number;
    model?: string;
    effort?: string;
    cwd?: string;
}
export declare function extractDelta(prevOutput: string, fullText: string, conversationBound: boolean): string;
export declare function createAgyProvider(opts?: AgyProviderOptions): ProviderV2 & {
    (modelId?: string, modelOpts?: {
        effort?: string;
    }): LanguageModelV2;
    provider: string;
};
export default function defaultFactory(opts?: AgyProviderOptions): ProviderV2;
