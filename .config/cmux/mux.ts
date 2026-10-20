#!/usr/bin/env bun
import { $ } from "bun";
import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";

const defaultCommandTimeoutMs = readPositiveIntEnv("MUX_COMMAND_TIMEOUT_MS", 60000);
const defaultMaxOutputBytes = readPositiveIntEnv("MUX_MAX_COMMAND_OUTPUT_BYTES", 1024 * 1024);
const defaultReadLines = readPositiveIntEnv("MUX_DEFAULT_READ_LINES", 80);
const maxReadLines = readPositiveIntEnv("MUX_MAX_READ_LINES", 240);
const promptPreviewChars = readPositiveIntEnv("MUX_PROMPT_PREVIEW_CHARS", 240);
const defaultSubagentGroupName = "Subagents";
const githubWatchStatePath = join(homedir(), ".cmuxterm", "github-watch-state.json");
const githubWatchLaunchAgentPath = join(
  homedir(),
  "Library",
  "LaunchAgents",
  "com.flexport.mux-github-watch.plist"
);
const githubWatchLaunchAgentLabel = "com.flexport.mux-github-watch";
const githubStatusKey = "github-pr";
const githubReviewStatusKey = "github-review";

type Worker = {
  id: string;
  name: string;
  agent: string;
  repoRoot: string;
  repoColor?: string;
  cwd: string;
  branch?: string;
  groupRef?: string;
  groupName?: string;
  managedGroup?: boolean;
  worktreePath?: string;
  resumeSession?: string;
  createdAt: string;
  windowRef: string;
  workspaceRef: string;
  surfaceRef: string;
  launchCommand: string;
  prompt?: string;
  status: "active" | "closed";
  closedAt?: string;
};

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

type Registry = {
  version: 1;
  workers: Worker[];
};

type CmuxWindow = {
  id: string;
  index?: number;
};

type CmuxWorkspaceList = {
  window_ref?: string;
  workspaces?: Array<{
    custom_title?: string | null;
    current_directory?: string;
    ref?: string;
    id?: string;
    index?: number;
    title?: string;
  }>;
};

type CmuxPaneList = {
  panes?: Array<{
    focused?: boolean;
    ref?: string;
    selected_surface_ref?: string;
    surface_refs?: string[];
  }>;
};

type CmuxSurfaceList = {
  surfaces?: Array<{
    ref?: string;
    selected?: boolean;
    title?: string;
    type?: string;
  }>;
};

type GitHubPullRequestSummary = {
  headRefName: string;
  headRefOid: string;
  number: number;
  title: string;
  url: string;
};

type GitHubReview = {
  author?: { login?: string } | null;
  id: string;
  state: string;
  submittedAt?: string | null;
};

type GitHubCheck = {
  __typename?: string;
  completedAt?: string;
  conclusion?: string;
  context?: string;
  detailsUrl?: string;
  name?: string;
  startedAt?: string;
  state?: string;
  status?: string;
  targetUrl?: string;
  workflowName?: string;
};

type GitHubPullRequest = GitHubPullRequestSummary & {
  author?: { login?: string } | null;
  reviewDecision?: string;
  reviews: GitHubReview[];
  statusCheckRollup: GitHubCheck[];
  updatedAt?: string;
};

type GitHubWatchState = {
  version: 1;
  pullRequests: Record<
    string,
    {
      failedCheckKeys: string[];
      headRefOid: string;
      lastSeenAt: string;
      reviewIds: string[];
    }
  >;
};

type GitHubWatchSummary = {
  errors: string[];
  liveWorkspaces: number;
  matchedPullRequests: number;
  notifications: Array<{
    body: string;
    title: string;
    worker: string;
  }>;
};

const registryPath = join(homedir(), ".cmuxterm", "mux-workers.json");
const registryLockPath = `${registryPath}.lock`;
const subcommand = process.argv[2];

switch (subcommand) {
  case "start":
    await start();
    break;
  case "close":
    await legacyClose();
    break;
  case "spawn":
    await spawnWorker();
    break;
  case "list":
  case "ls":
    await listWorkers();
    break;
  case "sync":
  case "retrack":
    await syncWorkers();
    break;
  case "send":
  case "ask":
    await sendWorker();
    break;
  case "read":
    await readWorker();
    break;
  case "focus":
    await focusWorker();
    break;
  case "stop":
  case "rm":
    await closeWorker();
    break;
  case "watch-github":
    await watchGithub();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    process.exit(subcommand ? 0 : 1);
  default:
    console.error(`Unknown command: ${subcommand}`);
    printUsage();
    process.exit(1);
}

function printUsage() {
  console.error(`Usage:
  mux spawn [path] [--name <name>] [--id <id>] [--branch <branch>] [--agent codex|claude] [--prompt <text>] [--window current|new|<ref>] [--group auto|none|<name|ref>] [--model <model>] [--focus] [--resume <session-id>] [--no-yolo] [--full-json]
  mux list [--json] [--all] [--full]
  mux sync [--window <ref>] [--dry-run] [--no-close-stale]
  mux send <worker> <message>
  mux read <worker> [--lines <n>]
  mux focus <worker>
  mux stop <worker> [--remove-worktree]
  mux watch-github once [--dry-run] [--notify-existing] [--state-file <path>]
  mux watch-github run [--interval <seconds>] [--state-file <path>]
  mux watch-github install [--interval <seconds>]
  mux watch-github status
  mux watch-github uninstall

Legacy:
  mux start [path] [-n <name>] [-w <branch>] [-p <prompt>]
  mux close [workspace]
`);
}

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!stream) return { text: "", truncated: false };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let storedBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = maxBytes - storedBytes;
    if (remaining > 0) {
      const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
      chunks.push(chunk);
      storedBytes += chunk.byteLength;
    }
    if (value.byteLength > remaining) truncated = true;
  }

  const buffered = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text = new TextDecoder().decode(buffered);
  if (truncated) text += `\n[mux: output truncated at ${maxBytes} bytes]\n`;
  return { text, truncated };
}

async function run(
  args: string[],
  options: { allowFail?: boolean; maxOutputBytes?: number; timeoutMs?: number } = {}
): Promise<RunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
  const timeoutMs = options.timeoutMs ?? defaultCommandTimeoutMs;
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CMUX_QUIET: "1" },
  });
  const stdoutPromise = readBoundedStream(proc.stdout, maxOutputBytes);
  const stderrPromise = readBoundedStream(proc.stderr, maxOutputBytes);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // The process may have exited between the timeout firing and kill.
    }
  }, timeoutMs);
  const exitCode = await proc.exited.finally(() => clearTimeout(timeout));
  const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);
  const stdout = stdoutResult.text;
  const stderr = stderrResult.text;
  const truncated = stdoutResult.truncated || stderrResult.truncated;

  if ((exitCode !== 0 || timedOut) && !options.allowFail) {
    const rendered = args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
    const timeoutSuffix = timedOut ? ` after ${timeoutMs}ms` : "";
    throw new Error(`${rendered} failed with exit ${exitCode}${timeoutSuffix}\n${stderr.trim() || stdout.trim()}`);
  }

  return { stdout, stderr, exitCode, truncated };
}

async function runJson<T>(args: string[]) {
  const { stdout } = await run(args);
  return JSON.parse(stdout) as T;
}

function loadRegistry(): Registry {
  if (!existsSync(registryPath)) {
    return { version: 1, workers: [] };
  }

  try {
    return JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  } catch {
    return { version: 1, workers: [] };
  }
}

function saveRegistry(registry: Registry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function compactPrompt(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim();
}

function promptBytes(prompt: string) {
  return new TextEncoder().encode(prompt).byteLength;
}

function publicWorker(worker: Worker, includePrompt = false) {
  if (includePrompt || !worker.prompt) return worker;

  const { prompt, ...rest } = worker;
  const compact = compactPrompt(prompt);
  return {
    ...rest,
    promptPreview:
      compact.length > promptPreviewChars ? `${compact.slice(0, promptPreviewChars).trimEnd()}...` : compact,
    promptBytes: promptBytes(prompt),
  };
}

async function withRegistryLock<T>(fn: () => T | Promise<T>) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const deadline = Date.now() + 10000;

  while (true) {
    try {
      mkdirSync(registryLockPath);
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for registry lock: ${registryLockPath}`);
      }
      await Bun.sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(registryLockPath, { recursive: true, force: true });
  }
}

async function upsertWorker(worker: Worker) {
  await withRegistryLock(() => {
    const registry = loadRegistry();
    const existing = registry.workers.findIndex((candidate) => candidate.id === worker.id);
    if (existing >= 0) {
      registry.workers[existing] = worker;
    } else {
      registry.workers.push(worker);
    }
    saveRegistry(registry);
  });
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "worker";
}

function uniqueWorkerId(registry: Registry, preferred: string) {
  const base = slugify(preferred);
  let id = base;
  let suffix = 2;

  while (registry.workers.some((worker) => worker.id === id && worker.status === "active")) {
    id = `${base}-${suffix++}`;
  }

  return id;
}

function resolvePath(input: string) {
  const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  const candidates = [
    expanded,
    resolve(process.cwd(), expanded),
    join(homedir(), expanded),
    join(homedir(), "flexport", expanded),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }

  throw new Error(`Could not find folder: ${input}`);
}

async function gitRoot(path: string) {
  const result = await run(["git", "-C", path, "rev-parse", "--show-toplevel"], { allowFail: true });
  return result.exitCode === 0 ? result.stdout.trim() : path;
}

async function repoIdentity(path: string) {
  const remote = await run(["git", "-C", path, "remote", "get-url", "origin"], { allowFail: true });
  if (remote.exitCode === 0 && remote.stdout.trim()) {
    return remote.stdout.trim().replace(/\.git$/, "");
  }

  return basename(path);
}

function hashString(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - chroma / 2;

  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) {
    red = chroma;
    green = x;
  } else if (hue < 120) {
    red = x;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = x;
  } else if (hue < 240) {
    green = x;
    blue = chroma;
  } else if (hue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  const toHex = (channel: number) =>
    Math.round((channel + m) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();

  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

async function colorForRepo(repoRoot: string) {
  const identity = await repoIdentity(repoRoot);
  const hash = hashString(identity);
  const hue = hash % 360;
  const saturation = 62 + (hash % 12);
  const lightness = 34 + ((hash >>> 8) % 10);
  return hslToHex(hue, saturation, lightness);
}

async function setupWorktree(cwd: string, branch: string) {
  const repoRoot = await gitRoot(cwd);
  const worktreePath = join(homedir(), "worktrees", basename(repoRoot), branch);
  mkdirSync(dirname(worktreePath), { recursive: true });

  if (existsSync(worktreePath)) {
    return { cwd: worktreePath, repoRoot, worktreePath };
  }

  const checkout = await run(["git", "-C", repoRoot, "worktree", "add", worktreePath, branch], {
    allowFail: true,
  });

  if (checkout.exitCode === 0) {
    return { cwd: worktreePath, repoRoot, worktreePath };
  }

  const create = await run(["git", "-C", repoRoot, "worktree", "add", "-b", branch, worktreePath], {
    allowFail: true,
  });

  if (create.exitCode !== 0) {
    throw new Error(`Failed to set up worktree for '${branch}':\n${create.stderr.trim()}`);
  }

  return { cwd: worktreePath, repoRoot, worktreePath };
}

function buildLaunchCommand(
  agent: string,
  cwd: string,
  model?: string,
  options: { yolo?: boolean; resumeSession?: string } = {},
) {
  if (agent === "codex") {
    const parts = options.resumeSession ? ["codex", "resume"] : ["codex"];
    parts.push("--cd", $.escape(cwd), "--no-alt-screen");
    if (options.yolo !== false) parts.push("--dangerously-bypass-approvals-and-sandbox");
    if (model) parts.push("--model", $.escape(model));
    if (options.resumeSession) parts.push($.escape(options.resumeSession));
    return parts.join(" ");
  }

  if (agent === "claude") {
    const parts = ["cd", $.escape(cwd), "&&", "claude", "--dangerously-skip-permissions"];
    if (model) parts.push("--model", $.escape(model));
    return parts.join(" ");
  }

  throw new Error(`Unsupported agent '${agent}'. Supported agents: codex, claude`);
}

type WorkspaceGroup = {
  name: string;
  ref?: string;
  create?: boolean;
  member_workspace_refs?: string[];
};

async function listGroups(windowArgs: string[]) {
  const result = await runJson<{ groups: WorkspaceGroup[] }>([
    "cmux",
    "workspace-group",
    "list",
    "--json",
    ...windowArgs,
  ]);
  return result.groups ?? [];
}

function normalizeGroupName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveGroup(selection: string, windowArgs: string[]) {
  if (selection === "none" || selection === "false" || selection === "off") return undefined;

  const groups = await listGroups(windowArgs).catch(() => []);

  if (selection !== "auto") {
    const wanted = normalizeGroupName(selection);
    const explicit = groups.find(
      (group) =>
        group.ref === selection ||
        normalizeGroupName(group.name) === wanted ||
        normalizeGroupName(group.name).includes(wanted)
    );

    return explicit ?? { name: selection, create: true };
  }

  const subagentGroup = groups.find(
    (group) => normalizeGroupName(group.name) === normalizeGroupName(defaultSubagentGroupName)
  );
  if (subagentGroup) return subagentGroup;

  return { name: defaultSubagentGroupName, create: true };
}

async function createGroupForWorkspace(groupName: string, workspaceRef: string) {
  const result = await runJson<{ group: WorkspaceGroup }>([
    "cmux",
    "workspace-group",
    "create",
    "--json",
    "--name",
    groupName,
    "--from",
    workspaceRef,
  ]);

  return result.group;
}

async function spawnWorker() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      agent: { type: "string" },
      branch: { type: "string", short: "w" },
      focus: { type: "boolean" },
      group: { type: "string" },
      "group-placement": { type: "string" },
      id: { type: "string" },
      model: { type: "string" },
      name: { type: "string", short: "n" },
      prompt: { type: "string", short: "p" },
      resume: { type: "string" },
      window: { type: "string" },
      "no-worktree": { type: "boolean" },
      "no-yolo": { type: "boolean" },
      "full-json": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const target = positionals[0] ?? process.cwd();
  let cwd = resolvePath(target);
  const branch = values.branch ?? "";
  const agent = values.agent ?? "codex";
  const prompt = values.prompt ?? positionals.slice(1).join(" ");
  const model = values.model;
  const resumeSession = values.resume;
  const registry = loadRegistry();

  let repoRoot = await gitRoot(cwd);
  let worktreePath: string | undefined;
  if (branch && !values["no-worktree"]) {
    const worktree = await setupWorktree(cwd, branch);
    cwd = worktree.cwd;
    repoRoot = worktree.repoRoot;
    worktreePath = worktree.worktreePath;
  }
  const repoColor = await colorForRepo(repoRoot);

  const name = values.name ?? (branch || basename(cwd));
  const id = uniqueWorkerId(registry, values.id ?? name);
  if (resumeSession && agent !== "codex") {
    throw new Error("--resume is only supported for codex workers");
  }

  const launchCommand = buildLaunchCommand(agent, cwd, model, {
    yolo: !values["no-yolo"],
    resumeSession,
  });
  const windowMode = values.window ?? "current";
  const windowArgs: string[] = [];
  let newWindowHandle: string | undefined;

  if (windowMode === "new") {
    const created = await run(["cmux", "--json", "new-window"]);
    newWindowHandle = created.stdout.trim().split(/\s+/).at(-1);
    if (!newWindowHandle) throw new Error(`Could not parse new window output: ${created.stdout}`);
    windowArgs.push("--window", newWindowHandle);
  } else if (windowMode !== "current") {
    windowArgs.push("--window", windowMode);
  }

  const group = await resolveGroup(values.group ?? "auto", windowArgs);
  const groupArgs = group?.ref
    ? ["--group", group.ref, "--group-placement", values["group-placement"] ?? "end"]
    : [];

  const workspace = await runJson<{
    surface_ref: string;
    window_ref: string;
    workspace_ref: string;
  }>([
    "cmux",
    "--json",
    "workspace",
    "create",
    "--name",
    name,
    "--cwd",
    cwd,
    "--command",
    launchCommand,
    "--focus",
    values.focus ? "true" : "false",
    ...groupArgs,
    ...windowArgs,
  ]);

  const resolvedGroup = group?.create
    ? await createGroupForWorkspace(group.name, workspace.workspace_ref)
    : group;

  const worker: Worker = {
    id,
    name,
    agent,
    repoRoot,
    repoColor,
    cwd,
    branch: branch || undefined,
    groupRef: resolvedGroup?.ref,
    groupName: resolvedGroup?.name,
    managedGroup: normalizeGroupName(resolvedGroup?.name ?? "") === normalizeGroupName(defaultSubagentGroupName),
    worktreePath,
    resumeSession,
    createdAt: new Date().toISOString(),
    windowRef: workspace.window_ref ?? newWindowHandle ?? windowMode,
    workspaceRef: workspace.workspace_ref,
    surfaceRef: workspace.surface_ref,
    launchCommand,
    prompt: prompt || undefined,
    status: "active",
  };

  await upsertWorker(worker);

  await run([
    "cmux",
    "workspace-action",
    "--action",
    "set-color",
    "--color",
    repoColor,
    "--workspace",
    worker.workspaceRef,
    "--window",
    worker.windowRef,
  ]).catch(() => undefined);

  if (prompt) {
    await waitForAgentInput(worker);
    await sendMessageToWorker(worker, prompt);
  }

  await run([
    "cmux",
    "set-status",
    `mux-${id}`,
    `${agent}: ${name}`,
    "--workspace",
    worker.workspaceRef,
    "--window",
    worker.windowRef,
    "--icon",
    "circle",
    "--color",
    repoColor,
  ]).catch(() => undefined);

  console.log(JSON.stringify(publicWorker(worker, values["full-json"] ?? false), null, 2));
}

async function listWorkers() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      all: { type: "boolean" },
      full: { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const registry = loadRegistry();
  const workers = values.all ? registry.workers : registry.workers.filter((worker) => worker.status === "active");

  if (values.json) {
    console.log(JSON.stringify(workers.map((worker) => publicWorker(worker, values.full ?? false)), null, 2));
    return;
  }

  if (workers.length === 0) {
    console.log("No workers");
    return;
  }

  for (const worker of workers) {
    console.log(
      [
        worker.id.padEnd(22),
        worker.agent.padEnd(6),
        worker.status.padEnd(6),
        (worker.groupName ?? "-").padEnd(16),
        worker.workspaceRef.padEnd(12),
        worker.surfaceRef.padEnd(11),
        worker.cwd,
      ].join("  ")
    );
  }
}

type SyncCandidate = {
  agent: string;
  branch?: string;
  cwd: string;
  groupName?: string;
  groupRef?: string;
  managedGroup?: boolean;
  name: string;
  repoColor: string;
  repoRoot: string;
  surfaceRef: string;
  windowRef: string;
  worktreePath?: string;
  workspaceRef: string;
};

async function syncWorkers() {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "dry-run": { type: "boolean" },
      "no-close-stale": { type: "boolean" },
      window: { type: "string" },
    },
  });

  const candidates = await liveSyncCandidates(values.window);
  const liveWorkspaceRefs = new Set(candidates.map((candidate) => candidate.workspaceRef));
  const now = new Date().toISOString();
  const result = await withRegistryLock(() => {
    const registry = loadRegistry();
    const touchedIds = new Set<string>();
    const tracked: Worker[] = [];
    const created: Worker[] = [];
    const closed: Worker[] = [];

    for (const candidate of candidates) {
      const activeMatch = registry.workers.find(
        (worker) =>
          worker.status === "active" &&
          !touchedIds.has(worker.id) &&
          worker.name === candidate.name &&
          worker.cwd === candidate.cwd
      );
      const refMatch =
        activeMatch ??
        registry.workers.find(
          (worker) =>
            worker.status === "active" &&
            !touchedIds.has(worker.id) &&
            worker.workspaceRef === candidate.workspaceRef &&
            worker.cwd === candidate.cwd
        );
      const staleNameMatch =
        refMatch ??
        registry.workers.find(
          (worker) =>
            worker.status === "active" &&
            !touchedIds.has(worker.id) &&
            worker.name === candidate.name &&
            !liveWorkspaceRefs.has(worker.workspaceRef)
        );
      const closedMatch =
        staleNameMatch ??
        registry.workers.find(
          (worker) =>
            worker.status === "closed" &&
            !touchedIds.has(worker.id) &&
            worker.name === candidate.name &&
            worker.cwd === candidate.cwd
        );

      const worker =
        closedMatch ??
        ({
          id: uniqueWorkerId(registry, candidate.name),
          createdAt: now,
        } as Worker);

      Object.assign(worker, {
        agent: candidate.agent,
        branch: candidate.branch,
        closedAt: undefined,
        cwd: candidate.cwd,
        groupName: candidate.groupName,
        groupRef: candidate.groupRef,
        launchCommand: closedMatch?.launchCommand ?? "retracked from live cmux workspace",
        managedGroup: candidate.managedGroup,
        name: candidate.name,
        repoColor: candidate.repoColor,
        repoRoot: candidate.repoRoot,
        status: "active",
        surfaceRef: candidate.surfaceRef,
        windowRef: candidate.windowRef,
        worktreePath: candidate.worktreePath,
        workspaceRef: candidate.workspaceRef,
      } satisfies Partial<Worker>);

      if (!registry.workers.includes(worker)) {
        registry.workers.push(worker);
        created.push(worker);
      }

      touchedIds.add(worker.id);
      tracked.push(worker);
    }

    if (!values["no-close-stale"]) {
      for (const worker of registry.workers) {
        if (worker.status === "active" && !touchedIds.has(worker.id)) {
          worker.status = "closed";
          worker.closedAt = now;
          closed.push(worker);
        }
      }
    }

    if (!values["dry-run"]) {
      saveRegistry(registry);
    }

    return { tracked, created, closed };
  });

  if (!values["dry-run"]) {
    for (const worker of result.tracked) {
      await applyWorkspaceColor(worker).catch(() => undefined);
      await replaceMuxStatus(worker).catch(() => undefined);
    }
  }

  console.log(
    JSON.stringify(
      {
        closedStale: result.closed.length,
        created: result.created.length,
        dryRun: values["dry-run"] ?? false,
        tracked: result.tracked.length,
        workers: result.tracked.map((worker) => ({
          id: worker.id,
          name: worker.name,
          cwd: worker.cwd,
          workspaceRef: worker.workspaceRef,
          surfaceRef: worker.surfaceRef,
          color: worker.repoColor,
        })),
      },
      null,
      2
    )
  );
}

async function liveSyncCandidates(windowSelection?: string) {
  const windows = windowSelection
    ? [{ id: windowSelection }]
    : await runJson<CmuxWindow[]>(["cmux", "--json", "list-windows"]).catch(() => []);
  const candidates: SyncCandidate[] = [];

  for (const window of windows) {
    const windowRef = window.id || (window.index !== undefined ? `window:${window.index}` : undefined);
    if (!windowRef) continue;

    const groups = await listGroups(["--window", windowRef]).catch(() => []);
    const workspaceList = await runJson<CmuxWorkspaceList>([
      "cmux",
      "--json",
      "workspace",
      "list",
      "--window",
      windowRef,
    ]);

    for (const workspace of workspaceList.workspaces ?? []) {
      const workspaceRef = workspace.ref ?? workspace.id;
      if (!workspaceRef) continue;

      const surfaceRef = await terminalSurfaceForWorkspace(windowRef, workspaceRef);
      if (!surfaceRef) continue;

      const cwd = workspace.current_directory || process.cwd();
      const repoRoot = await gitRoot(cwd);
      const repoColor = await colorForRepo(repoRoot);
      const group = groups.find((candidate) => candidate.member_workspace_refs?.includes(workspaceRef));
      const name = inferWorkspaceName(workspace, cwd);

      candidates.push({
        agent: "codex",
        branch: await currentGitBranch(cwd),
        cwd,
        groupName: group?.name,
        groupRef: group?.ref,
        managedGroup: normalizeGroupName(group?.name ?? "") === normalizeGroupName(defaultSubagentGroupName),
        name,
        repoColor,
        repoRoot,
        surfaceRef,
        windowRef,
        worktreePath: cwd.includes("/worktrees/") ? repoRoot : undefined,
        workspaceRef,
      });
    }
  }

  return candidates;
}

async function terminalSurfaceForWorkspace(windowRef: string, workspaceRef: string) {
  const paneList = await runJson<CmuxPaneList>([
    "cmux",
    "--json",
    "list-panes",
    "--workspace",
    workspaceRef,
    "--window",
    windowRef,
  ]).catch(() => undefined);
  const panes = paneList?.panes ?? [];
  const orderedPanes = [...panes].sort((left, right) => Number(Boolean(right.focused)) - Number(Boolean(left.focused)));

  for (const pane of orderedPanes) {
    if (!pane.ref) continue;

    const surfaceList = await runJson<CmuxSurfaceList>([
      "cmux",
      "--json",
      "list-pane-surfaces",
      "--workspace",
      workspaceRef,
      "--pane",
      pane.ref,
      "--window",
      windowRef,
    ]).catch(() => undefined);
    const surfaces = surfaceList?.surfaces ?? [];
    const selectedTerminal = surfaces.find(
      (surface) => surface.type === "terminal" && surface.ref === pane.selected_surface_ref
    );
    const firstTerminal = surfaces.find((surface) => surface.type === "terminal");
    const chosen = selectedTerminal ?? firstTerminal;
    if (chosen?.ref) return chosen.ref;
  }

  return undefined;
}

function inferWorkspaceName(workspace: NonNullable<CmuxWorkspaceList["workspaces"]>[number], cwd: string) {
  if (workspace.custom_title?.trim()) return workspace.custom_title.trim();

  const title = workspace.title?.replace(/^[⠁⠂⠄⡀⢀⠠⠐⠈⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/, "").trim();
  if (!title || title.includes(":~/") || title === basename(cwd)) return basename(cwd);
  return title;
}

async function currentGitBranch(cwd: string) {
  const branch = await run(["git", "-C", cwd, "branch", "--show-current"], { allowFail: true });
  return branch.exitCode === 0 && branch.stdout.trim() ? branch.stdout.trim() : undefined;
}

async function applyWorkspaceColor(worker: Worker) {
  if (!worker.repoColor) return;
  await run([
    "cmux",
    "workspace-action",
    "--action",
    "set-color",
    "--color",
    worker.repoColor,
    "--workspace",
    worker.workspaceRef,
    "--window",
    worker.windowRef,
  ]);
}

async function replaceMuxStatus(worker: Worker) {
  const statuses = await run([
    "cmux",
    "list-status",
    "--workspace",
    worker.workspaceRef,
    "--window",
    worker.windowRef,
  ], { allowFail: true });

  if (statuses.exitCode === 0) {
    for (const line of statuses.stdout.split(/\r?\n/)) {
      const key = line.split("=")[0];
      if (key?.startsWith("mux-")) {
        await run([
          "cmux",
          "clear-status",
          key,
          "--workspace",
          worker.workspaceRef,
          "--window",
          worker.windowRef,
        ], { allowFail: true });
      }
    }
  }

  await run([
    "cmux",
    "set-status",
    `mux-${worker.id}`,
    `${worker.agent}: ${worker.name}`,
    "--workspace",
    worker.workspaceRef,
    "--window",
    worker.windowRef,
    "--icon",
    "circle",
    "--color",
    worker.repoColor ?? "#2E7D32",
  ]);
}

async function watchGithub() {
  const action = process.argv[3] ?? "once";

  switch (action) {
    case "once": {
      const { values } = parseArgs({
        args: process.argv.slice(4),
        options: {
          "dry-run": { type: "boolean" },
          "notify-existing": { type: "boolean" },
          "state-file": { type: "string" },
        },
      });
      const summary = await watchGithubOnce({
        dryRun: values["dry-run"] ?? false,
        notifyExisting: values["notify-existing"] ?? false,
        stateFile: values["state-file"] ?? githubWatchStatePath,
      });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    case "run": {
      const { values } = parseArgs({
        args: process.argv.slice(4),
        options: {
          interval: { type: "string" },
          "state-file": { type: "string" },
        },
      });
      const intervalSeconds = parseGithubWatchInterval(values.interval);
      const stateFile = values["state-file"] ?? githubWatchStatePath;

      while (true) {
        try {
          const summary = await watchGithubOnce({
            dryRun: false,
            notifyExisting: false,
            stateFile,
          });
          if (summary.notifications.length > 0 || summary.errors.length > 0) {
            console.log(`${new Date().toISOString()} ${JSON.stringify(summary)}`);
          }
        } catch (error) {
          console.error(`${new Date().toISOString()} GitHub watcher failed`, error);
        }
        await Bun.sleep(intervalSeconds * 1000);
      }
    }
    case "install": {
      const { values } = parseArgs({
        args: process.argv.slice(4),
        options: {
          interval: { type: "string" },
        },
      });
      await installGithubWatchLaunchAgent(parseGithubWatchInterval(values.interval));
      return;
    }
    case "status":
      await githubWatchLaunchAgentStatus();
      return;
    case "uninstall":
      await uninstallGithubWatchLaunchAgent();
      return;
    default:
      throw new Error(
        "Usage: mux watch-github <once|run|install|status|uninstall> [options]"
      );
  }
}

function parseGithubWatchInterval(raw?: string) {
  if (!raw) return 90;
  const interval = Number.parseInt(raw, 10);
  if (!Number.isFinite(interval) || interval < 30) {
    throw new Error("GitHub watcher interval must be at least 30 seconds");
  }
  return interval;
}

function loadGithubWatchState(path: string): GitHubWatchState {
  if (!existsSync(path)) return { version: 1, pullRequests: {} };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GitHubWatchState;
    if (parsed.version === 1 && parsed.pullRequests) return parsed;
  } catch {
    // A corrupt state file should re-baseline rather than stop notifications permanently.
  }

  return { version: 1, pullRequests: {} };
}

function saveGithubWatchState(path: string, state: GitHubWatchState) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function githubRepoSlug(repoRoot: string) {
  const remote = await run(["git", "-C", repoRoot, "remote", "get-url", "origin"], {
    allowFail: true,
    timeoutMs: 5000,
  });
  if (remote.exitCode !== 0) return undefined;

  const value = remote.stdout.trim().replace(/\.git$/, "");
  const sshMatch = value.match(/^git@github\.com:(.+\/.+)$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = value.match(/^https?:\/\/github\.com\/(.+\/.+)$/);
  return httpsMatch?.[1];
}

function githubCheckIdentity(check: GitHubCheck) {
  if (check.__typename === "StatusContext") {
    return `status-context|${check.context ?? check.name ?? "unknown"}`;
  }
  return `check-run|${check.workflowName ?? ""}|${check.name ?? check.context ?? "unknown"}`;
}

function githubCheckTimestamp(check: GitHubCheck) {
  return check.startedAt ?? check.completedAt ?? "";
}

function latestGithubChecks(checks: GitHubCheck[]) {
  const latestByIdentity = new Map<string, GitHubCheck>();
  for (const check of checks) {
    const identity = githubCheckIdentity(check);
    const current = latestByIdentity.get(identity);
    if (!current || githubCheckTimestamp(check) > githubCheckTimestamp(current)) {
      latestByIdentity.set(identity, check);
    }
  }
  return [...latestByIdentity.values()];
}

function failedGithubChecks(checks: GitHubCheck[]) {
  const failedConclusions = new Set([
    "ACTION_REQUIRED",
    "FAILURE",
    "STARTUP_FAILURE",
    "TIMED_OUT",
  ]);
  const failedStates = new Set(["ERROR", "FAILURE"]);
  return latestGithubChecks(checks).filter((check) =>
    failedConclusions.has((check.conclusion ?? "").toUpperCase()) ||
    failedStates.has((check.state ?? "").toUpperCase())
  );
}

function githubCheckKey(check: GitHubCheck) {
  return [
    check.detailsUrl ?? "",
    check.workflowName ?? "",
    check.name ?? "unknown check",
    check.completedAt ?? "",
  ].join("|");
}

function githubCheckLabel(check: GitHubCheck) {
  const prefix = check.workflowName ? `${check.workflowName}: ` : "";
  return `${prefix}${check.name ?? "unknown check"}`;
}

function githubStatus(pr: GitHubPullRequest) {
  const latestChecks = latestGithubChecks(pr.statusCheckRollup);
  const failed = failedGithubChecks(latestChecks);
  const pendingStates = new Set(["EXPECTED", "PENDING"]);
  const pending = latestChecks.filter((check) =>
    check.__typename === "StatusContext"
      ? pendingStates.has((check.state ?? "").toUpperCase())
      : (check.status ?? "").toUpperCase() !== "COMPLETED"
  );

  if (failed.length > 0) {
    return { color: "#D1242F", icon: "circle", value: `PR #${pr.number} CI failed` };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { color: "#D97706", icon: "circle", value: `PR #${pr.number} changes` };
  }
  if (pending.length > 0) {
    return { color: "#2563EB", icon: "circle", value: `PR #${pr.number} CI running` };
  }
  if (pr.reviewDecision === "APPROVED") {
    return { color: "#1A7F37", icon: "circle", value: `PR #${pr.number} approved` };
  }
  if (pr.statusCheckRollup.length > 0) {
    return { color: "#1A7F37", icon: "circle", value: `PR #${pr.number} CI passed` };
  }
  return { color: "#6E7781", icon: "circle", value: `PR #${pr.number} open` };
}

function isAutomatedGithubReviewer(login: string) {
  const normalized = login.toLowerCase();
  return normalized.endsWith("[bot]") || [
    "claude",
    "coderabbit",
    "codex",
    "copilot",
    "cycode",
    "dependabot",
    "gemini",
    "github-actions",
    "openai",
    "renovate",
    "snyk",
  ].some((marker) => normalized.includes(marker));
}

function latestHumanGithubReview(pr: GitHubPullRequest) {
  const authorLogin = pr.author?.login?.toLowerCase();
  return pr.reviews
    .filter((review) => {
      const login = review.author?.login;
      return Boolean(
        login &&
        login.toLowerCase() !== authorLogin &&
        !isAutomatedGithubReviewer(login) &&
        ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(review.state.toUpperCase())
      );
    })
    .sort((left, right) =>
      (right.submittedAt ?? "").localeCompare(left.submittedAt ?? "")
    )[0];
}

function humanGithubReviewStatus(pr: GitHubPullRequest) {
  const review = latestHumanGithubReview(pr);
  if (!review) return undefined;

  const reviewer = review.author?.login ?? "reviewer";
  const state = review.state.toUpperCase();
  const label = state === "APPROVED"
    ? `approved by ${reviewer}`
    : state === "CHANGES_REQUESTED"
      ? `changes from ${reviewer}`
      : `review from ${reviewer}`;
  return { color: "#D97706", icon: "person.crop.circle.badge.exclamationmark", value: `PR #${pr.number} ${label}` };
}

async function setGithubStatus(candidate: SyncCandidate, pr: GitHubPullRequest) {
  const status = githubStatus(pr);
  await run(
    [
      "cmux",
      "set-status",
      githubStatusKey,
      status.value,
      "--workspace",
      candidate.workspaceRef,
      "--window",
      candidate.windowRef,
      "--icon",
      status.icon,
      "--color",
      status.color,
      "--priority",
      "90",
    ],
    { allowFail: true, timeoutMs: 5000 }
  );

  const reviewStatus = humanGithubReviewStatus(pr);
  if (!reviewStatus) {
    await run(
      [
        "cmux",
        "clear-status",
        githubReviewStatusKey,
        "--workspace",
        candidate.workspaceRef,
        "--window",
        candidate.windowRef,
      ],
      { allowFail: true, timeoutMs: 5000 }
    );
    return;
  }

  await run(
    [
      "cmux",
      "set-status",
      githubReviewStatusKey,
      reviewStatus.value,
      "--workspace",
      candidate.workspaceRef,
      "--window",
      candidate.windowRef,
      "--icon",
      reviewStatus.icon,
      "--color",
      reviewStatus.color,
      "--priority",
      "95",
    ],
    { allowFail: true, timeoutMs: 5000 }
  );
}

async function clearGithubStatus(candidate: SyncCandidate) {
  for (const key of [githubStatusKey, githubReviewStatusKey]) {
    await run(
      [
        "cmux",
        "clear-status",
        key,
        "--workspace",
        candidate.workspaceRef,
        "--window",
        candidate.windowRef,
      ],
      { allowFail: true, timeoutMs: 5000 }
    );
  }
}

async function notifyGithubWorkspace(
  candidate: SyncCandidate,
  notification: { body: string; subtitle: string; title: string }
) {
  await run(
    [
      "cmux",
      "notify",
      "--title",
      notification.title,
      "--subtitle",
      notification.subtitle,
      "--body",
      notification.body,
      "--workspace",
      candidate.workspaceRef,
      "--surface",
      candidate.surfaceRef,
      "--window",
      candidate.windowRef,
    ],
    { allowFail: true, timeoutMs: 5000 }
  );
  await run(
    [
      "cmux",
      "trigger-flash",
      "--workspace",
      candidate.workspaceRef,
      "--surface",
      candidate.surfaceRef,
      "--window",
      candidate.windowRef,
    ],
    { allowFail: true, timeoutMs: 5000 }
  );
}

async function watchGithubOnce(options: {
  dryRun: boolean;
  notifyExisting: boolean;
  stateFile: string;
}): Promise<GitHubWatchSummary> {
  const summary: GitHubWatchSummary = {
    errors: [],
    liveWorkspaces: 0,
    matchedPullRequests: 0,
    notifications: [],
  };
  const state = loadGithubWatchState(options.stateFile);
  // Detect against the state at the start of the cycle so duplicate live
  // workspaces for one PR all receive the same newly observed event.
  const previousPullRequestStates = new Map(Object.entries(state.pullRequests));
  const candidates = (await liveSyncCandidates()).filter(
    (candidate) => candidate.branch && !["main", "master"].includes(candidate.branch)
  );
  summary.liveWorkspaces = candidates.length;

  const candidatesByRepo = new Map<string, SyncCandidate[]>();
  for (const candidate of candidates) {
    const repoSlug = await githubRepoSlug(candidate.repoRoot);
    if (!repoSlug) continue;
    const existing = candidatesByRepo.get(repoSlug) ?? [];
    existing.push(candidate);
    candidatesByRepo.set(repoSlug, existing);
  }

  for (const [repoSlug, repoCandidates] of candidatesByRepo) {
    const listResult = await run(
      [
        "gh",
        "pr",
        "list",
        "--repo",
        repoSlug,
        "--state",
        "open",
        "--limit",
        "500",
        "--json",
        "number,url,title,headRefName,headRefOid",
      ],
      { allowFail: true, maxOutputBytes: 4 * 1024 * 1024, timeoutMs: 30000 }
    );
    if (listResult.exitCode !== 0) {
      summary.errors.push(`${repoSlug}: ${listResult.stderr.trim() || "failed to list PRs"}`);
      continue;
    }

    let openPullRequests: GitHubPullRequestSummary[];
    try {
      openPullRequests = JSON.parse(listResult.stdout) as GitHubPullRequestSummary[];
    } catch (error) {
      summary.errors.push(`${repoSlug}: invalid PR list response (${String(error)})`);
      continue;
    }

    const prByBranch = new Map(openPullRequests.map((pr) => [pr.headRefName, pr]));
    const detailsByNumber = new Map<number, GitHubPullRequest>();

    for (const candidate of repoCandidates) {
      const prSummary = prByBranch.get(candidate.branch!);
      if (!prSummary) {
        if (!options.dryRun) await clearGithubStatus(candidate);
        continue;
      }

      let pr = detailsByNumber.get(prSummary.number);
      if (!pr) {
        const detailResult = await run(
          [
            "gh",
            "pr",
            "view",
            String(prSummary.number),
            "--repo",
            repoSlug,
            "--json",
            "number,url,title,headRefName,headRefOid,author,reviewDecision,reviews,statusCheckRollup,updatedAt",
          ],
          { allowFail: true, maxOutputBytes: 4 * 1024 * 1024, timeoutMs: 30000 }
        );
        if (detailResult.exitCode !== 0) {
          summary.errors.push(
            `${repoSlug}#${prSummary.number}: ${detailResult.stderr.trim() || "failed to read PR"}`
          );
          continue;
        }
        try {
          pr = JSON.parse(detailResult.stdout) as GitHubPullRequest;
          detailsByNumber.set(pr.number, pr);
        } catch (error) {
          summary.errors.push(`${repoSlug}#${prSummary.number}: invalid PR response (${String(error)})`);
          continue;
        }
      }

      summary.matchedPullRequests += 1;
      const stateKey = `${repoSlug}#${pr.number}`;
      const previous = previousPullRequestStates.get(stateKey);
      const firstObservation = previous === undefined;
      const previousReviewIds = new Set(previous?.reviewIds ?? []);
      const failedChecks = failedGithubChecks(pr.statusCheckRollup);
      const previousFailedChecks = new Set(previous?.failedCheckKeys ?? []);
      const newReviews = pr.reviews.filter((review) => !previousReviewIds.has(review.id));
      const newHumanReviews = newReviews.filter((review) => {
        const login = review.author?.login;
        return Boolean(
          login &&
          login.toLowerCase() !== pr.author?.login?.toLowerCase() &&
          !isAutomatedGithubReviewer(login)
        );
      });
      const newFailedChecks = failedChecks.filter(
        (check) => !previousFailedChecks.has(githubCheckKey(check))
      );
      const shouldNotifyCurrent = !firstObservation || options.notifyExisting;

      if (shouldNotifyCurrent && newHumanReviews.length > 0) {
        const reviewSummary = newHumanReviews
          .slice(-3)
          .map((review) => `${review.author?.login ?? "reviewer"}: ${review.state.toLowerCase()}`)
          .join(", ");
        const notification = {
          title: `PR #${pr.number} received review`,
          subtitle: repoSlug,
          body: `${pr.title} — ${reviewSummary}`,
        };
        summary.notifications.push({ ...notification, worker: candidate.name });
        if (!options.dryRun) await notifyGithubWorkspace(candidate, notification);
      }

      if (shouldNotifyCurrent && newFailedChecks.length > 0) {
        const failedSummary = newFailedChecks.slice(0, 3).map(githubCheckLabel).join(", ");
        const more = newFailedChecks.length > 3 ? ` (+${newFailedChecks.length - 3} more)` : "";
        const notification = {
          title: `PR #${pr.number} CI failed`,
          subtitle: repoSlug,
          body: `${failedSummary}${more}`,
        };
        summary.notifications.push({ ...notification, worker: candidate.name });
        if (!options.dryRun) await notifyGithubWorkspace(candidate, notification);
      }

      state.pullRequests[stateKey] = {
        failedCheckKeys: failedChecks.map(githubCheckKey),
        headRefOid: pr.headRefOid,
        lastSeenAt: new Date().toISOString(),
        reviewIds: pr.reviews.map((review) => review.id),
      };
      if (!options.dryRun) await setGithubStatus(candidate, pr);
    }
  }

  if (!options.dryRun) saveGithubWatchState(options.stateFile, state);
  return summary;
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function installGithubWatchLaunchAgent(intervalSeconds: number) {
  // Establish a silent baseline before launchd begins polling.
  const baseline = await watchGithubOnce({
    dryRun: false,
    notifyExisting: false,
    stateFile: githubWatchStatePath,
  });

  mkdirSync(dirname(githubWatchLaunchAgentPath), { recursive: true });
  mkdirSync(dirname(githubWatchStatePath), { recursive: true });
  const scriptPath = resolve(process.argv[1]);
  const path = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(":");
  const stdoutPath = join(homedir(), ".cmuxterm", "github-watch.log");
  const stderrPath = join(homedir(), ".cmuxterm", "github-watch-error.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${githubWatchLaunchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>watch-github</string>
    <string>run</string>
    <string>--interval</string>
    <string>${intervalSeconds}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(homedir())}</string>
</dict>
</plist>
`;
  writeFileSync(githubWatchLaunchAgentPath, plist);

  const domain = `gui/${process.getuid()}`;
  await run(["launchctl", "bootout", domain, githubWatchLaunchAgentPath], {
    allowFail: true,
    timeoutMs: 10000,
  });
  await run(["launchctl", "bootstrap", domain, githubWatchLaunchAgentPath], {
    timeoutMs: 10000,
  });

  console.log(
    JSON.stringify(
      {
        baseline,
        intervalSeconds,
        label: githubWatchLaunchAgentLabel,
        plist: githubWatchLaunchAgentPath,
        status: "installed",
      },
      null,
      2
    )
  );
}

async function githubWatchLaunchAgentStatus() {
  const domain = `gui/${process.getuid()}`;
  const result = await run(["launchctl", "print", `${domain}/${githubWatchLaunchAgentLabel}`], {
    allowFail: true,
    maxOutputBytes: 256 * 1024,
    timeoutMs: 10000,
  });
  const pid = result.stdout.match(/\bpid = (\d+)/)?.[1];
  console.log(
    JSON.stringify(
      {
        installed: existsSync(githubWatchLaunchAgentPath),
        label: githubWatchLaunchAgentLabel,
        loaded: result.exitCode === 0,
        pid: pid ? Number(pid) : null,
        stateFile: githubWatchStatePath,
      },
      null,
      2
    )
  );
}

async function uninstallGithubWatchLaunchAgent() {
  const domain = `gui/${process.getuid()}`;
  await run(["launchctl", "bootout", domain, githubWatchLaunchAgentPath], {
    allowFail: true,
    timeoutMs: 10000,
  });
  rmSync(githubWatchLaunchAgentPath, { force: true });
  console.log(`Uninstalled ${githubWatchLaunchAgentLabel}`);
}

function findWorker(registry: Registry, input: string) {
  const matches = registry.workers.filter(
    (worker) =>
      worker.status === "active" &&
      (worker.id === input ||
        worker.name === input ||
        worker.workspaceRef === input ||
        worker.surfaceRef === input ||
        worker.id.startsWith(input))
  );

  if (matches.length === 0) {
    throw new Error(`No active worker found for '${input}'. Run 'mux list'.`);
  }

  if (matches.length > 1) {
    throw new Error(`Worker '${input}' is ambiguous: ${matches.map((worker) => worker.id).join(", ")}`);
  }

  return matches[0];
}

async function sendWorker() {
  const { positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
  });
  const target = positionals[0];
  const message = positionals.slice(1).join(" ");
  if (!target || !message) {
    throw new Error("Usage: mux send <worker> <message>");
  }

  const worker = findWorker(loadRegistry(), target);
  await sendMessageToWorker(worker, message);
}

async function sendMessageToWorker(worker: Worker, message: string) {
  const normalizedMessage = message.replace(/\s+/g, " ").trim();
  if (!normalizedMessage) return;

  await run([
    "cmux",
    "send",
    "--window",
    worker.windowRef,
    "--workspace",
    worker.workspaceRef,
    "--surface",
    worker.surfaceRef,
    normalizedMessage,
  ]);
  await run([
    "cmux",
    "send-key",
    "--window",
    worker.windowRef,
    "--workspace",
    worker.workspaceRef,
    "--surface",
    worker.surfaceRef,
    "Enter",
  ]);
}

async function waitForAgentInput(worker: Worker) {
  if (/^(0|false|off)$/i.test(process.env.MUX_WAIT_FOR_AGENT_INPUT ?? "")) {
    await Bun.sleep(1500);
    return;
  }

  const deadline = Date.now() + readPositiveIntEnv("MUX_AGENT_INPUT_WAIT_MS", 12000);
  let sleepMs = 750;

  while (Date.now() < deadline) {
    const screen = await run(
      [
        "cmux",
        "read-screen",
        "--window",
        worker.windowRef,
        "--workspace",
        worker.workspaceRef,
        "--surface",
        worker.surfaceRef,
        "--lines",
        "40",
      ],
      { allowFail: true, maxOutputBytes: 64 * 1024, timeoutMs: 5000 }
    );

    if (
      worker.agent === "codex" &&
      (screen.stdout.includes("Find and fix a bug in @filename") || /[›>]\s*$/.test(screen.stdout))
    ) {
      return;
    }

    if (worker.agent === "claude" && /Claude Code|claude/i.test(screen.stdout) && /[›>]\s*$/.test(screen.stdout)) {
      return;
    }

    await Bun.sleep(sleepMs);
    sleepMs = Math.min(sleepMs + 500, 2000);
  }
}

async function readWorker() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      lines: { type: "string" },
    },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    throw new Error("Usage: mux read <worker> [--lines <n>]");
  }

  const worker = findWorker(loadRegistry(), target);
  const lines = boundedReadLines(values.lines);
  const { stdout } = await run([
    "cmux",
    "read-screen",
    "--window",
    worker.windowRef,
    "--workspace",
    worker.workspaceRef,
    "--surface",
    worker.surfaceRef,
    "--lines",
    String(lines),
  ], { maxOutputBytes: 512 * 1024, timeoutMs: 10000 });
  process.stdout.write(stdout);
}

function boundedReadLines(input?: string) {
  if (!input) return defaultReadLines;

  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --lines value '${input}'. Expected a positive integer.`);
  }

  return Math.min(parsed, maxReadLines);
}

async function focusWorker() {
  const { positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    throw new Error("Usage: mux focus <worker>");
  }

  const worker = findWorker(loadRegistry(), target);
  const windowRef = await resolveLiveWindowRef(worker);
  await run(["cmux", "focus-window", "--window", windowRef]);
  await run(["cmux", "workspace", "select", worker.workspaceRef, "--window", windowRef]);
  await run([
    "cmux",
    "focus-panel",
    "--panel",
    worker.surfaceRef,
    "--workspace",
    worker.workspaceRef,
    "--window",
    windowRef,
  ]);

  if (windowRef !== worker.windowRef) {
    await upsertWorker({ ...worker, windowRef });
  }
}

async function resolveLiveWindowRef(worker: Worker) {
  const windows = await runJson<CmuxWindow[]>(["cmux", "--json", "list-windows"]).catch(() => []);

  for (const window of windows) {
    const windowRef = window.id || (window.index !== undefined ? `window:${window.index}` : undefined);
    if (!windowRef) continue;

    const workspaces = await run(["cmux", "--json", "workspace", "list", "--window", windowRef], {
      allowFail: true,
      maxOutputBytes: 512 * 1024,
      timeoutMs: 10000,
    });
    if (workspaces.exitCode !== 0) continue;

    try {
      const parsed = JSON.parse(workspaces.stdout) as CmuxWorkspaceList;
      if (parsed.workspaces?.some((workspace) => workspace.ref === worker.workspaceRef || workspace.id === worker.workspaceRef)) {
        return windowRef;
      }
    } catch {
      // Fall back below if cmux changes the JSON shape.
    }
  }

  const currentWindow = await run(["cmux", "current-window"], { allowFail: true, timeoutMs: 5000 });
  return currentWindow.exitCode === 0 && currentWindow.stdout.trim() ? currentWindow.stdout.trim() : worker.windowRef;
}

async function closeWorker() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "remove-worktree": { type: "boolean" },
    },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    throw new Error("Usage: mux stop <worker> [--remove-worktree]");
  }

  const registry = loadRegistry();
  const worker = findWorker(registry, target);
  await run(["cmux", "workspace", "close", worker.workspaceRef, "--window", worker.windowRef], {
    allowFail: true,
  });
  await run(["cmux", "clear-status", `mux-${worker.id}`, "--workspace", worker.workspaceRef, "--window", worker.windowRef], {
    allowFail: true,
  });
  await cleanupManagedGroup(worker);

  if (values["remove-worktree"] && worker.worktreePath) {
    await run(["git", "-C", worker.repoRoot, "worktree", "remove", "--force", worker.worktreePath], {
      allowFail: true,
    });
  }

  worker.status = "closed";
  worker.closedAt = new Date().toISOString();
  saveRegistry(registry);
}

async function cleanupManagedGroup(worker: Worker) {
  if (!worker.managedGroup || !worker.groupRef) return;

  const groups = await listGroups(["--window", worker.windowRef]).catch(() => []);
  const group = groups.find((candidate) => candidate.ref === worker.groupRef);

  if (group && (group.member_workspace_refs?.length ?? 0) <= 1) {
    await run(["cmux", "workspace-group", "delete", worker.groupRef], { allowFail: true });
  }
}

// Legacy start command: keep the original single-workspace layout helper.
async function start() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      n: { type: "string" },
      w: { type: "string" },
      p: { type: "string" },
    },
    allowPositionals: true,
  });

  let cwd = positionals[0] ?? process.cwd();
  const branch = values.w ?? "";
  let name = values.n ?? "";
  const prompt = values.p ?? "";

  if (branch) {
    const worktree = await setupWorktree(cwd, branch);
    cwd = worktree.cwd;
    if (!name) name = branch;
  }

  const ws = wsArgs();
  const quotedCwd = $.escape(cwd);

  const [, listPanesOut] = await Promise.all([
    name ? run(["cmux", "rename-workspace", ...ws, name]) : Promise.resolve(),
    run(["cmux", "list-panes", ...ws]).then((result) => result.stdout),
  ]);

  const currentPane = parseActiveId(listPanesOut);
  const claudeSurface = parseActiveId(
    (await run(["cmux", "list-pane-surfaces", "--pane", currentPane, ...ws])).stdout
  );

  const [nvimSurfaceOut, browserPaneOut] = await Promise.all([
    run(["cmux", "new-surface", "--type", "terminal", "--pane", currentPane, ...ws]).then((result) => result.stdout),
    run(["cmux", "new-pane", "--type", "browser", "--direction", "right", ...ws]).then((result) => result.stdout),
  ]);

  const nvimSurface = parseNewId(nvimSurfaceOut);
  const browserPane = parseNewId(browserPaneOut);

  const lazygitSurface = parseNewId((await run(["cmux", "new-split", "down", "--surface", browserPane, ...ws])).stdout);

  await Promise.all([
    sendCmd(
      `cd ${quotedCwd} && claude --dangerously-skip-permissions${prompt ? ` ${$.escape(prompt)}` : ""}`,
      ws,
      ["--surface", claudeSurface]
    ),
    sendCmd(`cd ${quotedCwd} && ./gradlew build -x test && nvim`, ws, ["--surface", nvimSurface]),
    sendCmd(`cd ${quotedCwd} && lazygit`, ws, ["--surface", lazygitSurface]),
  ]);

  await Promise.all([
    run(["cmux", "focus-pane", "--pane", currentPane, ...ws]),
    run(["cmux", "move-surface", "--surface", claudeSurface, "--pane", currentPane, "--focus", "true", ...ws]),
  ]);
}

async function legacyClose() {
  const { positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
  });

  const wsId = positionals[0] ?? process.env.CMUX_WORKSPACE_ID ?? "";
  if (!wsId) {
    console.error("No workspace ID provided and CMUX_WORKSPACE_ID is not set.");
    process.exit(1);
  }

  const ws = wsArgs(wsId);
  const listPanesOut = (await run(["cmux", "list-panes", ...ws])).stdout;
  const cwd =
    listPanesOut
      .split("\n")
      .find((line) => line.includes("*"))
      ?.trim()
      .split(/\s+/)
      .at(-1) ?? "";

  if (cwd.includes("/worktrees/")) {
    const repoRoot = cwd.split("/worktrees/")[0];
    await run(["git", "-C", repoRoot, "worktree", "remove", "--force", cwd], { allowFail: true });
  }

  await run(["cmux", "close-workspace", ...ws]);
}

const parseActiveId = (output: string) =>
  output
    .split("\n")
    .find((line) => line.includes("*"))!
    .trim()
    .split(/\s+/)[1];

const parseNewId = (output: string) => output.trim().split(/\s+/)[1];

function wsArgs(id?: string) {
  const wsId = id ?? process.env.CMUX_WORKSPACE_ID;
  return wsId ? ["--workspace", wsId] : [];
}

async function sendCmd(cmd: string, ws: string[], surfaceArgs: string[] = []) {
  await run(["cmux", "send", ...surfaceArgs, ...ws, cmd]);
  await run(["cmux", "send-key", ...surfaceArgs, ...ws, "Enter"]);
}
