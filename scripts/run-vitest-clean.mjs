import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const require = createRequire(import.meta.url);
const vitestCli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

function worktreeSnapshot() {
  // Status catches newly created paths, while the binary diff fingerprints the
  // exact bytes of tracked changes (including files that were already dirty
  // before the test run). "normal" reports untracked directories as one entry,
  // avoiding an enormous listing when container cache mounts are present.
  return [
    git(["status", "--porcelain=v1", "--untracked-files=normal"]),
    git(["diff", "--binary", "--no-ext-diff", "HEAD", "--"])
  ].join("\0");
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not inspect the Git worktree");
  }
  return result.stdout;
}

const before = worktreeSnapshot();
const vitest = spawnSync(process.execPath, [vitestCli, "run", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
const after = worktreeSnapshot();

if (after !== before) {
  process.stderr.write("\nVitest changed the Git worktree. Tests must write only to disposable locations.\n");
  const status = git(["status", "--short", "--untracked-files=normal"]);
  process.stderr.write(status || "Git reports no remaining changes; a tracked file changed and was restored during the run.\n");
  process.exitCode = 1;
} else if (vitest.error) {
  throw vitest.error;
} else {
  process.exitCode = vitest.status ?? 1;
}
