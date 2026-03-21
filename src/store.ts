import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
  `);
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
  ).all(chatId, since, limit) as any[];
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
    `INSERT INTO schedules (group_folder, chat_id, task, schedule_type, schedule_value, context_mode, next_run, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(task.groupFolder, task.chatId, task.task, task.scheduleType, task.scheduleValue, task.contextMode, task.nextRun, task.status);
  return Number(result.lastInsertRowid);
}

export function getDueSchedules(now: string): ScheduledTask[] {
  return db.prepare(`SELECT * FROM schedules WHERE next_run <= ? AND status = 'active'`).all(now) as any[];
}

export function getAllSchedules(): ScheduledTask[] {
  return db.prepare(`SELECT * FROM schedules WHERE status != 'completed'`).all() as any[];
}

const SCHEDULE_COLUMNS: Record<string, string> = {
  task: 'task', scheduleType: 'schedule_type', scheduleValue: 'schedule_value',
  contextMode: 'context_mode', nextRun: 'next_run', status: 'status',
  lastRun: 'last_run', lastError: 'last_error',
};

export function updateSchedule(id: number, fields: Partial<ScheduledTask>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = SCHEDULE_COLUMNS[k];
    if (!col) continue; // Skip unknown fields — prevents SQL injection
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
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: CakeSettings): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

// --- Pruning ---

export function pruneOldData(retentionDays = 30): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  db.prepare(`DELETE FROM messages WHERE timestamp < ?`).run(cutoff);
  db.prepare(`DELETE FROM audit_log WHERE created_at < datetime('now', '-30 days')`).run();
  db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).run(Date.now() - 7 * 24 * 60 * 60_000);
}

// --- Cleanup ---

export function closeDb(): void {
  db?.close();
}
