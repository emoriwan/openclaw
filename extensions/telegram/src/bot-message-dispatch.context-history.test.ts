import { expect, it } from "vitest";
import { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import { createContextPayload } from "./bot-message-dispatch.context-test-support.js";
import {
  describeTelegramDispatch,
  createBot,
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  mockCallArg,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramBotDeps } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage context-history", () => {
  it("keeps captured native conversation context in its original topic", () => {
    const capture = {
      owner: { agentId: "main", databasePath: "/tmp/native-general.sqlite" },
      conversationRef: "native-general",
      throughSequence: 70,
      requestSourceIds: ["70"],
    };
    const context = createContext({
      chatId: -1003774691294,
      isGroup: true,
      threadSpec: { id: 1, scope: "forum" },
      ctxPayload: createContextPayload("Native room request", {
        CommandAuthorized: false,
        From: "telegram:group:-1003774691294:topic:1",
        SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
        MessageThreadId: 1,
        TransportThreadId: 1,
        ConversationHistory: capture,
        ChatType: "group",
        To: "telegram:-1003774691294:topic:1",
      }),
    });
    const resolved = resolveDispatchTelegramContext({ context });
    expect(resolved.ctxPayload.ConversationHistory).toBe(capture);
    expect(resolved.threadSpec).toEqual({ scope: "forum", id: 1 });
    expect(resolved.ctxPayload.MessageThreadId).toBe(1);
  });
  it("keeps the host-bound payload object while recovering forum routing", () => {
    const ctxPayload = createContextPayload("Recover forum routing", {
      CommandAuthorized: false,
      From: "telegram:group:-1003774691294:topic:1",
      MessageThreadId: 1,
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
      TransportThreadId: 1,
      ChatType: "group",
      To: "telegram:-1003774691294:topic:1",
    });
    const context = createContext({
      ctxPayload,
      chatId: -1003774691294,
      isGroup: true,
      threadSpec: { id: 1, scope: "forum" },
    });

    const recovered = resolveDispatchTelegramContext({ context });

    expect(recovered.ctxPayload).toBe(ctxPayload);
    expect(recovered.ctxPayload).toMatchObject({
      From: "telegram:group:-1003774691294:topic:3731",
      MessageThreadId: 3731,
      TransportThreadId: 3731,
    });
  });

  it("keeps retained overflow draft previews", async () => {
    const draftStream = createDraftStream();
    const bot = createBot();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), bot });

    const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
      NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
    >[0];
    streamParams.onRetainedPage?.({
      messageId: 17,
      textSnapshot: "first page",
    });
    expect(bot.api["deleteMessage"]).not.toHaveBeenCalled();
  });
});
