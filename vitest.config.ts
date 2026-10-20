import os from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// jsdom 27+ defers window.localStorage to Node's built-in Web Storage API, which
// throws away silently unless a backing file is given. Set via NODE_OPTIONS (rather
// than poolOptions.execArgv) so it reaches vitest's worker pool regardless of
// whether that pool is forks or threads, on every OS this project builds on.
const localStorageFlag = `--localstorage-file=${path.join(os.tmpdir(), "mxtp-mkr-vitest-localstorage.db")}`;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, localStorageFlag].filter(Boolean).join(" ");

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    globals: true,
    css: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  }
});
