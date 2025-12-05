import * as v from "valibot";
import { Status } from "./enums";

export const LanguageSettingsSchema = v.object({
  compileCommand: v.optional(v.string()),
  runCommand: v.string(),
  currentWorkingDirectory: v.optional(v.string()),
});

export const TestSchema = v.object({
  input: v.string(),
  output: v.string(),
});

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

const InputStdinSchema = v.object({
  type: v.literal("stdin"),
});

const InputFileSchema = v.object({
  type: v.literal("file"),
  fileName: v.string(),
});

const InputRegexSchema = v.object({
  type: v.literal("regex"),
  pattern: v.string(),
});

const InputSchema = v.union([InputStdinSchema, InputFileSchema, InputRegexSchema]);

const OutputStdoutSchema = v.object({
  type: v.literal("stdout"),
});

const OutputFileSchema = v.object({
  type: v.literal("file"),
  fileName: v.string(),
});

const OutputSchema = v.union([OutputStdoutSchema, OutputFileSchema]);

const LanguagesStringSchema = v.record(v.string(), v.string());

const LanguagesJavaSchema = v.object({
  java: v.object({
    mainClass: v.string(),
    taskClass: v.string(),
  }),
});

const LanguagesSchema = v.union([LanguagesStringSchema, LanguagesJavaSchema]);

export const ProblemSchema = v.object({
  name: v.string(),
  group: v.string(),
  url: v.string(),
  interactive: v.optional(v.boolean()),
  memoryLimit: v.number(),
  timeLimit: v.number(),
  tests: v.array(TestSchema),
  testType: v.picklist(["single", "multiNumber"]),
  input: InputSchema,
  output: OutputSchema,
  languages: LanguagesSchema,
  batch: v.object({
    id: v.string(),
    size: v.number(),
  }),
});
