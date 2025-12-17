---
applyTo: "binding.gyp,src/addons/**/*.cpp,src/extension/utils/runtime.ts,rspack.config.ts,package.json"
---

This repo includes an optional **Windows-only** native addon (`win32-memory-stats`) used for efficient process memory tracking (e.g., memory limits in Judge/Stress).

When working on files matched by this pattern:

- **Windows-only:** The addon uses Win32 APIs (`Windows.h`, `psapi.lib`). It must compile and run on Windows; non-Windows should degrade gracefully (no hard failures).
- **Build pipeline:** The addon is built via `node-gyp` using [binding.gyp](binding.gyp) and produces `build/Release/win32-memory-stats.node`.
- **Bundling:** [rspack.config.ts](rspack.config.ts) copies the built `.node` into `dist/` (keep `noErrorOnMissing: true` so builds still work when the addon isn’t present).
- **Runtime loading:** [src/extension/utils/runtime.ts](src/extension/utils/runtime.ts) should:
  - Prefer loading the bundled `dist/win32-memory-stats.node` (relative to the compiled extension output)
  - Fall back to `require("win32-memory-stats")` when appropriate
  - Treat load failure as “addon unavailable” and keep the extension functional
- **Version/ABI:** Be careful when changing the Node target/ABI used by the addon build scripts in `package.json`; mismatches can break runtime loading.
