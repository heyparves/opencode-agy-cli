import { createAgyProvider } from "./provider.js";
import { applyAgyModels } from "./agy-models.js";
export { createAgyProvider } from "./provider.js";
export default function unified(input) {
    if (input && typeof input === "object" && "client" in input) {
        return {
            config: async (cfg) => {
                const directory = input.directory;
                if (typeof directory === "string" && directory.trim() !== "") {
                    const options = ((cfg.provider ??= {}).agy ??= {}).options ??= {};
                    if (options.cwd == null)
                        options.cwd = directory;
                }
                await applyAgyModels(cfg);
            },
            "chat.headers": async (incoming, output) => {
                if (incoming?.model?.providerID !== "agy")
                    return;
                if (!output?.headers)
                    return;
                output.headers["x-agy-session-id"] = incoming.sessionID;
                if (["title", "summary", "compaction"].includes(incoming?.agent)) {
                    output.headers["x-agy-session-scope"] = incoming.agent;
                }
                const modelObj = incoming?.model;
                const providerObj = incoming?.provider;
                const variant = typeof incoming?.variant === "string" && incoming.variant.trim()
                    ? incoming.variant.trim()
                    : typeof incoming?.message?.model?.variant === "string" &&
                        incoming.message.model.variant.trim()
                        ? incoming.message.model.variant.trim()
                        : undefined;
                if (variant) {
                    output.headers["x-agy-variant"] = variant;
                }
                const effort = incoming?.variant ??
                    incoming?.message?.model?.variant ??
                    modelObj?.options?.reasoningEffort ??
                    modelObj?.options?.effort ??
                    modelObj?.reasoningEffort ??
                    modelObj?.effort ??
                    providerObj?.options?.effort ??
                    providerObj?.options?.reasoningEffort;
                if (effort && typeof effort === "string") {
                    output.headers["x-agy-effort"] = effort;
                }
            },
        };
    }
    return createAgyProvider(input);
}
