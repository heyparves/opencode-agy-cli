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
