import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
} from "../../../test/helpers/image-fixtures.js";
import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  readObservedReplyInputOwner,
  withObservedReplyInputOwner,
} from "../../auto-reply/reply/observed-reply-input.js";
import { recordConversationObservationCore } from "../../config/sessions/conversation-history.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../../config/sessions/session-accessor.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import * as rootLogger from "../../logger.js";
import * as localMediaAccess from "../../media/local-media-access.js";
import {
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
  type MediaFact,
} from "../../media/media-facts.js";
import * as mediaReferences from "../../media/media-reference.js";
import { cleanOldMedia, saveMediaBuffer } from "../../media/store.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";

function harness() {
  const launches: WorkerLaunchPlan[] = [];
  const remoteFiles = new Map<string, Buffer>();
  const environment = attachedEnvironment();
  const tunnel: WorkerTurnTunnelHandle = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand: vi.fn(),
    syncWorkspace: vi.fn(async () => {
      throw new Error("must not resync active workspace");
    }),
    stageAttachments: vi.fn(async (request) => {
      expect(request.isAuthorized()).toBe(true);
      for (const file of await fs.readdir(request.localPath, { recursive: true })) {
        const source = path.join(request.localPath, file);
        if ((await fs.stat(source)).isFile()) {
          if (!remoteFiles.has(file)) {
            remoteFiles.set(file, await fs.readFile(source));
          }
        }
      }
    }),
    quiesceWorkspace: vi.fn(async () => ({ assertActive: async () => {}, resume: async () => {} })),
    reconcileWorkspace: vi.fn(async (request) => {
      if (request.source.kind !== "local") {
        throw new Error("expected a local workspace source");
      }
      request.source.journal.commit(MANIFEST_REF);
      return {
        manifestRef: MANIFEST_REF,
        changed: false,
        verifyStable: async () => {},
        verifyLocalStable: async () => {},
      };
    }),
    stop: vi.fn(async () => {}),
    measureLaunchTurn,
    launchTurn: vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      launches.push(structuredClone(request.plan));
      request.onDispatchReady?.();
      const leaf = openSessionManager().appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "image received" }],
          timestamp: Date.now(),
        }),
      );
      const seq = request.plan.assignment.transcript.nextSeq;
      createWorkerSessionPlacementGate(placements).updateAckCursors({
        claim: request.turnClaim,
        transcriptSeq: seq,
        liveSeq: request.plan.assignment.liveEvents.nextSeq,
      });
      return {
        stdout: JSON.stringify({
          status: "completed",
          transcriptLeafId: leaf,
          transcriptNextSeq: seq + 1,
        }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    }),
  };
  const provider = createWorkerSessionTurnPlacementProvider({
    placements,
    environments: {
      get: () => environment,
      acquireTurnCredential: async () => credential(),
      acknowledgeCredentialDelivery: () => true,
      startTunnel: async () => tunnel,
      stopTunnel: async () => {},
      destroy: async () => environment,
    },
  });
  const runLocal = vi.fn(async () => ({ meta: { durationMs: 0 } }));
  const execute = async (input: Parameters<typeof provider.executeTurn>[1]) =>
    await provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: input.runId },
      input,
      runLocal,
    );
  const inputFiles = () =>
    new Map([...remoteFiles].filter(([file]) => path.basename(file) !== ".gitignore"));
  return { launches, remoteFiles, inputFiles, tunnel, environment, execute, runLocal };
}

describe("cloud turn media boundary", () => {
  beforeEach(setupWorkerTurnLauncherTest);

  it("reserves the aggregate transfer budget for current files before background history", async () => {
    seedActivePlacement();
    const rig = harness();
    const current = await saveMediaBuffer(
      Buffer.from("required current file"),
      "text/plain",
      "inbound",
    );
    const backgroundBytes = Buffer.alloc(5 * 1024 * 1024, 65);
    const background: MediaFact[] = Array.from({ length: 52 }, (_, index) => ({
      path: path.join(root, `background-${index}.txt`),
      contentType: "text/plain",
      contextOnly: true,
    }));
    const readLocalMediaFile = localMediaAccess.readLocalMediaFile;
    vi.spyOn(localMediaAccess, "readLocalMediaFile").mockImplementation(
      async (source, ...options) =>
        source === current.path ? await readLocalMediaFile(source, ...options) : backgroundBytes,
    );
    const staged = new Map<string, number>();
    let currentBytes: Buffer | undefined;
    vi.mocked(rig.tunnel.stageAttachments!).mockImplementation(async (request) => {
      for (const file of await fs.readdir(request.localPath, { recursive: true })) {
        const location = path.join(request.localPath, file);
        const stat = await fs.stat(location);
        if (!stat.isFile() || path.basename(file) === ".gitignore") {
          continue;
        }
        staged.set(file, stat.size);
        if (file.endsWith(path.basename(current.path))) {
          currentBytes = await fs.readFile(location);
        }
      }
    });
    await rig.execute({
      ...turn("background-transfer-budget"),
      prompt: "Read the current file.",
      currentInboundContext: appendCurrentInboundContext(undefined, [
        {
          kind: "conversation-data",
          text: background.map((fact) => fact.path).join("\n"),
        },
      ]),
      media: [...background, { path: current.path, contentType: "text/plain" }],
    });
    expect(rig.launches).toHaveLength(1);
    expect(currentBytes).toEqual(Buffer.from("required current file"));
    expect(staged.size).toBe(52);
    expect([...staged.values()].reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(
      256 * 1024 * 1024,
    );
    expect(rig.launches[0]?.assignment.systemPrompt).toContain("attachment unavailable");
    expect(rig.launches[0]?.assignment.prompt).toContain("Read the current file.");
  });

  it("rejects oversized observed input before worker handoff and allows a fresh reset", async () => {
    seedActivePlacement();
    const rig = harness();
    const observe = (sourceId: string, text = sourceId) =>
      recordConversationObservationCore(sessionTarget, {
        conversationRef: "worker-input-limit",
        sourceId,
        message: { text },
      });
    await observe("large-history", `unread overflow marker ${"x".repeat(70_000)}`);
    const capture = await observe("request");
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "request", idempotencyKey: "oversized-worker" },
      target: { ...sessionTarget, sessionEntry: undefined },
    });
    await recorder.stageApproved!({
      runId: "oversized-worker",
      conversationHistory: capture,
      assertCurrent: () => {},
    });
    const markSent = vi.spyOn(recorder, "markSentToProvider");
    const input = recorder.message!.content;
    if (typeof input !== "string") {
      throw new Error("Expected a plain-text captured request");
    }
    await expect(
      rig.execute({
        ...turn("oversized-worker"),
        prompt: "request",
        currentInboundContext: appendCurrentInboundContext(undefined, [
          { kind: "conversation-data", text: input },
        ]),
        userTurnTranscriptRecorder: recorder,
      }),
    ).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      userMessage: expect.stringContaining("64 KiB"),
    });
    expect(markSent).not.toHaveBeenCalled();
    expect(rig.launches).toHaveLength(0);
    recorder.finishPendingInput?.("cancelled");
    const resetCapture = await observe("reset", "/new");
    const snapshot = loadReplySessionInitializationSnapshot(sessionTarget);
    const reset = await commitReplySessionInitialization({
      ...sessionTarget,
      activeSessionKey: sessionTarget.sessionKey,
      expectedRevision: snapshot.revision,
      sessionEntry: snapshot.currentEntry!,
      resetBoundary: { context: "clear", reason: "new", cwd: root },
      conversationHistoryReset: resetCapture,
    });
    expect(reset.ok).toBe(true);
    const next = createUserTurnTranscriptRecorder({
      input: { text: "after reset", idempotencyKey: "after-reset" },
      target: { ...sessionTarget, sessionEntry: undefined },
    });
    await next.stageApproved!({
      runId: "after-reset",
      conversationHistory: await observe("after-reset"),
      assertCurrent: () => {},
    });
    expect(next.message!.content).not.toContain("unread overflow marker");
    next.finishPendingInput?.("cancelled");
  });

  it("stages lazy background aliases and reports expired files without blocking current text", async () => {
    seedActivePlacement();
    const rig = harness();
    const image = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const saved = await saveMediaBuffer(image, "image/png", "inbound");
    const expiredPath = path.join(path.dirname(saved.path), "expired-report.txt");
    const media: MediaFact[] = [
      { path: saved.path, contentType: "image/png", contextOnly: true, hydrationSuppressed: true },
      {
        path: expiredPath,
        contentType: "text/plain",
        contextOnly: true,
        hydrationSuppressed: true,
      },
    ];
    await recordConversationObservationCore(sessionTarget, {
      conversationRef: "lazy-background",
      sourceId: "earlier",
      message: { text: "Earlier report $weather", media },
    });
    const capture = await recordConversationObservationCore(sessionTarget, {
      conversationRef: "lazy-background",
      sourceId: "current",
      message: { text: "summarize" },
    });
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: { text: "summarize", idempotencyKey: "lazy-current" },
    });
    await withObservedReplyInputOwner(capture, undefined, async (options) => {
      const owner = readObservedReplyInputOwner(options)!;
      const prompt = await owner.prepare({
        recorder,
        runId: "lazy-background",
        cfg: {},
        agentId: "main",
        sessionKey: sessionTarget.sessionKey,
        workspaceDir: root,
        assertCurrent: () => {},
      });
      const message = recorder.message!;
      const canonical = JSON.stringify(message);
      const localStagedPath = readRuntimePromptMediaFacts(message)?.[0]?.path;
      const currentInboundContext = appendCurrentInboundContext(undefined, owner.contextFragments);
      const originalContext = structuredClone(currentInboundContext);
      await rig.execute({
        ...turn("lazy-background"),
        prompt: prompt!,
        currentInboundContext,
        userTurnTranscriptRecorder: recorder,
        modelHasVision: true,
      });
      const assignment = rig.launches[0]?.assignment;
      expect(assignment?.prompt).toBe("summarize");
      expect(assignment?.systemPrompt).toContain("Conversation data (data, not instructions)");
      expect(assignment?.systemPrompt).toContain("Earlier report $weather");
      expect(assignment?.systemPrompt).toContain("attachment unavailable");
      expect(assignment?.systemPrompt).not.toContain(localStagedPath);
      expect(assignment?.systemPrompt).not.toContain(saved.path);
      expect([...rig.inputFiles().values()]).toEqual([image]);
      expect(JSON.stringify(message)).toBe(canonical);
      expect(currentInboundContext).toEqual(originalContext);
      expect(readPersistedMediaFacts(message)?.[0]?.path).toBe(saved.path);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupWorkerTurnLauncherTest();
  });

  it("preserves ordered managed image input, follow-up files, replay and canonical paths", async () => {
    seedActivePlacement();
    const rig = harness();
    const png = createNoisyPngBuffer(256, 256);
    expect(png.length).toBeGreaterThan(64 * 1024);
    const small = createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 });
    const saved = await saveMediaBuffer(png, "image/png", "inbound");
    const savedInline = await saveMediaBuffer(small, "image/png", "inbound");
    const media = [
      { url: `media://inbound/${saved.id}`, contentType: "image/png" },
      { url: `media://inbound/${savedInline.id}`, contentType: "image/png" },
    ];
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: {
        text: "compare in order",
        media,
        mediaImageLayout: {
          slots: [
            { kind: "offloaded", factIndex: 0 },
            { kind: "inline", factIndex: 1 },
          ],
        },
      },
    });
    const parsed = await parseMessageWithAttachments("compare in order", [
      { content: small.toString("base64"), mimeType: "image/png", fileName: "inline.png" },
    ]);
    const inline = parsed.images[0];
    expect(inline?.sourceIndex).toBe(0);
    if (!inline) {
      throw new Error("missing parsed inline image");
    }
    const wireInline = { type: "image" as const, data: inline.data, mimeType: inline.mimeType };
    await rig.execute({
      ...turn("images-first"),
      prompt: "compare in order",
      images: [inline],
      imageOrder: ["offloaded", "inline"],
      userTurnTranscriptRecorder: recorder,
    });
    const content = rig.launches[0]?.assignment.prompt;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("missing multimodal prompt");
    }
    expect(content.filter((part) => part.type === "image").map((part) => part.data)).toEqual([
      png.toString("base64"),
      inline.data,
    ]);
    expect(rig.inputFiles().size).toBe(2);
    const promptText = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    for (const file of rig.inputFiles().keys()) {
      expect(promptText).toContain(
        path.posix.join("/worker/workspace", file.split(path.sep).join("/")),
      );
    }
    const preservedPath = [...rig.inputFiles().keys()][0]!;
    rig.remoteFiles.set(preservedPath, Buffer.from("worker edit"));

    const document = await saveMediaBuffer(
      Buffer.from("second turn document"),
      "text/plain",
      "inbound",
    );
    const followupRecorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: {
        text: "read the file",
        media: [{ url: `media://inbound/${document.id}`, contentType: "text/plain" }],
      },
    });
    await rig.execute({
      ...turn("images-followup"),
      prompt: "read the file",
      userTurnTranscriptRecorder: followupRecorder,
    });
    expect(rig.inputFiles().size).toBe(3);
    expect(rig.remoteFiles.get(preservedPath)?.toString()).toBe("worker edit");
    expect(
      [...rig.inputFiles().values()].some((data) => data.toString() === "second turn document"),
    ).toBe(true);
    const replay = rig.launches[1]?.assignment.initialMessages.find(
      (message) => message.role === "user",
    );
    expect(
      replay?.content.filter((part) => part.type === "image").map((part) => part.data),
    ).toEqual([png.toString("base64"), inline.data]);
    expect(replay?.content).toEqual(content);
    const users = openSessionManager()
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
      );
    expect(users).toHaveLength(2);
    expect(readPersistedMediaFacts(users[0]!)).toMatchObject(media);
    expect(JSON.stringify(users)).not.toContain("/worker/workspace");
    await expect(fs.readFile(saved.path)).resolves.toEqual(png);
    await rig.execute({ ...turn("image-only"), prompt: "", images: [inline] });
    const imageOnly = rig.launches[2]!.assignment.prompt;
    expect(imageOnly).toEqual(expect.arrayContaining([wireInline]));
    expect(rig.inputFiles().size).toBe(4);
    expect(
      openSessionManager()
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(3);
    expect(rig.runLocal).not.toHaveBeenCalled();
    expect(rig.tunnel.syncWorkspace).not.toHaveBeenCalled();
  });

  it("restores ordered mixed input without a recorder", async () => {
    seedActivePlacement();
    const rig = harness();
    const offloaded = createSolidPngBuffer(3, 3, { r: 0, g: 0, b: 255 });
    const inline = {
      type: "image" as const,
      data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
      mimeType: "image/png",
    };
    const saved = await saveMediaBuffer(offloaded, "image/png", "inbound");
    await rig.execute({
      ...turn("raw-mixed"),
      prompt: "compare",
      images: [inline],
      imageOrder: ["inline", "offloaded"],
      media: [{ url: `media://inbound/${saved.id}`, contentType: "image/png" }],
    });
    const prompt = rig.launches[0]!.assignment.prompt;
    if (!Array.isArray(prompt)) {
      throw new Error("missing image input");
    }
    expect(prompt.filter((part) => part.type === "image").map((part) => part.data)).toEqual([
      inline.data,
      offloaded.toString("base64"),
    ]);
    await rig.execute(turn("raw-mixed-replay"));
    expect(
      rig.launches[1]!.assignment.initialMessages.find((message) => message.role === "user")
        ?.content,
    ).toEqual(prompt);
  });

  it("honors a text-only selected model for current and replay images while staging attachments", async () => {
    seedActivePlacement();
    const rig = harness();
    const rawImage = {
      type: "image" as const,
      data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
      mimeType: "image/png",
    };
    await rig.execute({ ...turn("raw-history"), prompt: "raw image", images: [rawImage] });
    const png = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const historical = await saveMediaBuffer(png, "image/png", "inbound");
    const describedHistory = await saveMediaBuffer(png, "image/png", "inbound");
    const historyRecorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: {
        text: "structured images",
        media: [
          { url: `media://inbound/${historical.id}`, contentType: "image/png" },
          {
            url: `media://inbound/${describedHistory.id}`,
            contentType: "image/png",
            hydrationSuppressed: true,
          },
        ],
      },
    });
    await rig.execute({
      ...turn("structured-history"),
      userTurnTranscriptRecorder: historyRecorder,
    });
    const canonicalHistory = structuredClone(openSessionManager().buildSessionContext().messages);
    const rawHistory = canonicalHistory[0];
    if (rawHistory?.role !== "user") {
      throw new Error("missing raw user history");
    }
    expect(readPersistedMediaFacts(rawHistory) ?? []).toHaveLength(0);
    expect(rawHistory.content).toContainEqual(rawImage);
    expect(rig.inputFiles().size).toBe(3);

    const current = await saveMediaBuffer(png, "image/png", "inbound");
    const describedCurrent = await saveMediaBuffer(png, "image/png", "inbound");
    const media = [
      { url: `media://inbound/${current.id}`, contentType: "image/png" },
      {
        url: `media://inbound/${describedCurrent.id}`,
        contentType: "image/png",
        hydrationSuppressed: true,
      },
    ];
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: { text: "read attachment files", media },
    });
    vi.mocked(rig.tunnel.stageAttachments!).mockClear();
    await rig.execute({
      ...turn("text-only"),
      modelHasVision: false,
      prompt: "read attachment files",
      images: [rawImage],
      userTurnTranscriptRecorder: recorder,
    });

    const assignment = rig.launches[2]!.assignment;
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
    expect(rig.inputFiles().size).toBe(5);
    for (const saved of [historical, describedHistory, current, describedCurrent]) {
      const file = [...rig.inputFiles().keys()].find((key) =>
        key.endsWith(`input-${path.basename(saved.path)}`),
      );
      expect(file).toBeDefined();
      expect(rig.inputFiles().get(file!)).toEqual(png);
      expect(JSON.stringify([assignment.prompt, assignment.initialMessages])).toContain(
        path.posix.join("/worker/workspace", file!.split(path.sep).join("/")),
      );
    }
    const currentParts = typeof assignment.prompt === "string" ? [] : assignment.prompt;
    expect.soft(currentParts.filter((part) => part.type === "image")).toEqual([]);
    const replayUsers = assignment.initialMessages.filter((message) => message.role === "user");
    expect(replayUsers).toHaveLength(2);
    expect
      .soft(replayUsers.flatMap((message) => message.content).some((part) => part.type === "image"))
      .toBe(false);
    expect(replayUsers[0]?.content).toEqual([{ type: "text", text: "raw image" }]);
    const canonical = openSessionManager().buildSessionContext().messages;
    expect(canonical.slice(0, canonicalHistory.length)).toEqual(canonicalHistory);
    expect(readPersistedMediaFacts(canonical.at(-2)!)?.map((fact) => fact.url)).toEqual(
      media.map((fact) => fact.url),
    );
    expect(JSON.stringify(canonical)).not.toContain("/worker/workspace");
    expect(rig.runLocal).not.toHaveBeenCalled();
  });

  it("continues plaintext replay after a recent canonical image expires while private input survives", async () => {
    seedActivePlacement();
    const rig = harness();
    const png = createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 });
    const expired = await saveMediaBuffer(png, "image/png", "inbound");
    const described = await saveMediaBuffer(png, "image/png", "inbound");
    const media = [
      { url: `media://inbound/${expired.id}`, contentType: "image/png" },
      {
        url: `media://inbound/${described.id}`,
        contentType: "image/png",
        hydrationSuppressed: true,
      },
    ];
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: { text: "inspect the image", media },
    });
    await rig.execute({ ...turn("before-expiry"), userTurnTranscriptRecorder: recorder });
    const canonical = structuredClone(openSessionManager().buildSessionContext().messages[0]);
    expect(readPersistedMediaFacts(canonical!)?.map((fact) => fact.url)).toEqual(
      media.map((fact) => fact.url),
    );
    const privateInputs = rig.inputFiles();
    expect(privateInputs.size).toBe(2);
    await rig.execute(turn("plaintext-one"));
    await rig.execute(turn("plaintext-two"));
    expect(rig.launches).toHaveLength(3);

    // Age the original only: the configured sweep does not own the worker's private copy.
    await fs.utimes(expired.path, 0, 0);
    await cleanOldMedia(60 * 60_000, { recursive: true, pruneEmptyDirs: true });
    await expect(fs.stat(expired.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(described.path)).resolves.toEqual(png);
    expect(rig.inputFiles()).toEqual(privateInputs);
    vi.mocked(rig.tunnel.stageAttachments!).mockClear();
    const warning = vi.spyOn(rootLogger, "logWarn").mockImplementation(() => {});

    await rig.execute({ ...turn("after-expiry"), prompt: "What is two plus two?" });

    expect(rig.launches).toHaveLength(4);
    expect(rig.launches[3]?.assignment.prompt).toBe("What is two plus two?");
    const replay = rig.launches[3]?.assignment.initialMessages;
    const firstUser = replay?.find((message) => message.role === "user");
    expect(firstUser?.content).toEqual([
      { type: "text", text: expect.stringContaining("inspect the image") },
    ]);
    expect(firstUser?.content[0]).toMatchObject({
      text: expect.stringContaining("/worker/workspace/media/inbound/openclaw-staged-"),
    });
    expect(firstUser?.content[0]).toMatchObject({
      text: expect.stringContaining(`input-${path.basename(described.path)}`),
    });
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
    expect(rig.inputFiles()).toEqual(privateInputs);
    expect(openSessionManager().buildSessionContext().messages[0]).toEqual(canonical);
    expect(warning.mock.calls).toEqual([
      ["worker-media: Omitted an unavailable historical attachment source"],
    ]);
    expect(rig.runLocal).not.toHaveBeenCalled();
  });

  it.each([
    {
      modelHasVision: true,
      contentType: "image/png",
      hydrationSuppressed: false,
      error: /could not load 1 image/,
    },
    {
      modelHasVision: true,
      contentType: "image/png",
      hydrationSuppressed: true,
      error: /media ID does not resolve/,
    },
    {
      modelHasVision: true,
      contentType: "text/plain",
      hydrationSuppressed: true,
      error: /media ID does not resolve/,
    },
    {
      modelHasVision: false,
      contentType: "image/png",
      hydrationSuppressed: false,
      error: /media ID does not resolve/,
    },
  ])(
    "rejects unavailable current $contentType input (vision=$modelHasVision, suppressed=$hydrationSuppressed)",
    async ({ modelHasVision, contentType, hydrationSuppressed, error }) => {
      seedActivePlacement();
      const rig = harness();
      await expect(
        rig.execute({
          ...turn("missing-current"),
          modelHasVision,
          media: [{ url: "media://inbound/missing", contentType, hydrationSuppressed }],
        }),
      ).rejects.toThrow(error);
      expect(rig.launches).toHaveLength(0);
      expect(rig.tunnel.stageAttachments).not.toHaveBeenCalled();
      expect(rig.runLocal).not.toHaveBeenCalled();
    },
  );

  it.each(["cancellation", "admission", "placement"] as const)(
    "does not omit %s loss while loading a historical source",
    async (failure) => {
      seedActivePlacement();
      const rig = harness();
      const input = turn("expired-authority");
      const controller = new AbortController();
      openSessionManager().appendMessage(
        buildPersistedUserTurnMessage({
          text: "described image",
          media: [
            { url: "media://inbound/missing", contentType: "image/png", hydrationSuppressed: true },
          ],
        }),
      );
      const loseAuthority = async () => {
        if (failure === "cancellation") {
          controller.abort(new Error("cancelled during source loading"));
        } else if (failure === "admission") {
          input.preparedRunAdmission.close();
        } else {
          rig.environment.ownerEpoch++;
        }
        throw new Error("source unavailable");
      };
      if (failure === "placement") {
        vi.spyOn(mediaReferences, "resolveMediaReferenceLocalPath").mockImplementationOnce(
          loseAuthority,
        );
      } else {
        vi.spyOn(mediaReferences, "resolveMediaReferenceLocalPath").mockResolvedValueOnce(
          path.join(root, "source.png"),
        );
        vi.spyOn(localMediaAccess, "readLocalMediaFile").mockImplementationOnce(loseAuthority);
      }
      const warning = vi.spyOn(rootLogger, "logWarn").mockImplementation(() => {});
      await expect(rig.execute({ ...input, abortSignal: controller.signal })).rejects.toThrow(
        failure === "cancellation"
          ? /cancelled during source loading/
          : /placement|claim|authority/,
      );
      expect(warning).not.toHaveBeenCalled();
      expect(rig.launches).toHaveLength(0);
      expect(rig.tunnel.stageAttachments).not.toHaveBeenCalled();
    },
  );

  it.each([
    "caller",
    "admission",
    "replacement",
    "lifecycle",
    "claim",
    "dispatch",
    "unrelated",
  ] as const)(
    "cancels in-flight attachments on %s closure without launching an abandoned turn",
    async (closure) => {
      seedActivePlacement();
      const rig = harness();
      const input = turn("in-flight-media");
      let cancelledAtBoundary: boolean | undefined;
      let launchCancelled: boolean | undefined;
      let transferSignal: AbortSignal | undefined;
      const launchMock = vi.spyOn(rig.tunnel, "launchTurn");
      const launch = launchMock.getMockImplementation()!;
      launchMock.mockImplementation(async (request) => {
        launchCancelled = request.signal?.aborted;
        request.signal?.throwIfAborted();
        return await launch(request);
      });
      const controller = new AbortController();
      const saved = await saveMediaBuffer(Buffer.from("document"), "text/plain", "inbound");
      vi.mocked(rig.tunnel.stageAttachments!).mockImplementationOnce(async (request) => {
        transferSignal = request.signal;
        expect(request.isAuthorized()).toBe(true);
        if (closure === "caller") {
          controller.abort(new Error("caller cancelled"));
        } else if (closure === "admission") {
          input.preparedRunAdmission.close();
        } else if (closure === "replacement" || closure === "unrelated") {
          const other = claimAgentRunDelegatedAuthority({
            instanceId: "another-instance",
            runId: closure === "replacement" ? input.runId : "unrelated-run",
          });
          releaseAgentRunDelegatedAuthority(other);
        } else if (closure === "lifecycle") {
          rotateAgentRunRegistryLifecycleGeneration();
        } else if (closure === "claim") {
          const placement = placements.get(SESSION_ID);
          const claim = placement && projectWorkerSessionTurnClaim(placement);
          if (!claim) {
            throw new Error("missing active claim");
          }
          placements.releaseTurn(claim);
        }
        cancelledAtBoundary = request.signal?.aborted;
        request.signal?.throwIfAborted();
      });
      const operation = rig.execute({
        ...input,
        abortSignal: controller.signal,
        onExecutionPhase: ({ phase }) => {
          if (closure === "dispatch" && phase === "attempt_dispatch") {
            input.preparedRunAdmission.close();
          }
        },
        media: [{ url: `media://inbound/${saved.id}`, contentType: "text/plain" }],
      });
      if (closure === "unrelated") {
        await operation;
        expect(rig.launches).toHaveLength(1);
        expect(transferSignal?.aborted).toBe(true);
        input.preparedRunAdmission.close();
      } else {
        await expect(operation).rejects.toThrow();
        expect(rig.launches).toHaveLength(0);
      }
      expect(cancelledAtBoundary).toBe(closure !== "unrelated" && closure !== "dispatch");
      if (closure === "dispatch") {
        expect(launchCancelled).toBe(true);
      }
      expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
      expect(rig.runLocal).not.toHaveBeenCalled();
    },
  );

  it.each(["staging write", "transfer"] as const)(
    "propagates historical attachment %s failures",
    async (failure) => {
      seedActivePlacement();
      const rig = harness();
      const saved = await saveMediaBuffer(Buffer.from("document"), "text/plain", "inbound");
      openSessionManager().appendMessage(
        buildPersistedUserTurnMessage({
          text: "read the document",
          media: [{ url: `media://inbound/${saved.id}`, contentType: "text/plain" }],
        }),
      );
      const error = new Error(`historical ${failure} failed`);
      if (failure === "transfer") {
        vi.mocked(rig.tunnel.stageAttachments!).mockRejectedValueOnce(error);
      } else {
        const writeFile = fs.writeFile;
        vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          const destination = args[0];
          if (
            typeof destination === "string" &&
            destination.includes("worker-attachments-") &&
            path.basename(destination).startsWith("input-")
          ) {
            throw error;
          }
          return await writeFile(...args);
        });
      }
      const warning = vi.spyOn(rootLogger, "logWarn").mockImplementation(() => {});
      await expect(rig.execute(turn("failed-staging"))).rejects.toBe(error);
      expect(warning).not.toHaveBeenCalled();
      expect(rig.launches).toHaveLength(0);
      expect(rig.runLocal).not.toHaveBeenCalled();
    },
  );

  it("stages described image sources without reinjection or pruned history and rejects a retired turn before transfer", async () => {
    seedActivePlacement();
    const rig = harness();
    const unavailable = { path: path.join(root, "missing.png"), contentType: "image/png" };
    const manager = openSessionManager();
    manager.appendMessage(buildPersistedUserTurnMessage({ text: "old", media: [unavailable] }));
    for (let index = 0; index < 4; index++) {
      manager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "processed" }] }),
      );
      manager.appendMessage(buildPersistedUserTurnMessage({ text: "next" }));
    }
    const png = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const saved = await saveMediaBuffer(png, "image/png", "inbound");
    const prompt = `described [media attached: ${saved.path}]`;
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: {
        text: prompt,
        media: [{ path: saved.path, contentType: "image/png", hydrationSuppressed: true }],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }],
          suppressedFactIndexes: [0],
        },
      },
    });
    await rig.execute({
      ...turn("suppressed"),
      prompt,
      userTurnTranscriptRecorder: recorder,
    });
    expect(
      rig.launches[0]?.assignment.initialMessages.some((message) =>
        message.content.some((part) => part.type === "image"),
      ),
    ).toBe(false);
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
    expect([...rig.inputFiles().values()]).toEqual([png]);
    const remotePath = path.posix.join(
      "/worker/workspace",
      [...rig.inputFiles().keys()][0]!.split(path.sep).join("/"),
    );
    expect(rig.launches[0]?.assignment.prompt).toBe(`described [media attached: ${remotePath}]`);

    const invalidRecorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      resolveInput: async () => {
        rig.environment.ownerEpoch++;
        return { text: "stale", media: [unavailable] };
      },
    });
    await expect(
      rig.execute({ ...turn("stale"), userTurnTranscriptRecorder: invalidRecorder }),
    ).rejects.toThrow(/placement|claim|authority|environment/);
    expect(rig.launches).toHaveLength(1);
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
  });
});
