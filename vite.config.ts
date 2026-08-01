import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const notebookRendererBuild = mode === "notebook-renderer";
  return {
    base: "./",
    plugins: notebookRendererBuild ? [] : [react()],
    publicDir: notebookRendererBuild ? false : "assets",
    build: {
      outDir: "media",
      emptyOutDir: false,
      sourcemap: true,
      rollupOptions: {
        preserveEntrySignatures: "strict",
        input: notebookRendererBuild
          ? resolve(__dirname, "src/webviews/notebookRenderer.ts")
          : {
              webview: resolve(__dirname, "src/webviews/main.tsx"),
              codePreview: resolve(__dirname, "src/webviews/codePreviewMain.ts")
            },
        output: {
          entryFileNames: notebookRendererBuild ? "notebookRenderer.js" : "[name].js",
          chunkFileNames: "[name].js",
          assetFileNames: "[name][extname]",
          codeSplitting: notebookRendererBuild ? false : undefined
        }
      }
    },
    test: {
      alias: { vscode: resolve(__dirname, "src/test/vscode.mock.ts") },
      environment: "jsdom",
      globals: true,
      // Vitest otherwise derives its fork count from the host CPU count. Keep
      // ordinary and coverage suites bounded on high-core developer and CI hosts.
      maxWorkers: 4,
      // Hosted Windows runners can take more than Vitest's 5-second default to
      // initialize concurrent jsdom/React files. Keep every test bounded while
      // avoiding platform-load failures unrelated to an individual assertion.
      testTimeout: 15_000,
      include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"],
      coverage: {
        provider: "v8",
        // Coverage remapping has a separate CPU-derived concurrency default.
        // Keep it aligned with the bounded test-file worker ceiling above.
        processingConcurrency: 4,
        reporter: ["text", "json-summary", "html"],
        thresholds: {
          statements: 60,
          branches: 55,
          functions: 60,
          lines: 65
        }
      }
    }
  };
});
