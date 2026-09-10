import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  recordConversationObservationCore,
  enrichConversationObservationMediaCore,
  resetConversationHistory,
  type ConversationHistoryCapture,
  type ConversationHistoryMessage,
} from "./conversation-history.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  listSessionPendingInputs,
  claimSessionPendingInputDedupeRecovery,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("durable conversation history custody", () => {
  const fixture = useTempSessionsFixture("openclaw-conversation-history-");
  const sessionKey = "agent:main:group-history";
  const sessionId = "history-session";
  const conversationRef = "conv_group";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", storePath: fixture.storePath() });
  const sessionScope = () => ({ ...scope(), sessionKey, sessionId });
  const database = () =>
    openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope())));
  const observe = (
    sourceId: string,
    message: ConversationHistoryMessage = { text: sourceId, sender: { name: "Alice" } },
    conversation = conversationRef,
  ) =>
    recordConversationObservationCore(scope(), {
      conversationRef: conversation,
      sourceId,
      message,
    });
  const input = (runId: string): PersistedUserTurnMessage => ({
    role: "user",
    content: runId,
    timestamp: 1,
    idempotencyKey: runId,
  });
  const stage = async (
    runId: string,
    conversationHistory: ConversationHistoryCapture,
    prepareMessageAfterIdempotencyCheck?: (
      message: PersistedUserTurnMessage,
    ) => PersistedUserTurnMessage,
  ) => {
    const receipt = await stageSessionPendingInput(sessionScope(), {
      runId,
      message: input(runId),
      conversationHistory,
      prepareMessageAfterIdempotencyCheck,
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Test input was not admitted");
    }
    receipts.push(receipt);
    return receipt;
  };
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(sessionScope(), { message: receipt.message }));

  beforeEach(async () => {
    await upsertSessionEntryCore(sessionScope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });

  it("keeps existing stores history-free until their first room observation", async () => {
    const db = database().db;
    db.exec("DROP TABLE conversation_history");
    const receipt = await stageSessionPendingInput(sessionScope(), {
      runId: "ordinary-input",
      message: input("ordinary-input"),
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Ordinary input was not admitted");
    }
    receipts.push(receipt);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'conversation_history'").get(),
    ).toBeUndefined();
    const capture = await observe("first-observation");
    expect(capture.requestSourceIds).toEqual(["first-observation"]);
    expect(db.prepare("SELECT source_id FROM conversation_history").all()).toEqual([
      { source_id: "first-observation" },
    ]);
  });

  it("retains every unread message across reopen, freezes the request boundary and consumes once", async () => {
    for (let index = 0; index < 100; index += 1) {
      await observe(`message-${index}`);
    }
    await observe("other-room", { text: "private to another room" }, "conv_other");
    const capture = await observe("first-request");
    expect(await observe("first-request")).toEqual(capture);
    closeOpenClawAgentDatabasesForTest();
    await observe("arrived-after-request");
    const first = await stage("first-request", capture);
    const expectedHistory = Array.from(
      { length: 100 },
      (_, index) => `Alice: message-${index}`,
    ).join("\n");
    expect(first.message.content).toBe(
      `[Earlier chat messages - for context]\n${expectedHistory}\n\n[Current message - respond to this]\nfirst-request`,
    );
    expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
    await promote(first);
    const second = await stage("second-request", await observe("second-request"));
    expect(second.message.content).toBe(
      "[Earlier chat messages - for context]\nAlice: arrived-after-request\n\n[Current message - respond to this]\nsecond-request",
    );
  });

  it("awaits speaker visibility and assigns all current request sources only once", async () => {
    await observe("allowed", { text: "visible", senderRoles: ["reader"] });
    await observe("restricted", { text: "restricted", senderRoles: ["private"] });
    const firstSource = await observe("album-1");
    const secondSource = await observe("album-2");
    const first = await stage("album", {
      ...secondSource,
      requestSourceIds: [...firstSource.requestSourceIds, ...secondSource.requestSourceIds],
      includeMessage: async (message) => message.senderRoles?.includes("reader") === true,
    });
    expect(first.message.content).toBe(
      "[Earlier chat messages - for context]\nvisible\n\n[Current message - respond to this]\nalbum",
    );
    await promote(first);
    const next = await stage("next", await observe("next"));
    expect(next.message.content).toBe(
      "[Earlier chat messages - for context]\nrestricted\n\n[Current message - respond to this]\nnext",
    );
  });

  it("rechecks admission after asynchronous visibility before invoking the write hook", async () => {
    await observe("background");
    const capture = await observe("request");
    const controller = new AbortController();
    let prepared = false;
    await expect(
      stageSessionPendingInput(sessionScope(), {
        runId: "request",
        message: input("request"),
        conversationHistory: {
          ...capture,
          includeMessage: async () => {
            controller.abort();
            return true;
          },
        },
        assertCurrent: () => controller.signal.throwIfAborted(),
        prepareMessageAfterIdempotencyCheck: (message) => {
          prepared = true;
          return message;
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(prepared).toBe(false);
    expect(listSessionPendingInputs(sessionScope()).total).toBe(0);
    const recovered = await stage("next", await observe("next"));
    expect(recovered.message.content).toContain("Alice: background");
    expect(recovered.message.content).toContain("Alice: request");
  });

  it("preserves a native reply to a nonadjacent background message", async () => {
    await observe("first", {
      text: "Release today?",
      sender: { name: "Alice" },
      transport: { messageId: "10" },
    });
    await observe("second", {
      text: "Deploy tomorrow?",
      sender: { name: "Bob" },
      transport: { messageId: "11" },
    });
    await observe("answer", {
      text: "Yes.",
      sender: { name: "Carol" },
      transport: { messageId: "12", replyToId: "10" },
    });
    const captured = await stage("summarize", await observe("summarize"));
    expect(captured.message.content).toContain(
      "[message 10] Alice: Release today?\n[message 11] Bob: Deploy tomorrow?\n[message 12; reply to 10] Carol: Yes.",
    );
  });

  it("retains attachment references and timestamps across restart without injecting background images", async () => {
    const capture = await observe("photo", {
      text: "Which colour?",
      sender: { name: "Alice" },
      timestamp: 1_700_000_000_000,
    });
    const photo = {
      path: "/media/inbound/kitchen.png",
      contentType: "image/png",
      fileName: "kitchen.png",
    };
    await enrichConversationObservationMediaCore(capture, "photo", [photo]);
    closeOpenClawAgentDatabasesForTest();
    await enrichConversationObservationMediaCore(capture, "photo", [{ path: "/retry/copy.png" }]);
    const request = await stage("suggest a colour", await observe("request"));
    expect(request.message.content).toContain("[2023-11-14T22:13:20.000Z] Alice: Which colour?");
    expect(request.message.content).toContain("reference: /media/inbound/kitchen.png");
    expect(readPersistedMediaFacts(request.message)).toMatchObject([
      { ...photo, hydrationSuppressed: true, contextOnly: true },
    ]);
    await promote(request);
    await enrichConversationObservationMediaCore(capture, "photo", [
      { path: "/late/replacement.png" },
    ]);
    const events = await loadTranscriptEvents(sessionScope());
    expect(JSON.stringify(events)).toContain("kitchen.png");
    expect(JSON.stringify(events)).not.toContain("replacement.png");
  });

  it("preserves unseen reply targets while applying quote visibility independently", async () => {
    const quote = {
      text: "The departure is at 08:15",
      sender: { id: "private", name: "Bob" },
      messageId: "older",
    };
    await observe("reply", { text: "I'll be there", sender: { name: "Alice" }, replyTo: quote });
    const filtered = await stage("first", {
      ...(await observe("first")),
      includeMessage: async (_message, kind) => kind !== "quote",
    });
    expect(filtered.message.content).toContain("I'll be there");
    expect(filtered.message.content).not.toContain("08:15");
    filtered.finish("cancelled");
    const visible = await stage("second", await observe("second"));
    expect(visible.message.content).toContain(
      'Reply target older from Bob: "The departure is at 08:15"',
    );
  });

  it("resets only the captured conversation boundary and cannot resurrect a late download", async () => {
    const background = await observe("before-reset");
    await observe("other-room", { text: "Other room" }, "conv_other");
    const reset = await observe("reset");
    await observe("after-reset");
    runOpenClawAgentWriteTransaction(
      (db) => resetConversationHistory(db, reset),
      toDatabaseOptions(resolveSqliteReadScope(scope())),
    );
    await enrichConversationObservationMediaCore(background, "before-reset", [
      { path: "/late.png" },
    ]);
    const request = await stage("reset", reset);
    expect(request.message.content).toBe("reset");
    await promote(request);
    const next = await stage("next", await observe("next"));
    expect(next.message.content).toContain("after-reset");
    expect(next.message.content).not.toContain("before-reset");
    expect(next.message.content).not.toContain("late.png");
    const other = await stage(
      "other-request",
      await observe("other-request", undefined, "conv_other"),
    );
    expect(other.message.content).toContain("Other room");
  });

  it("refuses reset without discarding live or uncertain request history", async () => {
    await observe("background");
    const pending = await stage("active", await observe("active"));
    const reset = await observe("reset");
    const resetHistory = () =>
      runOpenClawAgentWriteTransaction(
        (db) => resetConversationHistory(db, reset),
        toDatabaseOptions(resolveSqliteReadScope(scope())),
      );
    expect(resetHistory).toThrow("unfinished submission");
    pending.beginSubmission();
    pending.finish("interrupted");
    expect(resetHistory).toThrow("unfinished submission");
    expect(pending.message.content).toContain("background");
  });

  it("rejects an oversized backlog without taking custody and permits a fresh request after reset", async () => {
    await observe("large", { text: "x".repeat(MAX_PAYLOAD_BYTES) });
    const capture = await observe("request");
    await expect(stage("request", capture)).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      userMessage: expect.stringContaining(
        "Nothing was sent. Use /new to start fresh without unread conversation; in a group, send it as a reply to this message.",
      ),
    });
    expect(listSessionPendingInputs(sessionScope()).total).toBe(0);
    expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
    const reset = await observe("reset");
    runOpenClawAgentWriteTransaction(
      (db) => resetConversationHistory(db, reset),
      toDatabaseOptions(resolveSqliteReadScope(scope())),
    );
    expect((await stage("reset", reset)).message.content).toBe("reset");
  });

  it("isolates logical agents in one physical store and rejects a changed capture owner", async () => {
    const storePath = path.join(fixture.sessionsDir(), "shared.sqlite");
    const agents = [];
    for (const agentId of ["main", "ops"]) {
      const agentScope = {
        agentId,
        storePath,
        sessionKey: `agent:${agentId}:shared`,
        sessionId: `${agentId}-shared-session`,
      };
      await upsertSessionEntryCore(agentScope, { sessionId: agentScope.sessionId, updatedAt: 1 });
      await recordConversationObservationCore(agentScope, {
        conversationRef,
        sourceId: "background",
        message: { text: "shared chat" },
      });
      const capture = await recordConversationObservationCore(agentScope, {
        conversationRef,
        sourceId: "request",
        message: { text: "request" },
      });
      agents.push({ scope: agentScope, capture });
    }
    const main = expectDefined(agents[0], "main agent fixture");
    const ops = expectDefined(agents[1], "ops agent fixture");
    expect(main.capture.owner.databasePath).toBe(ops.capture.owner.databasePath);
    for (const target of [ops.scope, sessionScope()]) {
      await expect(
        stageSessionPendingInput(target, {
          runId: "wrong-owner",
          message: input("wrong-owner"),
          conversationHistory: main.capture,
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("observation owner changed");
    }
    for (const agent of agents) {
      const receipt = await stageSessionPendingInput(agent.scope, {
        runId: "request",
        message: input("request"),
        conversationHistory: agent.capture,
        assertCurrent: () => {},
      });
      if (!receipt) {
        throw new Error("Shared-store request was not admitted");
      }
      receipts.push(receipt);
      expect(receipt.message.content).toContain("shared chat");
      await receipt.run(() => appendTranscriptMessage(agent.scope, { message: receipt.message }));
    }
  });

  it("releases cancelled context without replaying that request and preserves current interrupted custody", async () => {
    await observe("background");
    const cancelled = await stage("cancelled", await observe("cancelled"));
    cancelled.finish("cancelled");
    const next = await stage("next", await observe("next"));
    expect(next.message.content).toContain("Alice: background\nAlice: cancelled");
    next.finish("interrupted");
    const latest = await stage("latest", await observe("latest"));
    expect(latest.message.content).toBe("latest");
  });

  it("transfers abandoned pre-restart context to a fresh tag and rejects replay of the old request", async () => {
    await observe("background");
    const oldCapture = await observe("old-request");
    const old = await stage("old-request", oldCapture);
    rotateAgentEventLifecycleGeneration();
    closeOpenClawAgentDatabasesForTest();
    const fresh = await stage("fresh-request", await observe("fresh-request"));
    expect(fresh.message.content).toContain("Alice: background\nAlice: old-request");
    expect(listSessionPendingInputs(sessionScope()).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: old.inputId, state: "cancelled" })]),
    );
    await expect(stage("old-request", oldCapture)).rejects.toThrow("ownership ended");
    await promote(fresh);
    const last = await stage("last-request", await observe("last-request"));
    expect(last.message.content).toBe("last-request");
  });

  it.each([false, true])(
    "replays an unsent native request from its saved source payload (restart: %s)",
    async (restart) => {
      await observe("background");
      const capture = await observe("request");
      const hookInputs: PersistedUserTurnMessage["content"][] = [];
      const prepare = (message: PersistedUserTurnMessage): PersistedUserTurnMessage => {
        hookInputs.push(message.content);
        return { ...message, content: "approved $current-request" };
      };
      const original = await stage("request", capture, prepare);
      expect(hookInputs).toEqual(["request"]);
      expect(original.message["__openclaw"]?.observedInput).toEqual({
        context: "Alice: background",
        request: "approved $current-request",
      });
      expect(original.message.content).toBe(
        "[Earlier chat messages - for context]\nAlice: background\n\n[Current message - respond to this]\napproved $current-request",
      );
      original.finish("interrupted");
      if (restart) {
        rotateAgentEventLifecycleGeneration();
      }
      closeOpenClawAgentDatabasesForTest();
      const replay = await stage("request", capture, prepare);
      expect(replay.inputId).toBe(original.inputId);
      expect(replay.message).toEqual(original.message);
      expect(hookInputs).toEqual(["request"]);
      expect(
        replay.run(() => claimSessionPendingInputDedupeRecovery(sessionScope(), "request")),
      ).toBe(true);
      await promote(replay);
      expect(JSON.stringify(await loadTranscriptEvents(sessionScope()))).toContain(
        "Alice: background",
      );
      expect(JSON.stringify(await loadTranscriptEvents(sessionScope()))).toContain(
        "approved $current-request",
      );
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
    },
  );

  it.each([1, null])(
    "keeps uncertain history unavailable after pending-row deletion (submission fact: %s)",
    async (submissionStarted) => {
      await observe("background");
      const original = await stage("request", await observe("request"));
      original.beginSubmission();
      original.finish("interrupted");
      const db = database().db;
      if (submissionStarted === null) {
        db.prepare(
          "UPDATE conversation_history SET submission_started = NULL WHERE assigned_input_id = ?",
        ).run(original.inputId);
      }
      db.prepare("DELETE FROM session_pending_inputs WHERE input_id = ?").run(original.inputId);
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
      expect(
        db
          .prepare(
            "SELECT assigned_input_id, submission_started FROM conversation_history WHERE source_id = 'background'",
          )
          .get(),
      ).toEqual({
        assigned_input_id: null,
        submission_started: submissionStarted,
      });
    },
  );

  it.each(["cancelled", "interrupted"] as const)(
    "preserves uncertain submission through %s and restart",
    async (disposition) => {
      await observe("background");
      const capture = await observe("request");
      const original = await stage("request", capture);
      const attempt = original.beginSubmission();
      original.finish(disposition);
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      const next = await stage("next", await observe("next"));
      expect(next.message.content).toBe("next");
      await expect(stage("request", capture)).rejects.toThrow(
        disposition === "cancelled" ? "ownership ended" : "delivery is uncertain",
      );
      expect(() => attempt.rejectSubmission()).toThrow("ownership ended");
      expect(
        database()
          .db.prepare(
            "SELECT source_id, assigned_input_id, submission_started FROM conversation_history WHERE source_id IN ('background', 'request') ORDER BY seq",
          )
          .all(),
      ).toEqual([
        { source_id: "background", assigned_input_id: original.inputId, submission_started: 1 },
        { source_id: "request", assigned_input_id: original.inputId, submission_started: 1 },
      ]);
    },
  );

  it("retries definitive rejection without allowing an earlier attempt to reopen later submission", async () => {
    const capture = await observe("request");
    const original = await stage("request", capture);
    const rejected = original.beginSubmission();
    rejected.rejectSubmission();
    const active = original.beginSubmission();
    expect(() => rejected.rejectSubmission()).toThrow("closed submission attempt");
    active.rejectSubmission();
    original.finish("interrupted");
    rotateAgentEventLifecycleGeneration();
    const replay = await stage("request", capture);
    expect(replay.inputId).toBe(original.inputId);
    await promote(replay);
  });

  it("records provider submission once when a staged recorder has no local transcript adoption", async () => {
    await observe("background");
    const capture = await observe("request");
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "request", idempotencyKey: "request" },
      target: { ...sessionScope(), sessionEntry: undefined },
    });
    try {
      expect(
        await recorder.stageApproved?.({
          runId: "request",
          conversationHistory: capture,
          assertCurrent: () => {},
        }),
      ).toBe(true);
      recorder.markSentToProvider?.();
      recorder.markSentToProvider?.();
      expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
      recorder.finishPendingInput?.("interrupted");
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
      await expect(stage("request", capture)).rejects.toThrow("delivery is uncertain");
    } finally {
      recorder.finishPendingInput?.("interrupted");
    }
  });

  it.each(["capture", "adoption"] as const)(
    "rolls back %s with source custody intact",
    async (phase) => {
      await observe("background");
      const capture = await observe("request");
      const db = database().db;
      let receipt = phase === "adoption" ? await stage("request", capture) : undefined;
      const column = phase === "capture" ? "assigned_input_id" : "consumed_session_id";
      db.exec(
        `CREATE TEMP TRIGGER reject_history BEFORE UPDATE OF ${column} ON conversation_history BEGIN SELECT RAISE(ABORT, 'history write failed'); END`,
      );
      try {
        await expect(receipt ? promote(receipt) : stage("request", capture)).rejects.toThrow(
          "history write failed",
        );
      } finally {
        db.exec("DROP TRIGGER reject_history");
      }
      expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
      expect(listSessionPendingInputs(sessionScope()).total).toBe(phase === "capture" ? 0 : 1);
      receipt ??= await stage("request", capture);
      expect(receipt.message.content).toContain("Alice: background");
      await promote(receipt);
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
    },
  );

  it.each([false, true])(
    "retains consumed originals exactly while their transcript remains (archive: %s)",
    async (archiveTranscript) => {
      await observe("background");
      await promote(await stage("request", await observe("request")));
      await observe("unread");
      await deleteSessionEntryLifecycle({
        archiveTranscript,
        deleteTranscriptWithoutArchive: !archiveTranscript,
        storePath: fixture.storePath(),
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expect(
        database()
          .db.prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
          .get(sessionId),
      ).toBeUndefined();
      const retained = database()
        .db.prepare("SELECT source_id FROM conversation_history ORDER BY seq")
        .all();
      expect(retained).toEqual(
        (archiveTranscript ? ["background", "request", "unread"] : ["unread"]).map((source_id) => ({
          source_id,
        })),
      );
      await upsertSessionEntryCore(sessionScope(), { sessionId, updatedAt: 2 });
      expect((await stage("after-reset", await observe("after-reset"))).message.content).toContain(
        "Alice: unread",
      );
    },
  );

  it.each(["window", "archive"] as const)(
    "reconciles history after an older writer deletes its %s owner",
    async (owner) => {
      await observe("orphan-background");
      await promote(await stage("orphan-request", await observe("orphan-request")));
      if (owner === "archive") {
        await deleteSessionEntryLifecycle({
          archiveTranscript: true,
          storePath: fixture.storePath(),
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
      }
      const retainedScope = {
        ...scope(),
        sessionKey: "agent:main:retained",
        sessionId: "retained-session",
      };
      await upsertSessionEntryCore(retainedScope, {
        sessionId: retainedScope.sessionId,
        updatedAt: 2,
      });
      let pending: SessionPendingInputReceipt | undefined;
      for (const runId of ["retained-consumed", "retained-pending"]) {
        const receipt = await stageSessionPendingInput(retainedScope, {
          runId,
          message: input(runId),
          conversationHistory: await observe(runId, { text: runId }, "conv_retained"),
          assertCurrent: () => {},
        });
        if (!receipt) {
          throw new Error("Retained input was not admitted");
        }
        receipts.push(receipt);
        if (runId === "retained-consumed") {
          await receipt.run(() =>
            appendTranscriptMessage(retainedScope, { message: receipt.message }),
          );
        } else {
          pending = receipt;
          pending.finish("interrupted");
        }
      }
      await observe("unread");
      const filename = database().path;
      closeOpenClawAgentDatabasesForTest();
      const previous = new DatabaseSync(filename);
      try {
        previous.exec("PRAGMA foreign_keys = ON");
        // An older writer knows transcript owners but has no conversation-history deletion hook.
        previous.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(sessionKey);
        previous
          .prepare("DELETE FROM session_transcript_archives WHERE session_id = ?")
          .run(sessionId);
      } finally {
        previous.close();
      }
      await observe("after-upgrade");
      expect(
        database()
          .db.prepare(
            "SELECT source_id, assigned_input_id, consumed_session_id FROM conversation_history ORDER BY seq",
          )
          .all(),
      ).toEqual([
        {
          source_id: "retained-consumed",
          assigned_input_id: null,
          consumed_session_id: retainedScope.sessionId,
        },
        {
          source_id: "retained-pending",
          assigned_input_id: pending?.inputId,
          consumed_session_id: null,
        },
        { source_id: "unread", assigned_input_id: null, consumed_session_id: null },
        { source_id: "after-upgrade", assigned_input_id: null, consumed_session_id: null },
      ]);
    },
  );
});
