import { expectDefined } from "@openclaw/normalization-core";
import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type {
  CurrentInboundPromptContext,
  RuntimeContextFragment,
} from "../../agents/internal-runtime-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  attachRuntimePromptMediaFacts,
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";
import type { ConversationHistoryCapture } from "../../sessions/user-turn-input.types.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { FinalizedRuntimeMsgContext, RuntimeMsgContext } from "../templating.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

const OBSERVED_REPLY_INPUT = Symbol("observed-reply-input");

export type ObservedReplyInputOwner = {
  readonly recorder: UserTurnTranscriptRecorder | undefined;
  readonly contextFragments: RuntimeContextFragment[];
  prepare: (params: {
    recorder: UserTurnTranscriptRecorder;
    runId: string;
    assertCurrent: () => void;
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    workspaceDir: string;
    abortSignal?: AbortSignal;
  }) => Promise<string | undefined>;
  transferToQueue: () => void;
  finish: (disposition?: "cancelled" | "interrupted") => void;
};

type ObservedReplyOptions = GetReplyOptions & {
  [OBSERVED_REPLY_INPUT]?: ObservedReplyInputOwner;
};

export function readObservedReplyInputOwner(
  options?: GetReplyOptions,
): ObservedReplyInputOwner | undefined {
  // SAFETY: This module alone attaches the owner under its private symbol.
  return (options as ObservedReplyOptions | undefined)?.[OBSERVED_REPLY_INPUT];
}

/** Dispatch owns input until a queue explicitly accepts it, including every early return. */
export async function withObservedReplyInputOwner<T>(
  capture: ConversationHistoryCapture | undefined,
  options: GetReplyOptions | undefined,
  run: (options: GetReplyOptions | undefined) => Promise<T>,
): Promise<T> {
  if (!capture || readObservedReplyInputOwner(options)) {
    return await run(options);
  }
  let recorder: UserTurnTranscriptRecorder | undefined;
  let contextFragments: RuntimeContextFragment[] = [];
  let transferred = false;
  let finished = false;
  const owner: ObservedReplyInputOwner = {
    get contextFragments() {
      return contextFragments;
    },
    get recorder() {
      return recorder;
    },
    async prepare(params) {
      if (finished || (recorder && recorder !== params.recorder)) {
        throw new Error("Observed input no longer belongs to this dispatch");
      }
      recorder = params.recorder;
      const stage = expectDefined(recorder.stageApproved, "observed input staging");
      const staged = await stage.call(recorder, {
        runId: params.runId,
        assertCurrent: params.assertCurrent,
        conversationHistory: capture,
      });
      params.assertCurrent();
      if (!staged) {
        return undefined;
      }
      const message = expectDefined(recorder.getPendingInputMessage?.(), "observed input message");
      const prompt =
        extractTextFromChatContent(
          message["__openclaw"]?.observedInput?.request ?? message.content,
          {
            normalizeText: (text) => text,
            joinWith: "\n",
          },
        ) ?? "";
      const media = readPersistedMediaFacts(message) ?? [];
      const background = media.filter((fact) => fact.contextOnly === true);
      if (background.length && !readRuntimePromptMediaFacts(message)) {
        const { stageSandboxMedia } = await import("./stage-sandbox-media.js");
        params.assertCurrent();
        const temporaryContext: RuntimeMsgContext = { media: background };
        await stageSandboxMedia({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          abortSignal: params.abortSignal,
          ctx: temporaryContext,
          sessionCtx: temporaryContext,
        });
        params.assertCurrent();
        let backgroundIndex = 0;
        attachRuntimePromptMediaFacts(
          message,
          media.map((fact) =>
            fact.contextOnly ? (temporaryContext.media ?? background)[backgroundIndex++]! : fact,
          ),
        );
      }
      const observed = message["__openclaw"]?.observedInput;
      contextFragments = observed
        ? [
            {
              kind: "conversation-data",
              text: projectObservedReplyMedia(
                message,
                `[Earlier chat messages - for context]\n${observed.context}`,
              ),
            },
          ]
        : [];
      return projectObservedReplyMedia(message, prompt);
    },
    transferToQueue() {
      if (finished) {
        throw new Error("Observed input completed before queue admission");
      }
      transferred = true;
    },
    finish(disposition = "cancelled") {
      if (finished) {
        return;
      }
      finished = true;
      // The receipt's submission fact preserves uncertain input; this owner never guesses delivery.
      recorder?.finishPendingInput?.(disposition);
    },
  };
  const ownedOptions: ObservedReplyOptions = { ...options, [OBSERVED_REPLY_INPUT]: owner };
  let disposition: "cancelled" | "interrupted" = "interrupted";
  try {
    const result = await run(ownedOptions);
    disposition = "cancelled";
    return result;
  } finally {
    if (!transferred) {
      owner.finish(disposition);
    }
  }
}

/** Runtime file locations never replace canonical observed-message text or media facts. */
export function projectObservedReplyMedia(
  message: PersistedUserTurnMessage,
  prompt: string,
): string {
  const runtimeMedia = readRuntimePromptMediaFacts(message);
  if (!runtimeMedia) {
    return prompt;
  }
  let projected = prompt;
  for (const [index, fact] of (readPersistedMediaFacts(message) ?? []).entries()) {
    if (!fact.contextOnly) {
      continue;
    }
    const runtimeFact = runtimeMedia[index];
    const destination = runtimeFact?.staged
      ? runtimeFact.path!
      : "[attachment unavailable; ask the sender to resend it]";
    for (const source of [fact.path, fact.url]) {
      if (source) {
        projected = projected.replaceAll(source, destination);
      }
    }
  }
  return projected;
}

/** Bound handlers receive the same captured input and recorder as the normal agent path. */
export async function prepareObservedReplyTakeover(
  state: {
    ctx: FinalizedRuntimeMsgContext;
    cfg: OpenClawConfig;
    workspaceDir: string;
    getPreDispatchAbortSignal: () => AbortSignal | undefined;
    replaceDispatchAgentText: (text: string, context?: CurrentInboundPromptContext) => void;
    params: { replyOptions?: GetReplyOptions };
  },
  targetSessionKey: string | undefined,
): Promise<boolean> {
  const owner = readObservedReplyInputOwner(state.params.replyOptions);
  if (!owner) {
    return true;
  }
  const key = expectDefined(targetSessionKey, "observed reply target session");
  const [{ resolveSessionStoreLookup }, { createUserTurnTranscriptRecorder }, sender, hooks] =
    await Promise.all([
      import("./dispatch-from-config.context.js"),
      import("../../sessions/user-turn-transcript.js"),
      import("../../sessions/user-turn-transcript.metadata.js"),
      import("../../agents/harness/hook-helpers.js"),
    ]);
  const target = resolveSessionStoreLookup(
    {
      ...state.ctx,
      SessionKey: key,
      CommandTargetSessionKey: undefined,
    },
    state.cfg,
  );
  const entry = expectDefined(target.entry, "observed reply target entry");
  const runId = expectDefined(readChannelSourceTurnId(state.ctx), "observed reply source identity");
  const recorder =
    owner.recorder ??
    state.params.replyOptions?.userTurnTranscriptRecorder ??
    createUserTurnTranscriptRecorder({
      input: {
        text: state.ctx.agentText,
        idempotencyKey: runId,
        timestamp: state.ctx.Timestamp,
        sender: sender.buildChannelUserTurnSender(state.ctx),
        provenance: state.ctx.InputProvenance,
        media: state.ctx.media,
        transport: {
          channel: state.ctx.OriginatingChannel ?? state.ctx.Provider,
          conversationRef: state.ctx.ConversationHistory?.conversationRef,
          messageId: state.ctx.MessageSidFull ?? state.ctx.MessageSid,
          replyToId: state.ctx.ReplyToIdFull ?? state.ctx.ReplyToId,
          threadId: state.ctx.MessageThreadId?.toString(),
        },
      },
      target: {
        agentId: expectDefined(target.agentId, "observed reply target agent"),
        sessionKey: key,
        sessionId: entry.sessionId,
        expectedSessionId: entry.sessionId,
        sessionEntry: entry,
        sessionStore: target.store,
        storePath: target.storePath,
        cwd: state.workspaceDir,
        config: state.cfg,
      },
      beforeMessageWrite: hooks.runAgentHarnessBeforeMessageWriteHook,
      errorContext: "observed reply input",
    });
  const prompt = await owner.prepare({
    recorder,
    runId,
    assertCurrent: () => state.getPreDispatchAbortSignal()?.throwIfAborted(),
    cfg: state.cfg,
    agentId: expectDefined(target.agentId, "observed reply target agent"),
    sessionKey: key,
    workspaceDir: state.workspaceDir,
    abortSignal: state.getPreDispatchAbortSignal(),
  });
  if (prompt === undefined) {
    return false;
  }
  // Keep the options object held by the dispatch coordinator; replacing it would split ownership.
  state.params.replyOptions ??= {};
  state.params.replyOptions.userTurnTranscriptRecorder = recorder;
  state.replaceDispatchAgentText(
    prompt,
    owner.contextFragments.length
      ? appendCurrentInboundContext(undefined, owner.contextFragments)
      : undefined,
  );
  return true;
}
