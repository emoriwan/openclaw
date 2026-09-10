import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { buildHistoryContext } from "../../auto-reply/reply/history.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import type {
  ConversationHistoryCapture,
  ConversationHistoryMessage,
  PersistedUserTurnMessage,
} from "../../sessions/user-turn-input.types.js";
import {
  ensureConversationHistorySchema,
  hasConversationHistorySchema,
} from "../../state/openclaw-agent-conversation-history-schema.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import {
  readSessionPendingInputOwnerIds,
  runWithSessionPendingInput,
  type SessionPendingInputOwner,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";

export type {
  ConversationHistoryCapture,
  ConversationHistoryMessage,
} from "../../sessions/user-turn-input.types.js";

type HistoryDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;
type ConversationHistorySelection = {
  availableSequences: readonly number[];
  selectedSequences: readonly number[];
  recoveredInputIds: readonly string[];
};
const submissionAttempts = new WeakMap<SessionPendingInputOwner, object>();

/** Persist uncertainty before handoff; only this exact live attempt may undo a definitive rejection. */
export function beginConversationHistorySubmission(owner: SessionPendingInputOwner): {
  rejectSubmission: () => void;
} {
  const sources = owner.sources ?? [owner];
  const inputIds = sources.map((source) => source.inputId);
  const attempt = {};
  const tracked = runWithSessionPendingInput(owner, () =>
    runOpenClawAgentWriteTransaction((database) => {
      runWithSessionPendingInput(owner, () => {});
      if (!hasConversationHistorySchema(database.db)) {
        return false;
      }
      const db = getSessionKysely(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("conversation_history")
          .select("submission_started")
          .where("assigned_input_id", "in", inputIds)
          .where("consumed_session_id", "is", null),
      ).rows;
      if (!rows.length) {
        return false;
      }
      const pending = executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_pending_inputs").selectAll().where("input_id", "in", inputIds),
      ).rows;
      if (
        readSessionPendingInputOwnerIds(database, pending).size !== pending.length ||
        pending.some((row) => row.state !== "queued") ||
        rows.some((row) => row.submission_started !== 0)
      ) {
        throw new Error("Pending input submission is already started or its custody ended");
      }
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("conversation_history")
          .set({ submission_started: 1 })
          .where("assigned_input_id", "in", inputIds)
          .where("consumed_session_id", "is", null),
      );
      return true;
    }, owner.databaseOptions),
  );
  if (!tracked) {
    return { rejectSubmission: () => {} };
  }
  for (const source of sources) {
    submissionAttempts.set(source, attempt);
  }
  return {
    rejectSubmission: () =>
      runWithSessionPendingInput(owner, () => {
        if (sources.some((source) => submissionAttempts.get(source) !== attempt)) {
          throw new Error("Pending input rejection belongs to a closed submission attempt");
        }
        runOpenClawAgentWriteTransaction((database) => {
          runWithSessionPendingInput(owner, () => {});
          const pending = executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_pending_inputs")
              .selectAll()
              .where("input_id", "in", inputIds),
          ).rows;
          if (
            readSessionPendingInputOwnerIds(database, pending).size !== pending.length ||
            pending.some((row) => row.state !== "queued")
          ) {
            throw new Error("Pending input rejection cannot reopen ended custody");
          }
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .updateTable("conversation_history")
              .set({ submission_started: 0 })
              .where("assigned_input_id", "in", inputIds)
              .where("consumed_session_id", "is", null)
              .where("submission_started", "=", 1),
          );
        }, owner.databaseOptions);
        for (const source of sources) {
          submissionAttempts.delete(source);
        }
      }),
  };
}

/** Room observation owns no session generation and never admits an agent turn. */
export async function recordConversationObservationCore(
  scope: { agentId: string; storePath?: string },
  observation: { conversationRef: string; sourceId: string; message: ConversationHistoryMessage },
): Promise<ConversationHistoryCapture> {
  const resolved = resolveSqliteReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const messageJson = JSON.stringify(observation.message);
  return withSqliteSessionDatabase(databaseOptions, (database) => {
    ensureConversationHistorySchema(database.db);
    return runOpenClawAgentWriteTransaction((current) => {
      const db = getSessionKysely(current.db);
      executeSqliteQuerySync(
        current.db,
        db
          .insertInto("conversation_history")
          .values({
            agent_id: resolved.agentId,
            conversation_ref: observation.conversationRef,
            source_id: observation.sourceId,
            message_json: messageJson,
            submission_started: 0,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "conversation_ref", "source_id"]).doNothing(),
          ),
      );
      const row = executeSqliteQueryTakeFirstSync(
        current.db,
        db
          .selectFrom("conversation_history")
          .select("seq")
          .where("agent_id", "=", resolved.agentId)
          .where("conversation_ref", "=", observation.conversationRef)
          .where("source_id", "=", observation.sourceId),
      );
      if (!row) {
        throw new Error("Conversation observation was not recorded");
      }
      return {
        owner: { agentId: resolved.agentId, databasePath: database.path },
        conversationRef: observation.conversationRef,
        throughSequence: row.seq,
        requestSourceIds: [observation.sourceId],
      };
    }, databaseOptions);
  });
}

/** Download completion enriches only its original observation, never a captured or reset input. */
export async function enrichConversationObservationMediaCore(
  capture: ConversationHistoryCapture,
  sourceId: string,
  media: NonNullable<ConversationHistoryMessage["media"]>,
): Promise<void> {
  if (!capture.requestSourceIds.includes(sourceId)) {
    throw new Error("Attachment source does not belong to this conversation observation");
  }
  const options = toDatabaseOptions(
    resolveSqliteReadScope({
      agentId: capture.owner.agentId,
      storePath: capture.owner.databasePath,
    }),
  );
  await withSqliteSessionDatabase(options, () =>
    runOpenClawAgentWriteTransaction((current) => {
      const query = getSessionKysely(current.db)
        .selectFrom("conversation_history")
        .selectAll()
        .where("agent_id", "=", capture.owner.agentId)
        .where("conversation_ref", "=", capture.conversationRef)
        .where("source_id", "=", sourceId)
        .where("seq", "<=", capture.throughSequence);
      const row = executeSqliteQueryTakeFirstSync(current.db, query);
      // Native redelivery must reuse the already admitted bytes. A reset must
      // not resurrect an observation whose download was still in flight.
      if (
        !row ||
        row.assigned_input_id !== null ||
        row.consumed_session_id !== null ||
        row.submission_started !== 0
      ) {
        return;
      }
      // SAFETY: Observation intake owns this JSON; enrichment preserves its source fields.
      const original = JSON.parse(row.message_json) as ConversationHistoryMessage;
      if (original.media?.some((entry) => entry.path || entry.url)) {
        // Redelivery may download another copy; keep the first source fingerprint stable.
        return;
      }
      executeSqliteQuerySync(
        current.db,
        getSessionKysely(current.db)
          .updateTable("conversation_history")
          .set({ message_json: JSON.stringify({ ...original, media }) })
          .where("seq", "=", row.seq),
      );
    }, options),
  );
}

/** Session reset and unread retirement commit together; active submissions keep their evidence. */
export function resetConversationHistory(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
): void {
  if (database.path !== capture.owner.databasePath) {
    throw new Error("Conversation observation owner changed before reset");
  }
  if (!hasConversationHistorySchema(database.db)) {
    return;
  }
  const db = getSessionKysely(database.db);
  const unread = db
    .selectFrom("conversation_history")
    .where("agent_id", "=", capture.owner.agentId)
    .where("conversation_ref", "=", capture.conversationRef)
    .where("seq", "<=", capture.throughSequence)
    .where("consumed_session_id", "is", null);
  const claimed = executeSqliteQueryTakeFirstSync(
    database.db,
    unread
      .select("seq")
      .where((eb) =>
        eb.or([
          eb("assigned_input_id", "is not", null),
          eb("submission_started", "!=", 0),
          eb("submission_started", "is", null),
        ]),
      ),
  );
  if (claimed) {
    throw new AgentHarnessPreflightError("Conversation history has an unfinished submission", {
      userMessage:
        "A previous request still owns some conversation history. Wait for or cancel an active request; if delivery is uncertain, inspect that request before resetting. Its history has been kept.",
    });
  }
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("conversation_history")
      .where("agent_id", "=", capture.owner.agentId)
      .where("conversation_ref", "=", capture.conversationRef)
      .where("seq", "<=", capture.throughSequence)
      .where("source_id", "not in", [...capture.requestSourceIds])
      .where("consumed_session_id", "is", null),
  );
}

/** Bind replay to the complete native request, not its later model-prompt projection. */
export function fingerprintConversationHistoryRequest(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
): string {
  const sourceIds = [...new Set(capture.requestSourceIds)];
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("conversation_history")
      .select(["source_id", "message_json"])
      .where("agent_id", "=", capture.owner.agentId)
      .where("conversation_ref", "=", capture.conversationRef)
      .where("source_id", "in", sourceIds)
      .where("seq", "<=", capture.throughSequence)
      .orderBy("seq", "asc"),
  ).rows;
  if (!sourceIds.length || rows.length !== sourceIds.length) {
    throw new Error("Native request source is unavailable for durable admission");
  }
  return createHash("sha256")
    .update(
      stableStringify({
        agentId: capture.owner.agentId,
        conversationRef: capture.conversationRef,
        sources: rows.map((row) => ({
          sourceId: row.source_id,
          message: JSON.parse(row.message_json),
        })),
      }),
    )
    .digest("hex");
}

export function isConversationHistoryInputUnsubmitted(
  database: HistoryDatabase,
  inputId: string,
): boolean {
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("conversation_history")
      .select("submission_started")
      .where("assigned_input_id", "=", inputId)
      .where("consumed_session_id", "is", null),
  ).rows;
  return rows.length > 0 && rows.every((row) => row.submission_started === 0);
}

function recoverableHistoryInputIds(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
): string[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("conversation_history")
            .select("seq")
            .whereRef("assigned_input_id", "=", "session_pending_inputs.input_id")
            .where("agent_id", "=", capture.owner.agentId)
            .where("conversation_ref", "=", capture.conversationRef)
            .where("seq", "<=", capture.throughSequence)
            .where("consumed_session_id", "is", null)
            .where("submission_started", "=", 0)
            .where("assigned_input_id", "is not", null),
        ),
      )
      .where("consumed_event_id", "is", null)
      .where("state", "in", ["queued", "interrupted"])
      .where("lifecycle_generation", "!=", getAgentEventLifecycleGeneration()),
  ).rows;
  const owned = readSessionPendingInputOwnerIds(database, rows);
  return rows
    .filter(
      (row) =>
        !owned.has(row.input_id) && isConversationHistoryInputUnsubmitted(database, row.input_id),
    )
    .map((row) => row.input_id);
}

function unreadHistory(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
  recoverableInputIds: readonly string[] = [],
) {
  return getSessionKysely(database.db)
    .selectFrom("conversation_history")
    .where("agent_id", "=", capture.owner.agentId)
    .where("conversation_ref", "=", capture.conversationRef)
    .where("seq", "<=", capture.throughSequence)
    .where("submission_started", "=", 0)
    .where((eb) =>
      recoverableInputIds.length
        ? eb.or([
            eb("assigned_input_id", "is", null),
            eb("assigned_input_id", "in", [...recoverableInputIds]),
          ])
        : eb("assigned_input_id", "is", null),
    )
    .where("consumed_session_id", "is", null);
}

/** Prepare complete context before hooks; the insertion transaction rechecks the captured range. */
export async function prepareConversationHistoryInput(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
): Promise<{
  historyText: string;
  backgroundMedia: NonNullable<ConversationHistoryMessage["media"]>;
  selection: ConversationHistorySelection;
}> {
  const recoveredInputIds = recoverableHistoryInputIds(database, capture);
  const rows = executeSqliteQuerySync(
    database.db,
    unreadHistory(database, capture, recoveredInputIds).selectAll().orderBy("seq", "asc"),
  ).rows;
  const sourceIds = new Set(rows.map((row) => row.source_id));
  if (
    capture.requestSourceIds.length === 0 ||
    capture.requestSourceIds.some((sourceId) => !sourceIds.has(sourceId))
  ) {
    throw new Error("Conversation request was already captured or its source is unavailable");
  }
  const requestIds = new Set(capture.requestSourceIds);
  const selectedSequences: number[] = [];
  const background: ConversationHistoryMessage[] = [];
  for (const row of rows) {
    // SAFETY: Only typed observation intake writes this JSON; native facts remain data, never authority.
    const input = JSON.parse(row.message_json) as ConversationHistoryMessage;
    if (requestIds.has(row.source_id)) {
      selectedSequences.push(row.seq);
    } else if (!capture.includeMessage || (await capture.includeMessage(input))) {
      selectedSequences.push(row.seq);
      background.push(input);
    }
  }
  const selection = {
    availableSequences: rows.map((row) => row.seq),
    selectedSequences,
    recoveredInputIds,
  };
  const visibleMessageIds = new Set(
    background.flatMap((input) => (input.transport?.messageId ? [input.transport.messageId] : [])),
  );
  const historyLines: string[] = [];
  for (const input of background) {
    const sender = input.sender?.name ?? input.sender?.username ?? input.sender?.id;
    const native = [
      ...(input.transport?.messageId ? [`message ${input.transport.messageId}`] : []),
      ...(input.transport?.replyToId ? [`reply to ${input.transport.replyToId}`] : []),
    ];
    const timestamp =
      input.timestamp === undefined ? "" : `[${new Date(input.timestamp).toISOString()}] `;
    const lines = [
      `${timestamp}${native.length ? `[${native.join("; ")}] ` : ""}${sender ? `${sender}: ` : ""}${input.text ?? ""}`,
    ];
    const quote = input.replyTo;
    if (
      quote &&
      (!quote.messageId || !visibleMessageIds.has(quote.messageId)) &&
      (!capture.includeMessage || (await capture.includeMessage(quote, "quote")))
    ) {
      const quoteSender = quote.sender?.name ?? quote.sender?.username ?? quote.sender?.id;
      lines.push(
        `[Reply target${quote.messageId ? ` ${quote.messageId}` : ""}${quoteSender ? ` from ${quoteSender}` : ""}: ${JSON.stringify(quote.text ?? "")}]`,
      );
    }
    for (const media of input.media ?? []) {
      const reference = media.path ?? media.url;
      const attachment = JSON.stringify(media.fileName ?? media.kind ?? "file");
      lines.push(
        reference
          ? `[Attachment: ${attachment}; reference: ${reference}]`
          : `[Attachment: ${attachment}; unavailable; ask the sender to resend it]`,
      );
    }
    historyLines.push(lines.join("\n"));
  }
  const historyText = historyLines.join("\n");
  const backgroundMedia = background.flatMap((input) => input.media ?? []);
  // These decoded facts belong to this capture; saved source messages remain unchanged.
  for (const media of backgroundMedia) {
    media.hydrationSuppressed = true;
    media.contextOnly = true;
  }
  return {
    selection,
    historyText,
    backgroundMedia,
  };
}

/** Reapply selected context after the current request's write hooks have completed. */
export function projectConversationHistoryInput(
  message: PersistedUserTurnMessage,
  historyText: string,
  backgroundMedia: NonNullable<ConversationHistoryMessage["media"]>,
): PersistedUserTurnMessage {
  if (!historyText) {
    return message;
  }
  const framed = buildHistoryContext({
    historyText,
    currentMessage: typeof message.content === "string" ? message.content : "",
    historyMarker: "[Earlier chat messages - for context]",
  });
  return {
    ...message,
    __openclaw: {
      ...message["__openclaw"],
      observedInput: { context: historyText, request: message.content },
      ...(backgroundMedia.length
        ? { media: [...(readPersistedMediaFacts(message) ?? []), ...backgroundMedia] }
        : {}),
    },
    content:
      typeof message.content === "string"
        ? framed
        : [{ type: "text", text: framed }, ...message.content],
  };
}

/** Called with pending-input insertion so a failed capture leaves both owners unchanged. */
export function assignConversationHistoryInput(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
  selection: ConversationHistorySelection,
  inputId: string,
): void {
  if (selection.recoveredInputIds.length) {
    const recoverable = new Set(recoverableHistoryInputIds(database, capture));
    if (selection.recoveredInputIds.some((id) => !recoverable.has(id))) {
      throw new Error("Interrupted conversation input custody changed before recovery");
    }
    // Transfer old-generation context only with terminal cancellation of its former
    // request. Otherwise a later native retry could replay the same captured range.
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ state: "cancelled" })
        .where("input_id", "in", [...selection.recoveredInputIds]),
    );
    for (const recoveredInputId of selection.recoveredInputIds) {
      releaseCancelledConversationHistoryInput(database, recoveredInputId);
    }
  }
  const current = executeSqliteQuerySync(
    database.db,
    unreadHistory(database, capture).select("seq").orderBy("seq", "asc"),
  ).rows;
  if (
    current.length !== selection.availableSequences.length ||
    current.some((row, index) => row.seq !== selection.availableSequences[index])
  ) {
    throw new Error(
      "Conversation history changed before input admission; submit the request again",
    );
  }
  // Match transcript lookups' 500-key batches below SQLite's 999-variable floor.
  // Every batch remains in the pending-input transaction; none commits alone.
  for (const sequences of chunkItems(selection.selectedSequences, 500)) {
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("conversation_history")
        .set({ assigned_input_id: inputId, submission_started: 0 })
        .where("agent_id", "=", capture.owner.agentId)
        .where("conversation_ref", "=", capture.conversationRef)
        .where("seq", "in", sequences)
        .where("assigned_input_id", "is", null)
        .where("consumed_session_id", "is", null),
    );
  }
}

export function releaseCancelledConversationHistoryInput(
  database: HistoryDatabase,
  inputId: string,
): void {
  if (!hasConversationHistorySchema(database.db)) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .updateTable("conversation_history")
      .set({ assigned_input_id: null })
      .where("assigned_input_id", "=", inputId)
      .where("consumed_session_id", "is", null)
      .where("submission_started", "=", 0),
  );
}

/** Archive publication replaces a window; only removal of both owners ends source retention. */
export function pruneConsumedConversationHistory(
  database: HistoryDatabase,
  sessionId: string,
): void {
  if (!hasConversationHistorySchema(database.db)) {
    return;
  }
  const db = getSessionKysely(database.db);
  const window = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_id", "=", sessionId),
  );
  if (window) {
    return;
  }
  const archiveTable = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("sqlite_schema").select("name").where("name", "=", "session_transcript_archives"),
  );
  if (
    archiveTable &&
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .limit(1),
    )
  ) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("conversation_history").where("consumed_session_id", "=", sessionId),
  );
}
