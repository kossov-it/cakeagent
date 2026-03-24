# CakeAgent

## Purpose
Minimal, secure personal AI assistant built on the Claude Agent SDK. Connects to Telegram, runs agents via `query()`, manages integrations via MCP + skills.sh, supports voice.

## Tech Stack
- **Runtime**: Node.js 18+ (ESM)
- **Agent**: `@anthropic-ai/claude-agent-sdk` — `query()`, `createSdkMcpServer`, `tool()`, hooks
- **Storage**: `better-sqlite3` (SQLite with WAL mode)
- **Validation**: `zod` (v4, peer dep of Agent SDK)
- **Telegram**: Raw `fetch()` — no framework, 0 deps
- **Voice (optional)**: `edge-tts` for TTS, local `whisper-cli` for STT — no API keys

## Directory Layout
```
src/index.ts        — Orchestrator: poll loop, routing, debounce, scheduler, shutdown
src/agent.ts        — Agent SDK wrapper: query(), session resume, streaming
src/tools.ts        — In-process MCP server: 19 tools (createSdkMcpServer)
src/hooks.ts        — Security hooks: 5 PreToolUse matchers + SubagentStart auditor + PreCompact archiver
src/store.ts        — SQLite CRUD (messages, schedules, groups, sessions, audit, skills)
src/voice.ts        — STT (whisper-cli) + TTS (edge-tts)
src/config.ts       — .env loading
src/types.ts        — Shared types + validation constants
channels/telegram.ts — Raw fetch Telegram adapter (retry, HTML, chunking)
groups/main/CLAUDE.md — Agent identity + rules (not this file)
data/skills/        — Installed skill content (.md) + index.json
```

## Build / Run / Test
```bash
npm install          # Install dependencies
npm run dev          # Development (tsx)
npm run build        # Compile TypeScript
npm start            # Production (node dist/)
npx tsc --noEmit     # Type-check only
```

## Key Conventions
- ESM only (`"type": "module"`) — use `.js` extensions in imports
- No framework dependencies for HTTP — raw `fetch()` everywhere
- In-process MCP server via `createSdkMcpServer` — no child process IPC
- Two integration paths: MCP servers (runtime tools) and skills.sh (CLI-based, knowledge-driven)
- Skills stored in `data/skills/`, loaded into prompt as `[SKILLS]` block
- `acceptEdits` permission mode — never `bypassPermissions`
- CLAUDE.md in `groups/*/` is read-only for the agent — memory goes to `data/memory.md`
- Sequential processing — one agent invocation at a time
- Settings hot-reloaded from `data/settings.json` per invocation

## Security
- Dedicated `cakeagent` system user with nologin shell
- systemd: `ProtectSystem=full`, `ProtectHome=true`, `PrivateTmp=true`
- Sudoers whitelist: `apt-get`, `apt`, `dpkg`, `systemctl`, `setup.sh` (agent told it only has apt)
- 6 PreToolUse hooks: Bash (deny patterns + command normalization), Read, Grep, Glob, Write/Edit
- PreCompact hook archives conversations on context compaction
- Bash commands normalized (quotes stripped) before deny-pattern matching
- Settings validated: model, thinkingLevel, voiceTtsVoice checked against allowed values
- Skill content capped at 50 KB, memory.md capped at 50 KB
- Atomic writes for settings.json and skills/index.json (write-tmp-then-rename)
- Prompt injection detection: flagged messages get security warning prepended
- Memory/skill content sanitized via `sanitizeMemory()` before storage
- Rate limiting persisted in SQLite; all tool calls logged to audit_log
- Chat ID + sender allowlist — only configured Telegram chats and senders processed
- Concurrency guard (`agentBusy`) — one agent invocation at a time
- `.env` permission check on startup (warns if not 600)
- `unhandledRejection` handler with audit logging
