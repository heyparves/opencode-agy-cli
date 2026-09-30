import { homedir } from "node:os";
import { join } from "node:path";

// Bump when agy-broker.js / agy-process.js change, so a running old broker is
// left to idle out and a new one starts on a fresh socket.
export const BROKER_VERSION = 3;
export const BROKER_DIR = join(homedir(), ".opencode-agy-plugin");
export const BROKER_SOCKET = join(BROKER_DIR, `broker-v${BROKER_VERSION}.sock`);
