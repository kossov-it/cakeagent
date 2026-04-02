// === Messages ===

export interface IncomingMessage {
  id: string;
  text?: string;
  voiceFileId?: string;
  photoFileId?: string;
  documentFileId?: string;
  documentName?: string;
  senderId: string;
  senderName: string;
  chatId: string;
  timestamp: number;
  isGroup: boolean;
  replyTo?: {
    text?: string;
    senderName?: string;
  };
}

export interface OutgoingMessage {
  chatId: string;
  text: string;
}

// === Channels ===

export interface Channel {
  name: string;
  poll(signal: AbortSignal): AsyncGenerator<TelegramUpdate>;
  send(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendVoice(chatId: string, audio: Buffer): Promise<void>;
  startTyping(chatId: string): void;
  stopTyping(): void;
  downloadFile(fileId: string): Promise<Buffer>;
  sendSettingsKeyboard(chatId: string, settings: CakeSettings): Promise<number>;
  updateSettingsKeyboard(chatId: string, messageId: number, settings: CakeSettings): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  setCommands(commands: BotCommand[]): Promise<void>;
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface TelegramUpdate {
  type: 'message' | 'callback_query';
  message?: IncomingMessage;
  callbackQuery?: CallbackQuery;
}

export interface CallbackQuery {
  id: string;
  chatId: string;
  messageId: number;
  data: string;
}

// === Groups ===

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  chatId: string;
}

// === Tasks ===

export interface ScheduledTask {
  id: number;
  groupFolder: string;
  chatId: string;
  task: string;
  scheduleType: 'interval' | 'once' | 'cron';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  nextRun: string;
  status: 'active' | 'paused' | 'completed';
  recurring: boolean;
  system: boolean;
  lastRun: string | null;
  lastError: string | null;
  createdAt: string;
}

// === Agent ===

export interface AgentRunParams {
  prompt: string;
  groupFolder: string;
  chatId: string;
  sessionId?: string;
}

// === Settings ===

export interface CakeSettings {
  assistantName: string;
  triggerPattern: string;
  model: string;
  thinkingLevel: string;
  voiceReceive: boolean;
  voiceSend: boolean;
  voiceSttModel: string;
  voiceTtsVoice: string;
  allowedSenders: string[];
  rateLimitMax: number;
  rateLimitWindow: number;
  agentTimeoutMs: number;
  morningCheckinCron: string;
  dreamCron: string;
}

export const DEFAULT_SETTINGS: CakeSettings = {
  assistantName: 'CakeAgent',
  triggerPattern: '@CakeAgent',
  model: 'claude-sonnet-4-6',
  thinkingLevel: 'low',
  voiceReceive: false,
  voiceSend: false,
  voiceSttModel: 'base',
  voiceTtsVoice: 'en-US-AriaNeural',
  allowedSenders: [],
  rateLimitMax: 10,
  rateLimitWindow: 60_000,
  agentTimeoutMs: 300_000,
  morningCheckinCron: '57 8 * * *',
  dreamCron: '23 3 * * *',
};

export const VALID_MODELS = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6']);
export const VALID_THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high']);
export const VALID_TTS_VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,4}-\w+Neural$/;

// === Shared State ===

export interface ScheduleOp {
  action: 'create';
  task: Omit<ScheduledTask, 'id' | 'lastRun' | 'lastError' | 'createdAt'>;
}

export interface ScheduleCreateFields extends Omit<ScheduledTask, 'id' | 'lastRun' | 'lastError' | 'createdAt'> {}

export interface PendingFile {
  chatId: string;
  filePath: string;
  caption?: string;
}

export interface SharedState {
  pendingMessages: OutgoingMessage[];
  pendingFiles: PendingFile[];
  pendingSchedules: ScheduleOp[];
  currentGroupFolder?: string;
}

// === Config ===

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  dataDir: string;
  groupsDir: string;
}
