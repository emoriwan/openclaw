// Telegram plugin module implements bot message context.silent ingest support behavior.
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    fireAndForgetHook: (task: Promise<unknown>) => void task,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

function makeGroupMessage(text: string) {
  return {
    message_id: 42,
    chat: { id: -1001234567890, type: "supergroup" as const, title: "Test Group" },
    date: 1_700_000_000,
    text,
    from: { id: 99, first_name: "Alice", username: "alice" },
  };
}

describe("telegram mention-skip silent ingest", () => {
  it("preserves topic identity for configured observation hooks", async () => {
    internalHookMocks.triggerInternalHook.mockClear();
    const result = await buildTelegramMessageContextForTest({
      message: {
        ...makeGroupMessage("topic background"),
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        message_thread_id: 99,
      },
      cfg: { channels: { telegram: { groups: { "*": { ingest: true } } } } },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { ingest: true },
        topicConfig: { ingest: true },
      }),
    });
    expect(result).toBeNull();
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "message",
        action: "received",
        context: expect.objectContaining({
          content: "topic background",
          conversationId: "telegram:-1001234567890:topic:99",
          metadata: expect.objectContaining({
            threadId: 99,
            to: "telegram:-1001234567890:topic:99",
          }),
        }),
      }),
    );
  });

  it.each([
    {
      name: "disabled topic ingest",
      addressed: false,
      topicConfig: { ingest: false },
      text: "background",
      entities: [],
    },
    {
      name: "a denied sender",
      addressed: false,
      topicConfig: { ingest: true, allowFrom: ["555"] },
      text: "background",
      entities: [],
    },
    {
      name: "another bot's command",
      addressed: false,
      topicConfig: { ingest: true },
      text: "/status@other_bot",
      entities: [{ type: "bot_command", offset: 0, length: 17 }],
    },
    {
      name: "an addressed request owned by the shared hook",
      addressed: true,
      topicConfig: { ingest: true },
      text: "@bot help",
      entities: [{ type: "mention", offset: 0, length: 4 }],
    },
  ])(
    "does not emit the observation hook for $name",
    async ({ addressed, topicConfig, text, entities }) => {
      internalHookMocks.triggerInternalHook.mockClear();
      const result = await buildTelegramMessageContextForTest({
        message: { ...makeGroupMessage(text), entities },
        cfg: { channels: { telegram: { groups: { "*": { ingest: true } } } } },
        resolveTelegramGroupConfig: () => ({ groupConfig: { ingest: true }, topicConfig }),
      });
      expect(result !== null).toBe(addressed);
      expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    },
  );
  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const result = await buildTelegramMessageContextForTest({
      message: makeGroupMessage("hello without mention"),
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/sonnet-4.6",
            workspace: "/tmp/openclaw",
          },
        },
        channels: {
          telegram: {
            groups: {
              "*": {
                requireMention: true,
                ingest: true,
              },
            },
          },
        },
        messages: {
          groupChat: {
            mentionPatterns: ["@bot"],
          },
        },
      } as never,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: true,
          ingest: true,
        },
        topicConfig: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("telegram"),
      expect.objectContaining({
        channelId: "telegram",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("uses wildcard ingest when a specific group override omits ingest", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const result = await buildTelegramMessageContextForTest({
      message: makeGroupMessage("hello without mention"),
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/sonnet-4.6",
            workspace: "/tmp/openclaw",
          },
        },
        channels: {
          telegram: {
            groups: {
              "*": {
                requireMention: true,
                ingest: true,
              },
              "-1001234567890": {
                requireMention: true,
              },
            },
          },
        },
        messages: {
          groupChat: {
            mentionPatterns: ["@bot"],
          },
        },
      } as never,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: true,
        },
        topicConfig: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("telegram"),
      expect.objectContaining({
        channelId: "telegram",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });
});
