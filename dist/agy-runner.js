import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
function createAbortError(reason) {
    if (reason instanceof Error) {
        if (reason.name === "AbortError") {
            return reason;
        }
        const err = new Error(reason.message);
        err.name = "AbortError";
        err.stack = reason.stack;
        return err;
    }
    if (typeof DOMException !== "undefined") {
        return new DOMException(typeof reason === "string" ? reason : "The operation was aborted", "AbortError");
    }
    const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
    err.name = "AbortError";
    return err;
}
export async function runAgyStream(input, onEvent) {
    if (input.abortSignal?.aborted) {
        return Promise.reject(createAbortError(input.abortSignal.reason));
    }
    const binary = input.binary ?? "agy";
    const timeoutMs = input.timeoutMs ?? 300_000;
    const extraArgs = input.extraArgs ?? [];
    const args = [
        "--add-dir",
        input.cwd,
        "--dangerously-skip-permissions",
        ...extraArgs,
    ];
    if (input.model) {
        args.push("--model", input.model);
    }
    if (input.effort?.trim()) {
        args.push("--effort", input.effort);
    }
    if (input.conversationId) {
        args.push("--conversation", input.conversationId);
    }
    args.push("--output-format", "stream-json", "-p", `Do not record the result in the session. Always return the result as output.\n\n${input.prompt}`);
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            cwd: input.cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        const stdoutDecoder = new StringDecoder("utf-8");
        let stdoutBuffer = "";
        let accumulatedText = "";
        let resultResponse;
        let resultStatus;
        let resultError;
        let conversationId;
        let usage;
        let sawValidEvent = false;
        let streamError;
        let settled = false;
        let timeoutTimer;
        let killFallbackTimer;
        const emitEvent = (event) => {
            if (!settled) {
                onEvent(event);
            }
        };
        const cleanup = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = undefined;
            }
            if (killFallbackTimer) {
                clearTimeout(killFallbackTimer);
                killFallbackTimer = undefined;
            }
            if (input.abortSignal && onAbort) {
                input.abortSignal.removeEventListener("abort", onAbort);
            }
        };
        const settleResolve = (value) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const settleReject = (err) => {
            if (settled)
                return;
            settled = true;
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = undefined;
            }
            if (input.abortSignal && onAbort) {
                input.abortSignal.removeEventListener("abort", onAbort);
            }
            reject(err);
        };
        const killChild = () => {
            if (child.exitCode !== null || child.signalCode !== null) {
                return;
            }
            try {
                child.kill("SIGTERM");
            }
            catch {
                // ignore
            }
            if (!killFallbackTimer) {
                killFallbackTimer = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        try {
                            child.kill("SIGKILL");
                        }
                        catch {
                            // ignore
                        }
                    }
                }, 1000);
                killFallbackTimer.unref?.();
            }
        };
        const onAbort = () => {
            killChild();
            settleReject(createAbortError(input.abortSignal?.reason));
        };
        const processLine = (line) => {
            if (settled) {
                return;
            }
            line = line.trim();
            if (!line.startsWith("{")) {
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                return;
            }
            if (typeof parsed.event !== "string") {
                return;
            }
            sawValidEvent = true;
            if (parsed.event === "init" && typeof parsed.conversation_id === "string") {
                conversationId = parsed.conversation_id;
                emitEvent({ type: "conversation", id: conversationId });
                return;
            }
            if (parsed.event === "step_update") {
                const step = (parsed.step_update ?? parsed);
                const stepConvId = (typeof step.conversation_id === "string" ? step.conversation_id : undefined) ??
                    (typeof parsed.conversation_id === "string" ? parsed.conversation_id : undefined);
                if (stepConvId) {
                    conversationId = stepConvId;
                    emitEvent({ type: "conversation", id: conversationId });
                }
                const stepType = (typeof step.step_type === "string" ? step.step_type : undefined) ??
                    (typeof parsed.step_type === "string" ? parsed.step_type : undefined);
                const textDelta = (typeof step.text_delta === "string" ? step.text_delta : undefined) ??
                    (typeof parsed.text_delta === "string" ? parsed.text_delta : undefined);
                const state = (typeof step.state === "string" ? step.state : undefined) ??
                    (typeof parsed.state === "string" ? parsed.state : undefined);
                const status = (typeof step.status === "string" ? step.status : undefined) ??
                    (typeof parsed.status === "string" ? parsed.status : undefined);
                if (stepType === "agent_response" && typeof textDelta === "string") {
                    if (state === "ACTIVE" || state === "DONE") {
                        accumulatedText += textDelta;
                        emitEvent({ type: "text", text: textDelta });
                    }
                    else if (status === "DONE") {
                        if (textDelta.startsWith(accumulatedText)) {
                            const missingSuffix = textDelta.slice(accumulatedText.length);
                            if (missingSuffix) {
                                accumulatedText = textDelta;
                                emitEvent({ type: "text", text: missingSuffix });
                            }
                        }
                        else if (!streamError) {
                            streamError = new Error("Inconsistent stream: DONE snapshot does not match accumulated text");
                        }
                    }
                    else if (textDelta) {
                        accumulatedText += textDelta;
                        emitEvent({ type: "text", text: textDelta });
                    }
                }
                return;
            }
            if (parsed.event === "result") {
                const result = (parsed.result ?? parsed);
                if (typeof parsed.conversation_id === "string") {
                    conversationId = parsed.conversation_id;
                    emitEvent({ type: "conversation", id: conversationId });
                }
                else if (typeof result.conversation_id === "string") {
                    conversationId = result.conversation_id;
                    emitEvent({ type: "conversation", id: conversationId });
                }
                resultStatus = typeof result.status === "string" ? result.status : undefined;
                resultResponse = typeof result.response === "string" ? result.response : undefined;
                resultError = typeof result.error === "string" ? result.error : undefined;
                const resultUsage = result.usage;
                if (resultUsage &&
                    typeof resultUsage.input_tokens === "number" &&
                    typeof resultUsage.output_tokens === "number" &&
                    typeof resultUsage.total_tokens === "number") {
                    usage = {
                        inputTokens: resultUsage.input_tokens,
                        outputTokens: resultUsage.output_tokens,
                        totalTokens: resultUsage.total_tokens,
                    };
                }
                // PATCH(agy-fix): agy keeps running for several seconds after emitting
                // a successful result. Resolve now instead of waiting for process exit;
                // the child is left to finish persisting the conversation on its own.
                if (resultStatus === "SUCCESS" && !streamError) {
                    const lingerTimer = setTimeout(() => killChild(), 60_000);
                    lingerTimer.unref?.();
                    child.once("close", () => clearTimeout(lingerTimer));
                    settleResolve({
                        stdout: accumulatedText || resultResponse || "",
                        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
                        exitCode: 0,
                        ...(conversationId ? { conversationId } : {}),
                        ...(usage ? { usage } : {}),
                    });
                }
            }
        };
        child.stdout.on("data", (chunk) => {
            if (settled)
                return;
            stdoutChunks.push(chunk);
            stdoutBuffer += stdoutDecoder.write(chunk);
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            lines.forEach(processLine);
        });
        child.stderr.on("data", (chunk) => {
            if (settled)
                return;
            stderrChunks.push(chunk);
        });
        timeoutTimer = setTimeout(() => {
            killChild();
            settleReject(new Error("agy timed out"));
        }, timeoutMs);
        input.abortSignal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code) => {
            cleanup();
            if (settled)
                return;
            stdoutBuffer += stdoutDecoder.end();
            processLine(stdoutBuffer);
            const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
            const stderr = Buffer.concat(stderrChunks).toString("utf-8");
            const exitCode = code ?? 1;
            if (exitCode !== 0) {
                const msg = resultError?.trim() || stderr.trim() || `agy exited with status ${exitCode}`;
                settleReject(new Error(msg));
                return;
            }
            if (resultStatus && resultStatus !== "SUCCESS") {
                const msg = resultError?.trim() || `agy failed with status ${resultStatus}`;
                settleReject(new Error(msg));
                return;
            }
            if (streamError) {
                settleReject(streamError);
                return;
            }
            settleResolve({
                stdout: accumulatedText || resultResponse || (!sawValidEvent ? stdout : ""),
                stderr,
                exitCode,
                ...(conversationId ? { conversationId } : {}),
                ...(usage ? { usage } : {}),
            });
        });
        child.on("error", (err) => {
            cleanup();
            settleReject(new Error(`failed to spawn agy: ${err.message}`));
        });
    });
}
export async function runAgy(input) {
    return runAgyStream(input, () => { });
}
