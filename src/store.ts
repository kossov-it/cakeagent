import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, RegisteredGroup, ScheduledTask, CakeSettings } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';

let db: Database.Database;
let dataDir: string;

export function initDb(dir: string): void {
  dataDir = dir;
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'store.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp INTEGER NOT NULL,
      is_group INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, timestamp);

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      task TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'group',
      next_run TEXT,
      status TEXT DEFAULT 'active',
      last_run TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      chat_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_word TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrations: add columns for KAIROS-style cron scheduling
  const migrations = [
    `ALTER TABLE schedules ADD COLUMN recurring INTEGER DEFAULT 1`,
    `ALTER TABLE schedules ADD COLUMN system INTEGER DEFAULT 0`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// --- Messages ---

export function saveMessage(msg: IncomingMessage, content?: string): void {
  db.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, sender_name, content, timestamp, is_group)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content`
  ).run(msg.id, msg.chatId, msg.senderId, msg.senderName, content ?? msg.text ?? '', msg.timestamp, msg.isGroup ? 1 : 0);
}

export function saveOutgoing(chatId: string, content: string, timestamp: number): void {
  const id = `out_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_id, sender_id, sender_name, content, timestamp, is_group)
     VALUES (?, ?, 'assistant', 'assistant', ?, ?, 0)`
  ).run(id, chatId, content, timestamp);
}

export function getMessagesSince(chatId: string, since: number, limit = 50): Array<{ sender_name: string; content: string; timestamp: number }> {
  return db.prepare(
    `SELECT sender_name, content, timestamp FROM messages
     WHERE chat_id = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT ?`
  ).all(chatId, since, limit) as Array<{ sender_name: string; content: string; timestamp: number }>;
}

// --- Groups ---

export function registerGroup(group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO groups (chat_id, name, folder, trigger_word) VALUES (?, ?, ?, ?)`
  ).run(group.chatId, group.name, group.folder, group.trigger);
}

export function getGroups(): RegisteredGroup[] {
  return db.prepare(`SELECT chat_id as chatId, name, folder, trigger_word as trigger FROM groups`).all() as RegisteredGroup[];
}

export function getGroupByChatId(chatId: string): RegisteredGroup | undefined {
  return db.prepare(`SELECT chat_id as chatId, name, folder, trigger_word as trigger FROM groups WHERE chat_id = ?`).get(chatId) as RegisteredGroup | undefined;
}

// --- Sessions ---

export function getSession(groupFolder: string): string | null {
  const row = db.prepare(`SELECT session_id FROM sessions WHERE group_folder = ?`).get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(`INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)`).run(groupFolder, sessionId);
}

// --- Schedules ---

export function addSchedule(task: Omit<ScheduledTask, 'id' | 'lastRun' | 'lastError' | 'createdAt'>): number {
  const result = db.prepare(
    `INSERT INTO schedules (group_folder, chat_id, task, schedule_type, schedule_value, context_mode, next_run, status, recurring, system)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(task.groupFolder, task.chatId, task.task, task.scheduleType, task.scheduleValue, task.contextMode, task.nextRun, task.status, task.recurring ? 1 : 0, task.system ? 1 : 0);
  return Number(result.lastInsertRowid);
}

const SCHEDULE_SELECT = `SELECT id, group_folder as groupFolder, chat_id as chatId, task,
  schedule_type as scheduleType, schedule_value as scheduleValue,
  context_mode as contextMode, next_run as nextRun, status,
  COALESCE(recurring, 1) as recurring, COALESCE(system, 0) as system,
  last_run as lastRun, last_error as lastError, created_at as createdAt
  FROM schedules`;

export function getDueSchedules(now: string): ScheduledTask[] {
  return db.prepare(`${SCHEDULE_SELECT} WHERE next_run <= ? AND status = 'active'`).all(now) as ScheduledTask[];
}

export function getAllSchedules(): ScheduledTask[] {
  return db.prepare(`${SCHEDULE_SELECT} WHERE status != 'completed'`).all() as ScheduledTask[];
}

const SCHEDULE_COLUMNS: Record<string, string> = {
  task: 'task', scheduleType: 'schedule_type', scheduleValue: 'schedule_value',
  contextMode: 'context_mode', nextRun: 'next_run', status: 'status',
  lastRun: 'last_run', lastError: 'last_error', recurring: 'recurring', system: 'system',
};

export function updateSchedule(id: number, fields: Partial<ScheduledTask>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = SCHEDULE_COLUMNS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteSchedule(id: number): void {
  db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
}

export function getMissedSchedules(now: string): ScheduledTask[] {
  return db.prepare(`${SCHEDULE_SELECT} WHERE next_run < ? AND status = 'active'`).all(now) as ScheduledTask[];
}

export function getScheduleByTask(taskDescription: string): ScheduledTask | undefined {
  return db.prepare(`${SCHEDULE_SELECT} WHERE task = ? AND status = 'active' LIMIT 1`).get(taskDescription) as ScheduledTask | undefined;
}

// --- Rate Limits ---

export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const row = db.prepare(`SELECT count, window_start FROM rate_limits WHERE key = ?`).get(key) as { count: number; window_start: number } | undefined;

  if (!row || now - row.window_start > windowMs) {
    db.prepare(`INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)`).run(key, now);
    return true;
  }
  if (row.count >= max) return false;
  db.prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`).run(key);
  return true;
}

// --- Audit ---

export function logAudit(event: string, detail?: string): void {
  db.prepare(`INSERT INTO audit_log (event, detail) VALUES (?, ?)`).run(event, detail ?? null);
}

// --- Settings ---

export function loadSettings(): CakeSettings {
  const path = join(dataDir, 'settings.json');
  if (!existsSync(path)) {
    saveSettings(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    // Migrate legacy single `voice` toggle → split toggles
    if ('voice' in raw && !('voiceReceive' in raw)) {
      raw.voiceReceive = raw.voice;
      raw.voiceSend = raw.voice;
      delete raw.voice;
    }
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch (err) {
    console.error('[store] settings.json is corrupt — using defaults:', (err as Error).message);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeAtomic(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

export function saveSettings(settings: CakeSettings): void {
  writeAtomic(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

// --- Pruning ---

export function pruneOldData(retentionDays = 30): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  db.prepare(`DELETE FROM messages WHERE timestamp < ?`).run(cutoff);
  db.prepare(`DELETE FROM audit_log WHERE created_at < datetime('now', ? || ' days')`).run(-retentionDays);
  db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).run(cutoff);
}

export function countActiveSchedules(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM schedules WHERE status = 'active'`).get() as { count: number };
  return row.count;
}

// --- Skills ---

interface SkillMeta { owner: string; repo: string; skill: string; installedAt: string }

export function loadSkillIndex(): Record<string, SkillMeta> {
  const path = join(dataDir, 'skills', 'index.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error('[store] skills/index.json is corrupt — treating as empty:', (err as Error).message);
    return {};
  }
}

export function saveSkillIndex(index: Record<string, SkillMeta>): void {
  const dir = join(dataDir, 'skills');
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'index.json'), JSON.stringify(index, null, 2));
}

export function loadAllSkills(): string {
  const dir = join(dataDir, 'skills');
  if (!existsSync(dir)) return '';
  const index = loadSkillIndex();
  const parts: string[] = [];
  for (const name of Object.keys(index)) {
    const mdPath = join(dir, `${name}.md`);
    if (existsSync(mdPath)) {
      parts.push(`### Skill: ${name}\n${readFileSync(mdPath, 'utf-8').trim()}`);
    }
  }
  return parts.join('\n\n---\n\n');
}

// --- Key-Value ---

export function getKv(key: string): string | null {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(key, value);
}

// --- Cleanup ---

export const MAX_MEMORY_SIZE = 50 * 1024; // 50 KB

export function closeDb(): void {
  db?.close();
}
