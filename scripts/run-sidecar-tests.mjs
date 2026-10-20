import { spawnSync } from "node:child_process";
import process from "node:process";

const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
const testFile = "src-tauri/resources/test_playlist_fetch.py";

for (const executable of candidates) {
  const args = executable === "py" ? ["-3", testFile] : [testFile];
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "inherit"
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

throw new Error("Python 3 is required to test the playlist sidecar");
