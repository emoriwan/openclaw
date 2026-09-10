import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";

const TELEGRAM_SELF_SENDER_SUFFIX = " (you)";

export function buildTelegramSelfSenderName(
  configuredName?: string,
  telegramIdentity?: { first_name?: string; username?: string },
): string {
  const name =
    configuredName?.trim() ||
    telegramIdentity?.first_name?.trim() ||
    telegramIdentity?.username?.trim() ||
    "OpenClaw";
  return `${name}${TELEGRAM_SELF_SENDER_SUFFIX}`;
}

export function isTelegramSelfSenderName(name: string | undefined): name is string {
  return name?.endsWith(TELEGRAM_SELF_SENDER_SUFFIX) === true;
}

export function isTelegramChatWindowPromptContext(entry: TelegramPromptContextEntry): boolean {
  return entry.source === "telegram" && entry.type === "chat_window";
}
