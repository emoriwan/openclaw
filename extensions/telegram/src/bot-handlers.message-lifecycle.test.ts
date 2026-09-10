import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { buildSyntheticTextMessage } from "./bot-handlers.message-context.js";

function message(fields: Record<string, unknown>): Message {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 42, type: "private", first_name: "Ada" },
    from: { id: 42, is_bot: false, first_name: "Ada" },
    ...fields,
  } as unknown as Message;
}

describe("Telegram synthetic message formatting", () => {
  it("preserves combined formatting entities when building synthetic text messages", () => {
    const entities = [{ type: "bold" as const, offset: 3, length: 4 }];
    const synthetic = buildSyntheticTextMessage({
      base: message({ caption: "old caption", caption_entities: entities }),
      text: "😀 bold",
      entities,
    });

    expect(synthetic.text).toBe("😀 bold");
    expect(synthetic.entities).toEqual(entities);
    expect(synthetic.caption).toBeUndefined();
    expect(synthetic.caption_entities).toBeUndefined();
  });
});
