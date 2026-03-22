import { loadConfig } from './config.js';
import * as store from './store.js';
import { createTools } from './tools.js';
import { createHooks } from './hooks.js';
import { runAgent } from './agent.js';
import { transcribeAudio, synthesizeSpeech, checkVoiceDeps } from './voice.js';
import { createTelegramChannel } from '../channels/telegram.js';
import { existsSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SharedState, TelegramUpdate, CakeSettings, IncomingMessage } from './types.js';

// --- Startup ---

const config = loadConfig();
store.initDb(config.dataDir);

const settings = store.loadSettings();
const groupsDir = resolve(config.groupsDir);

// Ensure main group exists
const mainDir = join(groupsDir, 'main');
mkdirSync(mainDir, { recursive: true });

// Default CLAUDE.md written in Phase 7 — create minimal one if missing
if (!existsSync(join(mainDir, 'CLAUDE.md'))) {
  writeFileSync(join(mainDir, 'CLAUDE.md'), `# ${settings.assistantName}\n\nYou are a personal AI assistant. Be concise and helpful.\n`);
}

// Default memory file
const memPath = join(config.dataDir, 'memory.md');
if (!existsSync(memPath)) writeFileSync(memPath, '');

// Shared state for hook-based IPC
const state: SharedState = { pendingMessages: [], pendingSchedules: [] };

// Build components
const picoServer = createTools(state, config.dataDir, groupsDir);
const hooks = createHooks(state, groupsDir);

// --- Startup security checks ---

const envPath = resolve('.env');
if (existsSync(envPath)) {
  const stat = statSync(envPath);
  const mode = (stat.mode & 0o777).toString(8);
  if (mode !== '600') {
    console.warn(`[security] .env has permissions ${mode} — should be 600. Run: chmod 600 .env`);
  }
}

const gitignorePath = resolve('.gitignore');
if (existsSync(gitignorePath)) {
  const gi = readFileSync(gitignorePath, 'utf-8');
  for (const required of ['.env', 'data/', 'credentials/']) {
    if (!gi.includes(required)) {
      console.warn(`[security] .gitignore is missing "${required}" — secrets may be committed!`);
    }
  }
}

// Telegram channel — allowedChatIds includes main + registered groups
const allowedChatIds = () => {
  const ids = new Set([config.telegramChatId]);
  for (const g of store.getGroups()) ids.add(g.chatId);
  return ids;
};
const telegram = createTelegramChannel(config.telegramBotToken, allowedChatIds);

function refreshBotCommands() {
  const commands = [
    { command: 'status', description: 'Show bot status' },
    { command: 'settings', description: 'Open settings menu' },
    { command: 'reset', description: 'Reset conversation session' },
    { command: 'update', description: 'Pull latest code and restart' },
    { command: 'restart', description: 'Restart the bot' },
    { command: 'help', description: 'Show available commands' },
  ];
  try {
    const mcpPath = resolve('.mcp.json');
    if (existsSync(mcpPath)) {
      const mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      for (const name of Object.keys(mcpConfig.mcpServers ?? {})) {
        commands.push({ command: name.replace(/[^a-z0-9]/g, '').slice(0, 32), description: `${name} integration` });
      }
    }
  } catch { /* ignore */ }
  telegram.setCommands(commands);
}
refreshBotCommands();

const startTime = Date.now();
console.log(`[cakeagent] Started. Model: ${settings.model}. Main chat: ${config.telegramChatId}`);

checkVoiceDeps().then(({ missing }) => {
  if (missing.length) console.warn('[voice] Missing:', missing.join(', '));
});

// --- Settings callback handler ---

const VALID_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']);
const VALID_THINKING = new Set(['off', 'low', 'medium', 'high']);

async function handleSettingsCallback(data: string, settings: CakeSettings, chatId: string): Promise<CakeSettings> {
  const [key, val] = data.split(':');
  if (key === 'model' && VALID_MODELS.has(val)) settings.model = val;
  else if (key === 'thinking' && VALID_THINKING.has(val)) settings.thinkingLevel = val;
  else if (key === 'voice') {
    settings.voiceReceive = !settings.voiceReceive;
    if (settings.voiceReceive) {
      await telegram.send(chatId, 'Setting up voice input (STT)...');
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('sudo', ['apt-get', 'install', '-y', 'ffmpeg'], { timeout: 120_000, stdio: 'pipe' });
        const modelsDir = join(config.dataDir, 'models');
        mkdirSync(modelsDir, { recursive: true });
        if (!existsSync(join(modelsDir, 'ggml-base.bin'))) {
          execFileSync('curl', ['-L', '-o', join(modelsDir, 'ggml-base.bin'), 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'], { timeout: 300_000, stdio: 'pipe' });
        }
        await telegram.send(chatId, 'Voice input ready.');
      } catch (err) {
        await telegram.send(chatId, `Voice setup failed: ${(err as Error).message.slice(0, 150)}`);
        settings.voiceReceive = false;
      }
    }
  } else if (key === 'voiceReply') {
    settings.voiceReply = !settings.voiceReply;
    if (settings.voiceReply) {
      await telegram.send(chatId, 'Setting up voice output (TTS)...');
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('sudo', ['apt-get', 'install', '-y', 'ffmpeg'], { timeout: 120_000, stdio: 'pipe' });
        execFileSync('npm', ['i', 'edge-tts'], { cwd: '/opt/cakeagent', timeout: 60_000, stdio: 'pipe' });
        await telegram.send(chatId, 'Voice output ready.');
      } catch (err) {
        await telegram.send(chatId, `Voice setup failed: ${(err as Error).message.slice(0, 150)}`);
        settings.voiceReply = false;
      }
    }
  }
  store.saveSettings(settings);
  return settings;
}

// --- Chat command handler ---

async function handleChatCommand(cmd: string, chatId: string): Promise<boolean> {
  const command = cmd.replace(/^\//, '').split(/\s|@/)[0].toLowerCase();

  switch (command) {
    case 'status': {
      const uptime = Math.floor((Date.now() - startTime) / 60_000);
      const s = store.loadSettings();
      const groups = store.getGroups();
      const tasks = store.getAllSchedules();
      await telegram.send(chatId,
        `*cakeagent*\nModel: \`${s.model}\`\nThinking: \`${s.thinkingLevel}\`\n` +
        `Groups: ${groups.length}\nActive tasks: ${tasks.filter(t => t.status === 'active').length}/${tasks.length}\n` +
        `Voice in: ${s.voiceReceive ? 'on' : 'off'} | Voice reply: ${s.voiceReply ? 'on' : 'off'}\nUptime: ${uptime} min`
      );
      return true;
    }
    case 'settings': {
      const s = store.loadSettings();
      await telegram.sendSettingsKeyboard(chatId, s);
      return true;
    }
    case 'reset': {
      const group = resolveGroup(chatId);
      if (group) store.setSession(group, '');
      await telegram.send(chatId, 'Session reset.');
      return true;
    }
    case 'update':
      await telegram.send(chatId, 'Updating...');
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['pull'], { cwd: '/opt/cakeagent', timeout: 60_000 });
        execFileSync('npm', ['run', 'build'], { cwd: '/opt/cakeagent', timeout: 120_000 });
        await telegram.send(chatId, 'Updated. Restarting...');
      } catch (err) {
        await telegram.send(chatId, `Update failed: ${(err as Error).message.slice(0, 200)}`);
        return true;
      }
      abortController.abort();
      setTimeout(() => process.exit(0), 500);
      return true;
    case 'restart':
      await telegram.send(chatId, 'Restarting...');
      abortController.abort();
      setTimeout(() => process.exit(0), 200);
      return true;
    case 'help':
      await telegram.send(chatId,
        '/status — Bot status\n/settings — Settings menu\n/reset — Reset session\n/update — Pull latest code and restart\n/restart — Restart bot\n/help — This message\n\nEverything else goes to the agent.'
      );
      return true;
    default:
      return false;
  }
}

// --- Message routing ---

function resolveGroup(chatId: string): string | null {
  if (chatId === config.telegramChatId) return 'main';
  const group = store.getGroupByChatId(chatId);
  return group?.folder ?? null;
}

function shouldTrigger(msg: IncomingMessage, groupFolder: string): boolean {
  // Main DM — always trigger
  if (groupFolder === 'main') return true;
  // Groups — check trigger pattern
  const group = store.getGroupByChatId(msg.chatId);
  if (!group) return false;
  const settings = store.loadSettings();
  const pattern = group.trigger || settings.triggerPattern;
  return msg.text?.toLowerCase().includes(pattern.toLowerCase()) ?? false;
}

function formatPrompt(messages: Array<{ sender_name: string; content: string; timestamp: number }>): string {
  // Reverse to chronological order (DB returns DESC)
  return [...messages].reverse().map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<message sender="${m.sender_name}" time="${time}">${m.content}</message>`;
  }).join('\n');
}

// --- Concurrency guard ---
// Only one agent invocation at a time (scheduler + main loop share this)
let agentBusy = false;

// --- Scheduler ---

const schedulerInterval = setInterval(async () => {
  if (agentBusy) return; // Skip if agent is already running
  const now = new Date().toISOString();
  const due = store.getDueSchedules(now);

  for (const task of due) {
    if (agentBusy) break;
    try {
      agentBusy = true;
      const prompt = `[SCHEDULED TASK]\n\n${task.task}`;
      const sessionId = task.contextMode === 'group' ? (store.getSession(task.groupFolder) ?? undefined) : undefined;
      const currentSettings = store.loadSettings();

      const { result } = await runAgent(
        { prompt, groupFolder: task.groupFolder, chatId: task.chatId, isMain: task.groupFolder === 'main', sessionId },
        { picoServer, hooks, settings: currentSettings, groupsDir },
      );

      // Drain pending messages from the scheduled task
      for (const msg of state.pendingMessages.splice(0)) {
        await telegram.send(msg.chatId || task.chatId, msg.text);
      }

      if (result) await telegram.send(task.chatId, result);

      // Update schedule
      if (task.scheduleType === 'once') {
        store.updateSchedule(task.id, { status: 'completed' } as any);
      } else if (task.scheduleType === 'interval') {
        const ms = Number(task.scheduleValue);
        const nextRun = isNaN(ms) || ms <= 0
          ? new Date(Date.now() + 60 * 60_000).toISOString()
          : new Date(Date.now() + ms).toISOString();
        store.updateSchedule(task.id, { nextRun, lastRun: now } as any);
      } else {
        // Cron: advance by 24h as fallback (agent can set precise nextRun via update_schedule)
        const nextRun = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
        store.updateSchedule(task.id, { nextRun, lastRun: now } as any);
      }
    } catch (err) {
      console.error(`[scheduler] Task #${task.id} failed:`, (err as Error).message);
      store.updateSchedule(task.id, { lastError: (err as Error).message } as any);
    } finally {
      agentBusy = false;
    }
  }
}, 60_000);

// --- Heartbeat ---

let messagesProcessed = 0;
const heartbeatInterval = setInterval(() => {
  const uptime = Math.floor((Date.now() - startTime) / 60_000);
  console.log(`[heartbeat] uptime=${uptime}m messages=${messagesProcessed} schedules=${store.getAllSchedules().filter(s => s.status === 'active').length}`);
  store.pruneOldData();
}, 5 * 60_000);

// --- Main loop ---

const abortController = new AbortController();

async function main() {
  // Track last message timestamp per chat for context window
  const lastProcessed = new Map<string, number>();

  for await (const update of telegram.poll(abortController.signal)) {
    try {
      await handleUpdate(update, lastProcessed);
    } catch (err) {
      console.error('[main] Error handling update:', (err as Error).message);
    }
  }
}

async function handleUpdate(update: TelegramUpdate, lastProcessed: Map<string, number>) {
  if (update.type === 'callback_query' && update.callbackQuery) {
    const cq = update.callbackQuery;
    let s = store.loadSettings();
    await telegram.answerCallback(cq.id);
    s = await handleSettingsCallback(cq.data, s, cq.chatId);
    await telegram.updateSettingsKeyboard(cq.chatId, cq.messageId, s);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const groupFolder = resolveGroup(msg.chatId);
  if (!groupFolder) return;

  const currentSettings = store.loadSettings();

  if (currentSettings.allowedSenders.length > 0 && !currentSettings.allowedSenders.includes(msg.senderId)) {
    return;
  }

  store.saveMessage(msg);

  if (msg.text?.startsWith('/')) {
    const handled = await handleChatCommand(msg.text, msg.chatId);
    if (handled) return;
  }

  if (!shouldTrigger(msg, groupFolder)) return;

  if (!store.checkRateLimit(msg.senderId, currentSettings.rateLimitMax, currentSettings.rateLimitWindow)) {
    return;
  }

  if (msg.voiceFileId) {
    if (currentSettings.voiceReceive) {
      try {
        const audioBuffer = await telegram.downloadFile(msg.voiceFileId);
        const transcript = await transcribeAudio(audioBuffer, currentSettings);
        if (transcript) {
          msg.text = `[Voice message]: ${transcript}`;
          store.saveMessage(msg, msg.text);
        } else {
          const { missing } = await checkVoiceDeps();
          msg.text = missing.length > 0
            ? `[Voice message — transcription failed. Missing: ${missing.join(', ')}. Install them now.]`
            : '[Voice message — transcription returned empty]';
        }
      } catch (err) {
        const errMsg = (err as Error).message;
        console.error('[voice] Transcription error:', errMsg);
        const { missing } = await checkVoiceDeps();
        msg.text = missing.length > 0
          ? `[Voice message — error: ${errMsg.slice(0, 100)}. Missing: ${missing.join(', ')}. Install them now.]`
          : `[Voice message — transcription error: ${errMsg.slice(0, 100)}]`;
      }
    } else {
      msg.text = '[Voice message received — voice transcription is disabled. Enable via /settings or say "enable voice".]';
    }
  }

  if (msg.text) {
    const INJECTION_PATTERNS = [
      /ignore\s+(all\s+)?(previous|prior)\s+(instructions?|prompts?)/i,
      /disregard\s+(all\s+)?(previous|prior)/i,
      /you\s+are\s+now\s+(a|an)\s+/i,
      /system\s*:\s*(prompt|override|command)/i,
      /\[System\s*Message\]/i,
    ];
    const suspicious = INJECTION_PATTERNS.some(p => p.test(msg.text!));
    if (suspicious) {
      store.logAudit('injection_detected', `sender=${msg.senderId} text=${msg.text!.slice(0, 200)}`);
    }
  }

  const since = lastProcessed.get(msg.chatId) ?? (msg.timestamp - 30 * 60_000);
  const recent = store.getMessagesSince(msg.chatId, since, 50);
  if (recent.length === 0) {
    // Fallback: use the current message directly if DB query returned nothing
    recent.push({ sender_name: msg.senderName, content: msg.text ?? '', timestamp: msg.timestamp });
  }
  const messagesXml = formatPrompt(recent);

  const memory = existsSync(memPath) ? readFileSync(memPath, 'utf-8').trim() : '';
  const prompt = `[MEMORY]\n${memory || '(empty)'}\n[/MEMORY]\n\n${messagesXml}`;

  if (agentBusy) return;
  agentBusy = true;

  try {
  telegram.startTyping(msg.chatId);
  const sessionId = store.getSession(groupFolder) ?? undefined;

  state.currentGroupFolder = groupFolder;
  let lastSentText = '';

  const { sessionId: newSessionId, result } = await runAgent(
    { prompt, groupFolder, chatId: msg.chatId, isMain: groupFolder === 'main', sessionId },
    { picoServer, hooks, settings: currentSettings, groupsDir },
    async (text) => {
      telegram.stopTyping();
      await telegram.send(msg.chatId, text);
      lastSentText = text.trim();
      telegram.startTyping(msg.chatId);
    },
  );

  if (newSessionId) store.setSession(groupFolder, newSessionId);
  lastProcessed.set(msg.chatId, msg.timestamp);
  messagesProcessed++;

  for (const pending of state.pendingMessages.splice(0)) {
    await telegram.send(pending.chatId || msg.chatId, pending.text);
  }

  for (const op of state.pendingSchedules.splice(0)) {
    if (op.action === 'create' && op.task) {
      store.addSchedule({
        ...op.task,
        chatId: op.task.chatId || msg.chatId,
        groupFolder: op.task.groupFolder || groupFolder,
      });
    }
  }

  if (result && result.trim() !== lastSentText) {
    if (currentSettings.voiceReply && msg.voiceFileId) {
      const audio = await synthesizeSpeech(result, currentSettings);
      if (audio) await telegram.sendVoice(msg.chatId, audio);
      else await telegram.send(msg.chatId, result);
    } else {
      await telegram.send(msg.chatId, result);
    }
  }
  if (result) store.saveOutgoing(msg.chatId, result, Date.now());

  refreshBotCommands();
  } finally {
    telegram.stopTyping();
    agentBusy = false;
  }
}

// --- Graceful shutdown ---

async function shutdown() {
  console.log('[cakeagent] Shutting down...');
  clearInterval(schedulerInterval);
  clearInterval(heartbeatInterval);
  abortController.abort();
  // Give active agent runs 5s to finish
  await new Promise(r => setTimeout(r, 5000));
  store.closeDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---

main().catch(err => {
  console.error('[cakeagent] Fatal error:', err);
  process.exit(1);
});
