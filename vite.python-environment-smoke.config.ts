import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    alias: { vscode: resolve(__dirname, "src/test/vscode.mock.ts") },
    environment: "node",
    fileParallelism: false,
    include: ["src/test/pythonEnvironment.smoke.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 35_000
  }
});
