---
applyTo: "binding.gyp,src/addons/**/*.cpp,src/extension/utils/runtime.ts,rspack.config.ts,package.json"
---

This repo includes an optional **Windows-only** native addon (`win32-memory-stats`) used for efficient process memory tracking (e.g., memory limits in Judge/Stress).

When working on files matched by this pattern:

- **Windows-only:** The addon uses Win32 APIs (`Windows.h`, `psapi.lib`). It must compile and run on Windows; non-Windows platforms should degrade gracefully (no hard failures).
- **Build pipeline:** The addon is built via `node-gyp` using [binding.gyp](binding.gyp) and produces `build/Release/win32-memory-stats.node`.
- **Bundling:** [rspack.config.ts](rspack.config.ts) conditionally copies the built `.node` into `dist/` only when `process.platform === "win32"`. This ensures non-Windows builds don't fail due to a missing addon file.
- **Runtime loading:** [src/extension/utils/runtime.ts](src/extension/utils/runtime.ts) should:
  - Check if the bundled `dist/win32-memory-stats.node` file exists before attempting to load it
  - Use Node's `createRequire(__filename)` to load the addon (bundlers like rspack/webpack can rewrite `require()`)
  - Treat load failure as "addon unavailable" and fall back to `pidusage` for memory stats (with degraded performance)
  - Log a warning when the addon is unavailable but continue running the extension
- **Version/ABI:** Be careful when changing the Node target/ABI used by the addon build scripts in `package.json`; mismatches can break runtime loading.