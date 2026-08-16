import { ModelDescription, SerializedContinueConfig } from "core";
import { IDE } from "core/index.js";
import { FromIdeProtocol, ToIdeProtocol } from "core/protocol/index.js";
import { IMessenger } from "core/protocol/messenger";
import FileSystemIde from "core/util/filesystem";
import {
  ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoreBinaryMessenger } from "../src/IpcMessenger";

class ActiveStartupRefreshGate {
  private consumed = false;
  private markObserved!: () => void;
  private releaseRefresh!: () => void;
  readonly observed: Promise<void>;
  private readonly released: Promise<void>;

  constructor(private readonly targetBasename: string) {
    this.observed = new Promise<void>((resolve) => {
      this.markObserved = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.releaseRefresh = resolve;
    });
  }

  async hold(filepath: string): Promise<void> {
    if (this.consumed || !filepath.endsWith(this.targetBasename)) {
      return;
    }
    this.consumed = true;
    this.markObserved();
    await this.released;
  }

  release(): void {
    this.releaseRefresh();
  }
}

/**
 * Handles IDE messages from the binary subprocess, responding with plain data
 * matching the Kotlin CoreMessenger format: { messageType, data, messageId }.
 *
 * This bypasses the JS _handleLine auto-wrapper which would double-wrap
 * responses in { done, content, status }.
 */
class BinaryIdeHandler {
  private ide: IDE;
  private subprocess: ChildProcessWithoutNullStreams;
  private handlers: Record<string, (data: any) => Promise<any> | any> = {};
  private unfinishedLine: string | undefined;
  readonly showToastObservations: {
    type: string;
    message: string;
    otherParams: unknown[];
  }[] = [];

  constructor(
    subprocess: ChildProcessWithoutNullStreams,
    ide: IDE,
    private readonly activeStartupRefreshGate?: ActiveStartupRefreshGate,
  ) {
    this.ide = ide;
    this.subprocess = subprocess;
    this.registerHandlers();

    // Listen on stdout alongside CoreBinaryMessenger (EventEmitter allows multiple listeners)
    // Use setEncoding so split multibyte UTF-8 characters are decoded correctly
    subprocess.stdout.setEncoding("utf8");
    subprocess.stdout.on("data", (data: string) => this.handleData(data));
  }

  private registerHandlers() {
    const ide = this.ide;
    const h = this.handlers;
    h["getIdeInfo"] = () => ide.getIdeInfo();
    h["getIdeSettings"] = () => ide.getIdeSettings();
    h["getControlPlaneSessionInfo"] = () => undefined;
    h["getWorkspaceDirs"] = () => ide.getWorkspaceDirs();
    h["readFile"] = async (d) => {
      await this.activeStartupRefreshGate?.hold(d.filepath);
      return ide.readFile(d.filepath);
    };
    h["writeFile"] = (d) => ide.writeFile(d.path, d.contents);
    h["fileExists"] = (d) => ide.fileExists(d.filepath);
    h["showLines"] = (d) => ide.showLines(d.filepath, d.startLine, d.endLine);
    h["openFile"] = (d) => ide.openFile(d.path);
    h["openUrl"] = (d) => ide.openUrl(d.url);
    h["runCommand"] = (d) => ide.runCommand(d.command);
    h["saveFile"] = (d) => ide.saveFile(d.filepath);
    h["readRangeInFile"] = (d) => ide.readRangeInFile(d.filepath, d.range);
    h["getFileStats"] = (d) => ide.getFileStats(d.files);
    h["getGitRootPath"] = (d) => ide.getGitRootPath(d.dir);
    h["listDir"] = (d) => ide.listDir(d.dir);
    h["getRepoName"] = (d) => ide.getRepoName(d.dir);
    h["getTags"] = (d) => ide.getTags(d);
    h["isTelemetryEnabled"] = () => ide.isTelemetryEnabled();
    h["isWorkspaceRemote"] = () => false;
    h["getUniqueId"] = () => ide.getUniqueId();
    h["getDiff"] = (d) => ide.getDiff(d.includeUnstaged);
    h["getTerminalContents"] = () => ide.getTerminalContents();
    h["getOpenFiles"] = () => ide.getOpenFiles();
    h["getCurrentFile"] = () => ide.getCurrentFile();
    h["getPinnedFiles"] = () => ide.getPinnedFiles();
    h["getSearchResults"] = (d) => ide.getSearchResults(d.query, d.maxResults);
    h["getFileResults"] = (d) => ide.getFileResults(d.pattern);
    h["getProblems"] = (d) => ide.getProblems(d.filepath);
    h["getBranch"] = (d) => ide.getBranch(d.dir);
    h["subprocess"] = (d) => ide.subprocess(d.command, d.cwd);
    h["getDebugLocals"] = (d) => ide.getDebugLocals(d.threadIndex);
    h["getAvailableThreads"] = () => ide.getAvailableThreads();
    h["getTopLevelCallStackSources"] = (d) =>
      ide.getTopLevelCallStackSources(d.threadIndex, d.stackDepth);
    h["showToast"] = (data) => {
      const [type, message, ...otherParams] = data;
      this.showToastObservations.push({ type, message, otherParams });
    };
    h["readSecrets"] = (d) => ide.readSecrets(d.keys);
    h["writeSecrets"] = (d) => ide.writeSecrets(d.secrets);
    h["removeFile"] = (d) => ide.removeFile(d.path);
  }

  private handleData(data: string) {
    const d = data;
    const lines = d.split(/\r\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return;

    if (this.unfinishedLine) {
      lines[0] = this.unfinishedLine + lines[0];
      this.unfinishedLine = undefined;
    }
    if (!d.endsWith("\r\n")) {
      this.unfinishedLine = lines.pop();
    }
    lines.forEach((line) => this.handleLine(line));
  }

  private async handleLine(line: string) {
    let msg: { messageType: string; messageId: string; data?: any };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON, ignore
    }

    const handler = this.handlers[msg.messageType];
    if (!handler) return; // not an IDE message, let CoreBinaryMessenger handle it

    try {
      const result = await handler(msg.data);
      this.respond(msg.messageType, result, msg.messageId);
    } catch (e) {
      this.respond(msg.messageType, undefined, msg.messageId);
    }
  }

  private respond(messageType: string, data: any, messageId: string) {
    const response = JSON.stringify({ messageType, data, messageId });
    this.subprocess.stdin.write(response + "\r\n");
  }
}

jest.setTimeout(90_000);

const READINESS_TIMEOUT_MS = 20_000;
const CAPABILITY_TIMEOUT_MS = 20_000;
const PACKAGED_INDEX_SENTINEL_NAME = "PACKAGED_INDEX_SENTINEL";
const PACKAGED_INDEX_SENTINEL_SOURCE = `export const ${PACKAGED_INDEX_SENTINEL_NAME} = "ready";`;
const PACKAGED_INDEX_SENTINEL_FILE = "packaged-runtime-index-sentinel.ts";
const PACKAGED_CAPABILITY_RESULT_PREFIX = "PACKAGED_RUNTIME_CAPABILITY_RESULT=";
const INDEXING_DISABLED_WARNING =
  "Codebase indexing disabled - Your Linux system lacks required CPU features (AVX2, FMA)";

type NativePlatform = "darwin" | "linux" | "win32";
type NativeArch = "arm64" | "x64";
type ProcessState = {
  pid?: number;
  killed: boolean;
  error?: SerializedError;
  exit?: ProcessObservation;
  close?: ProcessObservation;
};
type ProcessObservation = {
  code: number | null;
  signal: NodeJS.Signals | null;
};
type SerializedError = {
  name: string;
  message: string;
  stack?: string;
};
type ReadinessFailure =
  | { kind: "error"; error: Error }
  | { kind: "exit"; observation: ProcessObservation }
  | { kind: "close"; observation: ProcessObservation };
type RequestOutcome =
  | { kind: "response"; response: any }
  | { kind: "timeout" }
  | ReadinessFailure;
type RipgrepObservation = {
  executable: string;
  args: string[];
  pid?: number;
  timeout: boolean;
  error?: SerializedError;
  exit?: ProcessObservation;
  close?: ProcessObservation;
  stdout: string;
  stderr: string;
};
type CapabilityResult = {
  target: string;
  nativeHost: string;
  hostNode: string;
  artifactRelativePath: string;
  binarySha256: string;
  ripgrepSha256: string;
  indexNodeSha256: string;
  sqliteAddonSha256: string;
  ping: string;
  sqlite: boolean;
  ripgrep: boolean;
  completion: string;
  indexing: "indexed" | "degraded";
  degradedReason: string | null;
  quarantine: string;
  signingState: string;
  durations: Record<string, number>;
};

function autodetectPlatformAndArch(): [NativePlatform, NativeArch] {
  const platform = {
    aix: "linux",
    darwin: "darwin",
    freebsd: "linux",
    linux: "linux",
    openbsd: "linux",
    sunos: "linux",
    win32: "win32",
    android: "linux",
    cygwin: "win32",
    netbsd: "linux",
    haiku: "linux",
  }[process.platform] as NativePlatform | undefined;
  const arch = {
    arm: "arm64",
    arm64: "arm64",
    ia32: "x64",
    loong64: "arm64",
    mips: "arm64",
    mipsel: "arm64",
    ppc: "x64",
    ppc64: "x64",
    riscv64: "arm64",
    s390: "x64",
    s390x: "x64",
    x64: "x64",
  }[process.arch] as NativeArch | undefined;

  if (!platform || !arch) {
    throw new Error(
      `Unsupported native test host: ${process.platform}-${process.arch}`,
    );
  }

  return [platform, arch];
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "NonError",
    message: String(error),
  };
}

function loadNativeAddon(modulePath: string) {
  const absoluteModulePath = path.resolve(modulePath);
  const outcome = spawnSync(
    process.execPath,
    ["--eval", "require(process.argv[1]);", absoluteModulePath],
    {
      encoding: "utf8",
      timeout: CAPABILITY_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (outcome.error || outcome.status !== 0) {
    const serialized = serializeError(
      outcome.error ??
        new Error(
          `exit=${outcome.status} signal=${outcome.signal} stderr=${outcome.stderr.trim()}`,
        ),
    );
    throw new Error(
      `Failed to load native addon ${absoluteModulePath} with ${process.version}: ${serialized.name}: ${serialized.message}`,
    );
  }
}

function requireHostNodeMajor(expectedMajor: number) {
  const actualMajor = Number(process.versions.node.split(".")[0]);
  if (actualMajor !== expectedMajor) {
    throw new Error(
      `Packaged-runtime test requires Jest host Node ${expectedMajor}; received ${process.version}`,
    );
  }
}

function sha256File(filePath: string): string {
  return createHash("sha256")
    .update(Uint8Array.from(fs.readFileSync(filePath)))
    .digest("hex");
}

function getErrorCode(error: Error): string | undefined {
  const { code } = error as Error & { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function inspectMacQuarantine(filePath: string): "absent" | "removed" {
  const before = spawnSync("xattr", ["-p", "com.apple.quarantine", filePath], {
    encoding: "utf8",
  });
  if (before.error) {
    throw new Error(
      `Unable to inspect quarantine for ${path.basename(filePath)}: ${before.error.message}`,
    );
  }
  if (before.status !== 0) {
    if (before.status === 1) {
      return "absent";
    }
    throw new Error(
      `Unable to inspect quarantine for ${path.basename(filePath)}: ${String(before.stderr)}`,
    );
  }

  const remove = spawnSync("xattr", ["-d", "com.apple.quarantine", filePath], {
    encoding: "utf8",
  });
  if (remove.error || remove.status !== 0) {
    throw new Error(
      `Unable to remove quarantine for ${path.basename(filePath)}: ${remove.error?.message ?? String(remove.stderr)}`,
    );
  }

  const after = spawnSync("xattr", ["-p", "com.apple.quarantine", filePath], {
    encoding: "utf8",
  });
  if (after.error || after.status === 0) {
    throw new Error(
      `Quarantine remains on ${path.basename(filePath)} after removal`,
    );
  }
  if (after.status !== 1) {
    throw new Error(
      `Unable to verify quarantine removal for ${path.basename(filePath)}: ${String(after.stderr)}`,
    );
  }
  return "removed";
}

function inspectMacSigningState(filePath: string): string {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", filePath], {
    encoding: "utf8",
  });
  const errorCode = result.error ? getErrorCode(result.error) : undefined;
  if (errorCode === "ENOENT") {
    return "codesign-unavailable";
  }
  if (result.error) {
    return `codesign-error:${errorCode ?? result.error.name}`;
  }
  return result.status === 0 ? "signed" : "unsigned";
}

function unwrapBinaryResponse(response: any): any {
  return response?.content !== undefined ? response.content : response;
}

describe("Test Suite", () => {
  let messenger: IMessenger<ToIdeProtocol, FromIdeProtocol>;
  let subprocess: ChildProcessWithoutNullStreams | undefined;
  let processErrorPromise: Promise<ReadinessFailure> | undefined;
  let processExitPromise: Promise<ReadinessFailure> | undefined;
  let closePromise: Promise<ProcessObservation> | undefined;
  let continueGlobalDir: string | undefined;
  let workspace: string | undefined;
  let workspaceUri: string | undefined;
  let executablePath: string | undefined;
  let ripgrepPath: string | undefined;
  let indexNodePath: string | undefined;
  let sqliteAddonPath: string | undefined;
  let nativeTarget: string | undefined;
  let readinessResult: string | undefined;
  let completionResult: string | undefined;
  let ideHandler: BinaryIdeHandler | undefined;
  let activeStartupRefreshGate: ActiveStartupRefreshGate | undefined;
  let ripgrepObservation: RipgrepObservation | undefined;
  let quarantineResult = "not-applicable";
  let signingState = "not-applicable";
  const durations: Record<string, number> = {};
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const processState: ProcessState = {
    killed: false,
  };

  function readCoreLog(): string | undefined {
    if (!continueGlobalDir) {
      return undefined;
    }
    const coreLogPath = path.join(continueGlobalDir, "logs", "core.log");
    try {
      return fs.existsSync(coreLogPath)
        ? fs.readFileSync(coreLogPath, "utf8")
        : undefined;
    } catch (error) {
      return `Unable to read core log: ${serializeError(error).message}`;
    }
  }

  function diagnostic(error?: unknown) {
    return {
      executablePath,
      target: nativeTarget,
      timeoutMs: READINESS_TIMEOUT_MS,
      timedOut,
      workspaceUri,
      ripgrep: ripgrepObservation,
      coreLog: readCoreLog(),
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      processState: {
        ...processState,
        killed: subprocess?.killed ?? processState.killed,
      },
      error: error === undefined ? undefined : serializeError(error),
    };
  }

  function failWithDiagnostics(message: string, error?: unknown): never {
    throw new Error(
      `${message}\n${JSON.stringify(diagnostic(error), null, 2)}`,
    );
  }

  let timedOut = false;

  async function request(messageType: string, data: any): Promise<any> {
    if (
      !subprocess ||
      !processErrorPromise ||
      !processExitPromise ||
      !closePromise
    ) {
      failWithDiagnostics("Packaged runtime request prerequisites are absent");
    }
    if (processState.error || processState.exit || processState.close) {
      failWithDiagnostics(
        `Packaged runtime ended before request: ${messageType}`,
      );
    }

    const child = subprocess;
    const errorPromise = processErrorPromise;
    const exitPromise = processExitPromise;
    const childClosePromise = closePromise;
    const started = Date.now();
    let timeout: NodeJS.Timeout | undefined;
    let outcome: RequestOutcome;
    try {
      outcome = await Promise.race([
        messenger.request(messageType as any, data).then((response) => ({
          kind: "response" as const,
          response: unwrapBinaryResponse(response),
        })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ kind: "timeout" }),
            CAPABILITY_TIMEOUT_MS,
          );
        }),
        errorPromise,
        exitPromise,
        childClosePromise.then((observation) => ({
          kind: "close" as const,
          observation,
        })),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      durations[messageType] = Date.now() - started;
    }

    if (outcome.kind === "response") {
      return outcome.response;
    }
    if (outcome.kind === "timeout") {
      timedOut = true;
      child.kill();
      processState.killed = child.killed;
    }
    if (outcome.kind !== "close") {
      await childClosePromise;
    }
    failWithDiagnostics(
      `Packaged runtime request failed: ${messageType} (${outcome.kind})`,
      outcome.kind === "error" ? outcome.error : outcome,
    );
  }

  async function requireReadiness(): Promise<string> {
    if (
      !subprocess ||
      !processErrorPromise ||
      !processExitPromise ||
      !closePromise
    ) {
      failWithDiagnostics("Packaged runtime subprocess was not started");
    }

    const child = subprocess;
    const errorPromise = processErrorPromise;
    const exitPromise = processExitPromise;

    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        processState.killed = child.killed;
        resolve("timeout");
      }, READINESS_TIMEOUT_MS);
    });

    const closeFailurePromise = closePromise.then<ReadinessFailure>(
      (observation) => ({
        kind: "close",
        observation,
      }),
    );

    const responsePromise = messenger
      .request("ping" as any, "ping")
      .then((response) => ({
        kind: "response" as const,
        response: unwrapBinaryResponse(response),
      }));

    const readiness = await Promise.race([
      responsePromise,
      timeoutPromise,
      errorPromise,
      exitPromise,
      closeFailurePromise,
    ]);

    if (timeout) {
      clearTimeout(timeout);
    }

    if (readiness === "timeout") {
      await closePromise;
      failWithDiagnostics("Timed out waiting for packaged runtime readiness");
    }

    if (readiness.kind === "response") {
      if (readiness.response !== "pong") {
        failWithDiagnostics(
          `Unexpected packaged runtime readiness response: ${String(
            readiness.response,
          )}`,
        );
      }
      return readiness.response;
    }

    await closePromise;
    failWithDiagnostics(
      `Packaged runtime ended before readiness: ${readiness.kind}`,
      readiness.kind === "error" ? readiness.error : readiness.observation,
    );
  }

  async function runPackagedRipgrep(): Promise<void> {
    if (!ripgrepPath || !workspace || !nativeTarget) {
      failWithDiagnostics(
        "Packaged ripgrep prerequisites were not initialized",
      );
    }

    const args = [
      "--fixed-strings",
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      PACKAGED_INDEX_SENTINEL_NAME,
      ".",
    ];
    const started = Date.now();
    const ripgrep = spawn(ripgrepPath, args, {
      cwd: workspace,
      windowsHide: true,
    });
    const observation: RipgrepObservation = {
      executable: ripgrepPath,
      args,
      pid: ripgrep.pid,
      timeout: false,
      stdout: "",
      stderr: "",
    };
    ripgrepObservation = observation;
    ripgrep.stdout.setEncoding("utf8");
    ripgrep.stderr.setEncoding("utf8");
    ripgrep.stdout.on("data", (data: string) => {
      observation.stdout += data;
    });
    ripgrep.stderr.on("data", (data: string) => {
      observation.stderr += data;
    });

    const closePromise = new Promise<ProcessObservation>((resolve) => {
      ripgrep.once("close", (code, signal) => {
        const close = { code, signal };
        observation.close = close;
        resolve(close);
      });
    });
    const errorPromise = new Promise<SerializedError>((resolve) => {
      ripgrep.once("error", (error) => {
        const serialized = serializeError(error);
        observation.error = serialized;
        resolve(serialized);
      });
    });
    ripgrep.once("exit", (code, signal) => {
      observation.exit = { code, signal };
    });

    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      closePromise.then((close) => ({ kind: "close" as const, close })),
      errorPromise.then((error) => ({ kind: "error" as const, error })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ kind: "timeout" }),
          CAPABILITY_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    durations.ripgrep = Date.now() - started;

    if (outcome.kind === "timeout") {
      observation.timeout = true;
      ripgrep.kill();
      await closePromise;
      failWithDiagnostics("Packaged ripgrep timed out");
    }
    if (outcome.kind === "error") {
      await closePromise;
      failWithDiagnostics("Packaged ripgrep failed to start", outcome.error);
    }
    if (outcome.close.code !== 0 || outcome.close.signal !== null) {
      failWithDiagnostics(
        `Packaged ripgrep exited unsuccessfully: ${JSON.stringify(outcome.close)}`,
      );
    }

    const lines = observation.stdout
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const normalized = lines[0].replace(/\\/g, "/").replace(/^\.\//, "");
    expect(normalized).toBe(
      `${PACKAGED_INDEX_SENTINEL_FILE}:1:${PACKAGED_INDEX_SENTINEL_SOURCE}`,
    );
  }

  beforeAll(async () => {
    requireHostNodeMajor(24);

    const [platform, arch] = autodetectPlatformAndArch();
    nativeTarget = `${platform}-${arch}`;
    const binaryDir = path.join(__dirname, "..", "bin", nativeTarget);
    const exe = platform === "win32" ? ".exe" : "";
    executablePath = path.join(binaryDir, `continue-binary${exe}`);
    ripgrepPath = path.join(binaryDir, `rg${exe}`);
    indexNodePath = path.join(binaryDir, "index.node");
    sqliteAddonPath = path.join(
      binaryDir,
      "build",
      "Release",
      "node_sqlite3.node",
    );
    const expectedItems = [
      `continue-binary${exe}`,
      `rg${exe}`,
      "index.node",
      "package.json",
      "build/Release/node_sqlite3.node",
    ];
    expectedItems.forEach((item) => {
      expect(fs.existsSync(path.join(binaryDir, item))).toBe(true);
    });

    loadNativeAddon(indexNodePath);
    loadNativeAddon(sqliteAddonPath);

    const bundlePaths = [
      executablePath,
      ripgrepPath,
      indexNodePath,
      sqliteAddonPath,
    ];
    if (platform !== "win32") {
      for (const bundlePath of bundlePaths) {
        fs.chmodSync(bundlePath, 0o755);
      }
      if (platform === "darwin") {
        quarantineResult = JSON.stringify(
          Object.fromEntries(
            bundlePaths.map((bundlePath) => [
              path.basename(bundlePath),
              inspectMacQuarantine(bundlePath),
            ]),
          ),
        );
        signingState = inspectMacSigningState(executablePath);
      }
    }

    continueGlobalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "continue-packaged-runtime-"),
    );
    workspace = path.join(continueGlobalDir, "workspace");
    workspaceUri = pathToFileURL(workspace).toString();
    activeStartupRefreshGate = new ActiveStartupRefreshGate(
      PACKAGED_INDEX_SENTINEL_FILE,
    );
    fs.mkdirSync(workspace);
    fs.writeFileSync(
      path.join(workspace, PACKAGED_INDEX_SENTINEL_FILE),
      `${PACKAGED_INDEX_SENTINEL_SOURCE}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(continueGlobalDir, "config.yaml"),
      `name: Packaged Runtime Capability Test
version: 0.0.1
schema: v1
models:
  - name: Mock Chat
    provider: mock
    model: packaged-runtime-test
    roles:
      - chat
  - name: Deterministic Test Embeddings
    provider: transformers.js
    model: all-MiniLM-L6-v2
    roles:
      - embed
context:
  - provider: codebase
`,
      "utf8",
    );

    const childEnvironment = {
      ...process.env,
      CONTINUE_GLOBAL_DIR: continueGlobalDir,
      NODE_ENV: "test",
    };
    if (childEnvironment.NODE_ENV !== "test") {
      failWithDiagnostics("Packaged runtime child must retain NODE_ENV=test");
    }

    try {
      subprocess = spawn(executablePath, {
        cwd: binaryDir,
        env: childEnvironment,
      });
    } catch (error) {
      fs.rmSync(continueGlobalDir, { recursive: true, force: true });
      continueGlobalDir = undefined;
      failWithDiagnostics("Error spawning packaged runtime", error);
    }

    processState.pid = subprocess.pid;
    processState.killed = subprocess.killed;

    subprocess.stdout.on("data", (data: Buffer | string) => {
      stdoutChunks.push(data.toString());
    });
    subprocess.stderr.on("data", (data: Buffer | string) => {
      stderrChunks.push(data.toString());
    });
    processErrorPromise = new Promise((resolve) => {
      subprocess?.once("error", (error) => {
        processState.error = serializeError(error);
        resolve({ kind: "error", error });
      });
    });
    processExitPromise = new Promise((resolve) => {
      subprocess?.once("exit", (code, signal) => {
        const observation = { code, signal };
        processState.exit = observation;
        resolve({ kind: "exit", observation });
      });
    });
    closePromise = new Promise((resolve) => {
      subprocess?.once("close", (code, signal) => {
        const observation = { code, signal };
        processState.close = observation;
        processState.killed = subprocess?.killed ?? processState.killed;
        resolve(observation);
      });
    });

    messenger = new CoreBinaryMessenger<ToIdeProtocol, FromIdeProtocol>(
      subprocess,
    );

    const ide = new FileSystemIde(workspaceUri);
    ideHandler = new BinaryIdeHandler(
      subprocess,
      ide,
      activeStartupRefreshGate,
    );

    try {
      readinessResult = await requireReadiness();
    } catch (error) {
      failWithDiagnostics("Packaged runtime readiness failed", error);
    }
  });

  afterAll(async () => {
    const stdioClosePromise = subprocess
      ? Promise.all(
          [subprocess.stdin, subprocess.stdout, subprocess.stderr].map(
            (stream) =>
              stream.closed
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                    stream.once("close", resolve);
                  }),
          ),
        )
      : Promise.resolve();

    try {
      if (subprocess && !processState.close) {
        subprocess.kill();
        processState.killed = subprocess.killed;
      }
      if (closePromise) {
        await closePromise;
      }
      await stdioClosePromise;
    } finally {
      if (continueGlobalDir) {
        fs.rmSync(continueGlobalDir, { recursive: true, force: true });
        continueGlobalDir = undefined;
      }
    }
  });

  it("should respond to ping with pong", async () => {
    expect(readinessResult).toBe("pong");
  });

  it("keeps the packaged core alive when force reindex clears during an active startup refresh", async () => {
    expect(activeStartupRefreshGate).toBeDefined();
    expect(continueGlobalDir).toBeDefined();
    expect(workspaceUri).toBeDefined();

    const overlapEstablished = await Promise.race([
      activeStartupRefreshGate!.observed.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), CAPABILITY_TIMEOUT_MS);
      }),
    ]);
    if (!overlapEstablished) {
      failWithDiagnostics(
        "Unable to establish an unsettled packaged startup refresh",
      );
    }

    const indexSqlitePath = path.join(
      continueGlobalDir!,
      "index",
      "index.sqlite",
    );
    expect(fs.existsSync(indexSqlitePath)).toBe(true);
    const initialIndexIdentity = (() => {
      const stat = fs.statSync(indexSqlitePath);
      return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    })();
    const currentIndexIdentity = () => {
      try {
        const stat = fs.statSync(indexSqlitePath);
        return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      } catch {
        return "missing";
      }
    };

    const forceOutcome = request("index/forceReIndex", {
      dirs: [workspaceUri],
      shouldClearIndexes: true,
    }).then(
      (response) => ({ kind: "response" as const, response }),
      (error) => ({ kind: "error" as const, error }),
    );

    const boundaryObservation = await Promise.race([
      forceOutcome.then((outcome) => ({
        kind: "force-settled-before-release" as const,
        outcome,
      })),
      (async () => {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const identity = currentIndexIdentity();
          if (identity !== initialIndexIdentity) {
            return {
              kind: "database-changed-before-release" as const,
              identity,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return { kind: "quiesced" as const };
      })(),
    ]);

    activeStartupRefreshGate!.release();
    const forceResult = await forceOutcome;

    expect(boundaryObservation).toEqual({ kind: "quiesced" });
    if (forceResult.kind === "error") {
      throw forceResult.error;
    }
    expect(currentIndexIdentity()).not.toBe(initialIndexIdentity);
    expect(await request("ping", "ping")).toBe("pong");

    const contextItems = await request("context/getContextItems", {
      name: "codebase",
      query: PACKAGED_INDEX_SENTINEL_NAME,
      fullInput: PACKAGED_INDEX_SENTINEL_NAME,
      selectedCode: [],
      isInAgentMode: false,
    });
    expect(
      contextItems.some((item: { content?: unknown }) =>
        String(item.content).includes(PACKAGED_INDEX_SENTINEL_NAME),
      ),
    ).toBe(true);

    const runtimeOutput = [
      stdoutChunks.join(""),
      stderrChunks.join(""),
      readCoreLog() ?? "",
    ].join("\n");
    expect(runtimeOutput).not.toMatch(
      /SQLITE_MISUSE|Database handle is closed|unhandled rejection/i,
    );
  });

  it("should create .continue directory at the specified location with expected files", async () => {
    expect(continueGlobalDir).toBeDefined();
    expect(fs.existsSync(continueGlobalDir!)).toBe(true);

    // Many of the files are only created when trying to load the config
    await request("config/getSerializedProfileInfo", undefined);

    const expectedFiles = ["logs/core.log", "index/autocompleteCache.sqlite"];

    const missingFiles = expectedFiles.filter((file) => {
      const filePath = path.join(continueGlobalDir!, file);
      return !fs.existsSync(filePath);
    });

    expect(missingFiles).toEqual([]);
    if (missingFiles.length > 0) {
      console.log("Missing files:", missingFiles);
    }
  });

  it("should return valid config object", async () => {
    const { result } = await request(
      "config/getSerializedProfileInfo",
      undefined,
    );
    const { config } = result;
    expect(config).toHaveProperty("modelsByRole");
    expect(config).toHaveProperty("contextProviders");
    expect(config).toHaveProperty("slashCommands");
  });

  it("should properly handle history requests", async () => {
    const sessionId = "test-session-id";
    await request("history/save", {
      history: [],
      sessionId,
      title: "test-title",
      workspaceDirectory: "test-workspace-directory",
    });
    const sessions = await request("history/list", {});
    expect(sessions.length).toBeGreaterThan(0);

    const session = await request("history/load", {
      id: sessionId,
    });
    expect(session).toHaveProperty("history");

    await request("history/delete", {
      id: sessionId,
    });
    const sessionsAfterDelete = await request("history/list", {});
    expect(sessionsAfterDelete.length).toBe(sessions.length - 1);
  });

  it("should add and delete a model from config.json", async () => {
    const model: SerializedContinueConfig["models"][number] = {
      title: "Test Model",
      provider: "openai",
      model: "gpt-3.5-turbo",
      underlyingProviderName: "openai",
    };
    await request("config/addModel", { model });
    const {
      result: { config },
    } = await request("config/getSerializedProfileInfo", undefined);

    expect(
      config!.modelsByRole.chat.some(
        (m: ModelDescription) => m.title === model.title,
      ),
    ).toBe(true);

    await request("config/deleteModel", { title: model.title });
    const {
      result: { config: configAfterDelete },
    } = await request("config/getSerializedProfileInfo", undefined);
    expect(
      configAfterDelete!.modelsByRole.chat.some(
        (m: ModelDescription) => m.title === model.title,
      ),
    ).toBe(false);
  });

  it("should make an LLM completion", async () => {
    const model: SerializedContinueConfig["models"][number] = {
      title: "Test Model",
      provider: "mock",
      model: "gpt-3.5-turbo",
      underlyingProviderName: "mock",
    };

    try {
      await request("config/addModel", { model });

      const resp = await request("llm/complete", {
        prompt: "Say 'Hello' and nothing else",
        completionOptions: {},
        title: "Test Model",
      });
      expect(resp).toBe("Test Completion");
      completionResult = resp;
    } catch (error) {
      failWithDiagnostics("Packaged runtime mock completion failed", error);
    }
  });

  it("should prove packaged ripgrep and supported codebase indexing", async () => {
    expect(continueGlobalDir).toBeDefined();
    expect(workspace).toBeDefined();
    expect(workspaceUri).toBeDefined();
    expect(ideHandler).toBeDefined();
    expect(ripgrepPath).toBeDefined();
    expect(indexNodePath).toBeDefined();
    expect(sqliteAddonPath).toBeDefined();
    expect(completionResult).toBe("Test Completion");

    try {
      await runPackagedRipgrep();

      const profile = await request(
        "config/getSerializedProfileInfo",
        undefined,
      );
      const config = profile.result.config;
      let indexing: CapabilityResult["indexing"];
      let degradedReason: string | null = null;
      let indexSqlite = false;

      if (!config.disableIndexing) {
        await request("index/forceReIndex", {
          dirs: [workspaceUri],
        });

        const indexSqlitePath = path.join(
          continueGlobalDir!,
          "index",
          "index.sqlite",
        );
        const lanceDbPath = path.join(continueGlobalDir!, "index", "lancedb");
        indexSqlite = fs.existsSync(indexSqlitePath);
        expect(indexSqlite).toBe(true);
        expect(fs.readdirSync(lanceDbPath).length).toBeGreaterThan(0);

        const contextItems = await request("context/getContextItems", {
          name: "codebase",
          query: PACKAGED_INDEX_SENTINEL_NAME,
          fullInput: PACKAGED_INDEX_SENTINEL_NAME,
          selectedCode: [],
          isInAgentMode: false,
        });
        expect(
          contextItems.some((item: { content?: unknown }) =>
            String(item.content).includes(PACKAGED_INDEX_SENTINEL_NAME),
          ),
        ).toBe(true);
        indexing = "indexed";
      } else {
        const isLinuxX64 = nativeTarget === "linux-x64";
        const cpuInfo = isLinuxX64
          ? fs.readFileSync("/proc/cpuinfo", "utf8").toLowerCase()
          : "";
        expect(isLinuxX64).toBe(true);
        expect(cpuInfo).not.toMatch(/\bavx2\b/);
        expect(cpuInfo).not.toMatch(/\bfma\b/);
        expect(
          ideHandler!.showToastObservations.some(
            ({ message }) => message === INDEXING_DISABLED_WARNING,
          ),
        ).toBe(true);
        expect(await request("ping", "ping")).toBe("pong");
        indexing = "degraded";
        degradedReason = "linux-x64-missing-avx2-or-fma";
      }

      const coreLog = readCoreLog();
      if (!coreLog) {
        failWithDiagnostics("Packaged runtime Core log is absent");
      }
      const runtimeDiagnostics = `${coreLog}\n${stderrChunks.join("")}`;
      const forbiddenDiagnostics = [
        "tree-sitter-typescript.wasm'",
        "no such table: chunks",
        "Failed to load LanceDB",
        "Cannot find module '@lancedb/",
        "EBUSY",
      ];
      for (const forbiddenDiagnostic of forbiddenDiagnostics) {
        if (runtimeDiagnostics.includes(forbiddenDiagnostic)) {
          failWithDiagnostics(
            `Packaged runtime emitted forbidden diagnostic: ${forbiddenDiagnostic}`,
          );
        }
      }

      const result: CapabilityResult = {
        target: nativeTarget!,
        nativeHost: `${process.platform}-${process.arch}`,
        hostNode: process.version,
        artifactRelativePath: path.posix.join("binary", "bin", nativeTarget!),
        binarySha256: sha256File(executablePath!),
        ripgrepSha256: sha256File(ripgrepPath!),
        indexNodeSha256: sha256File(indexNodePath!),
        sqliteAddonSha256: sha256File(sqliteAddonPath!),
        ping: readinessResult!,
        sqlite: indexSqlite,
        ripgrep: true,
        completion: completionResult!,
        indexing,
        degradedReason,
        quarantine: quarantineResult,
        signingState,
        durations,
      };
      console.log(
        `${PACKAGED_CAPABILITY_RESULT_PREFIX}${JSON.stringify(result)}`,
      );
    } catch (error) {
      failWithDiagnostics("Packaged runtime capability harness failed", error);
    }
  });
});
