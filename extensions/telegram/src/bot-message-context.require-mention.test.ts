import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const groupMessage = {
  message_id: 1,
  chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
  date: 1_700_000_000,
  message_thread_id: 99,
  from: { id: 42, first_name: "Alice" },
};

describe("Telegram addressed group input", () => {
  it("rejects buffered context if the topic is routed to another agent before admission", async () => {
    const message = {
      ...groupMessage,
      text: "@bot use the room context",
      entities: [{ type: "mention", offset: 0, length: 4 }],
    };
    const original = await buildTelegramMessageContextForTest({ message });
    const capture = original?.ctxPayload.ConversationHistory;
    if (!original || !capture) {
      throw new Error("Expected an addressed request with captured room context");
    }
    const rerouted = await buildTelegramMessageContextForTest({
      message,
      options: { conversationHistory: capture },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { groupPolicy: "open" },
        topicConfig: { agentId: "after-reload" },
      }),
    });
    if (!rerouted) {
      throw new Error("Expected the refreshed topic route");
    }
    expect(rerouted.route.agentId).toBe("after-reload");
    expect(rerouted.ctxPayload.ConversationHistory?.owner).toEqual(capture.owner);
    const target = {
      agentId: rerouted.route.agentId,
      sessionKey: rerouted.route.sessionKey,
      sessionId: "rerouted-session",
      storePath: rerouted.turn.storePath,
    };
    await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = createRecorder({
      input: { text: message.text, idempotencyKey: "buffered-before-route-change" },
      target: { ...target, sessionEntry: undefined },
      conversationHistory: rerouted.ctxPayload.ConversationHistory,
    });
    await expect(
      recorder.stageApproved!({ runId: "route-change", assertCurrent: () => {} }),
    ).rejects.toThrow("Conversation observation owner changed before input admission");
  });
  it.each([
    {
      name: "room",
      groupConfig: { groupPolicy: "open" as const, allowFrom: [] },
      topicConfig: undefined,
    },
    {
      name: "topic",
      groupConfig: { groupPolicy: "open" as const, allowFrom: ["42"] },
      topicConfig: { allowFrom: [] },
    },
  ])(
    "does not let an open group bypass an explicit empty $name sender override",
    async ({ groupConfig, topicConfig }) => {
      const result = await buildTelegramMessageContextForTest({
        message: {
          ...groupMessage,
          text: "@bot run this",
          entities: [{ type: "mention", offset: 0, length: 4 }],
        },
        cfg: { channels: { telegram: { groupPolicy: "open" } } },
        resolveTelegramGroupConfig: () => ({ groupConfig, topicConfig }),
      });
      expect(result).toBeNull();
    },
  );
  it.each([
    { name: "ordinary chatter", text: "hello everyone", entities: [] },
    { name: "a wake word", text: "OpenClaw help", entities: [] },
    { name: "a bare abort", text: "stop", entities: [] },
    {
      name: "a bare command",
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
    {
      name: "another bot's command",
      text: "/status@otherbot",
      entities: [{ type: "bot_command", offset: 0, length: 16 }],
    },
    {
      name: "another bot's mention",
      text: "@otherbot help",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    },
    { name: "text without a native mention", text: "@bot help", entities: [] },
  ])("records $name without starting a turn or sending feedback", async ({ text, entities }) => {
    const sendChatAction = vi.fn(async () => {});
    const setMessageReaction = vi.fn();
    const result = await buildTelegramMessageContextForTest({
      message: { ...groupMessage, text, entities },
      cfg: {
        messages: {
          groupChat: { unmentionedInbound: "room_event", mentionPatterns: ["OpenClaw"] },
        },
      },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { requireMention: false },
      }),
      sendChatActionHandler: { sendChatAction, isSuspended: () => false, reset: () => {} },
      botApi: { setMessageReaction },
      ackReactionScope: "group-all",
    });
    expect(result).toBeNull();
    expect(sendChatAction).not.toHaveBeenCalled();
    expect(setMessageReaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a native username tag",
      text: "@bot help",
      entities: [{ type: "mention", offset: 0, length: 4 }],
    },
    {
      name: "a native user tag",
      text: "Assistant help",
      entities: [
        {
          type: "text_mention",
          offset: 0,
          length: 9,
          user: { id: 7, is_bot: true, first_name: "Bot" },
        },
      ],
    },
    {
      name: "a mixed tag",
      text: "@otherbot @bot help",
      entities: [
        { type: "mention", offset: 0, length: 9 },
        { type: "mention", offset: 10, length: 4 },
      ],
    },
    {
      name: "a native reply",
      text: "please continue",
      reply_to_message: {
        ...groupMessage,
        message_id: 90,
        text: "Earlier answer",
        from: { id: 7, first_name: "Bot", is_bot: true },
      },
    },
  ])(
    "admits $name with a durable capture and no legacy history projection",
    async ({ name: _name, ...message }) => {
      const result = await buildTelegramMessageContextForTest({
        message: { ...groupMessage, ...message },
      });
      expect(result?.ctxPayload.InboundEventKind).toBe("user_request");
      expect(result?.ctxPayload.WasMentioned).toBe(true);
      expect(result?.ctxPayload.ConversationHistory).toMatchObject({ requestSourceIds: ["1"] });
      expect(result?.ctxPayload.InboundHistory).toBeUndefined();
      expect(result?.ctxPayload.SessionTranscriptContext).toBeUndefined();
    },
  );

  it("does not treat a forum service reply as an invocation", async () => {
    const result = await buildTelegramMessageContextForTest({
      message: {
        ...groupMessage,
        text: "continue",
        reply_to_message: {
          ...groupMessage,
          message_id: 2,
          from: { id: 7, first_name: "Bot", is_bot: true },
          forum_topic_created: { name: "Forum", icon_color: 123 },
        },
      },
    });
    expect(result).toBeNull();
  });

  it("keeps direct messages explicit without requiring a tag", async () => {
    const result = await buildTelegramMessageContextForTest({
      message: {
        ...groupMessage,
        chat: { id: 42, type: "private" },
        message_thread_id: undefined,
        text: "help",
      },
    });
    expect(result?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(result?.ctxPayload.ConversationHistory).toBeUndefined();
  });
});
