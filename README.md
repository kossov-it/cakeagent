<p align="center">
  <img src=".github/banner.jpg" alt="CakeAgent" style="max-width: 600px; width: 100%;">
</p>

# 🍰 CakeAgent

[![Build](https://github.com/kossov-it/cakeagent/actions/workflows/build.yml/badge.svg)](https://github.com/kossov-it/cakeagent/actions/workflows/build.yml)
![Lines](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/lines.json)
![Files](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/files.json)
![Deps](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/deps.json)
![Size](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kossov-it/cakeagent/main/.badges/size.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A personal AI agent you can actually read. Under 2,200 lines of code, 9 files, 3 runtime dependencies.

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

Open-source AI assistants have a bloat problem. The popular ones ship 400K+ lines of code, 50+ dependencies, WebSocket control planes, and custom plugin marketplaces — then get hit with critical RCE vulnerabilities and tens of thousands of exposed instances. Their plugin ecosystems? Some have been found to leak credentials.

CakeAgent does almost nothing itself and lets the ecosystem do the rest. The orchestrator is under 2,000 lines. Integrations come from the MCP ecosystem — thousands of tool servers maintained by their own communities. No custom plugin format, no marketplace.

| | CakeAgent | Popular alternatives |
|---|---|---|
| **Source code** | <2,000 LOC, 9 files | 400K+ LOC, 50+ modules |
| **Dependencies** | 3 | 47+ direct |
| **Open ports** | 0 | WebSocket, HTTP API |
| **Telegram** | 220 LOC raw `fetch()` | Framework + adapter |
| **Extensions** | MCP open standard | Custom plugin marketplace |
| **Security** | 4-layer defense (OS + sudoers + hooks + agent) | Plaintext creds, no auth |
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

Toggle in `/settings` — CakeAgent installs everything automatically on first enable.

| | Provider | Runs where | Install |
|---|---|---|---|
| **Speech-to-text** | whisper.cpp | Local | ffmpeg, cmake, whisper model, compiles whisper-cli |
| **Text-to-speech** | Edge TTS | Microsoft (free, no API key) | python3-pip, edge-tts |

STT is fully local — your audio never leaves the server. TTS uses Microsoft's Edge speech service (free, no key required, no account needed).

---

## Security

CakeAgent gives Claude real system access — it installs packages, manages services, writes files, runs bash, and adds MCP servers. Four independent layers ensure this works without making the server a target.

```
Layer 1 — OS         systemd sandbox + dedicated user (nologin shell)
Layer 2 — Sudoers    Whitelist: apt-get, apt, dpkg, systemctl, setup.sh
Layer 3 — Hooks      PreToolUse validators on every tool call
Layer 4 — Agent      acceptEdits mode, maxTurns: 25, sender allowlist
```

### What the agent can do

| Action | Mechanism |
|--------|-----------|
| Install packages | `sudo apt-get` / `pip3` / `npm` |
| Manage services | `sudo systemctl` (sshd, cakeagent, networking, firewall blocked) |
| Read/write data files | Within `/opt/cakeagent/data`, `groups/` |
| Run bash commands | Validated by PreToolUse hook before execution |
| Add MCP integrations | Writes to `.mcp.json`, loads on next message |
| Download files | `curl` without sudo — agent-owned paths only |

### What's blocked

| Layer | Blocked |
|-------|---------|
| **Hooks — Bash** | Shell injection (`$()`, backticks), inline execution (`bash -c`, `node -e`, `ruby -e`, `php -r`), reverse shells, download-and-execute, destructive chained rm, user/password management, critical service mutations, firewall changes |
| **Hooks — Files** | Read `.env`/`.ssh`/credentials/`.pem` (Read + Grep guard), enumerate `.ssh`/credentials (Glob guard), write to source code/CLAUDE.md/`.env`/`/etc/` (Write/Edit guard) |
| **Sudoers** | No `curl` as root, no arbitrary `bash -c`, no commands outside whitelist |
| **OS sandbox** | `ProtectHome`, `ProtectSystem=full`, `PrivateTmp`, kernel module protection |
| **Agent** | Sender allowlist, rate limiting, turn limit, every tool call logged to SQLite audit table |

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
