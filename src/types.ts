// === Messages ===

export interface IncomingMessage {
  id: string;
  text?: string;
  voiceFileId?: string;
  senderId: string;
  senderName: string;
  chatId: string;
  timestamp: number;
  isGroup: boolean;
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
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  nextRun: string;
  status: 'active' | 'paused' | 'completed';
  lastRun: string | null;
  lastError: string | null;
  createdAt: string;
}

// === Agent ===

export interface AgentRunParams {
  prompt: string;
  groupFolder: string;
  chatId: string;
  isMain: boolean;
  sessionId?: string;
}

// === Settings ===

export interface CakeSettings {
  assistantName: string;
  triggerPattern: string;
  model: string;
  thinkingLevel: string;
  voiceReceive: boolean;
  voiceReply: boolean;
  voiceSttModel: string;
  voiceTtsVoice: string;
  allowedSenders: string[];
  rateLimitMax: number;
  rateLimitWindow: number;
  agentTimeoutMs: number;
}

export const DEFAULT_SETTINGS: CakeSettings = {
  assistantName: 'CakeAgent',
  triggerPattern: '@CakeAgent',
  model: 'claude-sonnet-4-6',
  thinkingLevel: 'low',
  voiceReceive: false,
  voiceReply: false,
  voiceSttModel: 'base',
  voiceTtsVoice: 'en-US-AriaNeural',
  allowedSenders: [],
  rateLimitMax: 10,
  rateLimitWindow: 60_000,
  agentTimeoutMs: 300_000,
};

// === Shared State ===

export interface ScheduleOp {
  action: 'create';
  task: Omit<ScheduledTask, 'id' | 'lastRun' | 'lastError' | 'createdAt'>;
}

export interface SharedState {
  pendingMessages: OutgoingMessage[];
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
