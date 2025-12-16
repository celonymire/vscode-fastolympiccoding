import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import eslintPluginSvelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts"],
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
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Rely on TypeScript for undefined symbols in TS files
      "no-undef": "off",
      // Disable base no-redeclare rule as it conflicts with TypeScript function overloads
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
    },
  },
  ...eslintPluginSvelte.configs["flat/recommended"],
  {
    files: ["src/**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsparser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
      },
      globals: {
        ...globals.browser,
        acquireVsCodeApi: "readonly",
        // Svelte 5 runes
        $state: "readonly",
        $derived: "readonly",
        $effect: "readonly",
        $props: "readonly",
        $bindable: "readonly",
        $inspect: "readonly",
        $host: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Rely on TypeScript for undefined symbols
      "no-undef": "off",
      // Disable base rule and use TypeScript version which better understands type definitions
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
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
