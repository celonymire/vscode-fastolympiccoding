---
applyTo: "src/shared/**/*.ts"
---

The `src/shared/**` directory contains string literal tuples, Valibot schemas, message contracts, and shared types used by both the extension backend (`src/extension/**`) and the webview frontend (`src/webview/**`). These files define the public protocol between the two halves of the extension.

When changing files under `src/shared/**`:

- Treat the message and enum definitions here as the single source of truth for extension ↔ webview communication. All messages use Valibot schemas (e.g., `v.object()`, `v.literal()`, `v.picklist()`) with discriminated unions via `v.union([...])` and `type` fields, and both sides should switch on these discriminants.
- Shared "enums" are defined as `const` string literal tuples (e.g., `StatusValues = ["CE", "RE", "WA", "AC", "NA", "TL", "COMPILING", "RUNNING", "EDITING", "ML"] as const`) validated via `v.picklist(StatusValues)`. This produces a tight union type via `(typeof StatusValues)[number]` and keeps stable string values for persisted workspace state.
- When you add new message types or enum members, append them to the existing arrays instead of reordering or renaming values. This preserves string identifiers and avoids breaking persisted data (for example, stored `Status` values).
- Keep message payloads minimal but explicit. Prefer well-typed Valibot schemas over loosely structured objects to make it clear what each side should expect.
- If you change a shared type, update both the extension providers (under `src/extension/providers/**`) and the corresponding webview handlers (under `src/webview/**`) in the same change to avoid protocol drift.
- The `Status` type in `enums.ts` models the run lifecycle: COMPILING → RUNNING → (AC | WA | RE | TL | ML | CE | NA). Preserve these semantics when adding new statuses and ensure the UI and backend continue to interpret them consistently.
- Use Valibot (`import * as v from "valibot"`) for all schemas. Define individual message schemas, then combine them into a union schema and export an inferred type (e.g., `type WebviewMessage = v.InferOutput<typeof WebviewMessageSchema>`).
- Because these contracts are central to the extension's behavior, keep changes focused and backwards-compatible wherever possible.

When adding a new feature that requires extension ↔ webview communication:

- First, define or extend the shared contract in `src/shared/` (add a new string literal to the values array, create a Valibot schema, and add to the union). Append to existing arrays rather than reordering to keep string values stable.
- Then update the relevant Provider class under `src/extension/providers/` to mutate its internal state, call `_postMessage` with the new message type, and persist state via `writeStorage()` only after all mutations are complete.
- Finally, implement handling for the new message type on the webview side under `src/webview/**`, adding a case to the `window.addEventListener("message", ...)` handler in `App.svelte`. Do not rely on message ordering beyond the established initial `INITIAL_STATE` / `SHOW` messages.
