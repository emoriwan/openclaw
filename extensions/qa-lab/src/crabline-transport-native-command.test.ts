import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

const NATIVE_COMMAND_CASES = [
  { command: "stop", name: "stop", wire: "/stop@crabline_bot" },
  {
    command: "queue collect please help",
    name: "queue",
    wire: "/queue@crabline_bot collect please help",
  },
  { command: "think high", name: "think", wire: "/think@crabline_bot high" },
] as const;

describe("Crabline Telegram native command arguments", () => {
  it("preserves full command text while restricting native names and entities to the command token", async () => {
    await withTempDir("qa-crabline-native-command-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: {
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          channel: "telegram",
          channelDriver: "crabline",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
        state: createQaBusState(),
      });

      try {
        for (const { command } of NATIVE_COMMAND_CASES) {
          await transport.sendNativeCommand?.({
            command,
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
          });
        }

        expect(transport.state.getSnapshot().messages).toMatchObject(
          NATIVE_COMMAND_CASES.map(({ command, name }) => ({
            text: `/${command}`,
            nativeCommand: { name },
          })),
        );

        const telegram = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels
          ?.telegram as { apiRoot?: string; botToken?: string } | undefined;
        if (!telegram?.apiRoot || !telegram.botToken) {
          throw new Error("Crabline Telegram API root and bot token are required");
        }
        await expect(
          fetch(`${telegram.apiRoot}/bot${telegram.botToken}/getMe`).then((response) =>
            response.json(),
          ),
        ).resolves.toMatchObject({
          result: { username: "crabline_bot" },
        });
        for (const text of ["ordinary room chatter", "🙂 @openclaw explain this", "/help"]) {
          await transport.sendInbound({
            conversation: { id: "-10042", kind: "group" },
            senderId: "100001",
            text,
          });
        }
        const response = await fetch(`${telegram.apiRoot}/bot${telegram.botToken}/getUpdates`);
        const updates: unknown = await response.json();
        expect(updates).toMatchObject({
          result: [
            ...NATIVE_COMMAND_CASES.map(({ wire, name }) => ({
              message: {
                entities: [{ length: name.length + 14, offset: 0, type: "bot_command" }],
                text: wire,
              },
            })),
            { message: { text: "ordinary room chatter" } },
            {
              message: {
                text: "🙂 @crabline_bot explain this",
                entities: [{ type: "mention", offset: 3, length: 13 }],
              },
            },
            { message: { text: "/help" } },
          ],
        });
        expect(updates).not.toHaveProperty("result.3.message.entities");
        expect(updates).not.toHaveProperty("result.5.message.entities");
      } finally {
        await transport.cleanup?.();
      }
    });
  });
});
