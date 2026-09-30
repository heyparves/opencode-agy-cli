import { createAgyProvider } from "./provider.js";
import { applyAgyModels } from "./agy-models.js";
import { agyDelegateHooks, prewarmDelegate } from "./agy-delegate.js";
export { createAgyProvider } from "./provider.js";
export default function unified(input) {
    if (input && typeof input === "object" && "client" in input) {
        // PATCH(agy-delegate): `agy` tool + `/agy` command. provider.agy.options.mode:
        //   "both" (default)  agy models selectable AND the delegate tool
        //   "delegate"        tool only; agy models are removed from /model
        let agyOpts = {};
        const delegate = agyDelegateHooks(input, () => agyOpts);
        return {
            tool: { agy: delegate.tool },
            // PATCH(agy-prewarm): user asked for agy while another model drives the
            // session, so warm the delegate process while that model thinks.
            "chat.message": async (incoming, output) => {
                if (incoming?.model?.providerID === "agy" || !incoming?.sessionID)
                    return;
                const text = (output?.parts ?? []).map((p) => (p?.type === "text" ? p.text : "")).join(" ");
                if (/\bagy\b|antigravity/i.test(text))
                    prewarmDelegate(incoming.sessionID, input.directory, agyOpts);
            },
            config: async (cfg) => {
                const directory = input.directory;
                if (typeof directory === "string" && directory.trim() !== "") {
                    const options = ((cfg.provider ??= {}).agy ??= {}).options ??= {};
                    if (options.cwd == null)
                        options.cwd = directory;
                }
                agyOpts = { ...(cfg.provider?.agy?.options ?? {}) };
                if (!cfg.command?.agy)
                    cfg.command = { ...cfg.command, agy: delegate.command };
                if (agyOpts.mode === "delegate") {
                    delete cfg.provider.agy;
                    return;
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
                const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
                // PATCH(agy-reasoning): OpenCode gives the title call the small-model
                // variant ("low"); the title prewarm must spawn with the user's pick
                // or the build turn's signature mismatches and agy respawns.
                const variant = incoming?.agent === "title"
                    ? pick(incoming?.message?.model?.variant) ?? pick(incoming?.variant)
                    : pick(incoming?.variant) ?? pick(incoming?.message?.model?.variant);
                if (variant) {
                    output.headers["x-agy-variant"] = variant;
                }
                const effort = variant ??
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
