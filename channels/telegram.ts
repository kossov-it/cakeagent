import type { Channel, TelegramUpdate, BotCommand, CakeSettings } from '../src/types.js';

async function tg(token: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as { ok: boolean; result?: any; description?: string; parameters?: { retry_after?: number } };
  if (!json.ok) {
    if (res.status === 429) {
      const wait = (json.parameters?.retry_after ?? 5) * 1000;
      await new Promise(r => setTimeout(r, wait));
      return tg(token, method, body);
    }
    throw new Error(`Telegram ${method}: ${json.description}`);
  }
  return json.result;
}

async function tgForm(token: string, method: string, form: FormData): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: form,
  });
  const json = await res.json() as { ok: boolean; result?: any; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

function chunkText(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function buildSettingsKeyboard(settings: CakeSettings): any {
  const btn = (label: string, data: string) => ({ text: label, callback_data: data });
  const mark = (active: boolean, label: string) => active ? `${label} ✓` : label;
  const isModel = (m: string) => settings.model.includes(m);
  const isThink = (t: string) => settings.thinkingLevel === t;

  return {
    inline_keyboard: [
      [
        btn(mark(isModel('sonnet'), 'Sonnet'), 'model:claude-sonnet-4-6'),
        btn(mark(isModel('opus'), 'Opus'), 'model:claude-opus-4-6'),
        btn(mark(isModel('haiku'), 'Haiku'), 'model:claude-haiku-4-5-20251001'),
      ],
      [
        btn(mark(isThink('off'), 'Think: Off'), 'thinking:off'),
        btn(mark(isThink('low'), 'Low'), 'thinking:low'),
        btn(mark(isThink('medium'), 'Med'), 'thinking:medium'),
        btn(mark(isThink('high'), 'High'), 'thinking:high'),
      ],
      [
        btn(mark(settings.voiceEnabled, 'Voice'), 'voice:toggle'),
        btn(mark(settings.voiceReply, 'Voice Reply'), 'voiceReply:toggle'),
      ],
    ],
  };
}

export function createTelegramChannel(
  token: string,
  allowedChatIds: () => Set<string>,
): Channel {
  let offset = 0;
  let typingInterval: ReturnType<typeof setInterval> | null = null;

  return {
    name: 'telegram',

    async *poll(signal: AbortSignal): AsyncGenerator<TelegramUpdate> {
      while (!signal.aborted) {
        try {
          const updates = await tg(token, 'getUpdates', {
            offset,
            timeout: 30,
            allowed_updates: ['message', 'callback_query'],
          });

          for (const u of updates) {
            offset = u.update_id + 1;

            if (u.callback_query) {
              const cq = u.callback_query;
              const chatId = String(cq.message?.chat?.id ?? '');
              if (!allowedChatIds().has(chatId)) continue;
              yield {
                type: 'callback_query',
                callbackQuery: {
                  id: cq.id,
                  chatId,
                  messageId: cq.message?.message_id ?? 0,
                  data: cq.data ?? '',
                },
              };
              continue;
            }

            if (u.message) {
              const m = u.message;
              const chatId = String(m.chat.id);
              if (!allowedChatIds().has(chatId)) continue;

              yield {
                type: 'message',
                message: {
                  id: `tg_${m.message_id}_${chatId}`,
                  text: m.text ?? m.caption ?? undefined,
                  voiceFileId: m.voice?.file_id ?? m.audio?.file_id ?? undefined,
                  senderId: String(m.from?.id ?? ''),
                  senderName: m.from?.first_name ?? 'Unknown',
                  chatId,
                  timestamp: m.date * 1000,
                  isGroup: m.chat.type !== 'private',
                },
              };
            }
          }
        } catch (err) {
          if (signal.aborted) break;
          console.error('[telegram] Poll error:', (err as Error).message);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    },

    async send(chatId: string, text: string): Promise<void> {
      for (const chunk of chunkText(text)) {
        await tg(token, 'sendMessage', {
          chat_id: chatId,
          text: chunk,
        }).catch(err => console.error('[telegram] Send failed:', err.message));
      }
    },

    async sendVoice(chatId: string, audio: Buffer): Promise<void> {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('voice', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'voice.ogg');
      await tgForm(token, 'sendVoice', form);
    },

    startTyping(chatId: string): void {
      this.stopTyping();
      const send = () => tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      send();
      typingInterval = setInterval(send, 4000);
    },

    stopTyping(): void {
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    },

    async downloadFile(fileId: string): Promise<Buffer> {
      const file = await tg(token, 'getFile', { file_id: fileId });
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(url);
      return Buffer.from(await res.arrayBuffer());
    },

    async sendSettingsKeyboard(chatId: string, settings: CakeSettings): Promise<number> {
      const model = escapeMarkdownV2(settings.model);
      const thinking = escapeMarkdownV2(settings.thinkingLevel);
      const result = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: `⚙️ *Settings*\nModel: \`${model}\`\nThinking: \`${thinking}\``,
        parse_mode: 'MarkdownV2',
        reply_markup: buildSettingsKeyboard(settings),
      });
      return result.message_id;
    },

    async updateSettingsKeyboard(chatId: string, messageId: number, settings: CakeSettings): Promise<void> {
      const model = escapeMarkdownV2(settings.model);
      const thinking = escapeMarkdownV2(settings.thinkingLevel);
      await tg(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `⚙️ *Settings*\nModel: \`${model}\`\nThinking: \`${thinking}\``,
        parse_mode: 'MarkdownV2',
        reply_markup: buildSettingsKeyboard(settings),
      }).catch(() => {});
    },

    async answerCallback(callbackId: string, text?: string): Promise<void> {
      await tg(token, 'answerCallbackQuery', { callback_query_id: callbackId, text }).catch(() => {});
    },

    async setCommands(commands: BotCommand[]): Promise<void> {
      await tg(token, 'setMyCommands', { commands }).catch(() => {});
    },
  };
}
