// User input facts shared by transcript recording and observed conversation history.
import type { HumanMention } from "@openclaw/gateway-protocol";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { TranscriptSenderIdentity } from "../chat/sender-identity.js";
import type { MediaFactInput } from "../media/media-facts.js";
import type { InputProvenance } from "./input-provenance.js";

export type PersistedUserTurnMediaInput = Pick<
  MediaFactInput,
  | "contentType"
  | "contextOnly"
  | "durationMs"
  | "fileName"
  | "height"
  | "hydrationSuppressed"
  | "messageId"
  | "path"
  | "sizeBytes"
  | "transcribed"
  | "url"
  | "width"
> & {
  kind?: string | null;
  workspaceDir?: string | null;
};

export type PersistedUserTurnMessage = Extract<AgentMessage, { role: "user" }> & {
  display?: false;
  excludeFromContext?: true;
  /** Private transcript correlation; never authorizes an execution. */
  idempotencyKey?: string;
  provenance?: InputProvenance;
  __openclaw?: Record<string, unknown> & {
    humanMentions?: readonly HumanMention[];
    observedInput?: {
      context: string;
      request: Extract<AgentMessage, { role: "user" }>["content"];
    };
  };
};

export type UserTurnInput = Pick<PersistedUserTurnMessage, "display" | "excludeFromContext"> & {
  text?: string | null;
  /** Explicit human selections bound to UTF-16 offsets in text. */
  mentions?: readonly HumanMention[];
  media?: readonly PersistedUserTurnMediaInput[] | null;
  /** Restart-safe native image placement; model-visible prompt bytes remain separate. */
  mediaImageLayout?: {
    slots: readonly {
      kind: "inline" | "offloaded";
      factIndex?: number;
    }[];
    suppressedFactIndexes?: readonly number[];
  } | null;
  timestamp?: number;
  idempotencyKey?: string;
  /** Durable transcript message reference used to render and hydrate replies. */
  replyToId?: string;
  /** Bounded display fallback for replies whose target is outside loaded history. */
  replyToPreview?: { text: string; senderLabel?: string | null } | null;
  senderIsOwner?: boolean;
  provenance?: InputProvenance;
  /** Identity is producer-owned attribution; labels remain editable display metadata. */
  sender?: {
    id?: string | null;
    name?: string | null;
    username?: string | null;
    identity?: TranscriptSenderIdentity;
  } | null;
  /** Durable transport correlation; stored privately and never rendered into model input. */
  transport?: {
    channel?: string;
    conversationRef?: string;
    messageId?: string;
    replyToId?: string;
    threadId?: string;
  };
};

export type ConversationHistoryCapture = {
  owner: { agentId: string; databasePath: string };
  conversationRef: string;
  throughSequence: number;
  requestSourceIds: readonly string[];
  includeMessage?: (
    message: ConversationHistoryMessage,
    kind?: "history" | "quote",
  ) => boolean | Promise<boolean>;
};

export type ConversationHistoryMessage = UserTurnInput & {
  senderRoles?: readonly string[];
  replyTo?: Pick<UserTurnInput, "text" | "timestamp" | "sender"> & {
    messageId?: string;
    senderRoles?: readonly string[];
  };
};
