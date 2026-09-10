// CI resource owner; the disposable credentialless runner is the isolation boundary.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

await runWithFailedTrailer("macos-native", async () => {
  const env = process.env;
  // Invocation checks prevent accidental local use; these markers are not a sandbox.
  if (
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_OS !== "macOS" ||
    !env.RUNNER_TEMP ||
    !env.HOME ||
    process.platform === "win32"
  ) {
    throw new Error(
      "Run native app tests in the disposable macos-swift GitHub CI job, never on an operator desktop.",
    );
  }
  const [profileMode, ...args] = process.argv.slice(2);
  if (profileMode !== "default" && profileMode !== "named") {
    throw new Error("Select default or named profile semantics before the Swift test arguments.");
  }
  let nativeActionFixture: string | undefined;
  const fixtureIndex = args.indexOf("--native-action-fixture");
  if (fixtureIndex !== -1) {
    const raw = args[fixtureIndex + 1];
    if (!raw || raw.length > 32_768) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    // This plain-Node launcher must also work before workspace packages are built.
    const { isRecord } = await import("../packages/normalization-core/src/record-coerce.ts");
    let fixture: unknown;
    try {
      fixture = JSON.parse(raw);
    } catch {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const fields = [
      "version",
      "gatewayURL",
      "controlURL",
      "controlToken",
      "gatewayID",
      "aliceProfileID",
      "bobProfileID",
      "cases",
      "media",
      "approvals",
    ];
    const caseIDs = [
      "allowed",
      "distinct",
      "foreign",
      "acl",
      "aclSuspended",
      "controlACL",
      "accepted",
      "profile",
      "profileSuspended",
      "controlProfile",
    ];
    const boundedText = (value: unknown, maximum: number) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      !value.includes("\0");
    if (
      !isRecord(fixture) ||
      fixture.version !== 1 ||
      Object.keys(fixture).length !== fields.length ||
      Object.keys(fixture).some((key) => !fields.includes(key)) ||
      !["controlToken", "gatewayID", "aliceProfileID", "bobProfileID"].every((key) =>
        boundedText(fixture[key], 256),
      )
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const cases = fixture.cases;
    if (
      typeof fixture.controlToken !== "string" ||
      !/^[a-zA-Z0-9-]{16,128}$/.test(fixture.controlToken) ||
      fixture.aliceProfileID === fixture.bobProfileID ||
      !isRecord(cases) ||
      Object.keys(cases).length !== caseIDs.length ||
      !caseIDs.every((id) => {
        const entry = cases[id];
        return (
          isRecord(entry) &&
          Object.keys(entry).length === 3 &&
          boundedText(entry.sessionKey, 256) &&
          boundedText(entry.marker, 256) &&
          boundedText(entry.message, 2048)
        );
      })
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const media = fixture.media;
    const mediaSessionIDs = ["acl", "controlACL", "profile", "controlProfile"];
    if (
      !isRecord(media) ||
      Object.keys(media).length !== 3 ||
      !boundedText(media.pngBase64, 32_768) ||
      typeof media.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(media.sha256)
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const mediaSessions = media.sessions;
    if (
      !isRecord(mediaSessions) ||
      Object.keys(mediaSessions).length !== mediaSessionIDs.length ||
      !mediaSessionIDs.every((id) => {
        const entry = mediaSessions[id];
        return (
          isRecord(entry) &&
          Object.keys(entry).length === 2 &&
          boundedText(entry.sessionKey, 256) &&
          boundedText(entry.artifactID, 256)
        );
      })
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const approvals = fixture.approvals;
    if (!isRecord(approvals) || Object.keys(approvals).length !== 2) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const requests = approvals.requests;
    const approvalIDs = ["allowed", "visible", "queued", "control"];
    if (
      !isRecord(requests) ||
      Object.keys(requests).length !== approvalIDs.length ||
      !approvalIDs.every((id) => {
        const entry = requests[id];
        return (
          isRecord(entry) &&
          Object.keys(entry).length === 3 &&
          boundedText(entry.id, 256) &&
          boundedText(entry.sessionKey, 256) &&
          boundedText(entry.command, 2048)
        );
      })
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    for (const [value, protocol] of [
      [fixture.gatewayURL, "ws:"],
      [fixture.controlURL, "http:"],
      [approvals.gatewayURL, "ws:"],
    ] as const) {
      const url = typeof value === "string" && value.length <= 256 ? URL.parse(value) : null;
      if (
        !url ||
        url.protocol !== protocol ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error("Native action fixture endpoints must use explicit loopback ports.");
      }
    }
    nativeActionFixture = JSON.stringify(fixture);
    args.splice(fixtureIndex, 2);
    if (args.includes("--native-action-fixture")) {
      throw new Error("Provide exactly one native action fixture descriptor.");
    }
  }
  if (!args.includes("--skip-build")) {
    throw new Error(
      "Build tests first with swift build --build-tests; this launcher requires --skip-build.",
    );
  }

  // Keep paths short for tools honoring TMPDIR, independently of RUNNER_TEMP's length.
  // Foundation's Darwin temp directory belongs to the disposable OS worker instead.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-test-"));
  let canRemove = true;
  try {
    const home = path.join(root, "home");
    const state = path.join(root, "state");
    const tmp = path.join(root, "tmp");
    for (const dir of [home, state, tmp]) {
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "DEVELOPER_DIR",
      "SDKROOT",
      "TOOLCHAINS",
      "LANG",
      "LC_ALL",
      "TERM",
      "DYLD_FRAMEWORK_PATH",
      "DYLD_LIBRARY_PATH",
      "LLVM_PROFILE_FILE",
      "SWIFTPM_MODULECACHE_OVERRIDE",
      "CLANG_MODULE_CACHE_PATH",
      // Preserve Actions' orphan-cleanup correlation through the isolated child env.
      "RUNNER_TRACKING_ID",
    ]) {
      if (env[key] !== undefined) {
        childEnv[key] = env[key];
      }
    }
    Object.assign(childEnv, {
      CI: "true",
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: `${tmp}/`,
      TMP: tmp,
      TEMP: tmp,
      // The full suite protects default-profile lifecycle behavior. Named-profile
      // construction is exercised separately; both use the disposable runner's account.
      OPENCLAW_PROFILE: profileMode === "named" ? `test-${randomUUID()}` : "default",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    });

    // Keep SwiftPM's build cache available without inheriting the runner's app state.
    const cache = path.join(home, "Library/Caches");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.join(env.HOME, "Library/Caches/org.swift.swiftpm"),
      path.join(cache, "org.swift.swiftpm"),
    );
    const keychain = path.join(home, "Library/Keychains/native-tests.keychain-db");
    // Security writes its user preferences beneath HOME but does not create the parent.
    for (const dir of [path.dirname(keychain), path.join(home, "Library/Preferences")]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const run = async (bin: string, commandArgs: string[], timeoutMs?: number) => {
      canRemove = false;
      const code = await runManagedCommand({
        bin,
        args: commandArgs,
        env: childEnv,
        requireProcessTreeExit: true,
        timeoutMs,
      });
      canRemove = true;
      return code;
    };
    // Empty test-only password prevents prompts; no automatic locking while the suite runs.
    // Only the user domain changes. Common/dynamic Keychains still require a disposable host.
    try {
      for (const command of [
        ["create-keychain", "-p", "", keychain],
        ["unlock-keychain", "-p", "", keychain],
        ["set-keychain-settings", keychain],
        ["list-keychains", "-d", "user", "-s", keychain],
        ["default-keychain", "-d", "user", "-s", keychain],
      ]) {
        process.exitCode = await run("security", command, 30_000);
        if (process.exitCode !== 0) {
          console.error(`[macos-native] security ${command[0]} failed (exit ${process.exitCode})`);
          return;
        }
      }
      try {
        if (nativeActionFixture) {
          childEnv.OPENCLAW_NATIVE_ACTION_FIXTURE = nativeActionFixture;
        }
        process.exitCode = await run("swift", ["test", ...args]);
      } finally {
        delete childEnv.OPENCLAW_NATIVE_ACTION_FIXTURE;
      }
    } finally {
      // A completed failed create may leave a database. Never delete it until every child closed.
      if (canRemove && fs.existsSync(keychain)) {
        const cleanupCode = await run("security", ["delete-keychain", keychain], 30_000);
        if (cleanupCode !== 0) {
          canRemove = false;
          process.exitCode ||= cleanupCode;
          console.error(`[macos-native] security delete-keychain failed (exit ${cleanupCode})`);
        }
      }
    }
  } finally {
    // Retain evidence/resources if process-tree completion could not be established.
    if (canRemove) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.error(`[macos-native] retained resources after incomplete launch/cleanup: ${root}`);
    }
  }
});
