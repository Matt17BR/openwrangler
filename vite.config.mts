import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const jsYamlVendorTestModule = resolve(import.meta.dirname, "node_modules/js-yaml/dist/js-yaml.cjs.js");
const realRContractTests = [
  "src/test/rFrameContract.cross.test.ts",
  "src/test/rInteractiveSessionTransport.cross.test.ts",
  "src/test/rKernelTransport.cross.test.ts",
  "src/test/rProcessTransport.cross.test.ts"
];
const domTests = [
  "src/test/**/*.test.tsx",
  "src/test/gridClipboard.unit.test.ts",
  "src/test/notebookRenderer.unit.test.ts",
  "src/test/codePreviewSynchronization.unit.test.ts"
];
const testOptions = {
  alias: [
    { find: /^\.\/vendor\/js-yaml$/u, replacement: jsYamlVendorTestModule },
    { find: "vscode", replacement: resolve(import.meta.dirname, "src/test/vscode.mock.ts") }
  ],
  globals: true,
  // Hosted Windows runners can take more than Vitest's 5-second default to
  // initialize concurrent jsdom/React files. Keep every test bounded while
  // avoiding platform-load failures unrelated to an individual assertion.
  testTimeout: 15_000,
  // Real-R contracts are an explicit test tier with their own environment,
  // package preflight, and bounded phase runner. Keep ordinary Vitest runs
  // honest instead of discovering and conditionally skipping that tier.
  ...(process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1" ? {} : { exclude: realRContractTests })
};

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
          ? resolve(import.meta.dirname, "src/webviews/notebookRenderer.ts")
          : {
              webview: resolve(import.meta.dirname, "src/webviews/main.tsx"),
              codePreview: resolve(import.meta.dirname, "src/webviews/codePreviewMain.ts")
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
      // Vitest otherwise derives its fork count from the host CPU count. Keep
      // ordinary suites bounded on high-core developer and CI hosts.
      maxWorkers: 4,
      projects: [
        {
          plugins: [react()],
          test: {
            ...testOptions,
            name: "node",
            environment: "node",
            include: ["src/test/**/*.test.ts"],
            exclude: [...(testOptions.exclude ?? []), ...domTests]
          }
        },
        {
          plugins: [react()],
          test: {
            ...testOptions,
            name: "dom",
            environment: "jsdom",
            include: domTests,
            setupFiles: ["src/test/popoverTestSetup.ts"]
          }
        }
      ]
    }
  };
});
