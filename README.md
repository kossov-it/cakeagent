# 🍰 CakeAgent

**A personal AI agent in 1,600 lines of code.**

CakeAgent runs Claude as a full agent on your server — with tool use, web search, code execution, file access, scheduling, and voice — all through Telegram. It extends itself through the MCP ecosystem: thousands of ready-made integrations, discoverable and installable via chat.

Single Node.js process. 3 dependencies. No containers. No web UI. No API keys for voice.

---

## Why

Every open-source AI assistant arrives pre-bloated. 50+ dependencies, Docker Compose stacks, Redis queues, WebSocket servers, custom plugin systems, and web dashboards — before you've sent a single message. They reinvent capabilities that already exist elsewhere, then lock you into their abstractions.

CakeAgent takes the opposite approach: **do almost nothing yourself, and let the ecosystem do the rest.**

The core is a thin orchestrator (~1,600 LOC) that connects Telegram to the Claude Agent SDK. Everything else — calendar, email, GitHub, Slack, databases, APIs — comes from the **MCP ecosystem**. Instead of building a plugin system, CakeAgent plugs into the one that already exists.

### How it compares

| | CakeAgent | Typical AI assistant |
|---|---|---|
| Dependencies | 3 | 30–100+ |
| Source code | ~1,600 LOC | 10K–50K+ |
| Network listeners | 0 (outbound only) | HTTP, WebSocket, Redis |
| Telegram | 200 LOC raw `fetch()` | Framework + adapter |
| Tool ecosystem | MCP — thousands of servers, install via chat | Custom plugin SDK |
| Permission model | `acceptEdits` + PreToolUse hooks | `bypassPermissions` or nothing |
| Memory | Injected into every prompt | Vector DB, embeddings |

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
| 5 | Installs ffmpeg |
| 6 | Configures passwordless `sudo apt` for the agent |
| 7 | Asks for Telegram bot token (validates it) |
| 8 | Asks for Telegram user ID |
| 9 | Asks for Claude auth (subscription token or API key) |
| 10 | Installs and starts the systemd service |

After setup, send a message to your bot on Telegram. CakeAgent guides you through personalization (name, personality, voice, integrations) via chat.

### Uninstall

Removes everything — service, user, data, sudoers entry, install directory. No traces.

```bash
sudo bash setup.sh uninstall
```

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  Telegram    │────▶│  Orchestrator │────▶│  Claude Agent   │
│  (raw fetch) │◀────│  (index.ts)   │◀────│  SDK query()    │
└─────────────┘     └──────┬───────┘     └───────┬────────┘
                           │                      │
                    ┌──────┴───────┐       ┌──────┴────────┐
                    │   SQLite     │       │  MCP Tools     │
                    │  (store.ts)  │       │  (in-process)  │
                    └──────────────┘       └───────────────┘
```

### Files

```
/opt/cakeagent/
├── src/
│   ├── index.ts        Orchestrator: routing, scheduler, shutdown
│   ├── agent.ts        Claude Agent SDK wrapper
│   ├── tools.ts        In-process MCP server (16 tools)
│   ├── hooks.ts        Security hooks + conversation archival
│   ├── store.ts        SQLite: messages, schedules, groups, audit
│   ├── voice.ts        Local Whisper STT + Edge TTS
│   ├── config.ts       .env parser
│   └── types.ts        Type definitions
├── channels/
│   └── telegram.ts     Raw fetch adapter
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

No API keys. No cloud. Voice notes processed entirely on-device. Enable via `/settings` or chat.

---

## Security

| Layer | What it does |
|-------|-------------|
| **No network listeners** | Outbound only — Telegram long poll + MCP registry |
| **Dedicated system user** | `cakeagent` user with restricted permissions |
| **Chat ID + sender allowlist** | Only configured chats and senders trigger the agent |
| **`acceptEdits` permissions** | File ops allowed, Bash gated by validation hooks |
| **PreToolUse Bash validator** | Blocks shell injection, reverse shells, pipe-to-sh |
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
