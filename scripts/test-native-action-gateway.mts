import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  startQaMockOpenAiServer,
  TINY_PNG_BASE64,
  type MockOpenAiRequestSnapshot,
} from "../extensions/qa-lab/api.js";
import {
  MODEL_REF,
  PROOF_TIMEOUT_MS,
  waitFor,
} from "../test/e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js";
import { wireMessageText } from "../test/e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js";
import { runProfileWireProof } from "../test/e2e/qa-lab/runtime/profile-binding-wire-fixture.js";
import {
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_WRITER_SCOPES,
} from "../test/e2e/qa-lab/runtime/skill-library-wire-fixture.js";
import { startQaGatewayRpcProxy } from "../test/fixtures/qa-gateway-rpc-proxy.mjs";
import { runQaGatewayFixture } from "../test/helpers/qa-gateway-cleanup.js";
import { runManagedCommand } from "./lib/managed-child-process.mts";

const CASES = {
  allowed: "allowed",
  distinct: "allowed",
  foreign: "rejected",
  acl: "rejected",
  aclSuspended: "rejected",
  controlACL: "allowed",
  accepted: "allowed",
  profile: "rejected",
  profileSuspended: "rejected",
  controlProfile: "allowed",
} as const;
type CaseID = keyof typeof CASES;
type WireCase = { sessionKey: string; marker: string; message: string };
const MEDIA_CASES = {
  aclAllowed: { session: "acl", allowed: true },
  acl: { session: "acl", allowed: false },
  controlACL: { session: "controlACL", allowed: true },
  profileAllowed: { session: "profile", allowed: true },
  profile: { session: "profile", allowed: false },
  controlProfile: { session: "controlProfile", allowed: true },
  retiredResult: { session: "controlACL", allowed: false },
  retiredControl: { session: "controlACL", allowed: true },
} as const;
type MediaCaseID = keyof typeof MEDIA_CASES;
type MediaSession = (typeof MEDIA_CASES)[MediaCaseID]["session"];
type WireMedia = { sessionKey: string; artifactID: string };
const CONTROL_ACTIONS = [
  "pair",
  "revoke-acl",
  "merge-profile",
  "verify",
  "complete",
  "hold-response",
  "wait-held",
  "release-response",
  "media-start",
  "media-complete",
] as const;
type ControlProgress = {
  action: (typeof CONTROL_ACTIONS)[number] | "unknown";
  phase:
    | "body"
    | "action"
    | "connect-record"
    | "identity"
    | "pending-list"
    | "pending-match"
    | "approval";
};
export type NativeActionFixtureDescriptor = {
  version: 1;
  gatewayURL: string;
  controlURL: string;
  controlToken: string;
  gatewayID: string;
  aliceProfileID: string;
  bobProfileID: string;
  cases: Record<CaseID, WireCase>;
  media: {
    pngBase64: string;
    sha256: string;
    sessions: Record<MediaSession, WireMedia>;
  };
};

async function readBody(request: AsyncIterable<Buffer | string>) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    assert(text.length <= 8192, "native fixture control body exceeded limit");
  }
  const input: unknown = JSON.parse(text);
  assert(isRecord(input), "native fixture control requires an object");
  return input;
}

/** Fixture lifecycle is reusable by native consumers without importing a test runner. */
export async function withNativeActionGateway(
  platform: "ios" | "macos",
  executeNative: (descriptor: NativeActionFixtureDescriptor) => Promise<void>,
) {
  let completedCases: CaseID[] = [];
  let completedMedia: MediaCaseID[] = [];
  await runProfileWireProof(
    () => startQaMockOpenAiServer({ modelRefs: [MODEL_REF] }),
    async (fixture) => {
      const { instance, provider, admin, alice, bob, aliceId, bobId } = fixture;
      const controlToken = randomUUID();
      const mediaPaths = new Set<string>();
      const proxy = await startQaGatewayRpcProxy({
        backendPort: instance.port,
        repoRoot: process.cwd(),
        token: controlToken,
        recordPath: undefined,
        observedMethods: ["artifacts.download"],
        mediaPaths,
        upstreamHeaders: {
          "x-forwarded-user": SKILL_LIBRARY_ALICE,
          "x-forwarded-for": "198.51.100.40",
          "x-forwarded-proto": "http",
          "x-forwarded-host": `127.0.0.1:${instance.port}`,
          "x-openclaw-scopes": SKILL_LIBRARY_WRITER_SCOPES.join(","),
        },
      });
      const verified = new Map<CaseID, string | undefined>();
      const completed = new Set<CaseID>();
      const mediaCompleted = new Set<MediaCaseID>();
      let mediaAttempt: { id: MediaCaseID; before: ReturnType<typeof proxy.snapshot> } | undefined;
      const png = Buffer.from(TINY_PNG_BASE64, "base64");
      const media = {
        pngBase64: TINY_PNG_BASE64,
        sha256: createHash("sha256").update(png).digest("hex"),
        sessions: {} as Record<MediaSession, WireMedia>,
      };
      const pairedDevices = new Set<string>();
      const pending = new Set<Promise<void>>();
      let firstControlFailure: Error | undefined;
      const cases = {} as Record<CaseID, WireCase>;
      const commands = new Map<CaseID, { sentinel: string; command: string }>();
      const caseKeys = Object.keys(CASES) as CaseID[];
      const groups = new Map<string, string>();
      const journal = async (): Promise<MockOpenAiRequestSnapshot[]> => {
        const response = await fetch(`${provider.baseUrl}/debug/requests?after=0`, {
          signal: AbortSignal.timeout(30_000),
        });
        assert(response.ok);
        return (await response.json()) as MockOpenAiRequestSnapshot[];
      };
      const history = async (sessionKey: string) =>
        (
          await admin.request<{ messages: Array<{ role?: string; content?: unknown }> }>(
            "chat.history",
            { sessionKey, limit: 100 },
          )
        ).messages;
      const verify = async (id: CaseID, runId?: string) => {
        const spec = cases[id];
        const effects = commands.get(id)!;
        if (CASES[id] === "allowed") {
          assert(runId, `missing native run receipt for ${id}`);
          const terminal = await admin.request<{ status: string }>(
            "agent.wait",
            { runId, timeoutMs: PROOF_TIMEOUT_MS },
            PROOF_TIMEOUT_MS + 5000,
          );
          assert.equal(terminal.status, "ok");
          await waitFor(`native ${id} final transcript`, async () => {
            const messages = await history(spec.sessionKey);
            return messages.some(
              (message) => message.role === "assistant" && wireMessageText(message) === spec.marker,
            )
              ? true
              : undefined;
          });
        }
        const messages = await history(spec.sessionKey);
        const requests = await journal();
        const expectedCount = CASES[id] === "allowed" ? 1 : 0;
        assert.equal(
          messages.filter(
            (message) => message.role === "user" && wireMessageText(message).includes(spec.marker),
          ).length,
          expectedCount,
          `${id}: user admission count`,
        );
        assert.equal(
          requests.filter(
            (request) =>
              request.requestKind === "agent-initial" &&
              request.plannedToolName === "exec" &&
              request.plannedToolArgs?.command === effects.command,
          ).length,
          expectedCount,
          `${id}: provider turn count`,
        );
        assert.equal(
          await fs.readFile(effects.sentinel, "utf8"),
          CASES[id] === "allowed" ? spec.marker : "",
          `${id}: executable sentinel count`,
        );
        if (CASES[id] === "rejected") {
          assert(!requests.some((request) => request.raw.includes(spec.marker)));
        }
        if (verified.has(id)) {
          assert.equal(verified.get(id), runId, `${id}: replay changed its receipt`);
        }
        verified.set(id, runId);
      };
      const proxyControl = async (input: Record<string, unknown>) => {
        const response = await fetch(proxy.controlUrl, {
          method: "POST",
          headers: { "x-qa-fixture-token": controlToken },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(35_000),
        });
        assert(response.ok, "proxy control failed");
        return await response.json();
      };
      const handle = async (
        input: Record<string, unknown>,
        progress: ControlProgress,
      ): Promise<unknown> => {
        progress.action = CONTROL_ACTIONS.find((action) => action === input.action) ?? "unknown";
        progress.phase = "action";
        if (["hold-response", "wait-held", "release-response"].includes(String(input.action))) {
          return await proxyControl(input);
        }
        switch (input.action) {
          case "media-start": {
            assert(typeof input.case === "string" && Object.hasOwn(MEDIA_CASES, input.case));
            const id = input.case as MediaCaseID;
            assert(!mediaAttempt && !mediaCompleted.has(id), "overlapping or repeated media case");
            mediaAttempt = { id, before: proxy.snapshot() };
            return { started: id };
          }
          case "media-complete": {
            assert(mediaAttempt && mediaAttempt.id === input.case, "media case was not started");
            const { id, before } = mediaAttempt;
            const allowed = MEDIA_CASES[id].allowed;
            const after = proxy.snapshot();
            const expected = allowed || id === "retiredResult" ? 1 : 0;
            for (const counter of ["requests", "matched", "completed", "succeeded"] as const) {
              assert.equal(
                after.media[counter] - before.media[counter],
                expected,
                `${id}: media ${counter}`,
              );
            }
            const responses = after.events
              .slice(before.events.length)
              .filter(
                (event: { kind: string; method?: string }) =>
                  event.kind === "rpc-response" && event.method === "artifacts.download",
              );
            assert.equal(responses.length, 1, `${id}: fresh artifact authorization response`);
            assert.equal(responses[0].ok, expected === 1, `${id}: artifact authorization`);
            if (id === "retiredResult") {
              const held = after.events
                .slice(before.events.length)
                .find(
                  (event: { kind: string; method?: string }) =>
                    event.kind === "response-held" && event.method === "media.get",
                );
              assert(held?.ok && held.sha256 === media.sha256 && held.sizeBytes === png.length);
              assert(
                after.events
                  .slice(before.events.length)
                  .some(
                    (event: { kind: string; method?: string; delivered?: boolean }) =>
                      event.kind === "response-released" &&
                      event.method === "media.get" &&
                      event.delivered,
                  ),
                "held PNG was not released to the retired loader",
              );
            }
            assert.equal(input.outcome, allowed ? "allowed" : "rejected");
            assert.equal(input.sha256, allowed ? media.sha256 : undefined);
            mediaCompleted.add(id);
            mediaAttempt = undefined;
            return { completed: id };
          }
          case "pair": {
            progress.phase = "connect-record";
            const connection = proxy
              .snapshot()
              .events.findLast((event: { kind: string }) => event.kind === "connect-request");
            assert(connection, "native connect record was missing");
            progress.phase = "identity";
            assert.equal(connection.clientId, `openclaw-${platform}`);
            assert.equal(typeof connection.deviceId, "string");
            assert(connection.deviceId.length > 0, "native device identity was omitted");
            progress.phase = "pending-list";
            const list = await admin.request<{
              pending: Array<{ requestId: string; deviceId: string }>;
            }>("device.pair.list", {});
            progress.phase = "pending-match";
            const request = list.pending.find((entry) => entry.deviceId === connection.deviceId);
            assert(request, "native device did not enter real pairing");
            progress.phase = "approval";
            await admin.request("device.pair.approve", { requestId: request.requestId });
            pairedDevices.add(connection.deviceId);
            return { paired: true };
          }
          case "revoke-acl": {
            // Bob created this session. A real owner-only draft removes Alice's writer access.
            const result = await bob.request<{ visibility: string }>("session.visibility.set", {
              sessionKey: cases.acl.sessionKey,
              visibility: "draft",
            });
            assert.equal(result.visibility, "draft");
            await assert.rejects(
              alice.request("chat.history", { sessionKey: cases.acl.sessionKey, limit: 1 }),
            );
            return { revoked: true };
          }
          case "merge-profile":
            await admin.request("users.linkEmail", {
              email: SKILL_LIBRARY_ALICE,
              targetProfileId: bobId,
            });
            assert.equal(
              (await alice.request<{ profile: { id: string } }>("users.self", {})).profile.id,
              bobId,
            );
            return { profileID: bobId };
          case "verify": {
            assert(typeof input.case === "string" && Object.hasOwn(CASES, input.case));
            const id = input.case as CaseID;
            assert.equal(input.outcome, CASES[id]);
            assert(input.runId === undefined || typeof input.runId === "string");
            await verify(id, input.runId);
            return { verified: id };
          }
          case "complete":
            assert(typeof input.case === "string" && verified.has(input.case as CaseID));
            assert(!completed.has(input.case as CaseID), "duplicate native case completion");
            completed.add(input.case as CaseID);
            return { completed: input.case };
          default:
            throw new Error("unknown native fixture action");
        }
      };
      const control = createServer((request, response) => {
        const progress: ControlProgress = { action: "unknown", phase: "body" };
        const task = (async () => {
          if (
            request.method !== "POST" ||
            request.url !== "/" ||
            request.headers["x-qa-fixture-token"] !== controlToken
          ) {
            response.writeHead(403).end();
            return;
          }
          const result = await handle(await readBody(request), progress);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        })().catch((error: unknown) => {
          if (!firstControlFailure) {
            const category =
              error instanceof assert.AssertionError
                ? "assertion"
                : error instanceof Error
                  ? "error"
                  : "non-error";
            const message = `native fixture controls failed: action=${progress.action}; phase=${progress.phase}; reason=request-failed; category=${category}`;
            // Raw assertions and stacks can contain fixture credentials and private paths.
            firstControlFailure = new Error(message);
            firstControlFailure.stack = message;
          }
          response.writeHead(500).end("native fixture assertion failed");
        });
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task),
        );
      });
      await runQaGatewayFixture(
        async () => {
          for (const id of caseKeys) {
            const group =
              id === "aclSuspended" ? "acl" : id === "profileSuspended" ? "profile" : id;
            let sessionKey = groups.get(group);
            if (!sessionKey) {
              sessionKey = await fixture.createSession(
                `native-${platform}-${group.toLowerCase()}`,
                "bob",
              );
              groups.set(group, sessionKey);
            }
            const marker = `NATIVE-${platform.toUpperCase()}-${id.toUpperCase()}`;
            const sentinel = path.join(instance.state.workspaceDir, `${marker}.txt`);
            const command = `printf '%s' ${JSON.stringify(marker)} >> ${JSON.stringify(`./${marker}.txt`)}`;
            await fs.writeFile(sentinel, "");
            commands.set(id, { sentinel, command });
            cases[id] = {
              sessionKey,
              marker,
              message: [
                "Tool progress QA check.",
                `Call the exec tool exactly once with this exact command before answering: \`${command}\`.`,
                `Reply exactly \`${marker}\`.`,
              ].join(" "),
            };
          }
          // Bob's ordinary send ingests the PNG into managed media. Native clients
          // receive only the artifact id and must obtain their own authorized download.
          await fs.writeFile(path.join(instance.state.workspaceDir, "native-wire.png"), png);
          for (const session of new Set(Object.values(MEDIA_CASES).map((spec) => spec.session))) {
            const sessionKey = cases[session].sessionKey;
            const started = await bob.request<{ runId: string }>("chat.send", {
              sessionKey,
              message: "Reply exactly `MEDIA:./native-wire.png`",
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            const terminal = await admin.request<{ status: string }>(
              "agent.wait",
              { runId: started.runId, timeoutMs: PROOF_TIMEOUT_MS },
              PROOF_TIMEOUT_MS + 5000,
            );
            assert.equal(terminal.status, "ok", "media ingestion run failed");
            const artifacts = await waitFor("managed native PNG", async () => {
              const result = await bob.request<{
                artifacts: Array<{ id: string; mimeType?: string; download: { mode: string } }>;
              }>("artifacts.list", { sessionKey, agentId: "qa" });
              return result.artifacts.length > 0 ? result.artifacts : undefined;
            });
            assert.equal(artifacts.length, 1);
            const artifact = artifacts[0]!;
            assert.match(artifact.id, /^artifact_managed_image_/);
            assert.equal(artifact.mimeType, "image/png");
            assert.equal(artifact.download.mode, "url");
            const download = await bob.request<{ url: string }>("artifacts.download", {
              sessionKey,
              agentId: "qa",
              artifactId: artifact.id,
            });
            assert(download.url.startsWith("/api/chat/media/outgoing/"));
            mediaPaths.add(new URL(download.url, "http://127.0.0.1").pathname);
            media.sessions[session] = { sessionKey, artifactID: artifact.id };
          }
          await new Promise<void>((resolve, reject) => {
            control.once("error", reject);
            control.listen(0, "127.0.0.1", resolve);
          });
          const address = control.address();
          assert(address && typeof address !== "string");
          await executeNative({
            version: 1,
            gatewayURL: proxy.url,
            controlURL: `http://127.0.0.1:${address.port}/`,
            controlToken,
            gatewayID: `native-action-${randomUUID()}`,
            aliceProfileID: aliceId,
            bobProfileID: bobId,
            cases,
            media,
          });
          assert.deepEqual(
            [...completed].toSorted(),
            [...caseKeys].toSorted(),
            "missing native wire cases",
          );
          if (platform === "ios") {
            assert.deepEqual([...mediaCompleted].toSorted(), Object.keys(MEDIA_CASES).toSorted());
            assert(!mediaAttempt, "unfinished native media case");
          }
          assert(pairedDevices.size > 0, "no real native device pairing was approved");
          for (const request of proxy
            .snapshot()
            .events.filter((event: { kind: string }) => event.kind === "connect-request")) {
            assert.equal(request.clientId, `openclaw-${platform}`);
            assert(
              pairedDevices.has(request.deviceId),
              "native connection bypassed paired identity",
            );
          }
          const admissions = proxy
            .snapshot()
            .events.filter((event: { kind: string }) => event.kind === "connect-success");
          assert(admissions.length > 0, "no real native admission");
          for (const admission of admissions) {
            assert.deepEqual(
              admission.scopes.toSorted(),
              [...SKILL_LIBRARY_WRITER_SCOPES].toSorted(),
              "native authority escaped the proxy's nonadmin cap",
            );
          }
          for (const [id, runId] of verified) {
            await verify(id, runId);
          }
        },
        () => proxy.stop(),
        async () => {
          control.closeAllConnections();
          if (control.listening) {
            await new Promise<void>((resolve, reject) => {
              control.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
        async () => {
          await Promise.allSettled(pending);
        },
        () => {
          if (firstControlFailure) {
            throw firstControlFailure;
          }
        },
      );
      completedCases = [...completed];
      completedMedia = [...mediaCompleted];
    },
  );
  console.log(
    JSON.stringify({
      platform,
      cases: completedCases,
      mediaCases: completedMedia,
      finalEffectsVerified: true,
    }),
  );
}

async function runNative(platform: "ios" | "macos", fixture: NativeActionFixtureDescriptor) {
  const descriptor = JSON.stringify(fixture);
  if (platform === "macos") {
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "scripts/test-macos-native.mts",
        "default",
        "--native-action-fixture",
        descriptor,
        "--package-path",
        "apps/macos",
        "--build-system",
        "native",
        "--skip-build",
        "--filter",
        "NativeActionGatewayWireTests",
      ],
      timeoutMs: 20 * 60_000,
      requireProcessTreeExit: true,
    });
    assert.equal(code, 0, "native macOS wire suite failed");
    return;
  }
  let simulatorJSON = "";
  const listCode = await runManagedCommand({
    bin: "xcrun",
    args: ["simctl", "list", "devices", "available", "--json"],
    stdio: ["ignore", "pipe", "inherit"],
    timeoutMs: 30_000,
    requireProcessTreeExit: true,
    onReady: (child) =>
      child.stdout?.on("data", (chunk) => {
        simulatorJSON += String(chunk);
        assert(simulatorJSON.length < 1024 * 1024, "simulator inventory too large");
      }),
  });
  assert.equal(listCode, 0);
  const inventory = JSON.parse(simulatorJSON) as {
    devices: Record<string, Array<{ name: string; isAvailable: boolean; udid: string }>>;
  };
  const simulator = Object.values(inventory.devices)
    .flat()
    .find((device) => device.isAvailable && device.name.startsWith("iPhone"));
  assert(simulator, "no available iPhone simulator");
  const code = await runManagedCommand({
    bin: "xcodebuild",
    args: [
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClaw",
      "-configuration",
      "Debug",
      "-destination",
      `platform=iOS Simulator,id=${simulator.udid}`,
      "-parallel-testing-enabled",
      "NO",
      "-only-testing:OpenClawTests/NativeActionGatewayWireTests",
      "test",
    ],
    env: { ...process.env, TEST_RUNNER_OPENCLAW_NATIVE_ACTION_FIXTURE: descriptor },
    timeoutMs: 45 * 60_000,
    requireProcessTreeExit: true,
  });
  assert.equal(code, 0, "native iOS wire suite failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const platform = process.argv[2];
  assert(platform === "ios" || platform === "macos", "select ios or macos");
  assert(
    process.platform === "darwin" &&
      process.env.CI === "true" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_OS === "macOS",
    "native wire proof requires the disposable hosted Apple CI worker",
  );
  await withNativeActionGateway(platform, (fixture) => runNative(platform, fixture));
}
