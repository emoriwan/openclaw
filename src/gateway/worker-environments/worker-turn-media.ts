import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { projectRuntimeContextFragments } from "../../agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { pruneProcessedHistoryImages } from "../../agents/embedded-agent-runner/run/history-image-prune.js";
import {
  detectAndLoadPromptImages,
  hydratePromptMediaMessages,
} from "../../agents/embedded-agent-runner/run/images.js";
import { resolveMediaFactLocalRef } from "../../agents/embedded-agent-runner/run/images.media-refs.js";
import {
  readPersistedMediaImageLayout,
  readPersistedImageBlockFactIndexes,
  type ImageFactIndex,
} from "../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resolveImageSanitizationLimits } from "../../agents/image-sanitization.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../agents/tool-fs-policy.js";
import { tempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { logWarn } from "../../logger.js";
import { readLocalMediaFile } from "../../media/local-media-access.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import {
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
  type MediaFact,
} from "../../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../../media/media-reference.js";
import {
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../../media/staged-inputs.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import {
  cloneImageContent,
  cloneTextContent,
  isWorkerTranscriptMessageFrameSafe,
} from "../../worker/transcript-message.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  MAX_RECONCILIATION_TOTAL_BYTES,
  MAX_RECONCILIATION_ENTRIES,
} from "./workspace-manifest.js";

function prepareInput(
  content: Extract<AgentMessage, { role: "user" }>["content"],
  media: MediaFact[],
  modelHasVision: boolean,
  imageFactIndexes?: readonly ImageFactIndex[],
) {
  // Factless replay bypasses hydration, so gate its raw image parts here too.
  const parts = (
    typeof content === "string" ? [{ type: "text" as const, text: content }] : content
  ).filter((part) => modelHasVision || part.type !== "image");
  const unownedImages = parts
    .filter((part) => part.type === "image")
    .filter((_image, index) => {
      const factIndex = imageFactIndexes?.[index];
      return factIndex == null || !resolveMediaFactLocalRef(media[factIndex]!);
    });
  return {
    parts,
    // Hydration suppression controls model reinjection, not source-file access for tools.
    media,
    unownedImages,
    files: new Set<string>(),
  };
}

/** Prepare transient worker input; canonical media paths and transcript bytes stay on the Gateway. */
export async function prepareWorkerTurnMedia(params: {
  turn: SessionPlacementTurnParams;
  history: AgentMessage[];
  workspace: WorkerSessionWorkspace;
  remoteWorkspaceDir: string;
  tunnel: WorkerTunnelHandle;
  isAuthorized: () => boolean;
  signal: AbortSignal;
}): Promise<{
  prompt: WorkerLaunchPlan["assignment"]["prompt"];
  systemPrompt: WorkerLaunchPlan["assignment"]["systemPrompt"];
  history: AgentMessage[];
  images: Awaited<ReturnType<typeof detectAndLoadPromptImages>>["images"];
  imageFactIndexes: Awaited<ReturnType<typeof detectAndLoadPromptImages>>["imageFactIndexes"];
}> {
  const { turn, signal } = params;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!params.isAuthorized()) {
      throw new Error("Worker media preparation lost its active placement or turn claim");
    }
  };
  assertCurrent();
  const recorded =
    turn.userTurnTranscriptRecorder?.message ??
    (await turn.userTurnTranscriptRecorder?.resolveMessage());
  assertCurrent();
  const recordedMedia = recorded ? readPersistedMediaFacts(recorded) : undefined;
  const runtimeMedia = recorded ? readRuntimePromptMediaFacts(recorded) : undefined;
  const media = recordedMedia?.length ? recordedMedia : (turn.media ?? []);
  const localWorkspace = params.workspace.kind === "local" ? params.workspace.path : undefined;
  const workspaceOnly = resolveEffectiveToolFsWorkspaceOnly({
    cfg: turn.config,
    agentId: turn.agentId,
  });
  // Repository sessions have no Gateway workspace root. An empty allowlist
  // still admits managed inbound media without exposing agent-scoped files.
  const localRoots = workspaceOnly
    ? localWorkspace
      ? [localWorkspace]
      : []
    : [
        ...getAgentScopedMediaLocalRoots(turn.config ?? {}, turn.agentId),
        ...(localWorkspace ? [localWorkspace] : []),
      ];
  const modelHasVision = turn.modelHasVision === true;
  const mediaOptions = {
    workspaceDir: localWorkspace ?? params.remoteWorkspaceDir,
    model: { input: modelHasVision ? ["text", "image"] : ["text"] },
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(turn.config).maxDimensionPx,
    localRoots,
  };
  const currentImages = await detectAndLoadPromptImages({
    ...mediaOptions,
    prompt: turn.prompt,
    existingImages: turn.images,
    imageOrder: turn.imageOrder,
    media: runtimeMedia ?? media,
    mediaImageLayout: recorded ? readPersistedMediaImageLayout(recorded) : undefined,
  });
  assertCurrent();
  if (currentImages.failedMediaCount) {
    throw new Error(
      `Cloud worker could not load ${currentImages.failedMediaCount} image attachment(s); resend the attachment and retry.`,
    );
  }
  const pruned = pruneProcessedHistoryImages(params.history) ?? params.history;
  const history = await hydratePromptMediaMessages(pruned, mediaOptions);
  assertCurrent();

  const current = prepareInput(
    [{ type: "text", text: turn.prompt }, ...currentImages.images],
    media,
    modelHasVision,
    currentImages.imageFactIndexes,
  );
  const replay = new Map(
    history.flatMap((message) =>
      message.role === "user"
        ? [
            [
              message,
              prepareInput(
                message.content,
                readPersistedMediaFacts(message) ?? [],
                modelHasVision,
                readPersistedImageBlockFactIndexes(message),
              ),
            ] as const,
          ]
        : [],
    ),
  );
  const inputs = [current, ...replay.values()];
  // Stable names preserve edits; the same projection is used for first input and replay.
  const projectedPaths = new Map<string, string | null>();
  let staging: Awaited<ReturnType<typeof tempWorkspace>> | undefined;
  try {
    let bytes = 0;
    const stagedPaths = new Set<string>();
    const stageFile = async (
      data: Buffer,
      identity: string,
      fileName: string,
      contextOnly = false,
    ) => {
      assertCurrent();
      const directory = stagedInputDirectory(identity);
      const relative = path.posix.join(directory, stagedInputFileName(fileName));
      const remotePath = path.posix.isAbsolute(params.remoteWorkspaceDir)
        ? path.posix.join(params.remoteWorkspaceDir, relative)
        : path.win32.join(params.remoteWorkspaceDir, ...relative.split("/"));
      if (stagedPaths.has(remotePath)) {
        return remotePath;
      }
      if (
        bytes + data.length > MAX_RECONCILIATION_TOTAL_BYTES ||
        stagedPaths.size >= MAX_RECONCILIATION_ENTRIES
      ) {
        if (contextOnly) {
          return null;
        }
        throw new Error(
          "Cloud worker attachments exceed the workspace transfer budget; send fewer or smaller files.",
        );
      }
      bytes += data.length;
      staging ??= await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "worker-attachments-",
      });
      const destination = path.join(staging.dir, ...relative.split("/"));
      assertCurrent();
      await ensureStagedInputDirectory(staging.dir, directory, signal);
      assertCurrent();
      await fs.writeFile(destination, data, { mode: 0o600, signal });
      stagedPaths.add(remotePath);
      return remotePath;
    };
    for (const contextOnly of [false, true]) {
      for (const input of inputs) {
        for (const image of contextOnly ? [] : input.unownedImages) {
          const data = Buffer.from(image.data, "base64");
          const identity = createHash("sha256").update(data).digest("hex");
          const remotePath = await stageFile(data, identity, "image");
          if (remotePath) {
            input.files.add(remotePath);
          }
        }
        for (const [factIndex, fact] of input.media.entries()) {
          if ((fact.contextOnly === true) !== contextOnly) {
            continue;
          }
          const ref = resolveMediaFactLocalRef(fact);
          if (!ref) {
            continue;
          }
          const runtimeFact = input === current ? runtimeMedia?.[factIndex] : undefined;
          const aliases = [
            ref.raw,
            ref.resolved,
            fact.path,
            fact.url,
            runtimeFact?.path,
            runtimeFact?.url,
          ];
          let remotePath = projectedPaths.get(ref.raw);
          if (remotePath === null) {
            if (input === current && fact.contextOnly !== true) {
              throw new Error(
                "Current attachment is unavailable; resend the attachment and retry.",
              );
            }
            continue;
          }
          if (!remotePath) {
            let source: string;
            let data: Buffer;
            try {
              source = path.resolve(
                fact.workspaceDir ?? localWorkspace ?? params.remoteWorkspaceDir,
                await resolveMediaReferenceLocalPath(ref.resolved),
              );
              assertCurrent();
              data = await readLocalMediaFile(source, localRoots, {
                maxBytes: Math.max(MAX_IMAGE_BYTES, MEDIA_MAX_BYTES),
              });
            } catch (error) {
              assertCurrent();
              if (input === current && fact.contextOnly !== true) {
                throw error;
              }
              // Retention can expire replay sources; only current input requires availability.
              // Keep authority checks and staging/transfer failures outside this omission policy.
              logWarn("worker-media: Omitted an unavailable historical attachment source");
              for (const alias of aliases) {
                if (alias) {
                  projectedPaths.set(alias, null);
                }
              }
              continue;
            }
            assertCurrent();
            const identity = createHash("sha256").update(source).digest("hex");
            remotePath = await stageFile(
              data,
              identity,
              path.basename(source),
              fact.contextOnly === true,
            );
            projectedPaths.set(source, remotePath);
          }
          for (const alias of aliases) {
            if (alias) {
              projectedPaths.set(alias, remotePath);
            }
          }
          if (remotePath) {
            input.files.add(remotePath);
          }
        }
      }
    }
    if (staging) {
      if (!params.tunnel.stageAttachments) {
        throw new Error(
          "Worker transport cannot stage attachments; update and reprovision the worker.",
        );
      }
      assertCurrent();
      await params.tunnel.stageAttachments({
        localPath: staging.dir,
        isAuthorized: params.isAuthorized,
        signal,
      });
    }
  } finally {
    await staging?.cleanup();
  }
  assertCurrent();
  const projectText = (text: string) => {
    let projected = text;
    for (const [source, destination] of projectedPaths) {
      projected = projected.replaceAll(
        source,
        destination ?? "[attachment unavailable; ask the sender to resend it]",
      );
    }
    return projected;
  };
  const context = turn.currentInboundContext;
  const contextFragments = (
    context?.fragments ??
    (context?.text ? [{ kind: "conversation-data" as const, text: context.text }] : [])
  ).map(({ kind, text }) => ({ kind, text: projectText(text) }));
  const contextText = contextFragments.map((fragment) => fragment.text).join("\n\n");
  const renderedContext = projectRuntimeContextFragments(contextFragments);
  const systemPrompt = renderedContext
    ? [turn.extraSystemPrompt, renderedContext].filter(Boolean).join("\n\n")
    : turn.extraSystemPrompt;
  const projectInput = (input: ReturnType<typeof prepareInput>) => {
    // Gateway bookkeeping is not part of the closed worker content contract.
    const parts = input.parts.map((part) =>
      part.type === "text"
        ? { ...cloneTextContent(part), text: projectText(part.text) }
        : cloneImageContent(part),
    );
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const notes = [...input.files]
      .filter((file) => !text.includes(file) && (input !== current || !contextText.includes(file)))
      .map((file) => `[media attached: ${file}]`)
      .join("\n");
    if (notes) {
      const index = parts.findIndex((part) => part.type === "text");
      const part = parts[index];
      if (part?.type === "text") {
        parts[index] = { ...part, text: [part.text, notes].filter(Boolean).join("\n") };
      } else {
        parts.unshift({ type: "text", text: notes });
      }
    }
    return parts;
  };
  const prompt = projectInput(current);
  if (
    !isWorkerTranscriptMessageFrameSafe({
      role: "user",
      content: [
        ...prompt,
        ...(renderedContext ? [{ type: "text" as const, text: renderedContext }] : []),
      ],
      timestamp: Date.now(),
    })
  ) {
    const userMessage =
      "This request and its unread conversation exceed the worker's 64 KiB text or 25 MiB image limit. " +
      "Use /new to start fresh without unread conversation; in a group, send it as a reply to this message. Then send a shorter request or smaller attachments.";
    throw new AgentHarnessPreflightError(userMessage, { userMessage });
  }
  return {
    systemPrompt,
    images: currentImages.images,
    imageFactIndexes: currentImages.imageFactIndexes,
    prompt: prompt.length === 1 && prompt[0]?.type === "text" ? prompt[0].text : prompt,
    history: history.map((message) => {
      const input = message.role === "user" ? replay.get(message) : undefined;
      return input ? Object.assign({}, message, { content: projectInput(input) }) : message;
    }),
  };
}
