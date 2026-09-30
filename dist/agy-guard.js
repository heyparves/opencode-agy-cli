// PATCH(agy-guard): usage guard shared by the provider and the `agy` delegate tool.
//
// Lowers abuse-looking traffic patterns toward the Antigravity backend:
//   - one agy turn at a time per OpenCode process (no parallel fan-out)
//   - minimum gap between turn starts, and an hourly cap (tracked across
//     OpenCode processes in ~/.opencode-agy-plugin/guard.json)
//   - circuit breaker: after a quota / rate-limit / auth / ToS error, all agy
//     calls stop for a cooldown instead of retrying into the error.
//
// Env overrides: AGY_MIN_GAP_MS, AGY_MAX_PER_HOUR, AGY_COOLDOWN_MS, AGY_GUARD=off.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".opencode-agy-plugin");
const STATE = join(DIR, "guard.json");
const HOUR = 3_600_000;

const MIN_GAP_MS = Number(process.env.AGY_MIN_GAP_MS ?? 3_000);
const MAX_PER_HOUR = Number(process.env.AGY_MAX_PER_HOUR ?? 60);
const COOLDOWN_MS = Number(process.env.AGY_COOLDOWN_MS ?? 30 * 60_000);
const ENABLED = process.env.AGY_GUARD !== "off";

export class AgyGuardError extends Error {
    constructor(message, code, details) {
        super(message);
        this.name = "AgyGuardError";
        this.code = code;
        this.details = details;
    }
}

function readState() {
    try {
        const s = JSON.parse(readFileSync(STATE, "utf-8"));
        return { starts: Array.isArray(s.starts) ? s.starts : [], blockedUntil: s.blockedUntil ?? 0, blockReason: s.blockReason };
    }
    catch {
        return { starts: [], blockedUntil: 0 };
    }
}

function writeState(state) {
    try {
        mkdirSync(DIR, { recursive: true });
        const tmp = `${STATE}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(state));
        renameSync(tmp, STATE);
    }
    catch {
        // best effort; the in-process limits still apply
    }
}

// Classify agy stderr / error text. Returns a code that trips the breaker, or null.
export function classifyAgyFailure(text) {
    const blob = String(text ?? "").toLowerCase();
    if (/violation of terms|terms of service|service has been disabled|account.*(suspended|disabled)/.test(blob))
        return "TOS_BLOCK";
    if (/quota|rate limit|resource.?exhausted|too many requests|\b429\b/.test(blob))
        return "QUOTA_EXHAUSTED";
    if (/unauthenticated|unauthorized|\b401\b|\b403\b|sign in|re-?authenticate|login required/.test(blob))
        return "AUTH_REQUIRED";
    return null;
}

// True while the breaker is open (used to skip prewarming during a cooldown).
export function guardBlocked() {
    return ENABLED && readState().blockedUntil > Date.now();
}

let chain = Promise.resolve();
let lastStart = 0;

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener?.("abort", () => {
            clearTimeout(t);
            reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
    });
}

function checkLimits(now) {
    const state = readState();
    if (state.blockedUntil > now) {
        const mins = Math.ceil((state.blockedUntil - now) / 60_000);
        throw new AgyGuardError(`agy paused for ${mins} more min after ${state.blockReason ?? "an upstream error"}. ` +
            "Not retrying on purpose: hammering after quota/auth errors looks like abuse. " +
            "Run `agy` in a terminal to check the account, or delete ~/.opencode-agy-plugin/guard.json to reset.", "GUARD_COOLDOWN", { blockedUntil: new Date(state.blockedUntil).toISOString(), reason: state.blockReason });
    }
    const recent = state.starts.filter((t) => now - t < HOUR);
    if (recent.length >= MAX_PER_HOUR) {
        const waitMin = Math.ceil((recent[0] + HOUR - now) / 60_000);
        throw new AgyGuardError(`agy hourly cap reached (${MAX_PER_HOUR}/h). Next slot in ~${waitMin} min. Raise AGY_MAX_PER_HOUR only if you need to.`, "GUARD_HOURLY_CAP", { perHour: MAX_PER_HOUR, waitMin });
    }
    return { state, recent };
}

/**
 * Runs `fn` under the guard. Serializes agy turns in this process, spaces
 * starts by MIN_GAP_MS, enforces the hourly cap and the breaker, and trips
 * the breaker when `fn` fails with a quota/auth/ToS error.
 */
export function guarded(fn, { abortSignal, label = "agy" } = {}) {
    if (!ENABLED)
        return fn();
    const run = async () => {
        checkLimits(Date.now());
        const gap = lastStart + MIN_GAP_MS - Date.now();
        if (gap > 0)
            await sleep(gap, abortSignal);
        const now = Date.now();
        const { state, recent } = checkLimits(now);
        lastStart = now;
        writeState({ ...state, starts: [...recent, now] });
        try {
            return await fn();
        }
        catch (err) {
            const code = classifyAgyFailure(err?.message) ?? classifyAgyFailure(err?.details?.stderr);
            if (code) {
                const cooldown = code === "TOS_BLOCK" ? 24 * HOUR : COOLDOWN_MS;
                writeState({ ...readState(), blockedUntil: Date.now() + cooldown, blockReason: `${code} (${label})` });
            }
            throw err;
        }
    };
    const result = chain.then(run, run);
    chain = result.catch(() => { });
    return result;
}
