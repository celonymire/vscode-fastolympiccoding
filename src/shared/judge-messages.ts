import * as v from "valibot";
import { StdioSchema, StdioValues } from "./enums";
import { MODES } from "./schemas";

export const ActionValues = [
  "RUN",
  "STOP",
  "DELETE",
  "ACCEPT",
  "DECLINE",
  "TOGGLE_VISIBILITY",
  "TOGGLE_SKIP",
  "COMPARE",
  "DEBUG",
  "REQUEST_DATA",
  "OPEN_INTERACTOR",
  "TOGGLE_INTERACTIVE",
] as const;

export type ActionValue = (typeof ActionValues)[number];

export const ActionSchema = v.picklist(ActionValues);

export const ProviderMessageTypeValues = [
  "LOADED",
  "NEXT",
  "ACTION",
  "SAVE",
  "VIEW",
  "STDIN",
  "TL",
  "ML",
  "COPY",
] as const;

export type ProviderMessageTypeValue = (typeof ProviderMessageTypeValues)[number];

export const ProviderMessageTypeSchema = v.picklist(ProviderMessageTypeValues);

export const LoadedMessageSchema = v.object({
  type: v.literal("LOADED"),
});

export const NextMessageSchema = v.object({
  type: v.literal("NEXT"),
  mode: v.picklist(MODES),
});

export const ActionMessageSchema = v.object({
  type: v.literal("ACTION"),
  uuid: v.string(),
  action: ActionSchema,
});

export const SaveMessageSchema = v.object({
  type: v.literal("SAVE"),
  uuid: v.string(),
  stdio: StdioSchema,
  data: v.string(),
});

export const ViewMessageSchema = v.object({
  type: v.literal("VIEW"),
  uuid: v.string(),
  stdio: StdioSchema,
});

export const CopyMessageSchema = v.object({
  type: v.literal("COPY"),
  uuid: v.string(),
  stdio: StdioSchema,
});

export const StdinMessageSchema = v.object({
  type: v.literal("STDIN"),
  uuid: v.string(),
  data: v.string(),
});

export const SetTimeLimitSchema = v.object({
  type: v.literal("TL"),
  limit: v.number(),
});

export const SetMemoryLimitSchema = v.object({
  type: v.literal("ML"),
  limit: v.number(),
});

export const RequestTrimmedDataMessageSchema = v.object({
  type: v.literal("REQUEST_TRIMMED_DATA"),
  uuid: v.string(),
  stdio: v.picklist(StdioValues),
});

export const RequestFullDataMessageSchema = v.object({
  type: v.literal("REQUEST_FULL_DATA"),
  uuid: v.string(),
  stdio: v.picklist(StdioValues),
});

export const NewInteractorSecretMessageSchema = v.object({
  type: v.literal("NEW_INTERACTOR_SECRET"),
  uuid: v.string(),
  data: v.string(),
});

export const ProviderMessageSchema = v.union([
  LoadedMessageSchema,
  NextMessageSchema,
  ActionMessageSchema,
  SaveMessageSchema,
  ViewMessageSchema,
  CopyMessageSchema,
  StdinMessageSchema,
  SetTimeLimitSchema,
  SetMemoryLimitSchema,
  RequestTrimmedDataMessageSchema,
  RequestFullDataMessageSchema,
  NewInteractorSecretMessageSchema,
]);

export type ProviderMessage = v.InferOutput<typeof ProviderMessageSchema>;

export const WebviewMessageTypeValues = [
  "NEW",
  "SET",
  "STDIO",
  "DELETE",
  "SAVE_ALL",
  "SHOW",
  "INITIAL_STATE",
  "SETTINGS_TOGGLE",
] as const;

export type WebviewMessageTypeValue = (typeof WebviewMessageTypeValues)[number];

export const WebviewMessageTypeSchema = v.picklist(WebviewMessageTypeValues);

export const NewMessageSchema = v.object({
  type: v.literal("NEW"),
  uuid: v.string(),
});

export const SetMessageSchema = v.object({
  type: v.literal("SET"),
  uuid: v.string(),
  property: v.picklist([
    "stdin",
    "stderr",
    "stdout",
    "acceptedStdout",
    "elapsed",
    "memoryBytes",
    "status",
    "shown",
    "toggled",
    "skipped",
    "mode",
    "interactorSecret",
  ]),
  value: v.unknown(),
});

export const StdioMessageSchema = v.object({
  type: v.literal("STDIO"),
  uuid: v.string(),
  stdio: StdioSchema,
  data: v.string(),
});

export const DeleteMessageSchema = v.object({
  type: v.literal("DELETE"),
  uuid: v.string(),
});

export const ShowMessageSchema = v.object({
  type: v.literal("SHOW"),
  visible: v.boolean(),
});

export const InitialStateSchema = v.object({
  type: v.literal("INITIAL_STATE"),
  timeLimit: v.number(),
  memoryLimit: v.number(),
});

export const SettingsToggleSchema = v.object({
  type: v.literal("SETTINGS_TOGGLE"),
});

export const WebviewMessageSchema = v.union([
  NewMessageSchema,
  SetMessageSchema,
  StdioMessageSchema,
  DeleteMessageSchema,
  ShowMessageSchema,
  InitialStateSchema,
  SettingsToggleSchema,
]);

export type WebviewMessage = v.InferOutput<typeof WebviewMessageSchema>;
