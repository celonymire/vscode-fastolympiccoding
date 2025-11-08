import { defineConfig } from "@rspack/cli";
import type { Configuration } from "@rspack/core";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import path from "node:path";

const isProd = process.env.NODE_ENV === "production";

const sharedResolve: Configuration["resolve"] = {
  extensions: [".ts", ".tsx"],
  alias: {
    "~shared": path.resolve("./src/shared"),
    "~webview": path.resolve("./src/webview"),
    "~extension": path.resolve("./src/extension"),
    "~external": path.resolve("./src/external"),
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
  entry: {
    "judge/index": "./src/webview/judge/index.tsx",
    "stress/index": "./src/webview/stress/index.tsx",
  },
  output: {
    path: path.resolve("./dist"),
    filename: "[name].js",
  },
  target: ["web", "es2015"],
  resolve: sharedResolve,
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript", tsx: true },
              transform: {
                react: { runtime: "automatic", importSource: "preact" },
              },
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
