# opencode-agy-cli

High-performance, local OpenCode provider and plugin bridge connecting OpenCode to Google Antigravity (`agy` CLI) through official streaming IPC with persistent process pooling.

---

> ### ⚠️ Disclaimer & Risk Notice
> **This project is an independent community tool and is NOT affiliated with, sponsored by, or endorsed by Google.**  
>
> **We are NOT responsible for any Google Antigravity (agy) CLI terms of service violations, API quota limits, account restrictions, or account suspensions resulting from the use of this software. By using this bridge, you accept full responsibility and proceed entirely at your own risk.**

---

## ⚡ Why This Approach?

Most third-party integrations attempt to reverse-engineer Google Antigravity by extracting internal OAuth tokens and sending forged HTTP requests directly to Google's internal APIs (e.g., token-hijacking auth plugins). **Those approaches carry severe risks of immediate account shadowbans and permanent suspensions.**

**`opencode-agy-cli` takes a completely different, safer approach:**
1. **Local Subprocess IPC:** Spawns your officially installed and authenticated `agy` binary locally via `node:child_process`.
2. **Official Streaming Protocol:** Uses native CLI flags (`--input-format stream-json --output-format stream-json`) to exchange structured NDJSON messages.
3. **Zero Token Theft:** No OAuth tokens, cookies, or secrets are intercepted, scraped, or forwarded. All authentication remains handled locally by Google's official CLI runtime.
4. **Persistent Daemon Process:** Standard bridges pay a 15–20s startup penalty on every turn for CLI auth and tool indexing. This bridge maintains a warm daemon per conversation session so subsequent turns respond immediately.
5. **Mirror HOME Optimization:** Symlinks runtime configurations while bypassing redundant MCP server indexing that can add 8–11s of latency per call.
6. **OpenCode AI SDK v3 Compatibility:** Full support for OpenCode 1.x+ `LanguageModelV3` specifications, eliminating infinite retry loops from unmapped `finishReason` values.
7. **Native Tool Mapping:** Transparently maps `agy` native tool calls (`run_command`, `view_file`, `replace_file_content`, `read_url_content`) to OpenCode UI tools (`bash`, `read`, `edit`, `webfetch`).
8. **Usage Guard:** One agy turn at a time, a minimum gap between calls, an hourly cap, and an automatic pause after quota, 429, auth or Terms of Service errors, so nothing hammers Google's backend with retries.
9. **Broker Daemon:** A small detached broker owns the agy processes, so hosts that restart `opencode serve` on every view switch keep the same warm agy and continuous conversation.
10. **Warm Respawn After Stop:** agy has no cancel event, so Stop ends the process. The bridge immediately starts a replacement on the same `--conversation`, and your next message lands on a warm process instead of a cold "Resuming".
11. **Reasoning Picker:** Gemini models that agy ships in low/medium/high tiers show OpenCode's variant picker.
12. **`agy` Delegate Tool:** Any main model can hand scoped tasks to agy via the `agy` tool or `/agy` command, read-only by default.

---

## 📋 Prerequisites

Before setting up the plugin, verify you have the following installed:

1. **Google Antigravity CLI (`agy`):**
   ```bash
   agy --version
   ```
   Ensure you have logged in and run `agy` at least once interactively in your terminal to complete authentication.

2. **OpenCode:**
   Ensure OpenCode is installed and accessible in your environment.

3. **Node.js (>= 18) or Bun:**
   Used to build and run the plugin bridge.

---

## 🚀 Installation & Setup

### 1. Clone & Build the Bridge

Clone this repository into your preferred tools or vendor directory (recommended: inside `~/.config/opencode/vendor/`):

```bash
mkdir -p ~/.config/opencode/vendor
git clone https://github.com/heyparves/opencode-agy-cli.git ~/.config/opencode/vendor/opencode-agy-cli
cd ~/.config/opencode/vendor/opencode-agy-cli
```

Install dependencies and compile:

```bash
# Using bun (recommended)
bun install
bun run build

# Or using npm
npm install
npm run build
```

---

### 2. Configure OpenCode

Open your OpenCode configuration file (typically located at `~/.config/opencode/opencode.json` or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file://${HOME}/.config/opencode/vendor/opencode-agy-cli/dist/index.js"
  ],
  "provider": {
    "agy": {
      "npm": "file://${HOME}/.config/opencode/vendor/opencode-agy-cli/dist/provider.js",
      "name": "Antigravity",
      "options": {
        "binary": "agy"
      }
    }
  }
}
```

> **Note:** Replace `${HOME}` with your absolute home directory path (e.g., `/Users/username` on macOS or `/home/username` on Linux).

---

### 3. Start OpenCode & Select Model

1. Restart OpenCode.
2. The plugin will automatically run `agy models` on startup to discover all available models permitted on your Google account.
3. Open model picker (`/model`) and select any available `agy/...` model (e.g. `agy/gemini-3.8-flash`, `agy/gemini-3.7-flash`, `agy/claude-sonnet-4-6`).

---

## ⚙️ Configuration & Options

### Manual Model Configuration (Optional)

If you prefer to lock specific models and reasoning variants instead of relying on auto-discovery, configure the `models` block in `opencode.json`:

```json
{
  "provider": {
    "agy": {
      "npm": "file:///path/to/opencode-agy-cli/dist/provider.js",
      "name": "Antigravity",
      "options": {
        "binary": "agy"
      },
      "models": {
        "gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash",
          "variants": {
            "high": {},
            "medium": {},
            "low": {}
          }
        },
        "gemini-3.1-pro": {
          "name": "Gemini 3.1 Pro",
          "variants": {
            "high": {},
            "low": {}
          }
        },
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6"
        }
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGY_IDLE_MS` | `3600000` (60m) | Duration in milliseconds to keep idle `agy` background processes alive between turns before releasing memory. |
| `AGY_DEBUG_RAW` | *unset* | Path to a file where raw incoming JSON events from `agy` stdout should be appended for troubleshooting. |
| `AGY_GUARD` | *on* | Set to `off` to disable the usage guard (not recommended). |
| `AGY_MIN_GAP_MS` | `3000` | Minimum time between agy turn starts. |
| `AGY_MAX_PER_HOUR` | `60` | Maximum agy turns per hour across all OpenCode windows. |
| `AGY_COOLDOWN_MS` | `1800000` (30m) | Pause after a quota, 429 or auth error. Terms of Service errors pause for 24h. Delete `~/.opencode-agy-plugin/guard.json` to reset. |
| `AGY_BROKER` | *on* | Set to `off` to run agy inside each OpenCode process instead of the shared broker. |
| `AGY_BROKER_IDLE_MS` | `1800000` (30m) | The broker exits after this long with no chats. |
| `AGY_BUSY_WAIT_MS` | `300000` (5m) | How long a new message waits for a still-running turn in the same chat. |
| `AGY_PREWARM` | *on* | Set to `off` to stop starting agy when the first message's title request arrives. |
| `AGY_PREWARM_TTL_MS` | `300000` (5m) | Lifetime of a prewarmed agy that never receives a turn. |
| `AGY_ABORT_RESPAWN` | *on* | Set to `off` to skip the warm respawn after Stop. |
| `AGY_DELEGATE_IDLE_MS` | `900000` (15m) | Idle lifetime of the delegate tool's agy process. |

### Provider Mode

`provider.agy.options.mode` controls how agy appears in OpenCode:

- `"both"` (default): agy models are selectable in `/model`, and the `agy` tool is available to other models.
- `"delegate"`: agy models are hidden; only the `agy` tool and `/agy` command remain. This is the lowest-risk setup because agy only runs scoped tasks you hand it.

### `agy` Delegate Tool

| Argument | Description |
|---|---|
| `prompt` | The task for agy. |
| `access` | `read` (default, no edits or shell), `write` (edits, sandboxed shell, asks for approval), `full` (asks for approval). |
| `model` | agy model id from `agy models`, e.g. `gemini-3.8-flash-high`. Defaults to agy's own default. |
| `effort` | `low`, `medium` (default), `high` or `max`. agy rejects `--effort` for Claude models. |
| `dir` | Workspace directory. Defaults to the OpenCode project directory. |
| `project` | agy project id or name, pins agy to one project. |
| `fresh` | `true` starts a new agy conversation instead of continuing the session's one. |
| `conversation` | Resume a specific agy conversation id. |

---

## 🔍 Troubleshooting

### 1. Models Not Showing in `/model`
The discovered model list is cached for 24 hours. Clear the cache and restart OpenCode:
```bash
rm -rf ~/.cache/opencode-agy-plugin/models.json
```
Verify that `agy models` runs cleanly in your terminal:
```bash
agy models
```

### 2. Startup Latency or Stalls
The first turn of any new conversation initializes the background daemon and mounts the mirrored config directory. Subsequent turns will execute with near-zero bridge overhead.

### 3. Session Lock Issues
Session bindings and conversation maps are stored in:
- `~/.opencode-agy-plugin/sessions.json`
- `~/.opencode-agy-plugin/pool.log`

If processes are terminated abruptly, you can safely clear stale lock files:
```bash
rm -f ~/.opencode-agy-plugin/*.lock
```

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
