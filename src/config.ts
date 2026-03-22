import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './types.js';

export function loadConfig(): Config {
  const envPath = resolve('.env');
  const env: Record<string, string> = {};

  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      let key = trimmed.slice(0, eq).trim();
      if (key.startsWith('export ')) key = key.slice(7).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (!val.startsWith('"') && !val.startsWith("'")) {
        const commentIdx = val.indexOf(' #');
        if (commentIdx > 0) val = val.slice(0, commentIdx).trim();
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }

  const get = (key: string): string | undefined => process.env[key] || env[key];

  const token = get('TELEGRAM_BOT_TOKEN');
  const chatId = get('TELEGRAM_CHAT_ID');

  if (!token || !chatId) {
    console.error('Missing required environment variables:');
    if (!token) console.error('  TELEGRAM_BOT_TOKEN — get one from @BotFather on Telegram');
    if (!chatId) console.error('  TELEGRAM_CHAT_ID   — your Telegram user ID (message @userinfobot)');
    console.error('\nCopy .env.example to .env and fill in the values.');
    process.exit(1);
  }

  return {
    telegramBotToken: token,
    telegramChatId: chatId,
    dataDir: resolve(get('DATA_DIR') || './data'),
    groupsDir: resolve(get('GROUPS_DIR') || './groups'),
  };
}
