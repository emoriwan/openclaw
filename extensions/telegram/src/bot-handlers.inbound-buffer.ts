import type { Message } from "grammy/types";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { ConversationHistoryCapture } from "openclaw/plugin-sdk/reply-history";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramChannelIngressResolver } from "./bot-message-context.types.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import { resolveTelegramMessageAddress } from "./bot/body-helpers.js";
import {
  buildTelegramThreadParams,
  getTelegramTextParts,
  joinTelegramTextParts,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { mergeTelegramConversationCaptures } from "./conversation-observation.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

type TelegramDebounceLane = "default" | "forward";

export type TelegramDebounceEntry = {
  conversationHistory?: ConversationHistoryCapture;
  ctx: TelegramContext;
  msg: Message;
  allMedia: TelegramMediaRef[];
  storeAllowFrom: string[];
  receivedAtMs: number;
  debounceKey: string | null;
  debounceLane: TelegramDebounceLane;
  botUsername?: string;
  threadSpec: TelegramThreadSpec;
  promptContextMinTimestampMs?: number;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
};

type TextFragmentEntry = {
  conversationHistory?: ConversationHistoryCapture;
  key: string;
  storeAllowFrom: string[];
  messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
  threadSpec: TelegramThreadSpec;
  promptContextMinTimestampMs?: number;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
  channelIngressResolvers: TelegramChannelIngressResolver[];
  timer: ReturnType<typeof setTimeout>;
};

type TelegramTextFragmentInput = {
  conversationHistory?: ConversationHistoryCapture;
  ctx: TelegramContext;
  msg: Message;
  chatId: number;
  threadSpec: TelegramThreadSpec;
  storeAllowFrom: string[];
  isAbortControlMessage: boolean;
  isAuthorizedAbortControlMessage: () => Promise<boolean>;
  promptContextMinTimestampMs?: number;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  channelIngressResolver: TelegramChannelIngressResolver;
};

interface TelegramInboundBuffers {
  inboundDebouncer: {
    enqueue: (entry: TelegramDebounceEntry) => Promise<void>;
    flushKey: (key: string) => Promise<void>;
    cancelKey: (key: string) => boolean;
    drain: () => Promise<void>;
  };
  resolveTelegramDebounceEntryMs: (entry: TelegramDebounceEntry) => number;
  shouldDebounceTelegramEntry: (entry: TelegramDebounceEntry) => boolean;
  resolveTelegramDebounceLane: (msg: Message) => TelegramDebounceLane;
  handleTextFragment: (params: TelegramTextFragmentInput) => Promise<boolean>;
}

export function createTelegramInboundBuffers({
  params: { cfg, bot, runtime, opts },
  message,
}: {
  params: Pick<RegisterTelegramHandlerParams, "cfg" | "bot" | "runtime" | "opts">;
  message: TelegramMessagePipeline;
}): TelegramInboundBuffers {
  const {
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    processMessageWithReplyChain,
  } = message;
  const readConfig = createRuntimeConfigReader(cfg);
  const resolveDebounceMs = () =>
    resolveInboundDebounceMs({ cfg: readConfig(), channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;
  const resolveTelegramDebounceEntryMs = (entry: TelegramDebounceEntry): number =>
    entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : resolveDebounceMs();
  const shouldDebounceTelegramEntry = (entry: TelegramDebounceEntry): boolean => {
    const hasDebounceableText = shouldDebounceTextInbound({
      text: getTelegramTextParts(entry.msg).text,
      cfg,
      commandOptions: { botUsername: entry.botUsername },
    });
    if (entry.debounceLane === "forward") {
      return hasDebounceableText || entry.allMedia.length > 0;
    }
    return hasDebounceableText && entry.allMedia.length === 0;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    const forwardMeta = msg as {
      forward_origin?: unknown;
      forward_from?: unknown;
      forward_from_chat?: unknown;
      forward_sender_name?: unknown;
      forward_date?: unknown;
    };
    return (forwardMeta.forward_origin ??
      forwardMeta.forward_from ??
      forwardMeta.forward_from_chat ??
      forwardMeta.forward_sender_name ??
      forwardMeta.forward_date)
      ? "forward"
      : "default";
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs: resolveDebounceMs(),
    serializeImmediate: true,
    resolveDebounceMs: resolveTelegramDebounceEntryMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: shouldDebounceTelegramEntry,
    onFlush: (entries) => {
      const completion = (async () => {
        const participants = entries
          .map((entry) => entry.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          );
        // Each native tag/reply defines a request. Ordinary text in the same
        // debounce window stays observed context, including text after the last request.
        const addressed = entries.filter(
          (entry) =>
            entry.msg.chat.type === "private" ||
            resolveTelegramMessageAddress(entry.msg, entry.ctx.me ?? {}),
        );
        const requestEntries = addressed.length > 0 ? addressed : entries;
        const last = requestEntries.at(-1);
        if (!last) {
          return;
        }
        try {
          if (requestEntries.length === 1) {
            const result = await processMessageWithReplyChain({
              ctx: last.ctx,
              msg: last.msg,
              allMedia: last.allMedia,
              storeAllowFrom: last.storeAllowFrom,
              options: {
                conversationHistory: last.conversationHistory,
                receivedAtMs: last.receivedAtMs,
                ingressBuffer: "inbound-debounce",
                threadSpec: last.threadSpec,
                ...promptContextBoundaryOptions(last.promptContextMinTimestampMs),
                ...spooledReplayOptions(participants),
                channelIngressResolvers: entries.flatMap((entry) => entry.channelIngressResolvers),
              },
              dispatchDedupeClaims: mergeDispatchDedupeClaims(
                ...entries.map((entry) => entry.dispatchDedupeClaims),
              ),
              spooledReplayParticipants: participants,
            });
            settleSpooledReplayParticipants(participants, result);
            return;
          }
          const combinedTextParts = joinTelegramTextParts(
            requestEntries.map((entry) => entry.msg),
            "\n",
          );
          const combinedText = combinedTextParts.text;
          const combinedMedia = requestEntries.flatMap((entry) => entry.allMedia);
          if (!combinedText.trim() && combinedMedia.length === 0) {
            releaseDispatchDedupeClaims(
              mergeDispatchDedupeClaims(...entries.map((entry) => entry.dispatchDedupeClaims)),
            );
            settleSpooledReplayParticipants(participants, { kind: "skipped" });
            return;
          }
          const first = expectDefined(requestEntries.at(0), "multi-entry Telegram debounce batch");
          const syntheticMessage = {
            ...buildSyntheticTextMessage({
              base: first.msg,
              text: combinedText,
              entities: combinedTextParts.entities,
              date: last.msg.date ?? first.msg.date,
            }),
            forward_origin: undefined,
          };
          const result = await processMessageWithReplyChain({
            ctx: buildSyntheticContext(first.ctx, syntheticMessage),
            msg: syntheticMessage,
            allMedia: combinedMedia,
            storeAllowFrom: first.storeAllowFrom,
            options: {
              conversationHistory: mergeTelegramConversationCaptures(
                requestEntries.map((entry) => entry.conversationHistory),
              ),
              ...(last.msg.message_id ? { messageIdOverride: String(last.msg.message_id) } : {}),
              receivedAtMs: first.receivedAtMs,
              ingressBuffer: "inbound-debounce",
              threadSpec: first.threadSpec,
              bufferedMessages: requestEntries.map((entry) => entry.msg),
              bufferedUpdateIds: requestEntries.map((entry) => entry.ctx.update?.update_id),
              ...promptContextBoundaryOptions(
                latestPromptContextMinTimestampMs(
                  ...requestEntries.map((entry) => entry.promptContextMinTimestampMs),
                ),
              ),
              ...spooledReplayOptions(participants),
              channelIngressResolvers: entries.flatMap((entry) => entry.channelIngressResolvers),
            },
            dispatchDedupeClaims: mergeDispatchDedupeClaims(
              ...entries.map((entry) => entry.dispatchDedupeClaims),
            ),
            spooledReplayParticipants: participants,
          });
          settleSpooledReplayParticipants(participants, result);
        } catch (error) {
          settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
          throw error;
        }
      })();
      // Spooled Telegram processing already returns at durable turn adoption;
      // its participant owns the remaining agent-turn lifecycle.
      return { admission: completion, completion };
    },
    onError: (error, items) => {
      const participants = items
        .map((item) => item.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
      runtime.error?.(danger(`telegram debounce flush failed: ${String(error)}`));
      if (participants.length > 0) {
        return;
      }
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadParams = buildTelegramThreadParams(items[0]?.threadSpec);
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadParams,
          )
          .catch((sendError: unknown) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendError)}`);
          });
      }
    },
    onCancel: (items) => {
      releaseDispatchDedupeClaims(
        mergeDispatchDedupeClaims(...items.map((item) => item.dispatchDedupeClaims)),
      );
      settleSpooledReplayParticipants(
        items
          .map((item) => item.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          ),
        { kind: "skipped" },
      );
    },
  });

  const maxGapMs =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : 1500;
  const textBuffer = new Map<string, TextFragmentEntry>();
  const textQueue = new KeyedAsyncQueue();

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const bufferedMessages = entry.messages.map((bufferedMessage) => bufferedMessage.msg);
      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const combinedTextParts = joinTelegramTextParts(bufferedMessages, "");
      const combinedText = combinedTextParts.text;
      if (!combinedText.trim()) {
        releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        entities: combinedTextParts.entities,
        date: last.msg.date ?? first.msg.date,
      });
      const result = await processMessageWithReplyChain({
        ctx: buildSyntheticContext(first.ctx, syntheticMessage),
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          conversationHistory: entry.conversationHistory,
          messageIdOverride: String(last.msg.message_id),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "text-fragment",
          threadSpec: entry.threadSpec,
          bufferedMessages,
          bufferedUpdateIds: entry.messages.map(({ ctx }) => ctx.update?.update_id),
          ...promptContextBoundaryOptions(entry.promptContextMinTimestampMs),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
          channelIngressResolvers: entry.channelIngressResolvers,
        },
        dispatchDedupeClaims: entry.dispatchDedupeClaims,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (error) {
      releaseDispatchDedupeClaims(entry.dispatchDedupeClaims, error);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(error),
      );
      runtime.error?.(danger(`text fragment handler failed: ${String(error)}`));
    }
  };
  const queueTextFlush = async (entry: TextFragmentEntry) => {
    await textQueue.enqueue(entry.key, async () => {
      await flushTextFragments(entry).catch(() => undefined);
    });
  };
  const runTextFlush = async (entry: TextFragmentEntry) => {
    textBuffer.delete(entry.key);
    await queueTextFlush(entry);
  };
  const scheduleTextFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void runTextFlush(entry), maxGapMs);
  };
  const handleTextFragment = async (params: TelegramTextFragmentInput): Promise<boolean> => {
    const text = typeof params.msg.text === "string" ? params.msg.text : undefined;
    const isCommand = getTelegramTextParts(params.msg).entities.some(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    );
    const senderId = params.msg.from?.id != null ? String(params.msg.from.id) : "unknown";
    const key = `text:${params.chatId}:${params.threadSpec.scope}:${params.threadSpec.id ?? "main"}:${senderId}`;
    if (text && !isCommand && !params.isAbortControlMessage) {
      const nowMs = Date.now();
      const existing = textBuffer.get(key);
      if (existing) {
        const last = existing.messages.at(-1);
        const idGap = last ? params.msg.message_id - last.msg.message_id : Infinity;
        const timeGapMs = nowMs - (last?.receivedAtMs ?? nowMs);
        const canAppend = idGap > 0 && idGap <= 1 && timeGapMs >= 0 && timeGapMs <= maxGapMs;
        const nextTotalChars =
          existing.messages.reduce(
            (sum, bufferedMessage) => sum + (bufferedMessage.msg.text?.length ?? 0),
            0,
          ) + text.length;
        if (canAppend && existing.messages.length < 12 && nextTotalChars <= 50_000) {
          const participant = createSpooledReplayParticipantForBufferedWork(
            `text-fragment:${key}:${params.msg.message_id}`,
          );
          if (participant) {
            existing.spooledReplayParticipants.push(participant);
          }
          existing.messages.push({ msg: params.msg, ctx: params.ctx, receivedAtMs: nowMs });
          existing.conversationHistory = mergeTelegramConversationCaptures([
            existing.conversationHistory,
            params.conversationHistory,
          ]);
          existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
            existing.promptContextMinTimestampMs,
            params.promptContextMinTimestampMs,
          );
          existing.dispatchDedupeClaims = mergeDispatchDedupeClaims(
            existing.dispatchDedupeClaims,
            params.dispatchDedupeClaims,
          );
          existing.channelIngressResolvers.push(params.channelIngressResolver);
          scheduleTextFlush(existing);
          return true;
        }
        clearTimeout(existing.timer);
        textBuffer.delete(key);
        await queueTextFlush(existing);
      }
      if (text.length >= 4000) {
        const participant = createSpooledReplayParticipantForBufferedWork(
          `text-fragment:${key}:${params.msg.message_id}`,
        );
        const entry: TextFragmentEntry = {
          conversationHistory: params.conversationHistory,
          key,
          storeAllowFrom: params.storeAllowFrom,
          threadSpec: params.threadSpec,
          messages: [{ msg: params.msg, ctx: params.ctx, receivedAtMs: nowMs }],
          dispatchDedupeClaims: params.dispatchDedupeClaims,
          spooledReplayParticipants: participant ? [participant] : [],
          channelIngressResolvers: [params.channelIngressResolver],
          ...promptContextBoundaryOptions(params.promptContextMinTimestampMs),
          timer: setTimeout(() => {}, maxGapMs),
        };
        textBuffer.set(key, entry);
        scheduleTextFlush(entry);
        return true;
      }
    } else if (
      text &&
      params.isAbortControlMessage &&
      (await params.isAuthorizedAbortControlMessage())
    ) {
      const existing = textBuffer.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        textBuffer.delete(key);
        releaseDispatchDedupeClaims(existing.dispatchDedupeClaims);
        settleSpooledReplayParticipants(existing.spooledReplayParticipants, { kind: "skipped" });
      }
    }
    return false;
  };

  return {
    inboundDebouncer,
    resolveTelegramDebounceEntryMs,
    shouldDebounceTelegramEntry,
    resolveTelegramDebounceLane,
    handleTextFragment,
  };
}
