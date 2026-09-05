import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // Plain Node ESM: no TypeScript, no React, no bundler.
    ...js.configs.recommended,
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      // Every empty block here is a `catch {}` around best-effort teardown: the
      // health poll retry, ws.terminate(), the failure-diagnostic log dump, and
      // end-of-test close. Swallowing is the point. Empty `if`/`for`/`while`
      // blocks still fail, since those are the ones that hide a real bug.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
