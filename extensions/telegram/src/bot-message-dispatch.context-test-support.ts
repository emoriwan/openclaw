import type { TelegramMessageContext } from "./bot-message-context.js";

export function createContextPayload(
  body: string,
  overrides: Partial<TelegramMessageContext["ctxPayload"]> = {},
): TelegramMessageContext["ctxPayload"] {
  return {
    Body: body,
    BodyForAgent: body,
    BodyForCommands: body,
    CommandBody: body,
    RawBody: body,
    From: "telegram:123",
    To: "telegram:123",
    SessionKey: "agent:test:telegram:direct:123",
    ChatType: "direct",
    CommandAuthorized: false,
    InboundEventKind: "user_request",
    ...overrides,
  };
}
