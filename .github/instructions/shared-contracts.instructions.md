---
applyTo: "src/shared/**/*.ts"
---

## Purpose

`src/shared/` contains the canonical contracts for extension ↔ webview communication. Both sides must use these types.

## Enums (String Literal Tuples)

Enums are `const` string literal tuples validated via `v.picklist()`. All string literal tuples (including `ActionValues`, `InputTypeValues`, `ProviderMessageTypeValues`, `WebviewMessageTypeValues`, etc.) follow the same append-only rule.

### Status

```typescript
StatusValues = [
  "CE",
  "RE",
  "WA",
  "AC",
  "NA",
  "TL",
  "COMPILING",
  "RUNNING",
  "EDITING",
  "ML",
] as const;
```

Lifecycle: `NA` → `COMPILING` → `RUNNING` → (terminal state)

Terminal states:

- `AC`: Accepted (output matches expected)
- `WA`: Wrong Answer (output differs)
- `RE`: Runtime Error (non-zero exit, signal)
- `TL`: Time Limit exceeded
- `ML`: Memory Limit exceeded
- `CE`: Compilation Error

Transient states:

- `NA`: Not run yet
- `COMPILING`: Compilation in progress
- `RUNNING`: Execution in progress
- `EDITING`: User is editing (webview-only state)

### Stdio

```typescript
StdioValues = ["STDIN", "STDERR", "STDOUT", "ACCEPTED_STDOUT", "INTERACTOR_SECRET"] as const;
```

- `STDIN`: Input data
- `STDOUT`: Program output
- `STDERR`: Error output
- `ACCEPTED_STDOUT`: Expected output for comparison
- `INTERACTOR_SECRET`: Secret from interactor (interactive mode)

### Mode

```typescript
MODES = ["standard", "interactive"] as const;
```

- `standard`: Normal input/output comparison
- `interactive`: Uses interactor process

### StateId (Stress)

```typescript
StateIdValue = ["Generator", "Solution", "Judge"] as const;
```

## Schema Patterns

Use Valibot for all schemas.

### Message Type Arrays

When adding a new message schema, its `type` literal **must** also be appended to the corresponding `ProviderMessageTypeValues` or `WebviewMessageTypeValues` array. This prevents the arrays from falling out of sync with the union schemas.

```typescript
export const ProviderMessageTypeValues = [
  "EXAMPLE",
  "OTHER",
  // Append new types here
] as const;

export const ExampleMessageSchema = v.object({
  type: v.literal("EXAMPLE"),
  payload: v.string(),
});
```

Combine into union:

```typescript
export const AllMessagesSchema = v.union([ExampleMessageSchema, OtherMessageSchema]);
export type AllMessages = v.InferOutput<typeof AllMessagesSchema>;
```

### Advanced Valibot Patterns

- **Default Values:** Use `v.fallback()` to provide default state values (e.g., `v.fallback(v.string(), "")` or `v.fallback(v.string(), () => crypto.randomUUID())`).
- **Complex Validation:** Use `v.pipe()`, `v.looseObject()`, and `v.check()` for custom validation logic (e.g., in `RunSettingsSchema`).
- **Optional & Record Types:** Use `v.optional()` and `v.record()` for flexible configurations.

### Type Inference and Utility Types

Derive property types from schemas using TypeScript utility types. For example:

```typescript
export type TestcaseProperty = Exclude<keyof Testcase, "uuid">;
```

## Data Schemas (`schemas.ts`)

Key schemas for persisted and exchanged data:

- **`TestcaseSchema`**: Judge testcase with `uuid`, stdio fields, `elapsed`, `memoryBytes`, `status`, `shown`, `toggled`, `skipped`, `mode`, `interactorSecret`. Uses `v.fallback()` for all fields.
- **`StressDataSchema`**: Stress state snapshot with `stdin`, `stdout`, `stderr`, `status`, `state` (StateId), `shown`.
- **`RunSettingsSchema`**: Validated via `v.pipe()` with `v.looseObject()` and `v.check()`. Known keys: `interactorFile`, `goodSolutionFile`, `generatorFile`. Additional properties must be file extensions (starting with `.`) and match `LanguageSettingsSchema`.
- **`LanguageSettingsSchema`**: Per-language config with optional `compileCommand`, `runCommand`, `currentWorkingDirectory`, `debugCommand`, `debugAttachConfig`.
- **`ProblemSchema`**: Competitive Companion problem data with `name`, `group`, `url`, `tests`, `timeLimit`, `memoryLimit`, `interactive`, `batch`, `input`, `output`.
- **`TestSchema`**: Simple `{ input, output }` for CC test pairs.

## Append-Only Rule

When adding new enum values or message types, **append to the end** of arrays. Never rename or reorder existing values—they may be persisted in workspaceState.

## Message Direction

- **ProviderMessage**: Webview → Extension (user actions)
- **WebviewMessage**: Extension → Webview (state updates)

Each view (Judge, Stress) has its own message contracts in `judge-messages.ts` and `stress-messages.ts`.
