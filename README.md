# 🍰 CakeAgent

[![Build](https://github.com/kossov-it/cakeagent/actions/workflows/build.yml/badge.svg)](https://github.com/kossov-it/cakeagent/actions/workflows/build.yml)
![Lines](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/lines.json)
![Files](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/files.json)
![Deps](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/deps.json)
![Size](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/size.json)

A personal AI agent you can actually read. Under 2,000 lines of code, 9 files, 3 runtime dependencies.

CakeAgent connects Claude to Telegram and gives it tools, voice, scheduling, file access, web search, and code execution. New capabilities come from MCP — an open standard with thousands of existing tool servers — not from custom plugin code. Ask "add Google Calendar" in chat and it installs itself.

Runs as a single Node.js process under a dedicated system user. No containers, no web UI, no open ports.

### Get started

```bash
curl -fsSL https://raw.githubusercontent.com/kossov-it/cakeagent/main/install.sh | sudo bash
```

The script creates a `cakeagent` system user, installs everything to `/opt/cakeagent`, asks for your Telegram bot token and Claude credentials, and starts the service. Once running, send your bot a message — it walks you through the rest (name, personality, voice, integrations).

To uninstall completely (user, service, data, everything):
```bash
sudo bash /opt/cakeagent/setup.sh uninstall
```

---

## Why this exists

Open-source AI assistants have a bloat problem. The popular ones ship 400K+ lines of code, 50+ dependencies, WebSocket control planes, and custom plugin marketplaces — then get hit with [critical RCE vulnerabilities](https://www.proarch.com/blog/threats-vulnerabilities/openclaw-rce-vulnerability-cve-2026-25253) and [135,000 exposed instances](https://signalcage.com/artificial-intelligence/2026/17/20/openclaw-security-crisis-135000-exposed-instances-and-active-infostealer-campaigns-february-2026/). Their plugin ecosystems? 7% of published skills leak credentials.

CakeAgent does almost nothing itself and lets the ecosystem do the rest. The orchestrator is under 2,000 lines. Integrations come from the MCP ecosystem — thousands of tool servers maintained by their own communities. No custom plugin format, no marketplace.

| | CakeAgent | Popular alternatives |
|---|---|---|
| **Source code** | <2,000 LOC, 9 files | 400K+ LOC, 50+ modules |
| **Dependencies** | 3 | 47+ direct |
| **Open ports** | 0 | WebSocket, HTTP API |
| **Telegram** | 220 LOC raw `fetch()` | Framework + adapter |
| **Extensions** | MCP open standard | Custom plugin marketplace |
| **Security** | Dedicated user, systemd sandbox, code-level hooks | Plaintext creds, no auth |
| **CVEs** | 0 | Multiple critical RCEs |

---

## Install

Linux server with Node.js 18+ required.

```bash
git clone https://github.com/kossov-it/cakeagent.git
cd cakeagent
sudo bash setup.sh
```

The setup script:

1. Checks Node.js
2. Creates a `cakeagent` system user (nologin shell, home at `/opt/cakeagent`)
3. Installs dependencies and builds
4. Configures passwordless `sudo apt` (only `apt-get` and `apt`) so the agent can install packages
5. Asks for your **Telegram bot token** — [get one from @BotFather](https://t.me/BotFather)
6. Asks for your **Telegram user ID** — [get it from @userinfobot](https://t.me/userinfobot)
7. Asks for **Claude authentication** (see below)
8. Installs and starts the systemd service

### Claude authentication

| Method | Where to get it | Saved as |
|--------|-----------------|----------|
| **Subscription token** (recommended) | Install [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code), run `claude setup-token`, copy the `sk-ant-oat...` token (valid 1 year) | `CLAUDE_CODE_OAUTH_TOKEN` in `.env` |
| **API key** | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys), copy the `sk-ant-api...` key | `ANTHROPIC_API_KEY` in `.env` |

### Uninstall

```bash
sudo bash /opt/cakeagent/setup.sh uninstall
```

Removes the systemd service, the `cakeagent` user, the sudoers entry, and `/opt/cakeagent` entirely.

---

## Architecture

```
┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│   Telegram   │────▶│  Orchestrator │────▶│ Claude Agent  │
│  (raw fetch) │◀────│  (index.ts)   │◀────│ SDK query()   │
└──────────────┘     └───────┬───────┘     └──────┬───────┘
                             │                    │
                      ┌──────┴──────┐      ┌──────┴──────┐
                      │   SQLite    │      │  MCP Tools  │
                      │ (store.ts)  │      │ (in-process)│
                      └─────────────┘      └─────────────┘
```

Messages go through three layers. Most never reach the Claude API:

1. **Settings callbacks** (inline keyboard buttons) — handled directly in the orchestrator
2. **Commands** (`/status`, `/settings`, `/update`, etc.) — handled in the orchestrator
3. **Everything else** — sent to Claude as a prompt with conversation context and persistent memory

### Source files

```
src/index.ts          466  Orchestrator, routing, scheduler, voice toggle
src/tools.ts          310  16 MCP tools (in-process)
channels/telegram.ts  230  Telegram adapter (raw fetch)
src/store.ts          218  SQLite: messages, schedules, groups, audit
src/hooks.ts          183  Security hooks (Bash, Read, Write guards)
src/voice.ts          160  Whisper STT + Edge TTS
src/types.ts          141  Type definitions
src/agent.ts           91  Claude Agent SDK wrapper + streaming
src/config.ts          51  .env parser
```

### First run

On your first message, CakeAgent detects empty memory and starts an onboarding conversation:

1. Asks your name and preferred language
2. Asks about personality (casual, formal, etc.)
3. Offers to set up group chats
4. Offers to enable voice (installs dependencies if you say yes)
5. Suggests MCP integrations (calendar, email, etc.)

Everything is saved to `settings.json` and `memory.md`. The agent remembers your preferences across restarts and session resets.

### Streaming

Responses are streamed as the agent works. If Claude produces intermediate text (thinking out loud, progress updates), you see it immediately in Telegram instead of waiting for the full response. The final result is only sent if it wasn't already streamed.

### Memory

The agent has persistent memory in `data/memory.md`. It's injected into every prompt automatically — the agent always sees it. When you say "remember that..." or "from now on...", the agent writes to memory. It also cleans up stale entries periodically via `rewrite_memory`.

Memory survives restarts and `/reset`. The `/reset` command only clears the Claude SDK session (conversation turns), not learned preferences.

---

## MCP integrations

```
You:       "Find an MCP server for Google Calendar"
CakeAgent:  Found 3 servers:
            1. com.google/calendar-mcp ...
            Install?
You:       "Yes"
CakeAgent:  Installed. Available now.
```

The agent searches the [official MCP Registry](https://registry.modelcontextprotocol.io), shows what it found, and installs after you confirm. Servers go into `.mcp.json` and load automatically on the next message.

### Built-in tools

| Tool | What it does |
|------|-------------|
| `send_message` | Send progress updates mid-conversation |
| `schedule_task` | Recurring or one-time tasks |
| `search_mcp_registry` | Search the official MCP registry |
| `install_tool` / `remove_tool` | Add or remove MCP servers |
| `update_settings` | Change model, thinking level, voice |
| `register_group` | Add a Telegram group with a trigger word |
| `update_memory` / `rewrite_memory` | Persistent memory across sessions |

---

## Voice

| | Provider | Runs on |
|---|---|---|
| **Speech-to-text** | whisper.cpp | Your server |
| **Text-to-speech** | Edge TTS | Your server |

No API keys, no cloud transcription. Toggle voice in `/settings` — when you enable it, CakeAgent installs the required packages (ffmpeg, whisper model, edge-tts) automatically and confirms when it's ready. Disable it and the dependencies stay installed but inactive.

---

## Security

CakeAgent runs as a dedicated `cakeagent` system user with a nologin shell. It cannot access anyone's home directory.

| Protection | How |
|------------|-----|
| **No open ports** | Outbound connections only (Telegram long poll, MCP registry) |
| **System user isolation** | `cakeagent` user, no login shell, no home directory access |
| **systemd sandbox** | `ProtectSystem=full`, `ProtectHome`, `PrivateTmp`, kernel hardening |
| **Sudoers whitelist** | Only `apt-get`, `apt`, `curl`, and the setup script |
| **Bash command validation** | PreToolUse hook blocks injection patterns, reverse shells, secret reads |
| **File read guard** | Blocks access to `.env`, `.ssh/`, credentials, SSH keys, `/etc/shadow` |
| **File write guard** | Blocks writes to CLAUDE.md, `.env`, `/etc/`, credentials |
| **Sender allowlist** | Only whitelisted Telegram users trigger the agent |
| **Rate limiting** | Per-sender, persisted in SQLite |
| **Audit log** | Every tool invocation recorded |
| **Agent turn limit** | `maxTurns: 25` prevents runaway loops |

---

## Commands

| Command | What it does |
|---------|-------------|
| `/status` | Model, uptime, active tasks |
| `/settings` | Inline keyboard — model, thinking level, voice |
| `/reset` | Clear conversation session |
| `/update` | Pull latest code, rebuild, restart |
| `/restart` | Restart without updating |
| `/help` | List commands |

### CLI

```bash
sudo bash /opt/cakeagent/setup.sh update    # Same as /update
sudo journalctl -u cakeagent -f             # Live logs
sudo systemctl status cakeagent             # Service status
```

---

## Contributing

CakeAgent is intentionally small. Before adding a feature, ask: can the agent do this via an MCP server instead? If yes, don't add it to the codebase.

You can read the entire source in an hour. Please do before submitting a PR.

## License

MIT
