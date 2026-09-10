// Discord plugin module implements message handler.preflight behavior.
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  classifyChannelInboundEvent,
  implicitMentionKindWhen,
  logInboundDrop,
  recordChannelBotPairLoopAndCheckSuppression,
  resolveInboundMentionDecision,
  resolveUnmentionedGroupInboundPolicy,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { isRecentOutboundMessageIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logDebug } from "openclaw/plugin-sdk/logging-core";
import {
  recordConversationObservation,
  type ConversationHistoryCapture,
} from "openclaw/plugin-sdk/reply-history";
import { getChildLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  buildConversationIdentity,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { ChannelType, MessageType, type User } from "../internal/discord.js";
import { resolveDiscordGuildEntry, resolveDiscordMemberAccessState } from "./allow-list.js";
import { resolveDiscordChannelNameSafe } from "./channel-access.js";
import { resolveDiscordTextCommandAccess } from "./dm-command-auth.js";
import { resolveDiscordSystemLocation, resolveTimestampMs } from "./format.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
} from "./message-channel-info.js";
import {
  resolveDiscordMessageStickers,
  resolveDiscordReferencedReplyMessage,
  resolveDiscordReferencedReplyMessageId,
} from "./message-forwarded.js";
import { resolveDiscordDmPreflightAccess } from "./message-handler.dm-preflight.js";
import { hydrateDiscordMessageIfNeeded } from "./message-handler.hydration.js";
import { resolveDiscordPreflightChannelAccess } from "./message-handler.preflight-channel-access.js";
import { resolveDiscordPreflightChannelContext } from "./message-handler.preflight-channel-context.js";
import { buildDiscordMessagePreflightContext } from "./message-handler.preflight-context.js";
import {
  hasRawDiscordUserMention,
  isBoundThreadBotSystemMessage,
  isDiscordThreadChannelMessage,
  resolveInjectedBoundThreadLookupRecord,
  shouldIgnoreBoundThreadWebhookMessage,
} from "./message-handler.preflight-helpers.js";
import {
  logDiscordPreflightChannelConfig,
  logDiscordPreflightInboundSummary,
} from "./message-handler.preflight-logging.js";
import { resolveDiscordPreflightPluralKitInfo } from "./message-handler.preflight-pluralkit.js";
import {
  loadPreflightAudioRuntime,
  loadSystemEventsRuntime,
} from "./message-handler.preflight-runtime.js";
import { resolveDiscordPreflightThreadContext } from "./message-handler.preflight-thread.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import { resolveDiscordPreflightRoute } from "./message-handler.routing-preflight.js";
import {
  resolveForwardedMediaList,
  resolveMediaList,
  type DiscordMediaInfo,
} from "./message-media.js";
import {
  resolveDiscordMessageBatch,
  resolveDiscordMessageMentionDocuments,
  resolveDiscordMessageHistoryText,
  resolveDiscordMessageText,
} from "./message-text.js";
import { resolveReplyContext } from "./reply-context.js";
import { resolveDiscordSenderIdentity, resolveDiscordWebhookId } from "./sender-identity.js";
import {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
} from "./timeouts.js";

export type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

export { shouldIgnoreBoundThreadWebhookMessage } from "./message-handler.preflight-helpers.js";

function resolveDiscordPreflightConversationKind(params: {
  isGuildMessage: boolean;
  channelType?: ChannelType;
}) {
  const isGroupDm = params.channelType === ChannelType.GroupDM;
  const isDirectMessage =
    params.channelType === ChannelType.DM ||
    (!params.isGuildMessage && !isGroupDm && params.channelType == null);
  return { isDirectMessage, isGroupDm };
}

export async function preflightDiscordMessage(
  params: DiscordMessagePreflightParams,
): Promise<DiscordMessagePreflightContext | null> {
  if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
    return null;
  }
  const logger = getChildLogger({ module: "discord-auto-reply" });
  let message = params.data.message;
  const author = params.data.author;
  if (!author) {
    return null;
  }
  const messageChannelId = resolveDiscordMessageChannelId({
    message,
    eventChannelId: params.data.channel_id,
  });
  if (!messageChannelId) {
    logVerbose(`discord: drop message ${message.id} (missing channel id)`);
    return null;
  }

  const allowBotsSetting = params.discordConfig?.allowBots;
  const allowBotsMode =
    allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting === true ? "all" : "off";
  if (params.botUserId && author.id === params.botUserId) {
    // Always ignore own messages to prevent self-reply loops
    return null;
  }

  const hydratedSources: Awaited<ReturnType<typeof hydrateDiscordMessageIfNeeded>>[] = [];
  // The admitted event stays last so batch IDs and reply references do not change.
  for (const source of [...(params.precedingMessages ?? []), message]) {
    hydratedSources.push(
      await hydrateDiscordMessageIfNeeded({
        client: params.client,
        message: source,
        messageChannelId,
      }),
    );
    if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
      return null;
    }
  }
  message = resolveDiscordMessageBatch(
    hydratedSources.at(-1)!.message,
    hydratedSources.slice(0, -1).map((source) => source.message),
  );

  const pluralkitConfig = params.discordConfig?.pluralkit;
  const webhookId = resolveDiscordWebhookId(message);
  // Shared turn admission cannot undo pending history recorded by channel preflight.
  // Consult the same generic registry before mention/history drops can admit an echo.
  if (
    isRecentOutboundMessageIdentity({
      channel: "discord",
      accountId: params.accountId,
      conversationId: messageChannelId,
      messageId: message.id,
      ...(webhookId ? { sourceId: webhookId } : {}),
    })
  ) {
    logVerbose(`discord: drop recent outbound echo message ${message.id}`);
    return null;
  }
  const isGuildMessage = Boolean(params.data.guild_id);
  const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
  if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
    return null;
  }
  const { isDirectMessage, isGroupDm } = resolveDiscordPreflightConversationKind({
    isGuildMessage,
    channelType: channelInfo?.type,
  });
  const messageText = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
  // Only bot/webhook traffic can be rejected before canonical routing; ordinary
  // messages should reach the single authoritative binding lookup below.
  const injectedBoundThreadBinding =
    !isDirectMessage && !isGroupDm && (webhookId || author.bot)
      ? resolveInjectedBoundThreadLookupRecord({
          threadBindings: params.threadBindings,
          threadId: messageChannelId,
        })
      : undefined;
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      threadId: messageChannelId,
      webhookId,
      threadBinding: injectedBoundThreadBinding,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  if (
    isBoundThreadBotSystemMessage({
      isBoundThreadSession:
        Boolean(injectedBoundThreadBinding) &&
        isDiscordThreadChannelMessage({
          isGuildMessage,
          message,
          channelInfo,
        }),
      isBotAuthor: Boolean(author.bot),
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const pluralkitInfo = await resolveDiscordPreflightPluralKitInfo({
    message,
    webhookId,
    config: pluralkitConfig,
    abortSignal: params.abortSignal,
  });
  if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
    return null;
  }
  const sender = resolveDiscordSenderIdentity({
    author,
    member: params.data.member,
    pluralkitInfo,
  });

  if (author.bot) {
    if (allowBotsMode === "off" && !sender.isPluralKit) {
      logVerbose("discord: drop bot message (allowBots=false)");
      return null;
    }
  }
  const data = message === params.data.message ? params.data : { ...params.data, message };
  logDebug(
    `[discord-preflight] channelId=${messageChannelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`,
  );

  if (isGroupDm && !params.groupDmEnabled) {
    logVerbose("discord: drop group dm (group dms disabled)");
    return null;
  }
  if (isDirectMessage && !params.dmEnabled) {
    logVerbose("discord: drop dm (dms disabled)");
    return null;
  }

  const dmPolicy = params.dmPolicy;
  const resolvedAccountId = params.accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
  let commandAuthorized = true;
  let blockControlCommand = false;
  let channelIngress;
  let resolveChannelIngress;
  if (isDirectMessage) {
    const access = await resolveDiscordDmPreflightAccess({
      preflight: params,
      author,
      sender,
      dmPolicy,
      resolvedAccountId,
      allowNameMatching,
      conversationId: messageChannelId,
    });
    if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
      return null;
    }
    if (!access) {
      return null;
    }
    commandAuthorized = access.commandAuthorized;
    channelIngress = access.channelIngress;
    resolveChannelIngress = access.resolveChannelIngress;
  }

  const botId = params.botUserId;
  const baseText = resolveDiscordMessageText(message, {
    includeForwarded: false,
  });

  recordChannelActivity({
    channel: "discord",
    accountId: params.accountId,
    direction: "inbound",
  });

  // Resolve thread parent early for binding inheritance
  const channelName =
    channelInfo?.name ??
    (isGuildMessage || isGroupDm
      ? resolveDiscordChannelNameSafe(
          "channel" in message ? (message as { channel?: unknown }).channel : undefined,
        )
      : undefined);
  const threadContext = await resolveDiscordPreflightThreadContext({
    client: params.client,
    isGuildMessage,
    message,
    channelInfo,
    messageChannelId,
    abortSignal: params.abortSignal,
  });
  if (!threadContext || params.isPolicyCurrent?.() === false) {
    return null;
  }
  const { earlyThreadChannel, earlyThreadParentId, earlyThreadParentName, earlyThreadParentType } =
    threadContext;

  // Routing inputs are payload-derived, but config must come from the boundary
  // snapshot already threaded into the monitor path.
  const memberRoleIds = Array.isArray(params.data.rawMember?.roles)
    ? params.data.rawMember.roles
    : [];
  const routeState = await resolveDiscordPreflightRoute({
    preflight: params,
    author,
    isDirectMessage,
    isGroupDm,
    messageChannelId,
    memberRoleIds,
    earlyThreadParentId,
  });
  if (params.isPolicyCurrent?.() === false) {
    return null;
  }
  const {
    conversationRuntime,
    threadBinding,
    configuredBinding,
    boundSessionKey,
    effectiveRoute,
    boundAgentId,
    baseSessionKey,
  } = routeState;
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      threadId: messageChannelId,
      webhookId,
      threadBinding,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  const isBoundThreadSession = Boolean(threadBinding && earlyThreadChannel);
  if (
    isBoundThreadBotSystemMessage({
      isBoundThreadSession,
      isBotAuthor: Boolean(author.bot),
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const requiresActiveBotMention =
    author.bot === true && !sender.isPluralKit && allowBotsMode === "mentions";
  const mentionSources = hydratedSources.map(({ message: source, kind }) => {
    const documents = resolveDiscordMessageMentionDocuments(source);
    const hasRawMention =
      (kind === "unavailable" || (requiresActiveBotMention && source.type === MessageType.Reply)) &&
      documents.some((text) => hasRawDiscordUserMention(text, botId));
    const explicitlyMentioned = Boolean(
      botId &&
      (source.mentionedUsers?.some((user: User) => user.id === botId) ||
        (kind === "unavailable" && hasRawMention)),
    );
    return {
      documents,
      explicitlyMentioned,
      activeNativeMention:
        explicitlyMentioned && (source.type !== MessageType.Reply || hasRawMention),
    };
  });
  const explicitlyMentioned = mentionSources.some((source) => source.explicitlyMentioned);
  const hasAnyMention =
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 ||
      (message.mentionedRoles?.length ?? 0) > 0 ||
      (message.mentionedEveryone && (!author.bot || sender.isPluralKit)));

  if (
    isGuildMessage &&
    (message.type === MessageType.ChatInputCommand ||
      message.type === MessageType.ContextMenuCommand)
  ) {
    logVerbose("discord: drop channel command message");
    return null;
  }

  const guildInfo = isGuildMessage
    ? resolveDiscordGuildEntry({
        guild: params.data.guild ?? undefined,
        guildId: params.data.guild_id ?? undefined,
        guildEntries: params.guildEntries,
      })
    : null;
  logDebug(
    `[discord-preflight] guild_id=${params.data.guild_id} guild_obj=${Boolean(params.data.guild)} guild_obj_id=${params.data.guild?.id} guildInfo=${Boolean(guildInfo)} guildEntries=${params.guildEntries ? Object.keys(params.guildEntries).join(",") : "none"}`,
  );
  if (
    isGuildMessage &&
    params.guildEntries &&
    Object.keys(params.guildEntries).length > 0 &&
    !guildInfo
  ) {
    logDebug(
      `[discord-preflight] guild blocked: guild_id=${params.data.guild_id} guildEntries keys=${Object.keys(params.guildEntries).join(",")}`,
    );
    logVerbose(
      `Blocked discord guild ${params.data.guild_id ?? "unknown"} (not in discord.guilds)`,
    );
    return null;
  }

  // Reuse early thread resolution from above (for binding inheritance)
  const threadChannel = earlyThreadChannel;
  const threadParentId = earlyThreadParentId;
  const threadParentName = earlyThreadParentName;
  const threadParentType = earlyThreadParentType;
  const {
    threadName,
    configChannelName,
    configChannelSlug,
    displayChannelName,
    displayChannelSlug,
    guildSlug,
    channelConfig,
  } = resolveDiscordPreflightChannelContext({
    isGuildMessage,
    messageChannelId,
    channelName,
    guildName: params.data.guild?.name,
    guildInfo,
    threadChannel,
    threadParentId,
    threadParentName,
  });
  const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
  logDiscordPreflightChannelConfig({
    channelConfig,
    channelMatchMeta,
    channelId: messageChannelId,
  });
  const channelAccess = resolveDiscordPreflightChannelAccess({
    isGuildMessage,
    isGroupDm,
    groupPolicy: params.groupPolicy,
    groupDmChannels: params.groupDmChannels,
    messageChannelId,
    displayChannelName,
    displayChannelSlug,
    guildInfo,
    channelConfig,
    channelMatchMeta,
  });
  if (!channelAccess.allowed) {
    return null;
  }
  const { channelAllowlistConfigured, channelAllowed } = channelAccess;

  const shouldRequireMention = !isDirectMessage;
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender,
    allowNameMatching,
  });

  const memberInvocationAllowed = !isGuildMessage || !hasAccessRestrictions || memberAllowed;

  let preflightTranscript: string | undefined;
  if (isDirectMessage) {
    const { resolveDiscordPreflightAudioMentionContext } = await loadPreflightAudioRuntime();
    if (params.isPolicyCurrent?.() === false) {
      return null;
    }
    const audio = await resolveDiscordPreflightAudioMentionContext({
      message,
      isDirectMessage,
      shouldRequireMention: false,
      mentionRegexes: [],
      cfg: params.cfg,
      abortSignal: params.abortSignal,
    });
    preflightTranscript = audio.transcript;
  }
  if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
    return null;
  }

  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    !isDirectMessage &&
      Boolean(botId) &&
      resolveDiscordReferencedReplyMessage(message)?.author?.id === botId,
  );
  const hasActiveBotMention =
    !isDirectMessage && mentionSources.some((source) => source.activeNativeMention);
  const wasMentioned = !isDirectMessage && explicitlyMentioned;
  logDiscordPreflightInboundSummary({
    messageId: message.id,
    guildId: params.data.guild_id ?? undefined,
    channelId: messageChannelId,
    wasMentioned,
    isDirectMessage,
    isGroupDm,
    hasContent: Boolean(messageText),
  });

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: "discord",
  });
  const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);
  const hasAbortRequest = isAbortRequestText(baseText);

  if (!isDirectMessage) {
    const resolveCommandIngress = async (
      contextBinding?: Parameters<typeof resolveDiscordTextCommandAccess>[0]["contextBinding"],
      conversation?: { parentId?: string; threadId?: string },
    ) =>
      await resolveDiscordTextCommandAccess({
        accountId: params.accountId,
        cfg: params.cfg,
        ownerAllowFrom: params.allowFrom,
        sender: {
          id: sender.id,
          name: sender.name,
          tag: sender.tag,
          isPluralKit: sender.isPluralKit,
          authorKind: author.bot ? "bot" : "user",
        },
        memberAccessConfigured: hasAccessRestrictions,
        memberAllowed,
        allowNameMatching,
        allowTextCommands,
        hasControlCommand: hasControlCommandInMessage,
        conversationId: messageChannelId,
        conversationParentId: conversation?.parentId,
        conversationThreadId: conversation?.threadId,
        ...(contextBinding ? { contextBinding } : {}),
      });
    const commandAccess = await resolveCommandIngress();
    if (params.isPolicyCurrent?.() === false) {
      return null;
    }
    commandAuthorized = commandAccess.commandAccess.authorized;
    blockControlCommand = commandAccess.commandAccess.shouldBlockControlCommand;
    channelIngress = commandAccess;
    resolveChannelIngress = resolveCommandIngress;
  }

  const canDetectMention = !isDirectMessage;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds,
    },
    policy: {
      isGroup: !isDirectMessage,
      requireMention: shouldRequireMention,
      allowedImplicitMentionKinds: ["reply_to_bot"],
      allowTextCommands: isDirectMessage && allowTextCommands,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
  const invocationAllowed = memberInvocationAllowed && !blockControlCommand;
  const shouldProcessRequest = invocationAllowed && !mentionDecision.shouldSkip;
  const inboundEventKind = classifyChannelInboundEvent({
    conversation: { kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel" },
    unmentionedGroupPolicy: resolveUnmentionedGroupInboundPolicy({
      cfg: params.cfg,
      agentId: effectiveRoute.agentId,
    }),
    wasMentioned: effectiveWasMentioned,
    hasControlCommand: hasControlCommandInMessage,
    hasAbortRequest,
  });
  logDebug(
    `[discord-preflight] shouldRequireMention=${shouldRequireMention} boundThreadSession=${isBoundThreadSession} mentionDecision.shouldSkip=${mentionDecision.shouldSkip} wasMentioned=${wasMentioned}`,
  );

  if (requiresActiveBotMention) {
    const botMentioned =
      isDirectMessage ||
      hasActiveBotMention ||
      mentionDecision.matchedImplicitMentionKinds.some((kind) => kind !== "reply_to_bot");
    if (!botMentioned) {
      logDebug(`[discord-preflight] drop: bot message missing mention (allowBots=mentions)`);
      logVerbose("discord: drop bot message (allowBots=mentions, missing mention)");
      return null;
    }
  }
  const systemLocation = resolveDiscordSystemLocation({
    isDirectMessage,
    isGroupDm,
    guild: params.data.guild ?? undefined,
    channelName: channelName ?? messageChannelId,
  });
  const { resolveDiscordSystemEvent } = await loadSystemEventsRuntime();
  if (params.isPolicyCurrent?.() === false) {
    return null;
  }
  const systemText = resolveDiscordSystemEvent(message, systemLocation);
  if (systemText) {
    logDebug(`[discord-preflight] drop: system event`);
    if (invocationAllowed) {
      enqueueRoutedSystemEvent(systemText, effectiveRoute, {
        contextKey: `discord:system:${messageChannelId}:${message.id}`,
      });
    }
    return null;
  }

  const hasNativeMedia =
    (message.attachments?.length ?? 0) > 0 || resolveDiscordMessageStickers(message).length > 0;
  if (!messageText && !hasNativeMedia) {
    logDebug(`[discord-preflight] drop: empty content`);
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return null;
  }
  const botLoopProtection =
    shouldProcessRequest &&
    author.bot &&
    !sender.isPluralKit &&
    allowBotsMode !== "off" &&
    params.botUserId &&
    author.id !== params.botUserId
      ? {
          scopeId: params.accountId,
          conversationId: messageChannelId,
          senderId: author.id,
          receiverId: params.botUserId,
          config: params.discordConfig?.botLoopProtection,
          defaultsConfig: params.cfg.channels?.defaults?.botLoopProtection,
          defaultEnabled: true,
          nowMs: resolveTimestampMs(message.timestamp),
        }
      : undefined;
  if (botLoopProtection) {
    const botLoopResult = recordChannelBotPairLoopAndCheckSuppression(botLoopProtection);
    if (botLoopResult.suppressed) {
      logVerbose(
        `discord: bot-to-bot loop detected before media download, suppressing for ${Math.max(0, Math.ceil((botLoopResult.cooldownUntilMs - Date.now()) / 1000))}s`,
      );
      return null;
    }
  }

  // Save expiring transport attachments while the source event is available.
  const mediaResolveOptions = {
    fetchImpl: params.discordRestFetch,
    ssrfPolicy: params.cfg.browser?.ssrfPolicy,
    readIdleTimeoutMs: DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  };
  const preparedMedia: DiscordMediaInfo[] = [];
  let conversationHistory: ConversationHistoryCapture | undefined;
  if (!isDirectMessage) {
    // Room visibility permits observation, not invocation. Keep friends' text
    // before applying sender/command gates; capture-time visibility filters it.
    const conversation = buildConversationIdentity({
      channel: "discord",
      accountId: resolvedAccountId,
      kind: isGroupDm ? "group" : "channel",
      peerId: messageChannelId,
      deliveryTarget: `channel:${messageChannelId}`,
      threadId: threadChannel?.id,
      nativeChannelId: messageChannelId,
    });
    if (!conversation) {
      throw new Error("Discord observed message is missing its conversation identity");
    }
    const scope = {
      agentId: effectiveRoute.agentId,
      storePath: resolveStorePath(params.cfg.session?.store, { agentId: effectiveRoute.agentId }),
    };
    const sourceIds: string[] = [];
    for (const { message: source } of hydratedSources) {
      const media = await resolveMediaList(source, params.mediaMaxBytes, mediaResolveOptions);
      if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
        return null;
      }
      media.push(
        ...(await resolveForwardedMediaList(source, params.mediaMaxBytes, mediaResolveOptions)),
      );
      if (params.abortSignal?.aborted || params.isPolicyCurrent?.() === false) {
        return null;
      }
      const sourceId =
        source.id === message.id ? pluralkitInfo?.original?.trim() || source.id : source.id;
      if (shouldProcessRequest) {
        preparedMedia.push(...media);
      }
      sourceIds.push(sourceId);
      const reply = resolveDiscordReferencedReplyMessage(source)
        ? resolveReplyContext(source, resolveDiscordMessageHistoryText)
        : null;
      conversationHistory = await recordConversationObservation(scope, {
        conversationRef: conversation.conversationRef,
        sourceId,
        message: {
          text: resolveDiscordMessageHistoryText(source, { includeForwarded: true }),
          timestamp: resolveTimestampMs(source.timestamp),
          sender: { id: sender.id, name: sender.name ?? sender.label, username: sender.tag },
          senderRoles: memberRoleIds,
          media: toInboundMediaFacts(media, { messageId: sourceId }),
          replyTo: reply?.body
            ? {
                text: reply.body,
                sender: {
                  id: reply.senderId,
                  name: reply.senderName,
                  username: reply.senderTag,
                },
                senderRoles: reply.memberRoleIds,
                messageId: reply.id,
                timestamp: reply.timestamp,
              }
            : undefined,
          transport: {
            channel: "discord",
            conversationRef: conversation.conversationRef,
            messageId: sourceId,
            replyToId: resolveDiscordReferencedReplyMessageId(source) ?? undefined,
            threadId: threadChannel?.id,
          },
        },
      });
    }
    if (conversationHistory) {
      conversationHistory = { ...conversationHistory, requestSourceIds: sourceIds };
    }
    if (!memberInvocationAllowed) {
      logVerbose("discord: observed guild text; sender cannot invoke (users/roles allowlist)");
      return null;
    }
    if (blockControlCommand) {
      logInboundDrop({
        log: logVerbose,
        channel: "discord",
        reason: "control command (unauthorized)",
        target: sender.id,
      });
      return null;
    }
    if (mentionDecision.shouldSkip) {
      logger.info(
        { channelId: messageChannelId, reason: "no-mention" },
        "discord: observed message",
      );
      return null;
    }
  }

  if (configuredBinding) {
    const ensured = await conversationRuntime.ensureConfiguredBindingRouteReady({
      cfg: params.cfg,
      bindingResolution: configuredBinding,
    });
    if (params.isPolicyCurrent?.() === false) {
      return null;
    }
    if (!ensured.ok) {
      logVerbose(
        `discord: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
      );
      return null;
    }
  }

  const guildId = isGuildMessage
    ? (data.guild?.id ?? data.guild_id ?? message.guild_id)
    : undefined;
  const conversationAvatar =
    isDirectMessage || guildId
      ? params.avatarResolver?.resolve({
          client: params.client,
          conversationId: messageChannelId,
          author,
          ...(guildId ? { guildId } : {}),
        })
      : undefined;

  if (isDirectMessage) {
    preparedMedia.push(
      ...(await resolveMediaList(message, params.mediaMaxBytes, mediaResolveOptions)),
    );
    if (params.abortSignal?.aborted) {
      return null;
    }
    preparedMedia.push(
      ...(await resolveForwardedMediaList(message, params.mediaMaxBytes, mediaResolveOptions)),
    );
    if (params.abortSignal?.aborted) {
      return null;
    }
  }

  logDebug(
    `[discord-preflight] success: route=${effectiveRoute.agentId} sessionKey=${effectiveRoute.sessionKey}`,
  );
  return buildDiscordMessagePreflightContext({
    preflightParams: params,
    data,
    client: params.client,
    message,
    messageChannelId,
    author,
    sender,
    canonicalMessageId: pluralkitInfo?.original?.trim() || undefined,
    memberRoleIds,
    channelInfo,
    channelName,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    commandAuthorized,
    channelIngress: channelIngress!,
    resolveChannelIngress: resolveChannelIngress!,
    baseText,
    messageText,
    ...(preflightTranscript !== undefined ? { preflightAudioTranscript: preflightTranscript } : {}),
    preparedMedia,
    wasMentioned,
    conversationAvatar,
    route: effectiveRoute,
    threadBinding,
    boundSessionKey: boundSessionKey || undefined,
    boundAgentId,
    guildInfo,
    guildSlug,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    configChannelName,
    configChannelSlug,
    displayChannelName,
    displayChannelSlug,
    baseSessionKey,
    channelConfig,
    channelAllowlistConfigured,
    channelAllowed,
    shouldRequireMention,
    groupRequireMention: shouldRequireMention,
    hasAnyMention,
    hasControlCommand: hasControlCommandInMessage,
    allowTextCommands,
    shouldBypassMention: mentionDecision.shouldBypassMention,
    effectiveWasMentioned,
    inboundEventKind,
    canDetectMention,
    conversationHistory,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
