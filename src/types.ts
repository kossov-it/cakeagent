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
  memoryExtractionEnabled: boolean;
  memoryExtractionInterval: number;
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
  memoryExtractionEnabled: true,
  memoryExtractionInterval: 5,
};

export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system\s*:\s*(prompt|override|command)/i,
  /\[System\s*Message\]/i,
  // Role/tag spoofing: "Assistant:" / "User:" line prefixes used to fake turn boundaries
  /^\s*(assistant|user|system|tool|tool_use|tool_result)\s*:/im,
  // XML/tag injection — fake SDK message wrappers in user content
  /<\/?(system|tool_use|tool_result|function_calls|parameter|assistant|user)\b[^>]*>/i,
  // ASCII-art / box-drawing runs used to smuggle instructions past scanners
  /[\u2580-\u259F\u2500-\u257F█▓▒░]{6,}/,
  // Common jailbreak framings
  /\b(developer|debug|admin|root)\s+mode\s+(on|enabled|activated)/i,
  /\boverride\s+(all\s+)?safety/i,
];

export const CREDENTIAL_PATTERNS = [
  /(api[_-]?key|token|secret|password|authorization)\s*[=:]\s*\S{20,}/i,
  /\b(sk-ant-|sk-|ghp_|gho_|xoxb-|xoxp-|glpat-)[a-zA-Z0-9_-]{20,}/,
];

// Shared sanitizer — strip lines matching known-bad patterns before storing or loading
// user-influenced content (memory.md, skills, etc.).
export function sanitizeMemory(content: string): string {
  return content.split('\n').filter(line =>
    !INJECTION_PATTERNS.some(p => p.test(line)) &&
    !CREDENTIAL_PATTERNS.some(p => p.test(line))
  ).join('\n');
}

// Redact known API-key prefixes from arbitrary strings before writing to
// audit_log / stdout. Conservative: only replace the secret span, not the
// surrounding context, so the log stays diagnostic.
const SECRET_SUBSTRING_RE = /(sk-ant-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9_-]{20,}|gho_[a-zA-Z0-9_-]{20,}|glpat-[a-zA-Z0-9_-]{20,}|xox[bpoas]-[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,})/g;
const KV_SECRET_RE = /(api[_-]?key|token|secret|password|authorization|bearer)(\s*[=:]\s*)(\S{16,})/ig;

export function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(SECRET_SUBSTRING_RE, '[REDACTED]')
    .replace(KV_SECRET_RE, (_m, k, sep) => `${k}${sep}[REDACTED]`);
}

export const VALID_MODELS = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6']);
export const VALID_THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high']);
export const VALID_TTS_VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,4}-\w+Neural$/;

// === Shared State ===

export interface ScheduleOp {
  action: 'create';
  task: Omit<ScheduledTask, 'id' | 'lastRun' | 'lastError' | 'createdAt'>;
}

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
  currentChatId?: string;
  // Signalled by the PreCompact hook so the main loop can extract facts from
  // messages about to be lost. Processed once and cleared.
  pendingMemoryExtraction?: { groupFolder: string; chatId: string };
}

// === Config ===

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  dataDir: string;
  groupsDir: string;
}
