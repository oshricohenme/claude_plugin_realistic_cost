// @ts-check
import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "opencode/node_modules/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node globals for plain-JS scripts (the TS configs already know these).
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", require: "readonly", Buffer: "readonly" },
    },
  },
  {
    rules: {
      // Dead code is a bug in waiting — this repo shipped several unused
      // exports and locals before these were switched on.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // The opencode plugin talks to an untyped host API.
    files: ["opencode/plugins/**/*.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
)
