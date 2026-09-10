import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB } from "./openclaw-agent-db.generated.js";
import { ensureSessionPendingInputsSchema } from "./openclaw-agent-pending-inputs-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export const CONVERSATION_HISTORY_TABLE = "conversation_history";
const ensuredDatabases = new WeakSet<DatabaseSync>();

export function hasConversationHistorySchema(db: DatabaseSync): boolean {
  return ensuredDatabases.has(db) || tableExists(db, CONVERSATION_HISTORY_TABLE);
}

/** First observation installs history; a rolled-back ensure never warms the connection cache. */
export function ensureConversationHistorySchema(db: DatabaseSync): void {
  if (ensuredDatabases.has(db)) {
    return;
  }
  ensureSessionPendingInputsSchema(db);
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_HISTORY_TABLE} (`,
  );
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS session_pending_inputs (",
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error("OpenClaw conversation history schema markers are missing.");
  }
  const nested = db.isTransaction;
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end)); // sqlite-allow-raw -- Canonical additive DDL only.
    // Older compatible writers have no history cleanup hooks. Reconcile once per
    // connection, preserving unread custody and every retained transcript owner.
    const query = getNodeSqliteKysely<DB>(db);
    let orphans = query
      .deleteFrom("conversation_history")
      .where("consumed_session_id", "is not", null)
      .where("assigned_input_id", "is", null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("session_windows")
              .select("session_id")
              .whereRef("session_id", "=", "conversation_history.consumed_session_id"),
          ),
        ),
      );
    if (tableExists(db, "session_transcript_archives")) {
      orphans = orphans.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("session_transcript_archives")
              .select("session_id")
              .whereRef("session_id", "=", "conversation_history.consumed_session_id"),
          ),
        ),
      );
    }
    executeSqliteQuerySync(db, orphans);
  });
  if (!nested) {
    ensuredDatabases.add(db);
  }
}
