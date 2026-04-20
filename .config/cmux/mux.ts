#!/usr/bin/env bun
import { $ } from "bun";
import { parseArgs } from "util";
import { homedir } from "os";
import { basename, join } from "path";

// ── Helpers ──────────────────────────────────────────────────────────────────

const parseActiveId = (output: string) =>
  output.split("\n").find((l) => l.includes("*"))!.trim().split(/\s+/)[1];

const parseNewId = (output: string) => output.trim().split(/\s+/)[1];

function wsArgs(id?: string) {
  const wsId = id ?? process.env.CMUX_WORKSPACE_ID;
  return wsId ? ["--workspace", wsId] : [];
}

async function sendCmd(cmd: string, ws: string[], surfaceArgs: string[] = []) {
  await $`cmux send ${surfaceArgs} ${ws} ${cmd}`;
  await $`cmux send-key ${surfaceArgs} ${ws} Enter`;
}

const subcommand = process.argv[2];

if (subcommand === "start") {
  await start();
} else if (subcommand === "close") {
  await close();
} else {
  console.error("Usage: mux <start|close> [options]");
  process.exit(1);
}

// ── start ─────────────────────────────────────────────────────────────────────

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
    const wtPath = join(homedir(), "worktrees", basename(cwd), branch);
    // Try checking out existing branch first, then fall back to creating a new one
    const checkout = await $`git -C ${cwd} worktree add ${wtPath} ${branch}`.quiet().nothrow();
    if (checkout.exitCode !== 0) {
      const create = await $`git -C ${cwd} worktree add -b ${branch} ${wtPath}`.quiet().nothrow();
      if (create.exitCode !== 0) {
        console.error(`Failed to set up worktree for branch '${branch}':\n${create.stderr.toString().trim()}`);
        process.exit(1);
      }
    }
    cwd = wtPath;
    if (!name) name = branch;
  }

  const ws = wsArgs();
  const quotedCwd = $.escape(cwd);

  const [, listPanesOut] = await Promise.all([
    name ? $`cmux rename-workspace ${ws} ${name}` : Promise.resolve(),
    $`cmux list-panes ${ws}`.text(),
  ]);

  const currentPane = parseActiveId(listPanesOut);

  // Get claudeSurface before creating new surfaces to avoid ID collision
  const claudeSurface = parseActiveId(
    await $`cmux list-pane-surfaces --pane ${currentPane} ${ws}`.text()
  );

  const [nvimSurfaceOut, browserPaneOut] = await Promise.all([
    $`cmux new-surface --type terminal --pane ${currentPane} ${ws}`.text(),
    $`cmux new-pane --type browser --direction right ${ws}`.text(),
  ]);

  const nvimSurface = parseNewId(nvimSurfaceOut);
  const browserPane = parseNewId(browserPaneOut);

  const lazygitSurface = parseNewId(
    await $`cmux new-split down --surface ${browserPane} ${ws}`.text()
  );

  await Promise.all([
    sendCmd(`cd ${quotedCwd} && claude --dangerously-skip-permissions${prompt ? ` -p ${$.escape(prompt)}` : ""}`, ws, ["--surface", claudeSurface]),
    sendCmd(`cd ${quotedCwd} && ./gradlew build -x test && nvim`, ws, ["--surface", nvimSurface]),
    sendCmd(`cd ${quotedCwd} && lazygit`, ws, ["--surface", lazygitSurface]),
  ]);

  await Promise.all([
    $`cmux focus-pane --pane ${currentPane} ${ws}`,
    $`cmux move-surface --surface ${claudeSurface} --pane ${currentPane} --focus true ${ws}`,
  ]);
}

// ── close ─────────────────────────────────────────────────────────────────────

async function close() {
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

  // Find the cwd from the active pane
  const listPanesOut = await $`cmux list-panes ${ws}`.text();
  const cwd = listPanesOut
    .split("\n")
    .find((l) => l.includes("*"))
    ?.trim()
    .split(/\s+/)
    .at(-1) ?? "";

  // Remove git worktree if we're inside ~/worktrees
  if (cwd.includes("/worktrees/")) {
    const repoRoot = cwd.split("/worktrees/")[0];
    await $`git -C ${repoRoot} worktree remove --force ${cwd}`.nothrow();
  }

  await $`cmux close-workspace ${ws}`;
}
