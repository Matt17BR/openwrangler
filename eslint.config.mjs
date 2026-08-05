import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".venv/**",
      ".vscode-test/**",
      "dist/**",
      "dist-test/**",
      "media/**",
      "node_modules/**",
      "tmp/**",
      "python/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx,cjs}", "scripts/**/*.mjs", "vite.config.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Cleanup code deliberately clears owned handles and combines caught errors with AggregateError.
      // ESLint 10's generic checks treat both patterns as mistakes even though they are intentional here.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off"
    }
  }
);
