import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
export function defaultConversationsDir() {
    return join(homedir(), ".gemini", "antigravity-cli", "conversations");
}
export async function snapshot(dir) {
    try {
        const entries = await readdir(dir);
        const stems = new Set();
        for (const entry of entries) {
            if (entry.endsWith(".pb")) {
                stems.add(entry.slice(0, -3));
            }
        }
        return stems;
    }
    catch {
        return new Set();
    }
}
export async function findNewConversation(before, dir) {
    const after = await snapshot(dir);
    const created = [];
    for (const stem of after) {
        if (!before.has(stem)) {
            created.push(stem);
        }
    }
    if (created.length === 0) {
        return null;
    }
    if (created.length > 1) {
        return null;
    }
    return created[0];
}
