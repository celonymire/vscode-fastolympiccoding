import * as v from "valibot";
import { Stdio } from "~shared/enums";

export enum Action {
  RUN = 0,
  STOP = 1,
  DELETE = 2,
  EDIT = 3,
  ACCEPT = 4,
  DECLINE = 5,
  TOGGLE_VISIBILITY = 6,
  TOGGLE_SKIP = 7,
  COMPARE = 8,
  DEBUG = 9,
}

export enum ProviderMessageType {
  LOADED = 0,
  NEXT = 1,
  ACTION = 2,
  SAVE = 3,
  VIEW = 4,
  STDIN = 5,
  TL = 6,
  ML = 7,
}

export const LoadedMessageSchema = v.object({
  type: v.literal(ProviderMessageType.LOADED),
});

export const NextMessageSchema = v.object({
  type: v.literal(ProviderMessageType.NEXT),
});

export const ActionMessageSchema = v.object({
  type: v.literal(ProviderMessageType.ACTION),
  id: v.number(),
  action: v.enum(Action),
});

export const SaveMessageSchema = v.object({
  type: v.literal(ProviderMessageType.SAVE),
  id: v.number(),
  stdin: v.string(),
  acceptedStdout: v.string(),
});

export const ViewMessageSchema = v.object({
  type: v.literal(ProviderMessageType.VIEW),
  id: v.number(),
  stdio: v.enum(Stdio),
});

export const StdinMessageSchema = v.object({
  type: v.literal(ProviderMessageType.STDIN),
  id: v.number(),
  data: v.string(),
});

export const SetTimeLimitSchema = v.object({
  type: v.literal(ProviderMessageType.TL),
  limit: v.number(),
});

export const SetMemoryLimitSchema = v.object({
  type: v.literal(ProviderMessageType.ML),
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

export enum WebviewMessageType {
  NEW = 0,
  SET = 1,
  STDIO = 2,
  DELETE = 3,
  SAVE_ALL = 4,
  SHOW = 5,
  INITIAL_STATE = 6,
  SETTINGS_TOGGLE = 7,
}

export const NewMessageSchema = v.object({
  type: v.literal(WebviewMessageType.NEW),
  id: v.number(),
});

export const SetMessageSchema = v.object({
  type: v.literal(WebviewMessageType.SET),
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
  type: v.literal(WebviewMessageType.STDIO),
  id: v.number(),
  stdio: v.enum(Stdio),
  data: v.string(),
});

export const DeleteMessageSchema = v.object({
  type: v.literal(WebviewMessageType.DELETE),
  id: v.number(),
});

export const SaveAllMessageSchema = v.object({
  type: v.literal(WebviewMessageType.SAVE_ALL),
});

export const ShowMessageSchema = v.object({
  type: v.literal(WebviewMessageType.SHOW),
  visible: v.boolean(),
});

export const InitialStateSchema = v.object({
  type: v.literal(WebviewMessageType.INITIAL_STATE),
  timeLimit: v.number(),
  memoryLimit: v.number(),
});

export const SettingsToggleSchema = v.object({
  type: v.literal(WebviewMessageType.SETTINGS_TOGGLE),
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
