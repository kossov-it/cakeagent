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

A personal AI agent you can actually read — around 2,900 lines of code, 11 files, and 3 runtime dependencies.

CakeAgent connects Claude to Telegram and gives it tools, voice, scheduling, file access, web search, and code execution. New capabilities come from two ecosystems: **MCP** (runtime tool servers) and **skills.sh** (knowledge-driven CLI integrations). Ask "add Google Calendar" in chat and it installs itself.

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

CakeAgent does almost nothing itself and lets the ecosystem do the rest. The entire codebase is ~2,900 lines across 11 files. Integrations come from two open ecosystems — MCP (thousands of tool servers) and skills.sh (CLI knowledge packs). No custom plugin format, no marketplace.

| | CakeAgent | Popular alternatives |
|---|---|---|
| **Source code** | ~2,900 LOC, 11 files | 400K+ LOC, 50+ modules |
| **Dependencies** | 3 | 47+ direct |
| **Open ports** | 0 | WebSocket, HTTP API |
| **Telegram** | 274 LOC raw `fetch()` | Framework + adapter |
| **Integrations** | MCP + skills.sh | Custom plugin marketplace |
| **Security** | 5-layer defense, 60+ deny patterns, every tool call audited | Varies — some have critical RCEs |
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
4. Configures passwordless sudo (`apt-get`, `apt`, `dpkg`, `systemctl`, `setup.sh`) — hooks restrict usage
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
┌──────────────┐     ┌───────────────┐     ┌───────────────┐
│   Telegram   │────▶│  Orchestrator │────▶│  Claude Agent │
│  (raw fetch) │◀────│  (index.ts)   │◀────│  SDK query()  │
└──────────────┘     └───────┬───────┘     └──────┬────────┘
                             │                    │
       ┌─────────────────────┼────────────────────┤
       │                     │                    │
┌──────┴──────┐       ┌──────┴──────┐      ┌──────┴──────────┐
│   SQLite    │       │    Voice    │      │ Security Hooks  │
│ (store.ts)  │       │  STT / TTS  │      │  (6 PreToolUse  │
└─────────────┘       └─────────────┘      │   + PreCompact) │
                                           └──────┬──────────┘
       ┌──────────────────────────────────────────┴┐
       │              Tool Layer                   │
       │                                           │
       │  ┌─────────────┐ ┌───────────┐ ┌───────┐  │
       │  │  19 Built-in│ │ External  │ │Skills │  │
       │  │  MCP Tools  │ │ MCP (.mcp)│ │(.sh)  │  │
       │  └─────────────┘ └───────────┘ └───────┘  │
       └───────────────────────────────────────────┘
```

Messages go through three layers. Most never reach the Claude API:

1. **Settings callbacks** (inline keyboard buttons) — handled directly in the orchestrator
2. **Commands** (`/status`, `/settings`, `/update`, etc.) — handled in the orchestrator
3. **Everything else** — sent to Claude as a prompt with conversation context and persistent memory

### Source files

```
src/index.ts          773  Orchestrator, routing, debounce, cron scheduler, memory extraction
src/tools.ts          471  19 MCP tools with cron support (in-process)
src/store.ts          321  SQLite: messages, schedules, groups, audit, skills
src/hooks.ts          275  Security hooks (60+ Bash deny patterns, Read, Grep, Glob, Write/Edit)
channels/telegram.ts  277  Telegram adapter (raw fetch, retry, HTML, replies, settings keyboard)
src/cron.ts           234  Cron expression parser + cronToHuman (standard 5-field format)
src/types.ts          182  Type definitions, shared constants, validation
src/voice.ts          129  Whisper STT + Edge TTS
src/agent.ts          111  Claude Agent SDK wrapper + streaming + subagents
src/systemTasks.ts     97  System tasks: morning check-in + dream/consolidation
src/config.ts          48  .env parser
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

**Auto-extraction**: Every 5 conversations (configurable via `memoryExtractionInterval`), a background agent reviews recent messages and automatically saves new facts, preferences, and corrections to memory — without you explicitly asking. Runs silently in the background.

Memory survives restarts and `/reset`. The `/reset` command only clears the Claude SDK session (conversation turns), not learned preferences.

### Autonomous behavior

Three system tasks run automatically (configurable via settings, disable by setting cron to empty string):

| Task | Default schedule | What it does |
|------|-----------------|-------------|
| **Morning check-in** | 8:57am daily | Reviews memory and scheduled tasks, sends a brief daily summary |
| **Dream** | 3:23am daily | Consolidates memory — removes outdated entries, merges duplicates, fixes contradictions |
| **Memory extraction** | Every 5 conversations | Reviews recent messages, saves new facts/preferences to memory |

Scheduling uses standard 5-field cron expressions (standard 5-field format). Missed tasks are recovered on restart — one-shot tasks fire, recurring tasks silently advance.

---

## Integrations

CakeAgent extends through two open ecosystems, searched **in parallel** when you ask to connect a service:

```
You:       "Connect to Google Calendar"
CakeAgent:  Found MCP server and a skill. MCP is preferred (structured tools).
            Install the MCP server?
You:       "Yes"
CakeAgent:  Installed. Available now.
```

### MCP servers — runtime tools

The agent searches the [official MCP Registry](https://registry.modelcontextprotocol.io) for tool servers. Installed servers go into `.mcp.json`, load automatically on the next message, and get their own `/command` in the Telegram menu.

### Skills — knowledge packs from [skills.sh](https://skills.sh)

Skills inject documentation and CLI knowledge directly into the agent's prompt. The agent then uses standard tools (Bash, pip, npm) to interact with the service. Used when no MCP server exists for a service. Browse available skills at [skills.sh](https://skills.sh) or manage them with `/skills` in Telegram.

### Built-in tools

| Tool | What it does |
|------|-------------|
| `send_message` / `send_file` | Send progress updates or files mid-conversation |
| `schedule_task` / `list_schedules` / `update_schedule` / `delete_schedule` | Task scheduling with cron expressions (e.g. `0 9 * * 1-5` = weekdays at 9am) |
| `search_mcp_registry` | Search the official MCP registry |
| `install_tool` / `remove_tool` / `list_tools` | Manage MCP servers |
| `install_skill` / `remove_skill` / `list_skills` | Manage skills.sh integrations |
| `get_settings` / `update_settings` | Read or change settings |
| `register_group` / `list_groups` | Manage Telegram group chats |
| `update_memory` / `rewrite_memory` | Persistent memory across sessions |

---

## Voice

Two separate toggles in `/settings` — **Voice In** (speech-to-text) and **Voice Out** (text-to-speech). CakeAgent installs all dependencies automatically on first enable.

| | Provider | Runs where | Install |
|---|---|---|---|
| **Speech-to-text** | whisper.cpp | Local | ffmpeg, cmake, whisper model, compiles whisper-cli |
| **Text-to-speech** | Edge TTS | Microsoft (free, no API key) | python3-pip, edge-tts |

STT is fully local — your audio never leaves the server. TTS uses Microsoft's Edge speech service (free, no key required, no account needed).

---

## Security

CakeAgent gives Claude real system access — it installs packages, manages services, writes files, runs bash, and adds integrations. Five independent layers ensure this works without making the server a target.

### Defense layers

| Layer | What it does |
|-------|-------------|
| **OS sandbox** | Dedicated `cakeagent` user (nologin shell), systemd `ProtectSystem=full`, `ProtectHome=true`, `PrivateTmp=true` |
| **Sudoers** | Passwordless sudo limited to `apt-get`, `apt`, `dpkg`, `systemctl`, and `setup.sh` only |
| **PreToolUse hooks** | Every Bash, Read, Grep, Glob, Write, and Edit call validated before execution |
| **Agent controls** | `acceptEdits` permission mode, `maxTurns: 25`, sender allowlist, rate limiting |
| **Runtime checks** | Prompt injection detection, memory/skill content sanitization, startup permission auto-fix (`.env`, `data/`, `.mcp.json`, `credentials/`) |

### What's allowed

Install packages (`apt`, `pip`, `npm`), manage services (`systemctl` — critical services blocked), read/write data files, run validated bash commands, add MCP servers and skills, download files without sudo.

### What's blocked

**Bash**: shell injection (subshell exfiltration, backticks), inline execution (`bash -c`, `node -e`, `python -c`, etc.), reverse shells, download-and-execute, destructive `rm`, environment variable dumps (`env`, `printenv`), user/password management, `systemctl mask`, critical service mutations (sshd, cakeagent, networking), source code writes, `npm run build`. Enhanced validators: Unicode whitespace injection, control characters, IFS manipulation, process substitution, `/proc/environ` access, zsh dangerous builtins. Commands are normalized (quotes stripped) before pattern matching.

**System files**: `/etc/shadow`, `/etc/passwd`, `/etc/sudoers*`, `/etc/ssh/`, `/etc/hosts`, `/etc/resolv.conf`, `/etc/hostname`, `/etc/fstab`, `/etc/sysctl.conf`, `/etc/apt/sources.list`, cakeagent's own service file. Agent can still configure nginx, mysql, cron, letsencrypt, systemd services, `sysctl.d/`, `sources.list.d/`, and any app it installs.

**Firewall**: `nft flush`, `nft delete table`, `iptables -F/-X/-Z`, `iptables -P ACCEPT` blocked. `systemctl stop/disable` on firewall services blocked. SSH port 22 protected. Adding/deleting rules and reloading allowed.

**Files**: read `.env`/`.ssh`/credentials/`.pem`/`/etc/shadow` (Read + Grep guard), enumerate `.ssh`/credentials (Glob guard), write to source code/CLAUDE.md/`.env`/`package.json`/`tsconfig.json`/skill index (Write/Edit guard).

**Audit**: every tool call logged to SQLite `audit_log` table. Injection attempts logged with sender and content.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/status` | Model, uptime, skills, active tasks, voice status |
| `/settings` | Inline keyboard — model (Haiku/Sonnet/Opus), thinking level, voice in/out, morning brief |
| `/skills` | List installed skills with source and install date |
| `/reset` | Clear conversation session (keeps memory and settings) |
| `/update` | Pull latest code, rebuild, restart |
| `/restart` | Restart without updating |
| `/help` | List commands |

`/reset` clears the conversation session but keeps memory and settings. `/update` clears all sessions (context is stale after code changes). `/restart` preserves everything. Memory survives all operations.

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
