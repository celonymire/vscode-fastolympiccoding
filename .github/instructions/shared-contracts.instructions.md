---
applyTo: "src/shared/**/*.ts"
---

The `src/shared/**` directory contains enums, message contracts, schemas, and shared types used by both the extension backend (`src/extension/**`) and the webview frontend (`src/webview/**`). These files define the public protocol between the two halves of the extension.

When changing files under `src/shared/**`:

- Treat the message and enum definitions here as the single source of truth for extension ↔ webview communication. All messages should be discriminated unions with clear `type` or `kind` fields, and both sides should switch on these discriminants.
- When you add new message types or enum members, append them to the existing enums instead of reordering or renaming values. This preserves numeric enum identifiers and avoids breaking persisted data (for example, stored `Status` values).
- Keep message payloads minimal but explicit. Prefer well-typed fields over loosely structured objects to make it clear what each side should expect.
- If you change a shared type, update both the extension providers (under `src/extension/providers/**`) and the corresponding webview handlers (under `src/webview/**`) in the same change to avoid protocol drift.
- The `Status` enum in `types.ts` models the run lifecycle: COMPILING → RUNNING → (AC | WA | RE | TL | CE | NA | EDITING). Preserve these semantics when adding new statuses and ensure the UI and backend continue to interpret them consistently.
- Schemas and validation helpers here should remain lightweight and focused on the Judge/Stress workflows. Avoid introducing heavy validation frameworks unless absolutely required.
- Because these contracts are central to the extension's behavior, keep changes focused and backwards-compatible wherever possible.

When adding a new feature that requires extension ↔ webview communication:

- First, define or extend the shared contract in `src/shared/` (add a new enum member, interface, and union entry as needed). Append to existing enums rather than reordering to keep numeric values stable.
- Then update the relevant Provider class under `src/extension/providers/` to mutate its internal state, call `_postMessage` with the new message type, and persist state via `writeStorage()` only after all mutations are complete.
- Finally, implement handling for the new message type on the webview side under `src/webview/**`, updating the relevant `App.tsx` and components to react to the new messages. Do not rely on message ordering beyond the established initial `INITIAL_STATE` / `SHOW` messages.
