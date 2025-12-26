---
applyTo: "binding.gyp,src/addons/**/*.cpp,src/extension/utils/runtime.ts,rspack.config.ts,package.json"
---

This repo includes optional **platform-specific** native addons used for efficient process memory tracking (e.g., memory limits in Judge/Stress):

- **Windows:** `win32-memory-stats` – uses Win32 APIs (`Windows.h`, `psapi.lib`)
- **Linux:** `linux-memory-stats` – reads `/proc/<pid>/status` for peak RSS (`VmHWM`)

When working on files matched by this pattern:

- **Platform-specific:** Each addon is built and runs only on its target platform. Non-matching platforms should degrade gracefully (no hard failures) by falling back to `pidusage`.
- **Build pipeline:** The addons are built via `node-gyp` using [binding.gyp](binding.gyp) and produce:
  - `build/Release/win32-memory-stats.node` (Windows)
  - `build/Release/linux-memory-stats.node` (Linux)
- **Bundling:** [rspack.config.ts](rspack.config.ts) conditionally copies the built `.node` files into `dist/` based on `process.platform`. This ensures builds on non-matching platforms don't fail due to missing addon files.
- **Runtime loading:** [src/extension/utils/runtime.ts](src/extension/utils/runtime.ts) provides lazy-loading functions (`getWin32MemoryAddon()`, `getLinuxMemoryAddon()`) that:
  - Check if the bundled `.node` file exists before attempting to load it
  - Use Node's `createRequire(__filename)` to load the addon (bundlers like rspack/webpack can rewrite `require()`)
  - Treat load failure as "addon unavailable" and fall back to `pidusage` for memory stats (with degraded performance)
  - Log a warning when the addon is unavailable but continue running the extension
  - Cache the loaded addon for subsequent calls
- **Memory sampling:** The `Runnable` class in `runtime.ts` uses `_sampleMemory()` to:
  - Prefer the native addon when available for accurate peak RSS tracking
  - Fall back to `pidusage` when the addon is unavailable or fails
  - Sample memory at regular intervals (`MEMORY_SAMPLE_INTERVAL_MS`) to track peak usage
  - Kill the process when memory limit is exceeded (`_memoryLimitExceeded`)
- **Native builds are detached:** `npm run build` / `npm run watch` do **not** invoke `node-gyp`. Use `npm run build:addon` to build the addon explicitly (intended for CI targeted packaging). Use `npm run build:addon:clean` to clean the addon build output.
- **CI packaging:** CI performs addon builds explicitly only for **targeted** VSIX packaging runs (e.g. `linux-x64`, `win32-x64`); the universal VSIX does not build the addon.
- **Version/ABI:** Be careful when changing the Node target/ABI used by the addon build scripts in `package.json`; mismatches can break runtime loading.