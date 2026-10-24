import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/dist/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/output/**",
      "artifacts/**",
      ".artifacts/**",
      "tmp/**",
      "packages/infinite-canvas-plugin/vendor/**",
      "packages/canvas-runtime/vendor/**",
      "apps/web/public/plugins/**",
      "**/.playwright-cli/**",
      "**/.output/**",
      "**/.wxt/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["docs/erp-blueprint/scripts/*.mjs", "docs/project-control/scripts/*.mjs", "docs/upgrade-plans/**/verify-*.mjs"],
    languageOptions: {
      globals: { URL: "readonly", console: "readonly", process: "readonly", Buffer: "readonly" },
    },
  },
  {
    files: ["docs/erp-blueprint/design/prototype.js"],
    languageOptions: {
      globals: {
        document: "readonly", window: "readonly", localStorage: "readonly",
        location: "readonly", history: "readonly", matchMedia: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        // The standalone prototype builder supplies its embedded Lucide map.
        ICONS: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
