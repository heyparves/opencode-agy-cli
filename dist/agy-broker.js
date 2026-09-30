// PATCH(agy-broker): keeps warm agy processes alive across OpenCode processes.
//
// super.engineering starts a fresh `opencode serve` when you switch views and
// kills old ones. The warm agy process was a child of that server, so it died
// with it and the next message had to cold-start agy and resume with
// --conversation (~9s of agy startup). This broker is a small detached process
// that owns the agy processes (same official binary and flags, via
// agy-process.js) and serves every OpenCode process over a unix socket, so a
// chat keeps one continuous agy conversation.
//
// Protocol: newline-delimited JSON over ~/.opencode-agy-plugin/broker-<v>.sock
//   -> {op:"run", key, config, prompt, timeoutMs, idleTimeoutMs}
//   <- {type:"event", event}* then {type:"result", result} | {type:"error", message, name}
//   -> {op:"abort"}            cancel the running turn on this connection
//   -> {op:"prewarm", key, config}   <- {type:"ok"}
//   -> {op:"dispose", key}           <- {type:"ok"}
// A dropped connection does NOT cancel the turn: the view switched, the user
// did not press stop. The turn finishes and the process stays warm.
import { createServer } from "node:net";
import { chmodSync, mkdirSync, unlinkSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgyPersistent, prewarmAgyProcess, disposeAgyProcess, poolSize, disposeAllAgyProcesses } from "./agy-process.js";
import { BROKER_SOCKET, BROKER_DIR } from "./agy-broker-path.js";

const IDLE_EXIT_MS = Number(process.env.AGY_BROKER_IDLE_MS ?? 30 * 60_000);
const LOG = join(BROKER_DIR, "broker.log");
function log(msg) {
    try {
        appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
    }
    catch { }
}

mkdirSync(BROKER_DIR, { recursive: true, mode: 0o700 });
try {
    chmodSync(BROKER_DIR, 0o700);
}
catch { }

let active = 0;
let idleTimer;
function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (active === 0 && poolSize() === 0) {
            log("idle, exiting");
            shutdown(0);
        }
        else {
            armIdle();
        }
    }, IDLE_EXIT_MS);
}

function handle(socket) {
    let buffer = "";
    let abort = null;
    const send = (obj) => {
        if (!socket.destroyed)
            socket.write(`${JSON.stringify(obj)}\n`);
    };
    socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!line.trim())
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                send({ type: "error", message: "bad json" });
                continue;
            }
            onMessage(msg);
        }
    });
    socket.on("error", () => { });
    const onMessage = async (msg) => {
        if (msg.op === "abort") {
            abort?.abort(new Error("aborted by OpenCode"));
            return;
        }
        if (msg.op === "prewarm") {
            send({ type: "ok", started: prewarmAgyProcess(msg.key, msg.config) });
            return;
        }
        if (msg.op === "dispose") {
            disposeAgyProcess(msg.key);
            send({ type: "ok" });
            return;
        }
        if (msg.op === "ping") {
            send({ type: "ok", pid: process.pid, pool: poolSize() });
            return;
        }
        if (msg.op !== "run")
            return send({ type: "error", message: `unknown op ${msg.op}` });
        active++;
        abort = new AbortController();
        try {
            const result = await runAgyPersistent(msg.key, msg.config, msg.prompt, (event) => send({ type: "event", event }), {
                timeoutMs: msg.timeoutMs,
                idleTimeoutMs: msg.idleTimeoutMs,
                abortSignal: abort.signal,
            });
            send({ type: "result", result });
        }
        catch (err) {
            send({ type: "error", message: err?.message ?? String(err), name: err?.name });
        }
        finally {
            active--;
            abort = null;
            socket.end();
            armIdle();
        }
    };
}

const server = createServer(handle);
function shutdown(code) {
    try {
        disposeAllAgyProcesses();
    }
    catch { }
    server.close();
    try {
        unlinkSync(BROKER_SOCKET);
    }
    catch { }
    setTimeout(() => process.exit(code), 6_000).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

server.on("error", (err) => {
    // Another broker won the race for the socket: this one is not needed.
    log(`listen failed: ${err.message}`);
    process.exit(0);
});
server.listen(BROKER_SOCKET, () => {
    try {
        chmodSync(BROKER_SOCKET, 0o600);
    }
    catch { }
    log(`listening ${BROKER_SOCKET}`);
    armIdle();
});
