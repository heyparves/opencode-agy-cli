// PATCH(agy-broker): client side. Same API as agy-process.js (runAgyPersistent,
// prewarmAgyProcess, disposeAgyProcess), but the agy processes live in the
// shared broker (agy-broker.js) so they survive OpenCode restarts. Falls back
// to in-process agy when the broker can't be reached. AGY_BROKER=off disables.
import { connect } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as local from "./agy-process.js";
import { BROKER_SOCKET } from "./agy-broker-path.js";

const BROKER_JS = join(dirname(fileURLToPath(import.meta.url)), "agy-broker.js");
const ENABLED = process.env.AGY_BROKER !== "off";

function runtime() {
    // opencode is a compiled binary, so process.execPath can't run a script.
    for (const bin of [process.env.AGY_BROKER_RUNTIME, "/opt/homebrew/bin/bun", "/opt/homebrew/bin/node", "/usr/local/bin/bun", "/usr/local/bin/node"]) {
        if (bin && existsSync(bin))
            return bin;
    }
    for (const name of ["bun", "node"]) {
        try {
            return execFileSync("/usr/bin/which", [name], { encoding: "utf-8" }).trim() || undefined;
        }
        catch { }
    }
    return undefined;
}

function tryConnect() {
    return new Promise((resolve) => {
        const socket = connect(BROKER_SOCKET);
        socket.once("connect", () => resolve(socket));
        socket.once("error", (err) => resolve({ error: err }));
    });
}

let starting = null;
async function brokerSocket() {
    let s = await tryConnect();
    if (!s.error)
        return s;
    if (starting)
        await starting;
    else {
        starting = (async () => {
            // A socket file without a listener is left over from a crash.
            if (s.error.code === "ECONNREFUSED") {
                try {
                    unlinkSync(BROKER_SOCKET);
                }
                catch { }
            }
            const bin = runtime();
            if (!bin)
                throw new Error("no bun/node runtime for agy broker");
            spawn(bin, [BROKER_JS], { detached: true, stdio: "ignore", env: process.env }).unref();
            for (let i = 0; i < 40; i++) {
                await new Promise((r) => setTimeout(r, 100));
                if (existsSync(BROKER_SOCKET))
                    break;
            }
        })().finally(() => { starting = null; });
        await starting;
    }
    s = await tryConnect();
    if (s.error)
        throw s.error;
    return s;
}

// One request per connection. Resolves with the final message; streams events.
async function request(msg, onEvent, abortSignal) {
    const socket = await brokerSocket();
    return new Promise((resolve, reject) => {
        let buffer = "";
        let done = false;
        const finish = (fn, v) => {
            if (done)
                return;
            done = true;
            abortSignal?.removeEventListener?.("abort", onAbort);
            fn(v);
        };
        const onAbort = () => {
            if (!socket.destroyed)
                socket.write(`${JSON.stringify({ op: "abort" })}\n`);
        };
        abortSignal?.addEventListener?.("abort", onAbort, { once: true });
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf-8");
            let nl;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (!line.trim())
                    continue;
                const m = JSON.parse(line);
                if (m.type === "event")
                    onEvent?.(m.event);
                else if (m.type === "error") {
                    const err = new Error(m.message);
                    if (m.name)
                        err.name = m.name;
                    finish(reject, err);
                    socket.end();
                }
                else {
                    finish(resolve, m);
                    socket.end();
                }
            }
        });
        socket.on("error", (err) => finish(reject, err));
        socket.on("close", () => finish(reject, new Error("agy broker connection closed")));
        socket.write(`${JSON.stringify(msg)}\n`);
    });
}

let brokerBroken = false;
function useBroker() {
    return ENABLED && !brokerBroken;
}

export async function runAgyPersistent(sessionKey, config, prompt, onEvent, options = {}) {
    if (useBroker()) {
        let connected = false;
        try {
            const m = await request({ op: "run", key: sessionKey, config, prompt, timeoutMs: options.timeoutMs, idleTimeoutMs: options.idleTimeoutMs }, (e) => {
                connected = true;
                onEvent(e);
            }, options.abortSignal);
            return m.result;
        }
        catch (err) {
            // Only fall back when the broker itself is unreachable; agy errors
            // (timeouts, quota, aborts) pass through unchanged.
            if (connected || !/ENOENT|ECONNREFUSED|runtime for agy broker|connection closed/.test(err?.message ?? "") || err?.name === "AbortError")
                throw err;
            brokerBroken = true;
        }
    }
    return local.runAgyPersistent(sessionKey, config, prompt, onEvent, options);
}

export function prewarmAgyProcess(sessionKey, config) {
    if (!useBroker())
        return local.prewarmAgyProcess(sessionKey, config);
    request({ op: "prewarm", key: sessionKey, config }).catch(() => { });
    return true;
}

export async function disposeAgyProcess(sessionKey) {
    if (!useBroker())
        return local.disposeAgyProcess(sessionKey);
    await request({ op: "dispose", key: sessionKey }).catch(() => { });
}
