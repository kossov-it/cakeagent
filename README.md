# 🍰 CakeAgent

[![Build](https://github.com/kossov-it/cakeagent/actions/workflows/build.yml/badge.svg)](https://github.com/kossov-it/cakeagent/actions/workflows/build.yml)
![Lines](https://img.shields.io/badge/source-1%2C750_lines-blue)
![Files](https://img.shields.io/badge/files-9-blue)
![Deps](https://img.shields.io/badge/deps-3-green)
![Size](https://img.shields.io/badge/source_size-63KB-blue)

**A personal AI agent in 1,750 lines of code.**

CakeAgent runs Claude as a full agent on your server — with tool use, web search, code execution, file access, scheduling, and voice — all through Telegram. It extends itself through the MCP ecosystem: thousands of ready-made integrations, discoverable and installable via chat.

Single Node.js process. 3 dependencies. Dedicated system user. Sandboxed by systemd. No API keys for voice.

### Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/kossov-it/cakeagent/main/install.sh | sudo bash
```

Or manually:
```bash
git clone https://github.com/kossov-it/cakeagent.git /tmp/cakeagent
cd /tmp/cakeagent && sudo bash setup.sh
```

Creates a `cakeagent` system user, installs to `/opt/cakeagent`, asks for credentials, starts the service. Send a message to your bot — it guides you through the rest.

Uninstall (removes everything — user, service, data, no traces):
```bash
sudo bash /opt/cakeagent/setup.sh uninstall
```

---

## Why

The most popular open-source AI assistants ship with 400K+ lines of code, 50+ dependencies, WebSocket control planes, monorepo workspace systems, custom plugin marketplaces, and eager-loaded SDKs for 20+ messaging platforms — burning 75–85% CPU on startup before a single message is processed. They bind to `0.0.0.0` by default, store credentials in plaintext, and have racked up critical RCE vulnerabilities (CVE-2026-25253, CVE-2026-30741) with 135,000+ exposed instances. Their plugin ecosystems? [7% of published skills contain credential-leaking flaws](https://signalcage.com/artificial-intelligence/2026/17/20/openclaw-security-crisis-135000-exposed-instances-and-active-infostealer-campaigns-february-2026/).

Users report spending more time configuring these tools than actually using them.

CakeAgent takes the opposite approach: **do almost nothing yourself, and let the ecosystem do the rest.**

The core is a thin orchestrator (1,750 LOC) that connects Telegram to the Claude Agent SDK. Everything else — calendar, email, GitHub, Slack, databases, APIs — comes from the **MCP ecosystem**. Thousands of ready-made tool servers, discoverable and installable via chat. No custom plugin system, no marketplace, no trust assumptions — just the open standard.

### How it compares

| | CakeAgent | Popular AI assistants |
|---|---|---|
| **Code** | 1,750 LOC, 9 files | 400K+ LOC, 50+ modules |
| **Dependencies** | 3 | 47+ direct, hundreds transitive |
| **Network surface** | 0 listeners (outbound only) | WebSocket on 0.0.0.0, HTTP API |
| **Telegram** | 220 LOC raw `fetch()` | grammY/Telegraf framework + adapter |
| **Tool ecosystem** | MCP open standard — install via chat | Custom plugin marketplace (7% malicious) |
| **Security** | Dedicated system user, systemd sandbox, Bash hooks | Plaintext credentials, no auth by default |
| **Startup** | Sub-second | 75–85% CPU, 3MB bundle, 1000+ imports |
| **CVEs** | 0 | Multiple critical RCEs |

### Key design decisions

**MCP as the extension model.** Other assistants build plugin systems from scratch. CakeAgent uses MCP (Model Context Protocol), an open standard with thousands of existing servers. Google Calendar, GitHub, Slack, Jira — all installable via a single chat message. No code changes, no restarts.

**Telegram via raw `fetch()`.** 8 API endpoints, 200 lines, zero dependencies. Full control over long polling, error handling, retry logic. Trivially auditable.

**In-process MCP via `createSdkMcpServer`.** CakeAgent's own tools run in the same process as the orchestrator. Side effects are intercepted via `PostToolUse` hooks with closure-shared state. No child process, no IPC.

**Layered security.** Not "please don't" in a prompt, but actual code-level enforcement. `acceptEdits` mode + Bash validation hooks + protected CLAUDE.md + sanitized memory + audit logging.

---

## Install

Requires a Linux server with Node.js 18+ and a Claude subscription or API key.

```bash
git clone https://github.com/kossov-it/cakeagent.git
cd cakeagent
sudo bash setup.sh
```

The script handles everything:

| Step | What it does |
|------|-------------|
| 1 | Checks Node.js and npm |
| 2 | Creates a dedicated `cakeagent` system user |
| 3 | Installs to `/opt/cakeagent` |
| 4 | Installs Node.js + voice dependencies |
| 5 | Configures passwordless `sudo apt` for the agent |
| 6 | Asks for Telegram bot token ([get from @BotFather](https://t.me/BotFather)) |
| 7 | Asks for Telegram user ID ([get from @userinfobot](https://t.me/userinfobot)) |
| 8 | Asks for Claude auth — see below |
| 9 | Installs and starts the systemd service |

**Claude authentication** (step 8 offers two options):

| Option | How to get it | Env var |
|--------|---------------|---------|
| **Subscription token** (recommended) | Install [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code): `npm i -g @anthropic-ai/claude-code`, then run `claude setup-token` — copy the `sk-ant-oat...` token (valid 1 year) | `CLAUDE_CODE_OAUTH_TOKEN` |
| **API key** (pay-per-use) | Create at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) — copy the `sk-ant-api...` key | `ANTHROPIC_API_KEY` |

After setup, send a message to your bot on Telegram. CakeAgent guides you through personalization (name, personality, voice, integrations) via chat.

### Uninstall

Removes everything — service, user, data, sudoers entry, install directory. No traces.

```bash
sudo bash setup.sh uninstall
```

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

### Files

```
/opt/cakeagent/
├── src/
│   ├── index.ts      422  Orchestrator: routing, scheduler, shutdown
│   ├── tools.ts      309  In-process MCP server (16 tools)
│   ├── store.ts      218  SQLite: messages, schedules, groups, audit
│   ├── voice.ts      151  Local Whisper STT + Edge TTS
│   ├── hooks.ts      147  Security hooks + conversation archival
│   ├── types.ts      141  Type definitions
│   ├── agent.ts       91  Claude Agent SDK wrapper
│   └── config.ts      51  .env parser
├── channels/
│   └── telegram.ts   220  Raw fetch adapter
├── groups/main/
│   └── CLAUDE.md       Agent identity + rules
├── data/
│   ├── store.db        SQLite database
│   ├── settings.json   Runtime settings
│   └── memory.md       Agent-writable persistent memory
├── .env                Credentials (chmod 600)
└── .mcp.json           External MCP servers
```

### Three layers of interception

Most interactions never touch the Claude API:

1. **Callback queries** (inline keyboard) → update settings → zero cost
2. **Chat commands** (`/status`, `/settings`, `/reset`, `/restart`) → handled in orchestrator → zero cost
3. **Regular messages** → routed to Claude agent → API cost

---

## MCP Integrations

```
You:       "Find an MCP server for Google Calendar"
CakeAgent: Found 3 servers:
            1. @anthropic/google-calendar-mcp (verified) ...
           Install #1?
You:       "Yes"
CakeAgent: Installed. Available on your next message.
```

The agent queries the [official MCP Registry](https://registry.modelcontextprotocol.io), shows results, and installs with your confirmation. Servers are stored in `.mcp.json` and loaded automatically — no restart needed.

### Built-in tools

| Tool | Description |
|------|-------------|
| `send_message` | Mid-conversation progress messages |
| `schedule_task` | Recurring / one-time tasks |
| `search_mcp_registry` | Query the official registry |
| `install_tool` / `remove_tool` | Manage MCP servers |
| `update_settings` | Change model, thinking level, voice |
| `register_group` | Add Telegram group chats |
| `update_memory` / `rewrite_memory` | Persistent memory |

---

## Voice

| Component | Provider | Cost |
|-----------|----------|------|
| STT | **whisper.cpp** (local) | Free |
| TTS | **Edge TTS** (Microsoft) | Free |

No API keys for voice. STT and TTS run entirely on your server. Enable via `/settings` or chat.

---

## Security

| Layer | What it does |
|-------|-------------|
| **No network listeners** | Outbound only — Telegram long poll + MCP registry |
| **Dedicated system user** | `cakeagent` user with nologin shell, isolated from your account |
| **Chat ID + sender allowlist** | Only configured chats and senders trigger the agent |
| **`acceptEdits` permissions** | File ops allowed, Bash gated by validation hooks |
| **PreToolUse Bash validator** | Blocks shell injection, reverse shells, pipe-to-sh, secret reads |
| **Read guard** | Blocks Read tool access to .env, .ssh/, credentials/, SSH keys |
| **Protected CLAUDE.md** | Agent cannot modify its own instructions |
| **Sanitized memory** | Injection patterns stripped from memory writes |
| **Persistent rate limiting** | SQLite-backed, survives restarts |
| **Audit trail** | Every tool invocation logged |
| **`maxTurns: 25`** | Prevents runaway agent loops |
| **Streaming dedup** | Final result only sent if not already streamed |
| **systemd hardening** | `ProtectSystem=full`, `ProtectHome=true`, `PrivateTmp` |

---

## Telegram Commands

| Command | Description | Cost |
|---------|-------------|------|
| `/status` | Model, uptime, active tasks | Free |
| `/settings` | Inline keyboard for model, thinking, voice | Free |
| `/reset` | Clear conversation session | Free |
| `/restart` | Restart the bot (systemd brings it back) | Free |
| `/help` | List commands | Free |

---

## Manage

```bash
sudo journalctl -u cakeagent -f       # Live logs
sudo systemctl status cakeagent       # Status
sudo systemctl restart cakeagent      # Restart (or /restart via Telegram)
sudo systemctl stop cakeagent         # Stop
```

---

## Contributing

CakeAgent is intentionally small. Before adding a feature, ask: can the agent do this via an MCP server instead? If yes, don't add it — install the MCP server.

The entire codebase fits in one context window. Read it before submitting a PR.

## License

MIT
