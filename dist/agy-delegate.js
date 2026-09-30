// PATCH(agy-delegate): `agy` tool + `/agy` command, modeled on opencode-agy
// (chigarow/antigravity-for-opencode). The main OpenCode model stays in charge
// and hands agy one scoped task, instead of agy being the model behind every
// OpenCode turn. Fewer, deliberate calls through the official CLI.
//
// PATCH(agy-warm): tasks run on a warm `agy --input-format stream-json`
// process (documented CLI flag) kept per OpenCode session + workspace. A cold
// start costs ~8-10s and several backend bootstrap calls before the model sees
// the prompt; follow-up tasks on a warm process skip all of that. No
// pre-warming: a process only starts when a task arrives, and exits after
// DELEGATE_IDLE_MS.
//
// PATCH(agy-tool-v2):
//   - `access`: read (default) | write | full. Headless agy auto-denies edits and
//     shell commands unless permissions are skipped, but reads inside the
//     workspace still work, so "read" is safe for research and review.
//     write/full go through OpenCode's own permission prompt first.
//   - live progress in the tool header (cold start, each agy tool step)
//   - an action log (files read/edited, commands run, denials) in the result
//     so the calling model can verify agy's work.
import { tool } from "@opencode-ai/plugin";
import { guarded, guardBlocked, classifyAgyFailure, AgyGuardError } from "./agy-guard.js";
import { runAgyPersistent, disposeAgyProcess, prewarmAgyProcess } from "./agy-client.js";

const DEFAULT_TIMEOUT = "10m";
const MAX_TIMEOUT_MS = 4 * 3_600_000;
const MAX_OUTPUT = 100_000;
const MAX_ACTIONS = 40;
const DELEGATE_IDLE_MS = Number(process.env.AGY_DELEGATE_IDLE_MS ?? 15 * 60_000);
const STALL_MS = 5 * 60_000;

class AgyDelegateError extends Error {
    constructor(message, code, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

function toMs(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const s = String(value).trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
    if (!m)
        throw new AgyDelegateError(`invalid timeout "${value}" (use 300s, 10m, 1h or milliseconds)`, "INVALID_TIMEOUT");
    const n = Number(m[1]);
    const unit = m[2] ?? (n >= 1000 ? "ms" : "s");
    const ms = n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
    return Math.min(ms, MAX_TIMEOUT_MS);
}

function scrub(text) {
    return String(text ?? "")
        .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
        .replace(/\b(ya29\.[A-Za-z0-9\-_]+|sk-[A-Za-z0-9]+|AIza[0-9A-Za-z\-_]{20,})/g, "[REDACTED]")
        .replace(/\b(password|token|secret|api[_-]?key)\s*[=:]\s*[^\s&"']+/gi, "$1=[REDACTED]");
}

function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

function rel(path, dir) {
    return typeof path === "string" && dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

// One short line per agy tool step, e.g. "view_file src/a.ts".
function describeStep(event, dir) {
    const p = event.parameters ?? {};
    const target = p.CommandLine ?? p.AbsolutePath ?? p.TargetFile ?? p.FilePath ?? p.Path ?? p.DirectoryPath ?? p.SearchPath ?? p.Query ?? p.Url;
    const shown = typeof target === "string" ? truncate(rel(target, dir), 120).replace(/\s+/g, " ") : "";
    return `${event.name ?? "tool"}${shown ? ` ${shown}` : ""}`;
}

function isDenied(event) {
    return event.state === "ERROR" && /denied permission|permission check failed|declaring permissions/i.test(event.error ?? "");
}

const ACCESS = {
    read: { skipPermissions: false, sandbox: false },
    write: { skipPermissions: true, sandbox: true },
    full: { skipPermissions: true, sandbox: false },
};

function delegateKey(sessionID, dir) {
    return `delegate:${sessionID ?? "none"}:${dir}`;
}

function delegateSpawnConfig(args, opts, dir) {
    const access = ACCESS[args.access ?? "read"] ?? ACCESS.read;
    const extraArgs = ["--disable-slash-commands"];
    if (access.sandbox)
        extraArgs.push("--sandbox");
    if (args.project)
        extraArgs.push("--project", args.project);
    return {
        cwd: dir,
        model: args.model ?? opts.delegateModel,
        // medium: ~30% faster than agy's default (high) on lookups, same answers in tests.
        effort: args.effort ?? opts.delegateEffort ?? "medium",
        binary: opts.binary,
        mcpServers: opts.mcpServers,
        skipPermissions: access.skipPermissions,
        extraArgs,
        idleMs: DELEGATE_IDLE_MS,
    };
}

// PATCH(agy-prewarm): when the user's message asks for agy (or uses /agy) and
// the main model is not agy, start the delegate process with default settings
// (access=read) while the main model is still reading the prompt. A later call
// with other settings (model, access) respawns it.
export function prewarmDelegate(sessionID, dir, opts) {
    if (guardBlocked())
        return false;
    return prewarmAgyProcess(delegateKey(sessionID, dir), delegateSpawnConfig({}, opts, dir));
}

async function runDelegate(args, opts, directory, context) {
    const timeoutMs = toMs(args.timeout ?? DEFAULT_TIMEOUT);
    const dir = args.dir?.trim() || directory || process.cwd();
    // One warm process per OpenCode session + workspace. Different flags
    // (model, access, project) respawn it; `fresh` drops its context.
    const key = delegateKey(context?.sessionID, dir);
    if (args.fresh)
        await disposeAgyProcess(key);
    const start = Date.now();
    let warm = true;
    const actions = [];
    const denied = [];
    const progress = (title) => {
        try {
            context?.metadata?.({ title: `agy · ${title}`, metadata: { actions: actions.slice(-10) } });
        }
        catch { }
    };
    progress("queued");
    try {
        const result = await runAgyPersistent(key, {
            ...delegateSpawnConfig(args, opts, dir),
            conversationId: args.conversation,
        }, args.prompt, (event) => {
            if (event.type === "status") {
                if (/^(Starting|Resuming)/.test(event.text))
                    warm = false;
                progress(warm ? "thinking" : "starting agy (cold start ~10s)");
            }
            else if (event.type === "tool") {
                const step = describeStep(event, dir);
                if (event.state === "ACTIVE")
                    progress(step);
                else if (isDenied(event))
                    denied.push(step);
                else if (event.state === "DONE" && actions.length < MAX_ACTIONS)
                    actions.push(step);
                else if (event.state === "ERROR" && actions.length < MAX_ACTIONS)
                    actions.push(`${step} (failed)`);
            }
            else if (event.type === "text") {
                progress("writing answer");
            }
        }, { timeoutMs, idleTimeoutMs: STALL_MS, abortSignal: context?.abort });
        const durationMs = Date.now() - start;
        const text = result.stdout ?? "";
        const details = { durationMs, warm, actions, denied, ...(result.conversationId ? { conversationId: result.conversationId } : {}) };
        if (!text.trim())
            throw new AgyDelegateError(denied.length
                ? `agy stopped after ${denied.length} action(s) were denied (access=${args.access ?? "read"}). Retry with access "write" if the task must edit files or run commands.`
                : "agy returned empty output", "EMPTY_OUTPUT", details);
        return { text: truncate(text, MAX_OUTPUT), ...details };
    }
    catch (err) {
        if (err instanceof AgyDelegateError || err?.name === "AbortError")
            throw err;
        const msg = scrub(truncate(err?.message ?? String(err), 2000));
        const kind = /timed out/i.test(msg) ? "TIMEOUT" : classifyAgyFailure(msg) ?? "AGY_FAILED";
        // message carries agy's error text so the guard can trip its breaker
        throw new AgyDelegateError(`agy ${kind.toLowerCase()}: ${msg}`, kind, { durationMs: Date.now() - start, actions, denied });
    }
}

function report(r, args) {
    const lines = [`## agy result (${Math.round(r.durationMs / 1000)}s, ${r.warm ? "warm" : "cold start"}, access=${args.access ?? "read"})`];
    if (r.conversationId)
        lines.push(`conversation: ${r.conversationId}`);
    if (r.actions?.length)
        lines.push("", "### agy actions", ...r.actions.map((a) => `- ${a}`));
    if (r.denied?.length)
        lines.push("", "### denied (needs access=write)", ...r.denied.map((a) => `- ${a}`));
    lines.push("", "### answer", r.text);
    return lines.join("\n");
}

const COMMAND = {
    description: "Delegate a scoped task to agy (Antigravity / Gemini sub-agent)",
    template: [
        "Delegate this task to the `agy` tool (headless Antigravity sub-agent):",
        "",
        "$ARGUMENTS",
        "",
        "Guidelines:",
        "- Send one scoped task per call. Batch related work into one prompt instead of many small calls.",
        "- access: \"read\" (default) for research/review, \"write\" when agy must edit files or run commands (sandboxed), \"full\" only if the sandbox blocks something needed.",
        "- Set `project` when the agy project is known, so agy stays in this repo.",
        "- Follow-up calls in this session continue agy's conversation. Pass `fresh: true` for an unrelated task.",
        "- On GUARD_*, QUOTA or AUTH errors, stop and tell the user. Do not retry.",
        "- Verify agy's work yourself using the action log: read changed files, run tests.",
    ].join("\n"),
};

export function agyDelegateHooks(ctx, getOpts) {
    return {
        command: COMMAND,
        tool: tool({
            description: "Delegate one well-scoped task to Antigravity (agy CLI, Gemini). Good for research across the repo, reviews, bulk edits, scaffolding, or a second opinion. " +
                "access=read (default) lets agy read files in the workspace but not edit or run commands; use access=write for edits (asks the user, sandboxed shell). " +
                "Follow-ups in the same session reuse agy's context and are fast (~3s overhead); first call ~10s. Pass fresh:true for an unrelated task. " +
                "The result lists agy's actions: verify edits yourself. Never retry GUARD_*, QUOTA or AUTH errors.",
            args: {
                prompt: tool.schema.string().describe("The task. Specific, scoped, self-contained: say which files/dirs and what output format you want."),
                access: tool.schema.enum(["read", "write", "full"]).optional().describe("read (default): read-only. write: may edit files and run sandboxed commands (asks the user). full: no sandbox (asks the user)."),
                dir: tool.schema.string().optional().describe("Workspace dir (--add-dir and cwd). Defaults to the OpenCode project dir."),
                project: tool.schema.string().optional().describe("agy project ID or name (--project). Pins agy to one project."),
                model: tool.schema.string().optional().describe("agy model id from `agy models`, e.g. gemini-3.8-flash-high or gemini-3.1-pro-high. Default: agy's own default."),
                effort: tool.schema.enum(["low", "medium", "high", "max"]).optional().describe("Reasoning effort (--effort). Default medium. Use high for hard debugging or design work."),
                timeout: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("e.g. 5m, 30m, 300s or ms. Default 10m, max 4h. Only stalls of 5 min without output fail early."),
                fresh: tool.schema.boolean().optional().describe("Start a new agy conversation instead of continuing this session's one."),
                conversation: tool.schema.string().optional().describe("Resume a specific agy conversation id."),
            },
            async execute(args, context) {
                const access = args.access ?? "read";
                const dir = args.dir?.trim() || context?.directory || ctx.directory;
                if (access !== "read" && typeof context?.ask === "function") {
                    try {
                        await context.ask({
                            permission: "agy",
                            patterns: [`${access}:${dir}`],
                            always: [`${access}:${dir}`],
                            metadata: { access, dir, prompt: truncate(args.prompt, 500) },
                        });
                    }
                    catch (err) {
                        return {
                            title: "agy (not approved)",
                            output: `AGY_ERROR [NOT_APPROVED]\nThe user did not approve agy access=${access} in ${dir}. Use access="read", or ask the user.`,
                            metadata: { error: true, code: "NOT_APPROVED" },
                        };
                    }
                }
                try {
                    const r = await guarded(() => runDelegate(args, getOpts(), ctx.directory, context), { abortSignal: context?.abort, label: "delegate" });
                    return {
                        title: `agy · done (${r.actions.length} actions${r.denied.length ? `, ${r.denied.length} denied` : ""})`,
                        output: report(r, args),
                        metadata: { durationMs: r.durationMs, warm: r.warm, conversationId: r.conversationId, actions: r.actions, denied: r.denied },
                    };
                }
                catch (err) {
                    const code = err instanceof AgyGuardError || err instanceof AgyDelegateError ? err.code : err?.name === "AbortError" ? "ABORTED" : "UNEXPECTED";
                    const stop = /^GUARD_|QUOTA|AUTH|TOS/.test(code);
                    return {
                        title: `agy error (${code})`,
                        output: [
                            `AGY_ERROR [${code}]`,
                            scrub(err?.message ?? String(err)),
                            err?.details ? JSON.stringify(err.details, null, 2) : "",
                            "",
                            stop
                                ? "Do NOT retry. Tell the user agy is paused and why."
                                : code === "EMPTY_OUTPUT"
                                    ? "Retry once with the access level named above, or rephrase."
                                    : "Retry at most once, with a higher timeout.",
                        ].join("\n"),
                        metadata: { error: true, code },
                    };
                }
            },
        }),
    };
}
