import * as v from "valibot";

/**
 * Shared "enum" values are represented as string-literal tuples so they:
 * - produce a tight union type via `(typeof Values)[number]`,
 * - provide a runtime list for Valibot validation via `v.picklist(...)`,
 * - keep stable string values for persisted workspace state.
 *
 * NOTE: Append new values; do not rename existing values.
 */

// ----------------------------------------------------------------------------
// Status
// ----------------------------------------------------------------------------

export const StatusValues = [
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

export type Status = (typeof StatusValues)[number];

export const StatusSchema = v.picklist(StatusValues);

// ----------------------------------------------------------------------------
// Stdio
// ----------------------------------------------------------------------------

export const StdioValues = ["STDIN", "STDERR", "STDOUT", "ACCEPTED_STDOUT"] as const;

export type Stdio = (typeof StdioValues)[number];

export const StdioSchema = v.picklist(StdioValues);
