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
      "apps/web/public/plugins/**",
      "**/.playwright-cli/**",
      "**/.output/**",
      "**/.wxt/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
