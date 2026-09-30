// PATCH(agy-fix): long-lived agy process per OpenCode session.
//
// Spawning agy costs ~10-20s (auth, MCP servers, skills) before the model even
// sees the prompt. `agy --input-format stream-json` keeps one process alive and
// runs a turn for every `{"event":"user"}` line written to stdin, so only the
// first turn of a session pays the startup cost.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// agy re-lists tools from every configured MCP server on every turn, which cost
// ~8-11s before the model was even called. OpenCode doesn't hand those tools to
// this provider anyway, so agy runs with a mirror HOME: every entry is a symlink
// to the real one (auth, conversations, skills, dotfiles for shell tools) except
// the MCP configs, which are filtered to `mcpServers` (default: none).
const MIRROR_ROOT = join(homedir(), ".opencode-agy-plugin", "agy-home");
const MCP_FILES = new Set(["mcp_config.json"]);

function linkEntries(realDir, mirrorDir, skip) {
    mkdirSync(mirrorDir, { recursive: true });
    for (const name of readdirSync(realDir)) {
        if (skip.has(name))
            continue;
        const target = join(mirrorDir, name);
        let present = false;
        try {
            lstatSync(target);
            present = true;
        }
        catch {
            // missing
        }
        if (!present) {
            try {
                symlinkSync(join(realDir, name), target);
            }
            catch {
                // ignore races with a concurrent spawn
            }
        }
    }
}

function writeFilteredMcp(realFile, mirrorFile, allow) {
    let servers = {};
    try {
        servers = JSON.parse(readFileSync(realFile, "utf-8")).mcpServers ?? {};
    }
    catch {
        // missing or invalid: no servers
    }
    const kept = Object.fromEntries(Object.entries(servers).filter(([name]) => allow.includes(name)));
    writeFileSync(mirrorFile, JSON.stringify({ mcpServers: kept }, null, 2));
}

export function mirrorHome(mcpServers) {
    if (mcpServers === "all")
        return undefined;
    const allow = Array.isArray(mcpServers) ? mcpServers : [];
    const realHome = homedir();
    const key = allow.length ? allow.slice().sort().join(",").replace(/[^\w,.-]/g, "_") : "none";
    const home = join(MIRROR_ROOT, key);
    linkEntries(realHome, home, new Set([".gemini"]));
    const realGemini = join(realHome, ".gemini");
    if (!existsSync(realGemini))
        return home;
    const gemini = join(home, ".gemini");
    linkEntries(realGemini, gemini, new Set(["antigravity-cli", "config"]));
    for (const sub of ["antigravity-cli", "config"]) {
        const realSub = join(realGemini, sub);
        if (!existsSync(realSub))
            continue;
        // config/plugins can ship their own MCP servers; leave them out too.
        const skip = new Set([...MCP_FILES, ...(sub === "config" ? ["plugins"] : [])]);
        linkEntries(realSub, join(gemini, sub), skip);
        writeFilteredMcp(join(realSub, "mcp_config.json"), join(gemini, sub, "mcp_config.json"), allow);
    }
    return home;
}

// PATCH(agy-pool): idle window configurable; default raised to 60 min so the
// process survives while the human reads the previous answer.
const IDLE_MS = Number(process.env.AGY_IDLE_MS ?? 60 * 60_000);
const STDERR_TAIL = 4000;
const pool = new Map();

// PATCH(agy-pool): trace why a turn had to respawn agy (~10-20s startup).
const TRACE = join(homedir(), ".opencode-agy-plugin", "pool.log");
function trace(msg) {
    try {
        mkdirSync(join(homedir(), ".opencode-agy-plugin"), { recursive: true });
        appendFileSync(TRACE, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
    }
    catch { }
}

function abortError(reason) {
    const err = new Error(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "The operation was aborted");
    err.name = "AbortError";
    return err;
}

function str(value) {
    return typeof value === "string" ? value : undefined;
}

class AgyProcess {
    constructor(config) {
        this.config = config;
        this.signature = signature(config);
        this.conversationId = config.conversationId;
        this.turn = null;
        this.exited = false;
        this.stderr = "";
        this.idleTimer = undefined;
        // PATCH(agy-delegate): skipPermissions defaults on for the provider; the
        // delegate tool turns it on only when the caller passes yolo.
        const args = ["--add-dir", config.cwd, ...(config.skipPermissions === false ? [] : ["--dangerously-skip-permissions"]), ...(config.extraArgs ?? [])];
        if (config.model)
            args.push("--model", config.model);
        if (config.effort?.trim())
            args.push("--effort", config.effort);
        if (config.conversationId)
            args.push("--conversation", config.conversationId);
        args.push("--output-format", "stream-json", "--input-format", "stream-json");
        let home;
        try {
            home = mirrorHome(config.mcpServers);
        }
        catch {
            home = undefined; // fall back to the real HOME (slower, but works)
        }
        this.spawnedAt = Date.now();
        this.child = spawn(config.binary ?? "agy", args, {
            cwd: config.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: home ? { ...process.env, HOME: home, AGY_REAL_HOME: homedir() } : process.env,
        });
        const decoder = new StringDecoder("utf-8");
        let buffer = "";
        this.child.stdout.on("data", (chunk) => {
            buffer += decoder.write(chunk);
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines)
                this.handleLine(line);
        });
        this.child.stderr.on("data", (chunk) => {
            this.stderr = (this.stderr + chunk.toString("utf-8")).slice(-STDERR_TAIL);
        });
        this.child.stdin.on("error", () => { });
        this.child.on("close", (code) => {
            buffer += decoder.end();
            if (buffer)
                this.handleLine(buffer);
            this.onExit(new Error(this.lastError?.trim() || this.stderr.trim() || `agy exited with status ${code ?? 1}`));
        });
        this.child.on("error", (err) => {
            this.onExit(new Error(`failed to spawn agy: ${err.message}`));
        });
    }

    get busy() {
        return this.turn !== null;
    }

    run(prompt, onEvent, { abortSignal, timeoutMs, idleTimeoutMs }) {
        if (this.exited)
            return Promise.reject(new Error("agy process is not running"));
        if (abortSignal?.aborted)
            return Promise.reject(abortError(abortSignal.reason));
        clearTimeout(this.idleTimer);
        this.child.ref?.();
        const turnStart = Date.now();
        trace(`turn start pid=${this.child.pid} spawnedAgo=${turnStart - this.spawnedAt}ms`);
        return new Promise((resolve, reject) => {
            const turn = {
                onEvent,
                text: "",
                usage: undefined,
                streamError: undefined,
                resolve: (value) => {
                    trace(`turn done in ${Date.now() - turnStart}ms (init after spawn: ${this.initAt ? this.initAt - this.spawnedAt : "n/a"}ms)`);
                    finish();
                    resolve(value);
                },
                reject: (err) => {
                    finish();
                    reject(err);
                },
            };
            const onAbort = () => {
                // agy has no cancel event for stream input; drop the process. The next
                // turn respawns with --conversation, so no context is lost.
                this.dispose();
                turn.reject(abortError(abortSignal?.reason));
            };
            const timer = setTimeout(() => {
                this.dispose();
                turn.reject(new Error("agy timed out"));
            }, timeoutMs ?? 3_600_000);
            // PATCH(agy-timeout): fail only when agy goes silent. Every stdout line
            // (step_update, tool, text) calls turn.touch() and pushes this back.
            const idleMs = idleTimeoutMs ?? 300_000;
            let idleTimer;
            turn.touch = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    this.dispose();
                    turn.reject(new Error(`agy timed out (no output for ${Math.round(idleMs / 1000)}s)`));
                }, idleMs);
            };
            turn.touch();
            const finish = () => {
                clearTimeout(timer);
                clearTimeout(idleTimer);
                abortSignal?.removeEventListener("abort", onAbort);
                if (this.turn === turn)
                    this.turn = null;
                this.scheduleIdle();
            };
            abortSignal?.addEventListener("abort", onAbort, { once: true });
            this.turn = turn;
            this.lastError = undefined;
            const message = {
                event: "user",
                message: { role: "user", content: [{ type: "text", text: prompt }] },
            };
            this.child.stdin.write(JSON.stringify(message) + "\n");
        });
    }

    handleLine(raw) {
        const line = raw.trim();
        if (!line.startsWith("{"))
            return;
        if (process.env.AGY_DEBUG_RAW) {
            try {
                appendFileSync(process.env.AGY_DEBUG_RAW, line + "\n");
            }
            catch { }
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return;
        }
        const turn = this.turn;
        turn?.touch?.();
        const emit = (event) => turn?.onEvent(event);
        if (parsed.event === "init") {
            this.initAt ??= Date.now();
            const id = str(parsed.conversation_id);
            if (id) {
                this.conversationId = id;
                emit({ type: "conversation", id });
            }
            return;
        }
        if (parsed.event === "step_update") {
            const step = parsed.step_update ?? parsed;
            const id = str(step.conversation_id) ?? str(parsed.conversation_id);
            if (id && id !== this.conversationId) {
                this.conversationId = id;
                emit({ type: "conversation", id });
            }
            if (!turn)
                return;
            const stepType = str(step.step_type);
            const state = str(step.state);
            if (stepType === "tool") {
                // PATCH(agy-tools): forward the whole tool lifecycle (index, output,
                // error) so the provider can emit real tool parts instead of prose.
                emit({
                    type: "tool",
                    state,
                    index: typeof step.step_index === "number" ? step.step_index : undefined,
                    name: str(step.tool_name) ?? str(step.tool_info?.name) ?? "tool",
                    parameters: step.tool_info?.parameters,
                    output: str(step.tool_info?.output),
                    error: str(step.tool_info?.error?.message),
                });
                return;
            }
            const textDelta = str(step.text_delta);
            if (stepType !== "agent_response" || textDelta === undefined)
                return;
            if (state === "ACTIVE" || state === "DONE" || !str(step.status)) {
                if (textDelta) {
                    turn.text += textDelta;
                    emit({ type: "text", text: textDelta });
                }
            }
            else if (step.status === "DONE") {
                if (textDelta.startsWith(turn.text)) {
                    const missing = textDelta.slice(turn.text.length);
                    if (missing) {
                        turn.text = textDelta;
                        emit({ type: "text", text: missing });
                    }
                }
                else {
                    turn.streamError ??= new Error("Inconsistent stream: DONE snapshot does not match accumulated text");
                }
            }
            return;
        }
        if (parsed.event === "result") {
            const result = parsed.result ?? parsed;
            const id = str(parsed.conversation_id) ?? str(result.conversation_id);
            if (id)
                this.conversationId = id;
            const usage = result.usage;
            const status = str(result.status);
            const error = str(result.error);
            if (!turn) {
                this.lastError = error;
                return;
            }
            if (status && status !== "SUCCESS") {
                this.lastError = error;
                // Unknown process state after a failed turn; start clean next time.
                this.dispose();
                turn.reject(new Error(error?.trim() || `agy failed with status ${status}`));
                return;
            }
            if (turn.streamError) {
                turn.reject(turn.streamError);
                return;
            }
            turn.resolve({
                stdout: turn.text || str(result.response) || "",
                conversationId: this.conversationId,
                usage: usage && typeof usage.input_tokens === "number"
                    ? {
                        inputTokens: usage.input_tokens,
                        outputTokens: usage.output_tokens ?? 0,
                        totalTokens: usage.total_tokens ?? 0,
                    }
                    : undefined,
            });
        }
    }

    scheduleIdle() {
        clearTimeout(this.idleTimer);
        if (this.exited)
            return;
        // Let the host exit while this process sits idle between turns.
        this.child.unref?.();
        this.idleTimer = setTimeout(() => this.dispose(), this.config.idleMs ?? IDLE_MS);
        this.idleTimer.unref?.();
    }

    onExit(err) {
        if (this.exited)
            return;
        trace(`process exit: ${err.message.slice(0, 200)}`);
        this.exited = true;
        clearTimeout(this.idleTimer);
        for (const [key, proc] of pool) {
            if (proc === this)
                pool.delete(key);
        }
        this.turn?.reject(err);
    }

    dispose() {
        if (this.exited)
            return;
        trace(`dispose (busy=${this.busy})`);
        for (const [key, proc] of pool) {
            if (proc === this)
                pool.delete(key);
        }
        try {
            this.child.stdin.end();
        }
        catch {
            // ignore
        }
        const child = this.child;
        const kill = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                try {
                    child.kill("SIGTERM");
                }
                catch {
                    // ignore
                }
            }
        }, this.turn ? 0 : 5_000);
        kill.unref?.();
    }
}

function signature(config) {
    return JSON.stringify([config.binary ?? "agy", config.cwd, config.model ?? "", config.effort ?? "", config.extraArgs ?? [], config.mcpServers ?? [], config.skipPermissions !== false]);
}

// PATCH(agy-prewarm): start a session's agy process before its first turn.
// agy does its startup (keyring auth, loadCodeAssist, model list) right away,
// so the first turn only pays for the model call. Unused prewarms exit after
// PREWARM_TTL_MS. AGY_PREWARM=off disables it.
const BUSY_WAIT_MS = Number(process.env.AGY_BUSY_WAIT_MS ?? 5 * 60_000);
const PREWARM_TTL_MS =Number(process.env.AGY_PREWARM_TTL_MS ?? 5 * 60_000);
export function prewarmAgyProcess(sessionKey, config) {
    if (process.env.AGY_PREWARM === "off" || pool.has(sessionKey))
        return false;
    const proc = new AgyProcess(config);
    pool.set(sessionKey, proc);
    trace(`prewarm key=${sessionKey}`);
    proc.child.unref?.();
    proc.idleTimer = setTimeout(() => proc.dispose(), PREWARM_TTL_MS);
    proc.idleTimer.unref?.();
    return true;
}

export function disposeAgyProcess(sessionKey) {
    pool.get(sessionKey)?.dispose();
}

/**
 * Runs one turn on the session's persistent agy process, spawning (or
 * respawning with --conversation) when needed.
 */
export async function runAgyPersistent(sessionKey, config, prompt, onEvent, options) {
    let proc = pool.get(sessionKey);
    trace(proc
        ? `turn key=${sessionKey} pooled=yes exited=${proc.exited} busy=${proc.busy} sigMatch=${proc.signature === signature(config)} convMatch=${proc.conversationId === config.conversationId}`
        : `turn key=${sessionKey} pooled=no poolKeys=${[...pool.keys()].join("|") || "(empty)"}`);
    if (proc && (proc.exited || proc.signature !== signature(config))) {
        if (proc.signature !== signature(config))
            trace(`signature drift\n  had: ${proc.signature}\n  now: ${signature(config)}`);
        proc.dispose();
        proc = undefined;
    }
    let oneOff = false;
    if (proc?.busy) {
        // PATCH(agy-broker): a turn is still running for this chat, typically one
        // started before a view switch. Wait for it (up to BUSY_WAIT_MS) so the
        // new message lands in the same continuous conversation.
        onEvent({ type: "status", text: "Waiting for previous agy turn" });
        const until = Date.now() + BUSY_WAIT_MS;
        while (proc.busy && !proc.exited && Date.now() < until && !options?.abortSignal?.aborted)
            await new Promise((r) => setTimeout(r, 250));
        if (!proc.exited && !proc.busy)
            return runAgyPersistent(sessionKey, config, prompt, onEvent, options);
        if (proc.busy && !proc.exited) {
            // Still busy: don't interleave turns on one stdin.
            proc = new AgyProcess(config);
            oneOff = true;
        }
        else {
            return runAgyPersistent(sessionKey, config, prompt, onEvent, options);
        }
    }
    if (!proc) {
        onEvent({ type: "status", text: config.conversationId ? "Resuming agy conversation" : "Starting agy" });
        proc = new AgyProcess(config);
        if (!oneOff)
            pool.set(sessionKey, proc);
    }
    else if (config.conversationId && proc.conversationId && proc.conversationId !== config.conversationId) {
        proc.dispose();
        return runAgyPersistent(sessionKey, config, prompt, onEvent, options);
    }
    else {
        onEvent({ type: "status", text: "Thinking" });
    }
    try {
        return await proc.run(prompt, onEvent, options);
    }
    catch (err) {
        if (!oneOff && err?.name === "AbortError")
            respawnAfterAbort(sessionKey, proc);
        throw err;
    }
    finally {
        if (oneOff)
            proc.dispose();
    }
}

// PATCH(agy-abort-respawn): agy's stream-json input has no cancel event and
// SIGINT exits the process, so Stop must kill agy. Start its replacement on the
// same --conversation right away, while the user types the next message, so
// that message lands on a warm process instead of "Resuming agy conversation".
// Triggered only by the user's Stop; it idles out like any pooled process.
// AGY_ABORT_RESPAWN=off disables it.
function respawnAfterAbort(sessionKey, dead) {
    if (process.env.AGY_ABORT_RESPAWN === "off" || !dead.conversationId)
        return;
    const current = pool.get(sessionKey);
    if (current && current !== dead && !current.exited)
        return;
    const proc = new AgyProcess({ ...dead.config, conversationId: dead.conversationId });
    pool.set(sessionKey, proc);
    trace(`respawn after abort key=${sessionKey} conv=${dead.conversationId}`);
    proc.scheduleIdle();
}

export function poolSize() {
    return pool.size;
}

export function disposeAllAgyProcesses() {
    for (const proc of [...pool.values()])
        proc.dispose();
}
