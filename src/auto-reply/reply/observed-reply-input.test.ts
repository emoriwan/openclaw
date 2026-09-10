import fs from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  recordConversationObservationCore,
  type ConversationHistoryCapture,
} from "../../config/sessions/conversation-history.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { readPersistedMediaFacts, readRuntimePromptMediaFacts } from "../../media/media-facts.js";
import { saveMediaBuffer } from "../../media/store.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestFollowupRun, createTestQueueSettings } from "./agent-runner.test-fixtures.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  prepareObservedReplyTakeover,
  projectObservedReplyMedia,
  readObservedReplyInputOwner,
  withObservedReplyInputOwner,
} from "./observed-reply-input.js";
import { clearSessionQueues, enqueueFollowupRun } from "./queue.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

describe("observed reply input ownership", () => {
  const fixture = useTempSessionsFixture("openclaw-observed-reply-");
  const targetKey = "agent:main:acp:bound";
  const sourceKey = "agent:main:discord:channel:source";
  const sessionId = "bound-session";
  const scope = () => ({ agentId: "main", storePath: fixture.storePath() });
  const target = () => ({ ...scope(), sessionKey: targetKey, sessionId });
  const staging = () => ({
    cfg: {},
    agentId: "main",
    sessionKey: targetKey,
    workspaceDir: fixture.sessionsDir(),
  });
  const observe = (sourceId: string, text = sourceId) =>
    recordConversationObservationCore(scope(), {
      conversationRef: "conv_source",
      sourceId,
      message: { text, sender: { name: "Friend" } },
    });
  const recorderFor = (sourceId: string) =>
    createUserTurnTranscriptRecorder({
      input: { text: sourceId, idempotencyKey: sourceId, timestamp: 1 },
      target: { ...target(), sessionEntry: { sessionId, updatedAt: 1 } },
    });
  const prepare = async (capture: ConversationHistoryCapture, sourceId: string) => {
    const recorder = recorderFor(sourceId);
    return await withObservedReplyInputOwner(capture, undefined, async (options) => {
      const owner = readObservedReplyInputOwner(options)!;
      const prompt = await owner.prepare({
        ...staging(),
        recorder,
        runId: sourceId,
        assertCurrent: () => {},
      });
      return [...owner.contextFragments.map((fragment) => fragment.text), prompt].join("\n\n");
    });
  };

  beforeEach(async () => {
    await upsertSessionEntryCore(target(), { sessionId, updatedAt: 1 });
    await upsertSessionEntryCore(
      { ...scope(), sessionKey: sourceKey },
      {
        sessionId: "source-session",
        updatedAt: 1,
      },
    );
  });

  it.each([false, true])(
    "projects optional background files without changing canonical input (expired: %s)",
    async (expired) => {
      await withOpenClawTestState({ label: "observed-file-staging" }, async (state) => {
        const saved = await saveMediaBuffer(Buffer.from("saved report"), "text/plain", "inbound");
        await recordConversationObservationCore(scope(), {
          conversationRef: "conv_source",
          sourceId: "report",
          message: {
            text: "Earlier report",
            media: [{ path: saved.path, contentType: "text/plain", fileName: "report.txt" }],
          },
        });
        if (expired) {
          await fs.unlink(saved.path);
        }
        const capture = await observe("read-report");
        const recorder = recorderFor("read-report");
        await withObservedReplyInputOwner(capture, undefined, async (options) => {
          const owner = readObservedReplyInputOwner(options)!;
          const prompt = await owner.prepare({
            ...staging(),
            workspaceDir: state.workspaceDir,
            recorder,
            runId: "read-report",
            assertCurrent: () => {},
          });
          const context = owner.contextFragments.map((fragment) => fragment.text).join("\n\n");
          const canonical = recorder.getPendingInputMessage!()!;
          if (typeof canonical.content !== "string") {
            throw new Error("Expected text-only captured input");
          }
          expect(readPersistedMediaFacts(canonical)?.[0]).toMatchObject({
            path: saved.path,
            hydrationSuppressed: true,
            contextOnly: true,
          });
          expect(canonical.content).toContain(saved.path);
          expect(prompt).toContain("read-report");
          if (expired) {
            expect(context).toContain("attachment unavailable");
          } else {
            const stagedPath = readRuntimePromptMediaFacts(canonical)?.[0]?.path;
            expect(stagedPath).toBeDefined();
            expect(stagedPath).not.toBe(saved.path);
            expect(context).toContain(stagedPath);
            expect(await fs.readFile(stagedPath!, "utf8")).toBe("saved report");
          }
          const collected = createUserTurnTranscriptRecorder({
            input: {
              text: canonical.content,
              media: readPersistedMediaFacts(canonical),
              idempotencyKey: "collected-report",
            },
            target: { ...target(), sessionEntry: { sessionId, updatedAt: 1 } },
            pendingInputSources: [recorder],
          });
          const collectedMessage = (await collected.resolveMessage())!;
          if (typeof collectedMessage.content !== "string") {
            throw new Error("Expected text-only collected input");
          }
          expect(projectObservedReplyMedia(collectedMessage, collectedMessage.content)).toBe(
            projectObservedReplyMedia(canonical, canonical.content),
          );
          expect(collectedMessage.content).toBe(canonical.content);
          collected.finishPendingInput?.("cancelled");
        });
      });
    },
  );

  it.each([false, true])(
    "keeps observed selections separate after request hooks (rewritten: %s)",
    async (rewritten) => {
      const background = "Try $background-skill and [@background-plugin] \n(plugin://background).";
      const request = "Use $current-skill and [@current-plugin] \n(plugin://current).";
      const approvedRequest = rewritten
        ? request.replace("current-skill", "approved-skill")
        : request;
      await observe("background-selection", background);
      const capture = await observe("current-selection", request);
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: request, idempotencyKey: "current-selection", timestamp: 1 },
        target: { ...target(), sessionEntry: { sessionId, updatedAt: 1 } },
        beforeMessageWrite: rewritten
          ? ({ message }) => ({ ...message, content: approvedRequest })
          : undefined,
      });
      await withObservedReplyInputOwner(capture, undefined, async (options) => {
        const owner = readObservedReplyInputOwner(options)!;
        expect(
          await owner.prepare({
            ...staging(),
            recorder,
            runId: "current-selection",
            assertCurrent: () => {},
          }),
        ).toBe(approvedRequest);
        expect(owner.contextFragments).toEqual([
          {
            kind: "conversation-data",
            text: `[Earlier chat messages - for context]\nFriend: ${background}`,
          },
        ]);
        const canonical = recorder.getPendingInputMessage!()!;
        expect(canonical.content).toEqual(expect.stringContaining(background));
        expect(canonical["__openclaw"]?.observedInput?.request).toBe(approvedRequest);
      });
    },
  );

  it("gives a bound takeover its captured prompt and commits only to the target transcript", async () => {
    await observe("background", "The deadline is Friday");
    const capture = await observe("request", "Summarize");
    const ctx = finalizeInboundContext({
      SessionKey: sourceKey,
      Body: "Summarize",
      BodyForAgent: "Summarize",
      RawBody: "Summarize",
      Provider: "discord",
      Surface: "discord",
      AccountId: "default",
      From: "discord:channel:source",
      To: "channel:source",
      ChatType: "channel",
      MessageSid: "request",
      SenderId: "owner",
      ConversationHistory: capture,
    });
    setChannelSourceTurnId(ctx, "request");
    await withObservedReplyInputOwner(capture, undefined, async (replyOptions) => {
      const params = { replyOptions };
      expect(
        await prepareObservedReplyTakeover(
          {
            params,
            ctx,
            cfg: { session: { store: fixture.storePath() } },
            workspaceDir: fixture.sessionsDir(),
            getPreDispatchAbortSignal: () => undefined,
            replaceDispatchAgentText: (text, context) => {
              ctx.agentText = text;
              ctx.CurrentInboundContext = context;
            },
          },
          targetKey,
        ),
      ).toBe(true);
      expect(ctx.CurrentInboundContext?.text).toContain("Friend: The deadline is Friday");
      expect(ctx.agentText).toBe("Summarize");
      await params.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    });
    expect(JSON.stringify(await loadTranscriptEvents(target()))).toContain(
      "The deadline is Friday",
    );
    expect(
      await loadTranscriptEvents({
        ...scope(),
        sessionKey: sourceKey,
        sessionId: "source-session",
      }),
    ).toEqual([]);
  });

  it("releases history when an early refusal returns before runtime execution", async () => {
    await observe("background", "Do not lose this context");
    const capture = await observe("refused");
    await withObservedReplyInputOwner(capture, undefined, async (options) => {
      await readObservedReplyInputOwner(options)!.prepare({
        ...staging(),
        recorder: recorderFor("refused"),
        runId: "refused",
        assertCurrent: () => {},
      });
      return { reason: "question-response-refused" };
    });
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("cancelled");
    expect(await prepare(await observe("next"), "next")).toContain("Do not lose this context");
  });

  it("retains interrupted input identity for a safe retry after a pre-submission error", async () => {
    const capture = await observe("retry");
    await expect(
      withObservedReplyInputOwner(capture, undefined, async (options) => {
        await readObservedReplyInputOwner(options)!.prepare({
          ...staging(),
          recorder: recorderFor("retry"),
          runId: "retry",
          assertCurrent: () => {},
        });
        throw new Error("preparation failed");
      }),
    ).rejects.toThrow("preparation failed");
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("interrupted");
    expect(await prepare(capture, "retry")).toBe("retry");
  });

  it("transfers cleanup only after queue admission and releases it when that queue closes", async () => {
    const capture = await observe("queued");
    const recorder = recorderFor("queued");
    const queueKey = "observed-input-owner";
    await withObservedReplyInputOwner(capture, undefined, async (options) => {
      const observedInput = readObservedReplyInputOwner(options)!;
      await observedInput.prepare({
        ...staging(),
        recorder,
        runId: "queued",
        assertCurrent: () => {},
      });
      const queued = createTestFollowupRun();
      queued.observedInput = observedInput;
      queued.userTurnTranscriptRecorder = recorder;
      expect(enqueueFollowupRun(queueKey, queued, createTestQueueSettings())).toBe(true);
    });
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("queued");
    clearSessionQueues([queueKey]);
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("cancelled");
  });
});
