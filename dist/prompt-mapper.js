export function flattenPrompt(prompt) {
    return mapPrompt(prompt).prompt;
}
export function mapPrompt(prompt) {
    const nonSystem = prompt.filter((msg) => msg.role !== "system");
    const warnings = [];
    let fileWarningAdded = false;
    const extractMappedText = (msg) => {
        if (!fileWarningAdded &&
            Array.isArray(msg.content) &&
            msg.content.some((part) => part.type === "file")) {
            warnings.push({
                type: "other",
                message: "File parts are not supported by the agy provider and were ignored.",
            });
            fileWarningAdded = true;
        }
        return extractText(msg);
    };
    if (nonSystem.length === 0) {
        const texts = prompt.map((msg) => extractText(msg).trim()).filter(Boolean);
        return { prompt: texts.join("\n"), warnings };
    }
    if (nonSystem.length === 1) {
        return { prompt: extractMappedText(nonSystem[0]).trim(), warnings };
    }
    const parts = [];
    const history = nonSystem.slice(0, -1);
    const current = nonSystem[nonSystem.length - 1];
    parts.push("[Previous Conversation Context]");
    for (const msg of history) {
        const text = extractMappedText(msg);
        if (text.trim()) {
            const label = msg.role === "user" ? "User" : "Assistant";
            parts.push(`${label}: ${text}`);
        }
    }
    parts.push("[End of Context]");
    const currentText = extractMappedText(current).trim();
    if (currentText) {
        parts.push("");
        parts.push("Current Request:");
        parts.push(currentText);
    }
    return { prompt: parts.join("\n"), warnings };
}
function extractText(msg) {
    if (typeof msg.content === "string") {
        return msg.content;
    }
    if (Array.isArray(msg.content)) {
        const texts = [];
        for (const part of msg.content) {
            if (part.type === "text") {
                texts.push(part.text);
            }
        }
        return texts.join("\n");
    }
    return "";
}
