import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { recordConversationObservation } from "openclaw/plugin-sdk/reply-history";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntry,
  buildConversationIdentity,
  loadTranscriptEventsSync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../channel.js";
import type { CommandInteraction } from "../internal/discord.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.manager.js";

const directories: string[] = [];
const userId = "100000000000000003";
const sessionId = "existing-channel-session";

afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  setActivePluginRegistry(createTestRegistry());
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function runReset(commandName: "new" | "reset", allowFrom: string[], withHistory = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "discord-native-reset-"));
  directories.push(home);
  const channelId = "100000000000000001";
  const guildId = "100000000000000002";
  const storePath = path.join(home, "sessions.json");
  const sessionKey = `agent:main:discord:channel:${channelId}`;
  const scope = { agentId: "main", storePath, sessionKey };
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: home } },
    session: { store: storePath },
    commands: { allowFrom: { discord: allowFrom } },
    channels: {
      discord: {
        commands: { native: true },
        guilds: { [guildId]: { channels: { [channelId]: { enabled: true } } } },
      },
    },
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
  await upsertSessionEntry({
    ...scope,
    entry: {
      sessionId,
      lifecycleRevision: "before-reset",
      updatedAt: Date.now(),
      totalTokens: 100,
    },
  });
  // Native commands reread the Gateway's published configuration before dispatch.
  setRuntimeConfigSnapshot(cfg);
  const conversation = buildConversationIdentity({
    channel: "discord",
    accountId: "default",
    kind: "channel",
    peerId: channelId,
    deliveryTarget: `channel:${channelId}`,
    nativeChannelId: channelId,
  })!;
  const observe = (sourceId: string, conversationRef = conversation.conversationRef) =>
    recordConversationObservation(scope, {
      conversationRef,
      sourceId,
      message: { text: sourceId },
    });
  if (withHistory) {
    await observe("before-native-reset");
    await observe("other-conversation-message", "other-conversation");
    const dispatch = nativeCommandRuntime.dispatchChannelInboundTurn;
    vi.spyOn(nativeCommandRuntime, "dispatchChannelInboundTurn").mockImplementation(
      async (plan) => {
        expect(plan.ctxPayload.ConversationHistory?.conversationRef).toBe(
          conversation.conversationRef,
        );
        await observe("after-native-reset-boundary");
        return await dispatch(plan);
      },
    );
  }
  const interaction = createMockCommandInteraction({
    channelType: ChannelType.GuildText,
    channelId,
    guildId,
    userId,
    interactionId: randomUUID(),
  });
  const command = createDiscordNativeCommand({
    command: { name: commandName, description: "Reset the session.", acceptsArgs: true },
    cfg,
    discordConfig: cfg.channels!.discord!,
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
  await command.run(interaction as unknown as CommandInteraction);
  const pendingText: string[] = [];
  if (withHistory) {
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    for (const conversationRef of [conversation.conversationRef, "other-conversation"]) {
      const sourceId = `next-${conversationRef}`;
      const recorder = createRecorder({
        input: { text: sourceId, idempotencyKey: sourceId },
        target: { ...scope, sessionId, sessionEntry: getSessionEntry(scope) },
      });
      await recorder.stageApproved!({
        runId: sourceId,
        conversationHistory: await observe(sourceId, conversationRef),
        assertCurrent: () => {},
      });
      const content = recorder.message?.content;
      if (typeof content !== "string") {
        throw new Error("Expected captured text input after reset");
      }
      pendingText.push(content);
      recorder.finishPendingInput?.("cancelled");
    }
  }
  return {
    pendingText,
    entry: getSessionEntry(scope),
    events: loadTranscriptEventsSync({ ...scope, sessionId }),
    replies: [...interaction.reply.mock.calls, ...interaction.followUp.mock.calls].map(
      ([payload]) => payload.content,
    ),
  };
}

describe.each(["new", "reset"] as const)(
  "Discord native /%s through the reply pipeline",
  (name) => {
    it("clears only unread conversation through the native reset boundary", async () => {
      const result = await runReset(name, [userId], true);
      expect(result.pendingText[0]).not.toContain("before-native-reset");
      expect(result.pendingText[0]).toContain("after-native-reset-boundary");
      expect(result.pendingText[1]).toContain("other-conversation-message");
      expect(result.replies).toEqual([
        name === "new" ? "✅ New session started." : "✅ Session reset.",
      ]);
    });
    it.each(["", "user:", "discord:", "pk:", "<@", "<@!"])(
      "resets the channel and acknowledges a matching %s sender entry",
      async (prefix) => {
        const entry = `${prefix}${userId}${prefix.startsWith("<") ? ">" : ""}`;
        const result = await runReset(name, [entry]);
        expect(result.entry?.sessionId).toBe(sessionId);
        expect(result.entry?.lifecycleRevision).toBeTruthy();
        expect(result.entry?.lifecycleRevision).not.toBe("before-reset");
        expect(result.events).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "reset", reason: name })]),
        );
        expect(result.replies).toEqual([
          name === "new" ? "✅ New session started." : "✅ Session reset.",
        ]);
      },
    );

    it.each([
      { reason: "a different user", allowFrom: ["user:100000000000000004"] },
      { reason: "an empty allowlist", allowFrom: [] },
    ])("preserves the session when denied by $reason", async ({ allowFrom }) => {
      const result = await runReset(name, allowFrom);
      expect(result.entry?.lifecycleRevision).toBe("before-reset");
      expect(result.events).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "reset" })]),
      );
    });
  },
);
