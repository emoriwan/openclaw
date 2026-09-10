/**
 * Shared reply-history helpers for plugins that keep short per-thread context windows.
 *
 * Prefer `createChannelHistoryWindow` for message-turn code. The lower-level map helpers are
 * deprecated plugin compatibility exports; core internals still use them behind the facade.
 */
import type {
  enrichConversationObservationMediaCore,
  recordConversationObservationCore,
} from "../config/sessions/conversation-history.js";
export type { HistoryEntry, HistoryMediaEntry } from "../auto-reply/reply/history.types.js";
export type {
  ConversationHistoryCapture,
  ConversationHistoryMessage,
} from "../sessions/user-turn-input.types.js";

export const recordConversationObservation: typeof recordConversationObservationCore = async (
  ...args
) => {
  const history = await import("../config/sessions/conversation-history.js");
  return history.recordConversationObservationCore(...args);
};
export const enrichConversationObservationMedia: typeof enrichConversationObservationMediaCore =
  async (...args) => {
    const history = await import("../config/sessions/conversation-history.js");
    return history.enrichConversationObservationMediaCore(...args);
  };
export {
  createChannelHistoryWindow,
  type ChannelHistoryWindow,
} from "../channels/turn/history-window.js";
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  HISTORY_CONTEXT_MARKER,
  buildHistoryContext,
  buildHistoryContextFromEntries,
  buildHistoryContextFromMap,
  buildInboundHistoryFromEntries,
  buildInboundHistoryFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  evictOldHistoryKeys,
  normalizeHistoryMediaEntries,
  recordPendingHistoryEntryWithMedia,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
