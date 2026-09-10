// Codex tests cover run-attempt prompt state helpers.
import { describe, expect, it } from "vitest";
import { prependCurrentInboundContext } from "./run-attempt-state.js";

describe("prependCurrentInboundContext", () => {
  it.each(["", " ", "\t", "\n", "\r\n", "\f"])(
    "neutralizes context selectors with link spacing %j while preserving the request",
    (spacing) => {
      const joined = prependCurrentInboundContext(
        `run $current-skill and [@current]${spacing}(plugin://current)`,
        {
          text: `Quoted reply: please try $example-manual and [@example]${spacing}(plugin://example)`,
        },
      );

      expect(joined).toBe(
        `Quoted reply: please try ＄example-manual and [＠example]${spacing}(plugin://example)\n\nrun $current-skill and [@current]${spacing}(plugin://current)`,
      );
    },
  );

  it("returns the prompt unchanged without inbound context", () => {
    expect(prependCurrentInboundContext("run $current-skill now", undefined)).toBe(
      "run $current-skill now",
    );
  });
});
