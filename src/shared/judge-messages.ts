import * as v from "valibot";
import { StdioSchema } from "./enums";

export const ActionValues = [
  "RUN",
  "STOP",
  "DELETE",
  "EDIT",
  "ACCEPT",
  "DECLINE",
  "TOGGLE_VISIBILITY",
  "TOGGLE_SKIP",
  "COMPARE",
  "DEBUG",
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
] as const;

export type ProviderMessageTypeValue = (typeof ProviderMessageTypeValues)[number];

export const ProviderMessageTypeSchema = v.picklist(ProviderMessageTypeValues);

export const LoadedMessageSchema = v.object({
  type: v.literal("LOADED"),
});

export const NextMessageSchema = v.object({
  type: v.literal("NEXT"),
});

export const ActionMessageSchema = v.object({
  type: v.literal("ACTION"),
  id: v.number(),
  action: ActionSchema,
});

export const SaveMessageSchema = v.object({
  type: v.literal("SAVE"),
  id: v.number(),
  stdin: v.string(),
  acceptedStdout: v.string(),
});

export const ViewMessageSchema = v.object({
  type: v.literal("VIEW"),
  id: v.number(),
  stdio: StdioSchema,
});

export const StdinMessageSchema = v.object({
  type: v.literal("STDIN"),
  id: v.number(),
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

export const ProviderMessageSchema = v.union([
  LoadedMessageSchema,
  NextMessageSchema,
  ActionMessageSchema,
  SaveMessageSchema,
  ViewMessageSchema,
  StdinMessageSchema,
  SetTimeLimitSchema,
  SetMemoryLimitSchema,
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
  id: v.number(),
});

export const SetMessageSchema = v.object({
  type: v.literal("SET"),
  id: v.number(),
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
  ]),
  value: v.unknown(),
});

export const StdioMessageSchema = v.object({
  type: v.literal("STDIO"),
  id: v.number(),
  stdio: StdioSchema,
  data: v.string(),
});

export const DeleteMessageSchema = v.object({
  type: v.literal("DELETE"),
  id: v.number(),
});

export const SaveAllMessageSchema = v.object({
  type: v.literal("SAVE_ALL"),
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
  SaveAllMessageSchema,
  ShowMessageSchema,
  InitialStateSchema,
  SettingsToggleSchema,
]);

export type WebviewMessage = v.InferOutput<typeof WebviewMessageSchema>;
