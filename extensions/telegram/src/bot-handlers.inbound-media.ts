import type { Message } from "grammy/types";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type {
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { ConversationHistoryCapture } from "openclaw/plugin-sdk/reply-history";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramInboundDisposition,
} from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramChannelIngressResolver } from "./bot-message-context.types.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import {
  hasLeadingBotCommandAddressedToOtherBot,
  resolveTelegramMessageAddress,
} from "./bot/body-helpers.js";
import {
  buildTelegramThreadParams,
  getTelegramTextParts,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { mergeTelegramConversationCaptures } from "./conversation-observation.js";
import { isTelegramGroupSenderAuthorized } from "./group-access.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

type MediaAuthorization = {
  authorizationCfg: OpenClawConfig;
  chatId: number;
  isGroup: boolean;
  threadSpec: TelegramThreadSpec;
  senderId: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
};

type TelegramMediaGroupInput = MediaAuthorization & {
  conversationHistory?: ConversationHistoryCapture;
  ctx: TelegramContext;
  msg: Message;
  storeAllowFrom: string[];
  promptContextMinTimestampMs?: number;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
};

type BufferedMediaGroupEntry = Omit<MediaGroupEntry, "messages" | "timer"> &
  Omit<TelegramMediaGroupInput, "ctx" | "msg"> & {
    messages: Array<{ ctx: TelegramContext; msg: Message; allMedia: TelegramMediaRef[] }>;
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
    receiving: number;
    timer?: ReturnType<typeof setTimeout>;
    failure?: { error: unknown };
  };

interface TelegramInboundMedia {
  withMediaGroupReceipt: (
    input: TelegramMediaGroupInput,
    receive: (
      recordAlbumMedia: (media: TelegramMediaRef[]) => boolean,
    ) => Promise<TelegramInboundDisposition>,
  ) => Promise<TelegramInboundDisposition>;
  shouldWarnOnMediaFailure: (
    input: MediaAuthorization & {
      ctx: TelegramContext;
      msg: Message;
      nativeMessages?: readonly Message[];
    },
  ) => Promise<boolean>;
}

export function createTelegramInboundMedia({
  params,
  message,
}: {
  params: Pick<RegisterTelegramHandlerParams, "accountId" | "bot" | "opts" | "runtime">;
  message: TelegramMessagePipeline;
}): TelegramInboundMedia {
  const { accountId, bot, opts, runtime } = params;
  const {
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    processMessageWithReplyChain,
  } = message;
  const timeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;
  const buffer = new Map<string, BufferedMediaGroupEntry>();
  const queue = new KeyedAsyncQueue();
  const shouldWarnOnMediaFailure: TelegramInboundMedia["shouldWarnOnMediaFailure"] = async (
    input,
  ) => {
    if (!input.isGroup) {
      return true;
    }
    const botUsername = input.ctx.me?.username;
    if (
      !isTelegramGroupSenderAuthorized(input) ||
      (botUsername && hasLeadingBotCommandAddressedToOtherBot(input.msg, botUsername))
    ) {
      return false;
    }
    const command = await resolveTelegramCommandIngressAuthorization({
      accountId,
      cfg: input.authorizationCfg,
      dmPolicy: "pairing",
      isGroup: true,
      chatId: input.chatId,
      resolvedThreadId: input.threadSpec.id,
      senderId: input.senderId,
      effectiveDmAllow: input.effectiveDmAllow,
      effectiveGroupAllow: input.effectiveGroupAllow,
      ownerAccess: { ownerList: [], senderIsOwner: false },
      eventKind: "message",
      allowTextCommands: true,
      hasControlCommand: hasControlCommand(
        getTelegramTextParts(input.msg).text,
        input.authorizationCfg,
        { botUsername },
      ),
      modeWhenAccessGroupsOff: "allow",
      includeDmAllowForGroupCommands: false,
    });
    if (command.shouldBlockControlCommand) {
      return false;
    }
    return (input.nativeMessages ?? [input.msg]).some((msg) =>
      resolveTelegramMessageAddress(msg, input.ctx.me ?? {}),
    );
  };

  const processMediaGroup = async (entry: BufferedMediaGroupEntry) => {
    try {
      if (entry.failure) {
        throw entry.failure.error;
      }
      const finalIngressMessageId = entry.messages.at(-1)?.msg.message_id;
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      let primary =
        entry.messages.find((item) => item.msg.caption || item.msg.text) ?? entry.messages[0];
      if (!primary) {
        releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const captionParts = entry.messages
        .map(({ msg }) => getTelegramTextParts(msg))
        .filter(({ text }) => text.trim());
      if (captionParts.length > 1) {
        const botUsername = primary.ctx.me?.username;
        const commandCaptionIndex = captionParts.findIndex(({ text }) =>
          hasControlCommand(text, entry.authorizationCfg, {
            botUsername,
          }),
        );
        if (commandCaptionIndex > 0) {
          // Command detection is prefix-based in both ingress and canonical message processing.
          const [commandCaption] = captionParts.splice(commandCaptionIndex, 1);
          if (commandCaption) {
            captionParts.unshift(commandCaption);
          }
        }
        let caption = "";
        const captionEntities: NonNullable<Message["caption_entities"]> = [];
        for (const { text, entities } of captionParts) {
          if (caption) {
            caption += "\n";
          }
          const offset = caption.length;
          caption += text;
          for (const entity of entities) {
            captionEntities.push({ ...entity, offset: entity.offset + offset });
          }
        }
        const combinedMessage = {
          ...primary.msg,
          text: undefined,
          entities: undefined,
          caption,
          caption_entities: captionEntities.length ? captionEntities : undefined,
        } as Message;
        // Keep grammY context methods/getters while exposing the complete album to every owner.
        const combinedContext = Object.create(primary.ctx) as TelegramContext;
        Object.defineProperty(combinedContext, "message", {
          value: combinedMessage,
          enumerable: true,
        });
        primary = { ...primary, ctx: combinedContext, msg: combinedMessage };
      }
      const shouldShowMediaWarning = await shouldWarnOnMediaFailure({
        ...entry,
        ...primary,
        nativeMessages: entry.messages.map(({ msg }) => msg),
      });
      const allMedia = entry.messages.flatMap((item) => item.allMedia);
      const selection = new Map<string, "include" | "exclude">(
        entry.messages.map(({ msg, allMedia: itemMedia }) => [
          String(msg.message_id),
          itemMedia.some((media) => media.path) ? "include" : "exclude",
        ]),
      );
      const materializedCount = allMedia.filter((media) => media.path).length;
      const skippedCount = allMedia.length - materializedCount;
      if (skippedCount > 0 && shouldShowMediaWarning) {
        const verb = skippedCount === 1 ? "was" : "were";
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              primary.msg.chat.id,
              `⚠️ Received ${materializedCount} of ${entry.messages.length} images — ${skippedCount} could not be fetched and ${verb} skipped.`,
              {
                ...buildTelegramThreadParams(entry.threadSpec),
                reply_parameters: {
                  message_id: primary.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
      const result = await processMessageWithReplyChain({
        ctx: primary.ctx,
        msg: primary.msg,
        allMedia,
        promptContextMessageSelection: selection,
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          conversationHistory: entry.conversationHistory,
          threadSpec: entry.threadSpec,
          bufferedMessages: entry.messages.map(({ msg }) => msg),
          bufferedUpdateIds: entry.messages.map(({ ctx }) => ctx.update?.update_id),
          ...(finalIngressMessageId != null
            ? { messageIdOverride: String(finalIngressMessageId) }
            : {}),
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
      runtime.error?.(danger(`media group handler failed: ${String(error)}`));
    }
  };
  const queueEntry = (key: string, entry: BufferedMediaGroupEntry) =>
    void queue.enqueue(key, async () => {
      await processMediaGroup(entry).catch(() => undefined);
    });
  const mediaGroupKey = ({
    msg,
    chatId,
    threadSpec,
  }: Pick<TelegramMediaGroupInput, "msg" | "chatId" | "threadSpec">) =>
    `media:${chatId}:${threadSpec.scope}:${threadSpec.id ?? "main"}:${msg.media_group_id}`;
  const registerMediaGroupReceipt = (input: TelegramMediaGroupInput) => {
    const key = mediaGroupKey(input);
    const existing = buffer.get(key);
    const member: BufferedMediaGroupEntry["messages"][number] = {
      msg: input.msg,
      ctx: input.ctx,
      allMedia: [],
    };
    const participant = createSpooledReplayParticipantForBufferedWork(
      `media-group:${key}:${input.msg.message_id}`,
    );
    if (existing) {
      if (participant) {
        existing.spooledReplayParticipants.push(participant);
      }
      clearTimeout(existing.timer);
      existing.receiving++;
      existing.messages.push(member);
      existing.conversationHistory = mergeTelegramConversationCaptures([
        existing.conversationHistory,
        input.conversationHistory,
      ]);
      existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
        existing.promptContextMinTimestampMs,
        input.promptContextMinTimestampMs,
      );
      existing.dispatchDedupeClaims = mergeDispatchDedupeClaims(
        existing.dispatchDedupeClaims,
        input.dispatchDedupeClaims,
      );
      // An album can span separately authorized updates; preserve each exact resolver once.
      existing.channelIngressResolvers = [
        ...existing.channelIngressResolvers,
        ...input.channelIngressResolvers,
      ];
      return { key, entry: existing, member };
    }
    const entry: BufferedMediaGroupEntry = {
      ...input,
      messages: [member],
      spooledReplayParticipants: participant ? [participant] : [],
      receiving: 1,
      ...promptContextBoundaryOptions(input.promptContextMinTimestampMs),
    };
    buffer.set(key, entry);
    return { key, entry, member };
  };
  const withMediaGroupReceipt: TelegramInboundMedia["withMediaGroupReceipt"] = async (
    input,
    receive,
  ) => {
    if (!input.msg.media_group_id) {
      return await receive(() => false);
    }
    const { key, entry, member } = registerMediaGroupReceipt(input);
    try {
      return await queue.enqueue(key, async (): Promise<TelegramInboundDisposition> => {
        if (!entry.failure) {
          try {
            return await receive((media) => {
              member.allMedia = media;
              return true;
            });
          } catch (error) {
            entry.failure = { error };
          }
        }
        return { kind: "buffered", buffer: "media-group" };
      });
    } finally {
      entry.receiving--;
      // One album retains every replay participant until all receipt work has settled.
      if (entry.receiving === 0) {
        entry.timer = setTimeout(() => {
          buffer.delete(key);
          queueEntry(key, entry);
        }, timeoutMs);
      }
    }
  };

  return { withMediaGroupReceipt, shouldWarnOnMediaFailure };
}
