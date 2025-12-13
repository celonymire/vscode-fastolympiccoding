---
applyTo: "src/shared/**/*.ts"
---

The `src/shared/**` directory contains enums, Valibot schemas, message contracts, and shared types used by both the extension backend (`src/extension/**`) and the webview frontend (`src/webview/**`). These files define the public protocol between the two halves of the extension.

When changing files under `src/shared/**`:

- Treat the message and enum definitions here as the single source of truth for extension ↔ webview communication. All messages use Valibot schemas (e.g., `v.object()`, `v.literal()`, `v.enum()`) with discriminated unions via `v.union([...])` and `type` fields, and both sides should switch on these discriminants.
- When you add new message types or enum members, append them to the existing enums instead of reordering or renaming values. This preserves numeric enum identifiers and avoids breaking persisted data (for example, stored `Status` values).
- Keep message payloads minimal but explicit. Prefer well-typed Valibot schemas over loosely structured objects to make it clear what each side should expect.
- If you change a shared type, update both the extension providers (under `src/extension/providers/**`) and the corresponding webview handlers (under `src/webview/**`) in the same change to avoid protocol drift.
- The `Status` enum in `enums.ts` models the run lifecycle: COMPILING → RUNNING → (AC | WA | RE | TL | CE | NA | EDITING). Preserve these semantics when adding new statuses and ensure the UI and backend continue to interpret them consistently.
- Use Valibot (`import * as v from "valibot"`) for all schemas. Define individual message schemas, then combine them into a union schema and export an inferred type (e.g., `type WebviewMessage = v.InferOutput<typeof WebviewMessageSchema>`).
- Because these contracts are central to the extension's behavior, keep changes focused and backwards-compatible wherever possible.

When adding a new feature that requires extension ↔ webview communication:

- First, define or extend the shared contract in `src/shared/` (add a new enum member, Valibot schema, and union entry). Append to existing enums rather than reordering to keep numeric values stable.
- Then update the relevant Provider class under `src/extension/providers/` to mutate its internal state, call `_postMessage` with the new message type, and persist state via `writeStorage()` only after all mutations are complete.
- Finally, implement handling for the new message type on the webview side under `src/webview/**`, adding a case to the `window.addEventListener("message", ...)` handler in `App.tsx`. Do not rely on message ordering beyond the established initial `INITIAL_STATE` / `SHOW` messages.
