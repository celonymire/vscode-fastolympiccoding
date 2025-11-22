import * as v from "valibot";

export enum Status {
  CE = 0,
  RE = 1,
  WA = 2,
  AC = 3,
  NA = 4,
  TL = 5,
  COMPILING = 6,
  RUNNING = 7,
  EDITING = 8,
}

export enum Stdio {
  STDIN = 0,
  STDERR = 1,
  STDOUT = 2,
  ACCEPTED_STDOUT = 3,
}

export const TestcaseSchema = v.object({
  stdin: v.string(),
  stderr: v.string(),
  stdout: v.string(),
  acceptedStdout: v.string(),
  elapsed: v.number(),
  status: v.enum(Status),
  shown: v.boolean(),
  toggled: v.boolean(),
  skipped: v.boolean(),
});
