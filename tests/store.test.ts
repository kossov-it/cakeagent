import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/store.js';
import type { IncomingMessage } from '../src/types.js';

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cakeagent-test-'));
  store.initDb(tmp);
});

after(() => {
  store.closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `id_${Math.random().toString(36).slice(2)}`,
    text: 'hello',
    senderId: 'user1',
    senderName: 'Alice',
    chatId: 'chat1',
    timestamp: Date.now(),
    isGroup: false,
    ...overrides,
  };
}

test('store: saveMessage + getMessagesSince roundtrip', () => {
  const t = Date.now();
  store.saveMessage(msg({ id: 'm1', text: 'hi there', timestamp: t }));
  store.saveMessage(msg({ id: 'm2', text: 'second msg', timestamp: t + 100 }));
  const rows = store.getMessagesSince('chat1', t - 1, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.content, 'second msg');   // DESC
  assert.equal(rows[1]!.content, 'hi there');
});

test('store: searchMessages finds FTS / LIKE hits', () => {
  store.saveMessage(msg({ id: 'm3', text: 'I love pineapple pizza', chatId: 'chat2', timestamp: Date.now() }));
  const hits = store.searchMessages('pineapple');
  assert.ok(hits.length >= 1);
  assert.ok(hits.some(h => h.content?.includes('pineapple')));
});

test('store: searchMessages respects chatId filter', () => {
  store.saveMessage(msg({ id: 'm4', text: 'unique-marker-xyz', chatId: 'chat-other', timestamp: Date.now() }));
  const all = store.searchMessages('unique-marker-xyz');
  const filtered = store.searchMessages('unique-marker-xyz', { chatId: 'chat1' });
  assert.ok(all.length >= 1);
  assert.equal(filtered.length, 0);
});

test('store: searchMessages survives malformed FTS input', () => {
  // Double-quote injection attempts shouldn't throw — sanitizer strips them.
  const hits = store.searchMessages('"""');
  assert.ok(Array.isArray(hits));
});

test('store: rate limit — within window blocks over max', () => {
  const key = `rl_${Math.random()}`;
  assert.equal(store.checkRateLimit(key, 3, 60_000), true);
  assert.equal(store.checkRateLimit(key, 3, 60_000), true);
  assert.equal(store.checkRateLimit(key, 3, 60_000), true);
  assert.equal(store.checkRateLimit(key, 3, 60_000), false);  // over limit
});

test('store: audit log redacts secrets in detail', () => {
  store.logAudit('test_event', 'leak sk-ant-1234567890abcdefghij1234567890 done');
  const rows = store.listAuditEvents({ event: 'test_event', limit: 5 });
  assert.ok(rows.length >= 1);
  const latest = rows[0]!;
  assert.ok(!latest.detail!.includes('sk-ant-1234567890abcdefghij'));
  assert.ok(latest.detail!.includes('[REDACTED]'));
});

test('store: listAuditEvents filters by event', () => {
  store.logAudit('filter_a', 'first');
  store.logAudit('filter_b', 'second');
  const a = store.listAuditEvents({ event: 'filter_a', limit: 10 });
  assert.ok(a.every(r => r.event === 'filter_a'));
});

test('store: skill index loads and saves', () => {
  store.saveSkillIndex({
    outlook: {
      owner: 'dandcg', repo: 'claude-skills', skill: 'outlook',
      installedAt: '2026-04-15', sha: 'abc123def456', summary: 'Email integration',
    },
  });
  const idx = store.loadSkillIndex();
  assert.equal(idx.outlook?.sha, 'abc123def456');
  assert.equal(idx.outlook?.summary, 'Email integration');
});
