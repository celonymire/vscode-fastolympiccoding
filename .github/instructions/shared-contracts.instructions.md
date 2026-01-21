---
applyTo: "src/shared/**/*.ts"
---

## Purpose

`src/shared/` contains the canonical contracts for extension ↔ webview communication. Both sides must use these types.

## Enums (String Literal Tuples)

Enums are `const` string literal tuples validated via `v.picklist()`:

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

Use Valibot for all schemas. Pattern:

```typescript
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

## Append-Only Rule

When adding new enum values or message types, **append to the end** of arrays. Never rename or reorder existing values—they may be persisted in workspaceState.

## Message Direction

- **ProviderMessage**: Webview → Extension (user actions)
- **WebviewMessage**: Extension → Webview (state updates)

Each view (Judge, Stress) has its own message contracts in `judge-messages.ts` and `stress-messages.ts`.
