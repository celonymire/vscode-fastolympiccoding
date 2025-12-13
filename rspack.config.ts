import { defineConfig } from "@rspack/cli";
import { type Configuration } from "@rspack/core";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import * as path from "node:path";
import { sveltePreprocess } from "svelte-preprocess";

const isProd = process.env.NODE_ENV === "production";

const sharedResolve: Configuration["resolve"] = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".svelte"],
  alias: {
    "~shared": path.resolve("./src/shared"),
    "~webview": path.resolve("./src/webview"),
    "~extension": path.resolve("./src/extension"),
  },
};

const sharedConfig: Configuration = {
  resolve: sharedResolve,
  optimization: {
    minimize: isProd,
  },
  devtool: isProd ? false : "source-map",
};

const extensionConfig: Configuration = {
  ...sharedConfig,
  entry: {
    extension: "./src/extension/index.ts",
  },
  output: {
    path: path.resolve("./dist"),
    filename: "[name].js",
    libraryTarget: "commonjs2",
  },
  externals: {
    vscode: "commonjs vscode",
  },
  target: "node",
  node: {
    __dirname: false,
    __filename: false,
  },
  resolve: sharedResolve,
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript" },
            },
          },
        },
      },
    ],
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin({
      typescript: {
        configFile: "tsconfig.node.json",
      },
    }),
  ],
};

const webviewsConfig: Configuration = {
  ...sharedConfig,
  experiments: {
    css: true,
  },
  entry: {
    "judge/index": "./src/webview/judge/index.ts",
    "stress/index": "./src/webview/stress/index.ts",
  },
  output: {
    path: path.resolve("./dist"),
    filename: "[name].js",
  },
  target: ["web", "es2015"],
  resolve: {
    ...sharedResolve,
    alias: {
      ...sharedResolve.alias,
    },
    conditionNames: ["svelte", "browser", "import"],
    mainFields: ["svelte", "browser", "module", "main"],
  },
  module: {
    rules: [
      {
        test: /\.svelte$/,
        use: [
          {
            loader: "svelte-loader",
            options: {
              preprocess: sveltePreprocess({ typescript: true }),
              emitCss: true,
              compilerOptions: {
                dev: !isProd,
                css: "external",
              },
              onwarn: (warning: { code: string }, handler: (warning: { code: string }) => void) => {
                if (warning.code.startsWith("a11y")) return;
                handler(warning);
              },
            },
          },
        ],
      },
      {
        test: /\.ts$/,
        exclude: /\.svelte\.ts$/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript" },
            },
          },
        },
      },
    ],
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin({
      typescript: {
        configFile: "tsconfig.app.json",
      },
    }),
  ],
};

export default defineConfig([extensionConfig, webviewsConfig]);
