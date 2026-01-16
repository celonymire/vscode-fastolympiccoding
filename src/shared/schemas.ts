import * as v from "valibot";
import { StatusSchema } from "./enums";

export const MODES = ["standard", "interactive"] as const;
export type Mode = (typeof MODES)[number];

export const LanguageSettingsSchema = v.object({
  compileCommand: v.optional(v.array(v.string())),
  runCommand: v.optional(v.array(v.string())),
  currentWorkingDirectory: v.optional(v.string()),
  debugCommand: v.optional(v.array(v.string())),
  debugAttachConfig: v.optional(v.string()),
});
export type LanguageSettings = v.InferOutput<typeof LanguageSettingsSchema>;

export const RunSettingsSchema = v.pipe(
  v.looseObject({
    interactorFile: v.optional(v.string()),
    goodSolutionFile: v.optional(v.string()),
    generatorFile: v.optional(v.string()),
  }),
  v.check((value) => {
    // Validate that any additional properties have keys starting with '.' (file extension)
    return Object.keys(value).every((key) => {
      if (key !== "interactorFile" && key !== "goodSolutionFile" && key !== "generatorFile") {
        return key.startsWith(".");
      }
      return true; // Skip known properties
    });
  }, "Additional properties must be file extensions (starting with '.')"),
  v.check((value) => {
    // Validate the values of additional properties match LanguageSettingsSchema
    return Object.entries(value).every(([key, val]) => {
      if (key !== "interactorFile" && key !== "goodSolutionFile" && key !== "generatorFile") {
        return v.safeParse(LanguageSettingsSchema, val).success;
      }
      return true; // Skip known properties
    });
  }, "Additional property values must match language settings schema")
);
export type RunSettings = v.InferOutput<typeof RunSettingsSchema>;

export const TestSchema = v.object({
  input: v.string(),
  output: v.string(),
});

export const TestcaseSchema = v.object({
  uuid: v.fallback(v.string(), () => crypto.randomUUID()),
  stdin: v.fallback(v.string(), ""),
  stderr: v.fallback(v.string(), ""),
  stdout: v.fallback(v.string(), ""),
  acceptedStdout: v.fallback(v.string(), ""),
  elapsed: v.fallback(v.number(), 0),
  memoryBytes: v.fallback(v.number(), 0),
  status: v.fallback(StatusSchema, "NA"),
  shown: v.fallback(v.boolean(), true),
  toggled: v.fallback(v.boolean(), false),
  skipped: v.fallback(v.boolean(), false),
  mode: v.fallback(v.picklist(MODES), "standard"),
  interactorSecret: v.fallback(v.string(), ""),
});

export type Testcase = v.InferOutput<typeof TestcaseSchema>;
export type TestcaseProperty = Exclude<keyof Testcase, "uuid">;

export const InputTypeValues = ["stdin", "file", "regex"] as const;
export type InputType = (typeof InputTypeValues)[number];

export const OutputTypeValues = ["stdout", "file"] as const;
export type OutputType = (typeof OutputTypeValues)[number];

export const TestTypeValues = ["single", "multiNumber"] as const;
export type TestType = (typeof TestTypeValues)[number];

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
  testType: v.picklist(TestTypeValues),
  input: InputSchema,
  output: OutputSchema,
  languages: LanguagesSchema,
  batch: v.object({
    id: v.string(),
    size: v.number(),
  }),
});
