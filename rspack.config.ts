import { defineConfig } from "@rspack/cli";
import { CopyRspackPlugin, type Configuration } from "@rspack/core";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import * as path from "node:path";
import { sveltePreprocess } from "svelte-preprocess";

const sharedResolve: Configuration["resolve"] = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".svelte"],
};

function getSharedConfig(isProd: boolean, mode: Configuration["mode"]): Configuration {
  return {
    mode,
    resolve: sharedResolve,
    optimization: {
      minimize: isProd,
    },
    devtool: isProd ? false : "source-map",
  };
}

function addonCopyPlugins(): Configuration["plugins"] {
  const plugins: Configuration["plugins"] = [];

  if (process.platform === "win32") {
    const winMemoryPath = path.join("build", "Release", "win32-memory-stats.node");
    const winTimesPath = path.join("build", "Release", "win32-process-times.node");
    plugins.push(
      new CopyRspackPlugin({
        patterns: [
          {
            from: winMemoryPath,
            to: "win32-memory-stats.node",
          },
          {
            from: winTimesPath,
            to: "win32-process-times.node",
          },
        ],
      })
    );
  } else if (process.platform === "linux") {
    const linuxMemoryPath = path.join("build", "Release", "linux-memory-stats.node");
    const linuxTimesPath = path.join("build", "Release", "linux-process-times.node");
    plugins.push(
      new CopyRspackPlugin({
        patterns: [
          {
            from: linuxMemoryPath,
            to: "linux-memory-stats.node",
          },
          {
            from: linuxTimesPath,
            to: "linux-process-times.node",
          },
        ],
      })
    );
  } else if (process.platform === "darwin") {
    const darwinTimesPath = path.join("build", "Release", "darwin-process-times.node");
    plugins.push(
      new CopyRspackPlugin({
        patterns: [
          {
            from: darwinTimesPath,
            to: "darwin-process-times.node",
          },
        ],
      })
    );
  }

  return plugins;
}

const extensionConfig = (isProd: boolean, mode: Configuration["mode"]): Configuration => ({
  ...getSharedConfig(isProd, mode),
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
    // Only include the addon copy plugin(s) if the built file(s) exist on disk.
    ...(addonCopyPlugins() ?? []),
  ],
});

const webviewsConfig = (isProd: boolean, mode: Configuration["mode"]): Configuration => ({
  ...getSharedConfig(isProd, mode),
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
    new CopyRspackPlugin({
      patterns: [
        {
          from: "node_modules/@vscode/codicons/dist/codicon.css",
          to: "codicons/",
        },
        {
          from: "node_modules/@vscode/codicons/dist/codicon.ttf",
          to: "codicons/",
        },
      ],
    }),
  ],
});

export default defineConfig((_env, argv) => {
  const mode: Configuration["mode"] = (argv.mode as Configuration["mode"]) ?? "development";
  const isProd = mode === "production";
  return [extensionConfig(isProd, mode), webviewsConfig(isProd, mode)];
});
