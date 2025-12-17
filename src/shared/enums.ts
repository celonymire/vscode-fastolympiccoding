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
  ML = 9,
}

export enum Stdio {
  STDIN = 0,
  STDERR = 1,
  STDOUT = 2,
  ACCEPTED_STDOUT = 3,
}
