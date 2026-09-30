import { runAgyPersistent } from "./agy-process.js";
import { SessionStore } from "./session-store.js";
import { mapPrompt } from "./prompt-mapper.js";
import { randomUUID } from "node:crypto";
// PATCH(agy-fix): OpenCode >= 1.x uses the AI SDK LanguageModelV3 spec, which reads
// finishReason.unified and usage.inputTokens.total. The v2 string finishReason was
// recorded as "unknown", so OpenCode looped into a second step with no new user
// text and the plugin threw "agy bound turn has no current-turn text".
function v3FinishReason(reason) {
    return { unified: reason, raw: reason };
}
function v3Usage(usage) {
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    return {
        inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: output, text: output, reasoning: undefined },
    };
}
function lastUserText(prompt) {
    for (let i = prompt.length - 1; i >= 0; i--) {
        const msg = prompt[i];
        if (msg.role !== "user")
            continue;
        const text = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
                ? msg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
                : "";
        if (text.trim())
            return text;
    }
    return "";
}
// PATCH(agy-fix): the title agent's instructions live in the system prompt, which
// mapPrompt drops, so agy answered the user request in full (a whole second
// response) while holding the global binding lock. Build the title locally instead.
function localTitle(prompt) {
    const lines = lastUserText(prompt)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^generate a title/i.test(l) && !/^<\/?[a-z_-]+>$/i.test(l));
    const title = (lines[0] ?? "New session").replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "") || "New session";
    return title.length > 50 ? `${title.slice(0, 47).trimEnd()}...` : title;
}
// PATCH(agy-fix): agy runs its own tools silently for tens of seconds before it
// writes any answer text. Surface each tool step as live progress.
function describeTool(event) {
    const params = event.parameters && typeof event.parameters === "object" ? event.parameters : {};
    const detail = Object.values(params).find((v) => typeof v === "string" && v.trim());
    const short = detail ? detail.replace(/\s+/g, " ").trim() : "";
    const clipped = short.length > 100 ? `${short.slice(0, 97)}...` : short;
    return clipped ? `${event.name}: ${clipped}` : event.name;
}
// PATCH(agy-tools): agy's tool names are its own; OpenCode renders an "invalid"
// tool for anything outside its own registry, so map the common ones onto the
// built-ins (bash, read, edit, write, glob, grep, webfetch, task, todowrite).
function pickParam(params, keys) {
    for (const key of keys) {
        const hit = Object.entries(params).find(([k, v]) => k.toLowerCase() === key.toLowerCase() && typeof v === "string" && v.trim());
        if (hit)
            return hit[1];
    }
    return undefined;
}
const AGY_TOOL_MAP = {
    run_command: (p) => ({
        tool: "bash",
        input: { command: pickParam(p, ["CommandLine", "command"]) ?? "", description: pickParam(p, ["Description"]) ?? "agy command" },
    }),
    command_status: (p) => ({ tool: "bash", input: { command: pickParam(p, ["CommandId", "command"]) ?? "", description: "command status" } }),
    send_command_input: (p) => ({ tool: "bash", input: { command: pickParam(p, ["Input", "command"]) ?? "", description: "command input" } }),
    view_file: (p) => ({ tool: "read", input: { filePath: pickParam(p, ["AbsolutePath", "Path", "filePath"]) ?? "" } }),
    view_content_chunk: (p) => ({ tool: "read", input: { filePath: pickParam(p, ["AbsolutePath", "Path", "filePath"]) ?? "" } }),
    view_file_outline: (p) => ({ tool: "read", input: { filePath: pickParam(p, ["AbsolutePath", "Path", "filePath"]) ?? "" } }),
    read_resource: (p) => ({ tool: "read", input: { filePath: pickParam(p, ["Uri", "Path", "filePath"]) ?? "" } }),
    create_file: (p) => ({ tool: "write", input: { filePath: pickParam(p, ["TargetFile", "AbsolutePath", "Path", "filePath"]) ?? "", content: pickParam(p, ["CodeContent", "Content", "content"]) ?? "" } }),
    replace_file_content: (p) => ({ tool: "edit", input: { filePath: pickParam(p, ["TargetFile", "AbsolutePath", "Path", "filePath"]) ?? "" } }),
    multi_replace_file_content: (p) => ({ tool: "edit", input: { filePath: pickParam(p, ["TargetFile", "AbsolutePath", "Path", "filePath"]) ?? "" } }),
    sed_file: (p) => ({ tool: "edit", input: { filePath: pickParam(p, ["TargetFile", "AbsolutePath", "Path", "filePath"]) ?? "" } }),
    notebook_edit: (p) => ({ tool: "edit", input: { filePath: pickParam(p, ["NotebookPath", "TargetFile", "filePath"]) ?? "" } }),
    find_by_name: (p) => ({ tool: "glob", input: { pattern: pickParam(p, ["Pattern", "pattern"]) ?? "*", path: pickParam(p, ["SearchDirectory", "Path", "path"]) } }),
    list_dir: (p) => ({ tool: "glob", input: { pattern: "*", path: pickParam(p, ["DirectoryPath", "Path", "path"]) } }),
    grep_search: (p) => ({ tool: "grep", input: { pattern: pickParam(p, ["Query", "Pattern", "pattern"]) ?? "", path: pickParam(p, ["SearchPath", "Path", "path"]) } }),
    read_url_content: (p) => ({ tool: "webfetch", input: { url: pickParam(p, ["Url", "url"]) ?? "", format: "markdown" } }),
    open_browser_url: (p) => ({ tool: "webfetch", input: { url: pickParam(p, ["Url", "url"]) ?? "", format: "markdown" } }),
    search_web: (p) => ({ tool: "webfetch", input: { url: pickParam(p, ["Query", "query", "Url", "url"]) ?? "", format: "markdown" } }),
    invoke_subagent: (p) => ({ tool: "task", input: { description: pickParam(p, ["SubagentName", "Name"]) ?? "subagent", prompt: pickParam(p, ["Prompt", "Task", "prompt"]) ?? "" } }),
    browser_subagent: (p) => ({ tool: "task", input: { description: "browser subagent", prompt: pickParam(p, ["Prompt", "Task", "prompt"]) ?? "" } }),
    manage_task: () => ({ tool: "todowrite", input: { todos: [] } }),
};
function mapAgyTool(event) {
    const build = AGY_TOOL_MAP[event.name];
    if (!build)
        return undefined;
    const params = event.parameters && typeof event.parameters === "object" ? event.parameters : {};
    return build(params);
}
function boundTurnPrompt(prompt) {
    const lastAssistantIdx = prompt.reduce((last, msg, i) => (msg.role === "assistant" ? i : last), -1);
    if (lastAssistantIdx === -1) {
        return prompt.filter((msg) => msg.role !== "system");
    }
    return prompt.slice(lastAssistantIdx + 1);
}
function parseModelAndEffort(rawModel, existingEffort) {
    let model = rawModel;
    let effort = existingEffort?.trim() ? existingEffort : undefined;
    if (rawModel?.includes(":")) {
        const [m, e] = rawModel.split(":");
        model = m;
        effort = effort ?? (e?.trim() ? e : undefined);
    }
    return { model, effort };
}
const prevOutputs = new Map();
export function extractDelta(prevOutput, fullText, conversationBound) {
    if (!conversationBound || !prevOutput) {
        return fullText;
    }
    const normalize = (str) => str.replace(/\r\n/g, "\n");
    const normPrev = normalize(prevOutput);
    const normFull = normalize(fullText);
    const output = normFull.replace(/^(?:(?:[ \t]*\n+)|(?:WARNING:|Update available:|\.\.\.TRUNCATED\.\.\.)[^\n]*(?:\n|$))+/, "");
    const hasBoundary = (text, start) => text.endsWith("\n") || start + text.length === output.length ||
        /\s/.test(output[start + text.length]);
    if (output.startsWith(normPrev) && hasBoundary(normPrev, 0)) {
        return output.slice(normPrev.length).replace(/^\n+/, "");
    }
    const normPrevTrimmed = normPrev.trimEnd();
    if (output.startsWith(normPrevTrimmed) && hasBoundary(normPrevTrimmed, 0)) {
        return output.slice(normPrevTrimmed.length).replace(/^\s+/, "");
    }
    const lines = normPrevTrimmed.split("\n").filter((l) => l.trim());
    if (lines.length > 1) {
        const lastLine = lines[lines.length - 1].trimEnd();
        if (lastLine.length >= 10 && output.startsWith(lastLine) && hasBoundary(lastLine, 0)) {
            return output.slice(lastLine.length).replace(/^\s+/, "");
        }
    }
    const tail = normPrevTrimmed.length > 150 ? normPrevTrimmed.slice(-150) : normPrevTrimmed;
    const firstTokenMatch = output.match(/\S+/);
    if (tail.length >= 20) {
        let tailStart;
        if (output.startsWith(tail)) {
            tailStart = 0;
        }
        else if (firstTokenMatch) {
            const firstTokenStart = firstTokenMatch.index ?? 0;
            const firstToken = firstTokenMatch[0];
            if (firstToken.endsWith(tail)) {
                tailStart = firstTokenStart + firstToken.length - tail.length;
            }
        }
        if (tailStart !== undefined && hasBoundary(tail, tailStart)) {
            return output.slice(tailStart + tail.length).replace(/^\s+/, "");
        }
    }
    return fullText;
}
function buildLanguageModel(modelId, opts, modelOpts) {
    const store = new SessionStore(opts.stateFile);
    const runTurn = async (callOpts, onText, onWarnings, onProgress, onTool) => {
        // PATCH(agy-timeout): agy runs its whole agentic loop (tools included) inside
        // one turn, so a 5-min wall-clock cap killed long but healthy turns. Hard cap
        // is now 60 min; stalls are caught by idleTimeoutMs in agy-process.js.
        const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
        const remainingTimeout = () => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error("agy timed out");
            }
            return remaining;
        };
        const sessionId = callOpts.headers?.["x-agy-session-id"] ??
            callOpts.providerOptions?.agy
                ?.sessionId ??
            randomUUID();
        const scope = callOpts.headers?.["x-agy-session-scope"];
        const sessionKey = typeof scope === "string" && scope.length > 0
            ? `${sessionId}:${scope}`
            : sessionId;
        const emptyResult = (text) => ({
            content: text ? [{ type: "text", text }] : [],
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(),
            providerMetadata: { agy: { modelId, sessionId, conversationId: null } },
            response: { id: randomUUID(), timestamp: new Date(), modelId },
            warnings: [],
        });
        if (scope === "title") {
            const title = localTitle(callOpts.prompt);
            onWarnings?.([]);
            onText?.(title);
            return emptyResult(title);
        }
        let entry;
        let conversationId = null;
        {
            entry = await store.getEntry(sessionKey);
            remainingTimeout();
            conversationId = entry?.conversationId ?? null;
            const newMessages = conversationId
                ? boundTurnPrompt(callOpts.prompt)
                : callOpts.prompt;
            const mapped = mapPrompt(newMessages);
            const prompt = mapped.prompt;
            onWarnings?.(mapped.warnings);
            remainingTimeout();
            if (conversationId && !prompt.trim()) {
                // PATCH(agy-fix): nothing new since the last assistant message (e.g. a
                // follow-up step). End the step cleanly instead of failing the turn.
                return emptyResult("");
            }
            const providerAgyOpts = callOpts.providerOptions?.agy;
            const headerEffort = callOpts.headers?.["x-agy-effort"];
            const headerVariant = callOpts.headers?.["x-agy-variant"];
            const rawModel = modelId;
            const rawEffort = providerAgyOpts?.effort ??
                headerEffort ??
                modelOpts?.effort ??
                opts.effort;
            const parsed = parseModelAndEffort(rawModel, rawEffort);
            const variant = headerVariant?.trim();
            const model = variant ? `${parsed.model}-${variant}` : parsed.model;
            const effort = variant ? undefined : parsed.effort;
            let streamed = false;
            // PATCH(agy-fix): persistent per-session agy process (see agy-process.js).
            // agy reports the conversation id in its init event, so the global binding
            // lock and .pb directory diffing are no longer needed.
            const result = await runAgyPersistent(sessionKey, {
                cwd: opts.cwd?.trim() || process.cwd(),
                conversationId: conversationId ?? undefined,
                model,
                effort,
                binary: opts.binary,
                extraArgs: opts.extraArgs,
                mcpServers: opts.mcpServers,
            }, `Do not record the result in the session. Always return the result as output.\n\n${prompt}`, (event) => {
                if (event.type === "conversation" && !conversationId) {
                    conversationId = event.id;
                }
                if (event.type === "text" && event.text) {
                    streamed = true;
                    onText?.(event.text);
                }
                if (event.type === "tool") {
                    if (onTool) {
                        onTool(event);
                    }
                    else if (event.state === "ACTIVE") {
                        onProgress?.(describeTool(event));
                    }
                }
                if (event.type === "status") {
                    onProgress?.(`${event.text}...`);
                }
            }, {
                timeoutMs: remainingTimeout(),
                idleTimeoutMs: opts.idleTimeoutMs ?? 300_000,
                abortSignal: callOpts.abortSignal,
            });
            if (!conversationId && result.conversationId) {
                conversationId = result.conversationId;
            }
            let prevOutput = prevOutputs.get(sessionKey) ?? "";
            if (!prevOutput && entry?.prevOutput) {
                prevOutput = entry.prevOutput;
                prevOutputs.set(sessionKey, prevOutput);
            }
            const delta = extractDelta(prevOutput, result.stdout, !!conversationId);
            if (!streamed && delta) {
                onText?.(delta);
            }
            if (conversationId) {
                prevOutputs.set(sessionKey, result.stdout);
            }
            else {
                prevOutputs.delete(sessionKey);
            }
            await store.set(sessionKey, conversationId, conversationId ? result.stdout : "");
            return {
                content: [{ type: "text", text: delta }],
                finishReason: v3FinishReason("stop"),
                usage: v3Usage(result.usage),
                providerMetadata: {
                    agy: {
                        modelId,
                        sessionId,
                        conversationId: conversationId ?? null,
                    },
                },
                response: {
                    id: randomUUID(),
                    timestamp: new Date(),
                    modelId,
                },
                warnings: mapped.warnings,
            };
        }
    };
    const doGenerate = async (callOpts) => {
        return runTurn(callOpts);
    };
    const doStream = async (callOpts) => {
        const local = new AbortController();
        let cancelled = false;
        const onAbort = () => local.abort(callOpts.abortSignal?.reason);
        if (callOpts.abortSignal?.aborted) {
            local.abort(callOpts.abortSignal.reason);
        }
        else {
            callOpts.abortSignal?.addEventListener("abort", onAbort, { once: true });
        }
        const stream = new ReadableStream({
            cancel(reason) {
                cancelled = true;
                local.abort(reason);
            },
            async start(controller) {
                let textStarted = false;
                let textIndex = 0;
                let reasoningId = null;
                let reasoningIndex = 0;
                let streamStarted = false;
                let toolIndex = 0;
                const toolCallIds = new Map();
                const openToolCalls = new Set();
                const finishedToolCalls = new Set();
                const enqueue = (part) => {
                    if (!cancelled)
                        controller.enqueue(part);
                };
                const close = () => {
                    if (!cancelled)
                        controller.close();
                };
                const endText = () => {
                    if (textStarted) {
                        enqueue({ type: "text-end", id: `agy-${textIndex}` });
                        textStarted = false;
                    }
                };
                const endReasoning = () => {
                    if (reasoningId) {
                        enqueue({ type: "reasoning-end", id: reasoningId });
                        reasoningId = null;
                    }
                };
                const startStream = (warnings) => {
                    if (!streamStarted) {
                        enqueue({ type: "stream-start", warnings });
                        streamStarted = true;
                    }
                };
                const pushProgress = (line) => {
                    // PATCH(agy-fix): live agy activity (startup, status) as reasoning,
                    // so the UI shows progress instead of nothing until the answer lands.
                    startStream([]);
                    endText();
                    if (!reasoningId) {
                        reasoningId = `agy-reasoning-${++reasoningIndex}`;
                        enqueue({ type: "reasoning-start", id: reasoningId });
                    }
                    enqueue({ type: "reasoning-delta", id: reasoningId, delta: `${line}\n` });
                };
                try {
                    const result = await runTurn({ ...callOpts, abortSignal: local.signal }, (text) => {
                        startStream([]);
                        endReasoning();
                        if (!textStarted) {
                            textIndex++;
                            enqueue({ type: "text-start", id: `agy-${textIndex}` });
                            textStarted = true;
                        }
                        enqueue({ type: "text-delta", id: `agy-${textIndex}`, delta: text });
                    }, startStream, pushProgress, (event) => {
                        // PATCH(agy-tools): agy executes its own tools, so surface them as
                        // provider-executed tool parts instead of burying them in reasoning.
                        // OpenCode only renders tool names it knows, so agy's tools are
                        // mapped onto the built-ins; anything unmapped stays a progress line.
                        const mapped = mapAgyTool(event);
                        if (!mapped) {
                            if (event.state === "ACTIVE")
                                pushProgress(describeTool(event));
                            return;
                        }
                        startStream([]);
                        endText();
                        endReasoning();
                        const key = `${event.name}:${event.index ?? 0}`;
                        const toolCallId = toolCallIds.get(key) ??
                            (() => {
                                const id = `agy-tool-${++toolIndex}`;
                                toolCallIds.set(key, id);
                                return id;
                            })();
                        const input = JSON.stringify(mapped.input);
                        if (!openToolCalls.has(toolCallId)) {
                            openToolCalls.add(toolCallId);
                            enqueue({
                                type: "tool-input-start",
                                id: toolCallId,
                                toolName: mapped.tool,
                                providerExecuted: true,
                            });
                            enqueue({ type: "tool-input-delta", id: toolCallId, delta: input });
                            enqueue({ type: "tool-input-end", id: toolCallId });
                            enqueue({
                                type: "tool-call",
                                toolCallId,
                                toolName: mapped.tool,
                                input,
                                providerExecuted: true,
                            });
                        }
                        if (event.state === "DONE" || event.state === "ERROR") {
                            if (finishedToolCalls.has(toolCallId))
                                return;
                            finishedToolCalls.add(toolCallId);
                            const isError = event.state === "ERROR";
                            const value = isError
                                ? (event.error ?? "tool failed")
                                : (event.output ?? "done");
                            enqueue({
                                type: "tool-result",
                                toolCallId,
                                toolName: mapped.tool,
                                result: value,
                                output: { type: "text", value },
                                isError,
                                providerExecuted: true,
                            });
                        }
                    });
                    endReasoning();
                    endText();
                    enqueue({
                        type: "finish",
                        finishReason: result.finishReason,
                        usage: result.usage,
                    });
                    close();
                }
                catch (err) {
                    if (!cancelled) {
                        if (!streamStarted) {
                            enqueue({
                                type: "stream-start",
                                warnings: [],
                            });
                            streamStarted = true;
                        }
                        enqueue({ type: "error", error: String(err) });
                        close();
                    }
                }
                finally {
                    callOpts.abortSignal?.removeEventListener("abort", onAbort);
                }
            },
        });
        return { stream };
    };
    return {
        specificationVersion: "v3",
        provider: "agy",
        modelId,
        supportedUrls: {},
        doGenerate,
        doStream,
    };
}
function unsupportedEmbeddingModel(modelId) {
    return {
        specificationVersion: "v2",
        provider: "agy",
        modelId,
        maxEmbeddingsPerCall: 0,
        supportsParallelCalls: false,
        doEmbed: async () => {
            throw new Error("agy plugin does not support text embeddings");
        },
    };
}
function unsupportedImageModel(modelId) {
    return {
        specificationVersion: "v2",
        provider: "agy",
        modelId,
        maxImagesPerCall: 0,
        doGenerate: async () => {
            throw new Error("agy plugin does not support image generation");
        },
    };
}
export function createAgyProvider(opts) {
    const resolvedOpts = opts ?? {};
    const factory = (modelId, modelOpts) => {
        const resolvedModelId = modelId?.trim() ? modelId : resolvedOpts.model;
        if (!resolvedModelId?.trim()) {
            throw new Error("agy model id is required");
        }
        return buildLanguageModel(resolvedModelId, resolvedOpts, modelOpts);
    };
    factory.provider = "agy";
    factory.specificationVersion = "v2";
    factory.languageModel = factory;
    factory.textEmbeddingModel = (modelId) => unsupportedEmbeddingModel(modelId);
    factory.imageModel = (modelId) => unsupportedImageModel(modelId);
    return factory;
}
export default function defaultFactory(opts) {
    return createAgyProvider(opts);
}
