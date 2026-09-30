import type { LanguageModelV2CallWarning, LanguageModelV2Prompt } from "@ai-sdk/provider";
export declare function flattenPrompt(prompt: LanguageModelV2Prompt): string;
export declare function mapPrompt(prompt: LanguageModelV2Prompt): {
    prompt: string;
    warnings: LanguageModelV2CallWarning[];
};
