import * as js from "@eslint/js";
import * as tseslint from "@typescript-eslint/eslint-plugin";
import * as tsparser from "@typescript-eslint/parser";
import * as react from "eslint-plugin-react";
import prettier from "eslint-config-prettier";
import * as globals from "globals";

// eslint-plugin-preact is CommonJS without types, use require
// eslint-disable-next-line @typescript-eslint/no-require-imports
const preact = require("eslint-plugin-preact") as {
  configs: { recommended: { rules: Record<string, unknown> } };
};

export default [
  js.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "src/external/**"],
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        // Provide both browser and node globals
        // TypeScript will catch incorrect usage based on tsconfig
        ...globals.browser,
        ...globals.node,
        acquireVsCodeApi: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      react: react,
      preact: preact,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...preact.configs.recommended.rules,
      // Rely on TypeScript for undefined symbols in TS files
      "no-undef": "off",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    // Shared protocol/message definitions - allow unused enum members
    files: ["src/shared/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  prettier,
];
