// Tests owner gating for group activation session changes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { HandleCommandsParams } from "./commands-types.js";

const persistSessionEntryMock = vi.hoisted(() => vi.fn(async () => true));
const persistenceConflictReply = vi.hoisted(() => ({
  shouldContinue: false,
  reply: { text: "retry session command" },
}));

vi.mock("./commands-session-store.js", () => ({
  persistCommandSession: persistSessionEntryMock,
  sessionEntryPersistenceConflictReply: () => persistenceConflictReply,
}));

function buildActivationParams(
  overrides: {
    commandBody?: string;
    isAuthorizedSender?: boolean;
    senderIsOwner?: boolean;
    channel?: string;
    commandSource?: "text" | "native";
  } = {},
): HandleCommandsParams {
  const commandBody = overrides.commandBody ?? "/activation always";
  const channel = overrides.channel ?? "telegram";
  return {
    cfg: { commands: { text: true } },
    ctx: {
      CommandSource: overrides.commandSource ?? "text",
      CommandAuthorized: overrides.isAuthorizedSender ?? true,
      CommandBody: commandBody,
      Surface: channel,
      Provider: channel,
    },
    command: {
      commandBodyNormalized: commandBody,
      rawBodyNormalized: commandBody,
      isAuthorizedSender: overrides.isAuthorizedSender ?? true,
      senderIsOwner: overrides.senderIsOwner ?? true,
      senderId: "group-member",
      channel,
      channelId: channel,
      surface: channel,
      ownerList: ["owner"],
      from: "group-member",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "telegram:group:main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
      channel,
      chatType: "group",
      groupActivation: "mention",
    },
    sessionStore: {},
    workspaceDir: "/tmp/workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    isGroup: true,
  } as unknown as HandleCommandsParams;
}

describe("handleActivationCommand", () => {
  beforeEach(() => {
    persistSessionEntryMock.mockClear();
    persistSessionEntryMock.mockResolvedValue(true);
    setActivePluginRegistry(
      createTestRegistry(
        [
          { id: "telegram", modes: ["mention"] as const },
          { id: "discord", modes: ["mention"] as const },
          { id: "matrix", modes: ["mention", "always"] as const },
          { id: "whatsapp", modes: undefined },
        ].map(({ id, modes }) => ({
          pluginId: id,
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id }),
            commands: { groupActivationModes: modes },
          },
        })),
      ),
    );
  });
  afterEach(() => setActivePluginRegistry(createTestRegistry([])));

  it("rejects authorized non-owner senders without changing group activation", async () => {
    const { handleActivationCommand } = await import("./commands-session.js");
    const params = buildActivationParams({ senderIsOwner: false });

    const result = await handleActivationCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
    });
    expect(params.sessionEntry?.groupActivation).toBe("mention");
    expect(params.sessionEntry?.groupActivationNeedsSystemIntro).toBeUndefined();
    expect(persistSessionEntryMock).not.toHaveBeenCalled();
  });

  it.each(["matrix", "whatsapp"])(
    "preserves supported owner activation changes for %s",
    async (channel) => {
      const { handleActivationCommand } = await import("./commands-session.js");
      const params = buildActivationParams({ channel });

      const result = await handleActivationCommand(params, true);

      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: "⚙️ Group activation set to always." },
      });
      expect(params.sessionEntry?.groupActivation).toBe("always");
      expect(params.sessionEntry?.groupActivationNeedsSystemIntro).toBe(true);
      expect(persistSessionEntryMock).toHaveBeenCalledWith({
        ...params,
        touchedFields: ["groupActivation", "groupActivationNeedsSystemIntro"],
      });
    },
  );

  it.each([
    ["telegram", "text"],
    ["telegram", "native"],
    ["discord", "text"],
    ["discord", "native"],
  ] as const)(
    "rejects unsupported always activation on %s via %s without changing stored state",
    async (channel, commandSource) => {
      const { handleActivationCommand } = await import("./commands-session.js");
      const params = buildActivationParams({ channel, commandSource });
      const result = await handleActivationCommand(params, true);
      expect(result).toEqual({
        shouldContinue: false,
        reply: {
          text: "⚙️ This channel supports group activation: mention. Mention the bot with a native tag or reply to its message.",
        },
      });
      expect(params.sessionEntry?.groupActivation).toBe("mention");
      expect(params.sessionEntry?.groupActivationNeedsSystemIntro).toBeUndefined();
      expect(persistSessionEntryMock).not.toHaveBeenCalled();
    },
  );

  it.each(["telegram", "discord"])(
    "accepts supported mention activation on %s",
    async (channel) => {
      const { handleActivationCommand } = await import("./commands-session.js");
      const params = buildActivationParams({ channel, commandBody: "/activation mention" });
      expect(await handleActivationCommand(params, true)).toEqual({
        shouldContinue: false,
        reply: { text: "⚙️ Group activation set to mention." },
      });
      expect(persistSessionEntryMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["telegram", "discord"])(
    "lists only supported activation usage on %s",
    async (channel) => {
      const { handleActivationCommand } = await import("./commands-session.js");
      expect(
        await handleActivationCommand(
          buildActivationParams({ channel, commandBody: "/activation" }),
          true,
        ),
      ).toEqual({
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /activation mention" },
      });
      expect(persistSessionEntryMock).not.toHaveBeenCalled();
    },
  );

  it("reports a concurrent session change instead of acknowledging persistence", async () => {
    const { handleActivationCommand } = await import("./commands-session.js");
    const params = buildActivationParams({ channel: "matrix" });
    persistSessionEntryMock.mockResolvedValueOnce(false);

    await expect(handleActivationCommand(params, true)).resolves.toEqual(persistenceConflictReply);
  });
});
