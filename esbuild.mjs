import { build, context } from "esbuild";

//@ts-check
/** @typedef {import("esbuild").BuildOptions} BuildOptions **/

/** @type BuildOptions */
const baseConfig = {
	bundle: true,
	minify: process.env.NODE_ENV === "production",
	sourcemap: process.env.NODE_ENV !== "production",
};

/** @type BuildOptions */
const extensionConfig = {
	...baseConfig,
	platform: "node",
	mainFields: ["module", "main"],
	format: "cjs",
	entryPoints: ["./src/extension.ts"],
	outfile: "./dist/extension.js",
	external: ["vscode"],
	tsconfig: "./tsconfig.node.json",
};

/**
 * @param {string} subsystem
 * @returns {BuildOptions}
 */
function getWebviewConfig(subsystem) {
	return {
		...baseConfig,
		format: "esm",
		entryPoints: [`./src/views/${subsystem}/webview/index.tsx`],
		outfile: `./dist/${subsystem}/index.js`,
		tsconfig: "./tsconfig.app.json",
	};
}

/** @type BuildOptions[] */
const configs = [
	extensionConfig,
	getWebviewConfig("judge"),
	getWebviewConfig("stress"),
];

(async () => {
	const args = process.argv.slice(2);
	try {
		if (args.includes("--watch")) {
			console.log("[watch] build started");
			for (const config of configs) {
				(await context(config)).watch();
			}
			console.log("[watch] build finished, watching for changes...");
		} else {
			const builds = configs.map((config) => build(config));
			await Promise.all(builds);
			console.log("build complete");
		}
	} catch (err) {
		process.stderr.write(err.stderr);
		process.exit(1);
	}
})();
