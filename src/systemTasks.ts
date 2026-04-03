// System tasks: autonomous behaviors (morning check-in, dream/memory consolidation).
// Creates morning check-in and dream/memory consolidation tasks on first boot.

import * as store from './store.js';
import { parseCronExpression, computeNextCronRun } from './cron.js';
import type { ScheduledTask } from './types.js';

const SYSTEM_TASKS: Array<{
  key: string;
  settingsField: 'morningCheckinCron' | 'dreamCron';
  task: string;
  contextMode: 'group' | 'isolated';
}> = [
  {
    key: 'system:morning-checkin',
    settingsField: 'morningCheckinCron',
    task: 'Review your memory and any pending scheduled tasks. Send a brief morning summary to the user including: today\'s scheduled tasks, any recent items of note, and any action items. Be concise.',
    contextMode: 'isolated',
  },
  {
    key: 'system:dream',
    settingsField: 'dreamCron',
    task: 'Review the [MEMORY] block. Remove outdated entries, merge duplicates, fix contradictions, and keep it concise and well-organized. Use the rewrite_memory tool with the cleaned content. Only use send_message if something notable was found or changed.',
    contextMode: 'isolated',
  },
];

export function ensureSystemTasks(chatId: string, dataDir: string): void {
  const settings = store.loadSettings();

  for (const def of SYSTEM_TASKS) {
    const cronExpr = settings[def.settingsField];

    // Find existing system task by its key (stored in task description)
    const existing = store.getScheduleByTask(def.task);

    if (!cronExpr) {
      // Disabled via settings — pause if exists
      if (existing && existing.status === 'active') {
        store.updateSchedule(existing.id, { status: 'paused' } as any);
        console.log(`[system-tasks] Paused ${def.key} (cron empty in settings)`);
      }
      continue;
    }

    const fields = parseCronExpression(cronExpr);
    if (!fields) {
      console.warn(`[system-tasks] Invalid cron for ${def.key}: "${cronExpr}"`);
      continue;
    }

    if (existing) {
      // Re-activate if it was paused and cron is now set
      if (existing.status === 'paused') {
        const next = computeNextCronRun(fields, new Date());
        if (next) {
          store.updateSchedule(existing.id, {
            status: 'active',
            scheduleValue: cronExpr,
            nextRun: next.toISOString(),
          } as any);
          console.log(`[system-tasks] Re-activated ${def.key}`);
        }
      }
      // Update cron if it changed
      if (existing.scheduleValue !== cronExpr) {
        const next = computeNextCronRun(fields, new Date());
        if (next) {
          store.updateSchedule(existing.id, {
            scheduleValue: cronExpr,
            nextRun: next.toISOString(),
          } as any);
          console.log(`[system-tasks] Updated ${def.key} cron to "${cronExpr}"`);
        }
      }
      continue;
    }

    // Create new system task
    const next = computeNextCronRun(fields, new Date());
    if (!next) continue;

    store.addSchedule({
      groupFolder: 'main',
      chatId,
      task: def.task,
      scheduleType: 'cron',
      scheduleValue: cronExpr,
      contextMode: def.contextMode,
      nextRun: next.toISOString(),
      status: 'active',
      recurring: true,
      system: true,
    });
    console.log(`[system-tasks] Created ${def.key} (${cronExpr}, next: ${next.toISOString()})`);
  }
}
