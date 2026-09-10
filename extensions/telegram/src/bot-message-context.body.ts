// Telegram plugin module implements bot message context.body behavior.
import {
  formatLocationText,
  formatMediaPlaceholderText,
  implicitMentionKindWhen,
  logInboundDrop,
  type BuildChannelInboundEventContextParams,
  type InboundEventKind,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type {
  OpenClawConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { formatAudioTranscriptForAgent } from "openclaw/plugin-sdk/media-understanding-runtime";
import type { ConversationHistoryCapture } from "openclaw/plugin-sdk/reply-history";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type {
  TelegramLogger,
  TelegramMediaRef,
  TelegramMessageContextOptions,
} from "./bot-message-context.types.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  hasLeadingBotCommandAddressedToOtherBot,
  resolveTelegramMessageAddress,
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessagePlaceholder,
  resolveTelegramRichMessageText,
} from "./bot/body-helpers.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramInboundOriginTarget,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import { renderTelegramTextEntities } from "./bot/inbound-text-entities.js";
import type { TelegramContext } from "./bot/types.js";
import { recordTelegramConversationMessages } from "./conversation-observation.js";
import { isTelegramGroupSenderAuthorized } from "./group-access.js";
import { resolveTelegramGroupIngestEnabled } from "./group-config-helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
type TelegramMentionFacts = NonNullable<
  NonNullable<BuildChannelInboundEventContextParams["access"]>["mentions"]
>;

const loadStickerVisionRuntime = createLazyRuntimeModule(
  () => import("./sticker-vision.runtime.js"),
);

const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("./media-understanding.runtime.js"),
);

type TelegramInboundBodyResult = {
  bodyText: string;
  rawBody: string;
  historyKey?: string;
  commandAuthorized: boolean;
  effectiveWasMentioned: boolean;
  mentionFacts: TelegramMentionFacts;
  inboundEventKind: InboundEventKind;
  canDetectMention: boolean;
  shouldBypassMention: boolean;
  hasControlCommand: boolean;
  audioTranscribedMediaIndex?: number;
  stickerCacheHit: boolean;
  locationData?: NormalizedLocation;
  conversationHistory?: ConversationHistoryCapture;
};

function resolveTelegramMentionFacts(params: {
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  explicitlyMentionedBot: boolean;
  implicitMentionKinds: TelegramMentionFacts["implicitMentionKinds"];
  requireMention: boolean;
  shouldBypassMention: boolean;
}): TelegramMentionFacts {
  let mentionSource: TelegramMentionFacts["mentionSource"];
  if (params.explicitlyMentionedBot) {
    mentionSource = "explicit_bot";
  } else if (params.implicitMentionKinds && params.implicitMentionKinds.length > 0) {
    mentionSource = "implicit_thread";
  } else if (params.shouldBypassMention) {
    mentionSource = "command_bypass";
  }

  return {
    canDetectMention: params.canDetectMention,
    wasMentioned: params.effectiveWasMentioned,
    explicitlyMentionedBot: params.explicitlyMentionedBot,
    mentionSource,
    implicitMentionKinds: params.implicitMentionKinds,
    effectiveWasMentioned: params.effectiveWasMentioned,
    requireMention: params.requireMention,
  };
}

async function resolveStickerVisionSupport(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<boolean> {
  try {
    const { resolveStickerVisionSupportRuntime } = await loadStickerVisionRuntime();
    return await resolveStickerVisionSupportRuntime(params);
  } catch {
    return false;
  }
}

export async function resolveTelegramInboundBody(params: {
  cfg: OpenClawConfig;
  primaryCtx: TelegramContext;
  msg: TelegramContext["message"];
  allMedia: TelegramMediaRef[];
  isGroup: boolean;
  chatId: number | string;
  accountId?: string;
  senderId: string;
  senderUsername: string;
  sessionKey?: string;
  resolvedThreadId?: number;
  replyThreadId?: number;
  threadSpec: TelegramThreadSpec;
  originatingTo?: string;
  routeAgentId?: string;
  storePath?: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  options?: TelegramMessageContextOptions;
  logger: TelegramLogger;
}): Promise<TelegramInboundBodyResult | null> {
  const {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    accountId,
    senderId,
    senderUsername,
    resolvedThreadId,
    replyThreadId,
    threadSpec,
    originatingTo: providedOriginatingTo,
    routeAgentId,
    effectiveGroupAllow,
    effectiveDmAllow,
    groupConfig,
    topicConfig,
    options,
    logger,
  } = params;
  const botUsername = normalizeOptionalLowercaseString(primaryCtx.me?.username);
  const messageTextParts = getTelegramTextParts(msg);
  const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
  const useAccessGroups = true;
  const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, {
    botUsername,
  });
  const commandGate = await resolveTelegramCommandIngressAuthorization({
    accountId: accountId ?? "default",
    cfg,
    dmPolicy: "pairing",
    isGroup,
    chatId,
    resolvedThreadId,
    senderId,
    effectiveDmAllow,
    effectiveGroupAllow,
    ownerAccess: { ownerList: [], senderIsOwner: false },
    eventKind: "message",
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInMessage,
    modeWhenAccessGroupsOff: "allow",
    includeDmAllowForGroupCommands: false,
  });
  const commandAuthorized = commandGate.authorized;
  const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, threadSpec) : undefined;
  const originatingTo =
    providedOriginatingTo ?? buildTelegramInboundOriginTarget(chatId, threadSpec);

  const primaryMedia = resolveTelegramPrimaryMedia(msg);
  const nativeMediaFacts =
    allMedia.length > 0 ? allMedia : primaryMedia ? [{ kind: primaryMedia.kind }] : [];
  const locationData = extractTelegramLocation(msg);
  const locationText = locationData ? formatLocationText(locationData) : undefined;
  const rawText = renderTelegramTextEntities(
    messageTextParts.text,
    messageTextParts.entities,
  ).trim();
  const richText = resolveTelegramRichMessageText(msg);
  const hasUserText = Boolean(rawText || locationText);
  let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
  if (!rawBody) {
    rawBody = richText ?? resolveTelegramRichMessagePlaceholder(msg) ?? "";
  }
  if (!rawBody && nativeMediaFacts.length === 0) {
    return null;
  }

  const conversationHistory =
    options?.conversationHistory ??
    (isGroup && routeAgentId && params.storePath
      ? await recordTelegramConversationMessages({
          agentId: routeAgentId,
          storePath: params.storePath,
          accountId: accountId ?? "default",
          chatId,
          threadSpec,
          messages: options?.bufferedMessages?.length ? options.bufferedMessages : [msg],
          media: allMedia,
          updateIds: options?.bufferedUpdateIds ?? [primaryCtx.update?.update_id],
          interactionId: options?.forceWasMentioned ? options.messageIdOverride : undefined,
        })
      : undefined);

  const nativeMessages = options?.bufferedMessages?.length ? options.bufferedMessages : [msg];
  const addressing = nativeMessages.map((message) =>
    resolveTelegramMessageAddress(message, primaryCtx.me ?? {}),
  );
  const explicitlyMentioned = addressing.includes("mention");
  // Synthetic callbacks are explicit interactions. Ordinary text cannot grant this flag.
  const wasMentioned = addressing.some(Boolean) || options?.forceWasMentioned === true;
  const foreignCommand = botUsername && hasLeadingBotCommandAddressedToOtherBot(msg, botUsername);
  const senderAuthorized =
    !isGroup ||
    isTelegramGroupSenderAuthorized({
      groupConfig,
      topicConfig,
      effectiveGroupAllow,
      senderId,
      senderUsername,
    });
  if (foreignCommand || (isGroup && !wasMentioned && options?.commandSource !== "native")) {
    logger.info(
      { chatId, reason: "not-addressed" },
      "recorded group context without an agent turn",
    );
    if (
      isGroup &&
      !foreignCommand &&
      !commandGate.shouldBlockControlCommand &&
      senderAuthorized &&
      params.sessionKey &&
      resolveTelegramGroupIngestEnabled({ cfg, chatId, accountId, topicConfig })
    ) {
      // Unaddressed inputs never reach the shared dispatch hook. Preserve the
      // configured ingestion integration here without granting turn authority.
      fireAndForgetHook(
        triggerInternalHook(
          createInternalHookEvent(
            "message",
            "received",
            params.sessionKey,
            toInternalMessageReceivedContext({
              from: `telegram:group:${historyKey ?? chatId}`,
              to: originatingTo,
              content: rawBody || formatMediaPlaceholderText(nativeMediaFacts),
              timestamp: msg.date ? msg.date * 1000 : undefined,
              channelId: "telegram",
              accountId,
              conversationId: originatingTo,
              messageId: String(msg.message_id),
              senderId: senderId || undefined,
              senderName: buildSenderName(msg),
              senderUsername: senderUsername || undefined,
              provider: "telegram",
              surface: "telegram",
              threadId: resolvedThreadId,
              originatingChannel: "telegram",
              originatingTo,
              isGroup: true,
              groupId: `telegram:${chatId}`,
              media: allMedia
                .filter((media) => Boolean(media.path))
                .map(({ path, contentType, kind, sourceMessageId }) => ({
                  path,
                  contentType,
                  kind,
                  messageId: sourceMessageId ?? String(msg.message_id),
                })),
            }),
          ),
        ),
        "telegram: observed message hook failed",
      );
    }
    return null;
  }
  if (isGroup && (commandGate.shouldBlockControlCommand || !senderAuthorized)) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "sender cannot invoke group agent",
      target: senderId,
    });
    return null;
  }

  const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
  const stickerSupportsVision =
    msg.sticker && allMedia.some((media) => media.kind === "sticker" && media.path)
      ? await resolveStickerVisionSupport({ cfg, agentId: routeAgentId })
      : false;
  const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
  let formattedStickerDescription: string | undefined;
  if (stickerCacheHit) {
    const emoji = allMedia[0]?.stickerMetadata?.emoji;
    const setName = allMedia[0]?.stickerMetadata?.setName;
    const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
    formattedStickerDescription = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
  }

  let bodyText = rawBody;
  if (formattedStickerDescription) {
    bodyText = [formattedStickerDescription, rawBody].filter(Boolean).join("\n");
  }
  const isAudioMedia = (media: TelegramMediaRef) =>
    media.kind === "audio" || media.contentType?.startsWith("audio/") === true;
  const hasAudio = nativeMediaFacts.some(isAudioMedia);
  const materializedMedia = allMedia.filter((media) => Boolean(media.path));
  const materializedAudioIndex = allMedia.findIndex(
    (media) => Boolean(media.path) && isAudioMedia(media),
  );
  const disableAudioPreflight =
    (topicConfig?.disableAudioPreflight ??
      (groupConfig as TelegramGroupConfig | undefined)?.disableAudioPreflight) === true;
  const senderAllowedForAudioPreflight =
    !useAccessGroups || !allowForCommands.hasEntries || commandAuthorized;

  let preflightTranscript: string | undefined;
  const needsPreflightTranscription =
    hasAudio &&
    materializedAudioIndex >= 0 &&
    !hasUserText &&
    !disableAudioPreflight &&
    senderAllowedForAudioPreflight;

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await loadMediaUnderstandingRuntime();
      const tempCtx: MsgContext = {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: originatingTo,
        AccountId: accountId,
        MessageThreadId: replyThreadId,
        media: materializedMedia,
      };
      preflightTranscript = await transcribeFirstAudio({
        ctx: tempCtx,
        cfg,
        agentDir: undefined,
      });
    } catch (err) {
      logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
    }
  }
  const audioTranscribedMediaIndex =
    preflightTranscript === undefined ? undefined : materializedAudioIndex;

  if (hasAudio && !rawBody && preflightTranscript) {
    bodyText = formatAudioTranscriptForAgent(preflightTranscript);
  }

  if (isGroup && commandGate.shouldBlockControlCommand) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "control command (unauthorized)",
      target: senderId ?? "unknown",
    });
    return null;
  }

  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    addressing.includes("reply"),
  );
  const canDetectMention = Boolean(primaryCtx.me?.id || botUsername);
  const effectiveWasMentioned = wasMentioned;
  const inboundEventKind = "user_request";
  return {
    bodyText,
    rawBody,
    historyKey,
    commandAuthorized,
    effectiveWasMentioned,
    inboundEventKind,
    mentionFacts: resolveTelegramMentionFacts({
      canDetectMention,
      effectiveWasMentioned,
      explicitlyMentionedBot: explicitlyMentioned,
      implicitMentionKinds,
      requireMention: isGroup,
      shouldBypassMention: options?.commandSource === "native",
    }),
    canDetectMention,
    shouldBypassMention: options?.commandSource === "native",
    conversationHistory,
    hasControlCommand: hasControlCommandInMessage,
    ...(audioTranscribedMediaIndex !== undefined && audioTranscribedMediaIndex >= 0
      ? { audioTranscribedMediaIndex }
      : {}),
    stickerCacheHit,
    locationData: locationData ?? undefined,
  };
}
