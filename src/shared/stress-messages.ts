import * as v from "valibot";
import { StatusSchema, StdioValues } from "./enums";

export const WebviewMessageTypeValues = ["STATUS", "STDIO", "CLEAR", "SHOW"] as const;

export const StateIdValue = ["Generator", "Solution", "Judge"] as const;

export type WebviewMessageTypeValue = (typeof WebviewMessageTypeValues)[number];

export type StateId = (typeof StateIdValue)[number];

export const WebviewMessageTypeSchema = v.picklist(WebviewMessageTypeValues);

export const InitMessageSchema = v.object({
  type: v.literal("INIT"),
  interactiveMode: v.boolean(),
});

export const StatusMessageSchema = v.object({
  type: v.literal("STATUS"),
  id: v.picklist(StateIdValue),
  status: StatusSchema,
});

export const StdioMessageSchema = v.object({
  type: v.literal("STDIO"),
  id: v.picklist(StateIdValue),
  stdio: v.picklist(StdioValues),
  data: v.string(),
});

export const ClearMessageSchema = v.object({
  type: v.literal("CLEAR"),
});

export const ShowMessageSchema = v.object({
  type: v.literal("SHOW"),
  visible: v.boolean(),
});

export const SettingsToggleSchema = v.object({
  type: v.literal("SETTINGS_TOGGLE"),
});

export const WebviewMessageSchema = v.union([
  InitMessageSchema,
  StatusMessageSchema,
  StdioMessageSchema,
  ClearMessageSchema,
  ShowMessageSchema,
  SettingsToggleSchema,
]);

export type WebviewMessage = v.InferOutput<typeof WebviewMessageSchema>;

export const ProviderMessageTypeValues = ["LOADED", "RUN", "STOP", "VIEW", "ADD", "CLEAR"] as const;

export type ProviderMessageTypeValue = (typeof ProviderMessageTypeValues)[number];

export const ProviderMessageTypeSchema = v.picklist(ProviderMessageTypeValues);

export const LoadedMessageSchema = v.object({
  type: v.literal("LOADED"),
});

export const RunMessageSchema = v.object({
  type: v.literal("RUN"),
});

export const StopMessageSchema = v.object({
  type: v.literal("STOP"),
});

export const ViewMessageSchema = v.object({
  type: v.literal("VIEW"),
  id: v.picklist(StateIdValue),
  stdio: v.picklist(StdioValues),
});

export const AddMessageSchema = v.object({
  type: v.literal("ADD"),
  id: v.picklist(StateIdValue),
});

export const ResetMessageSchema = v.object({
  type: v.literal("CLEAR"),
});

export const SaveMessageSchema = v.object({
  type: v.literal("SAVE"),
  interactiveMode: v.boolean(),
});

export const ProviderMessageSchema = v.union([
  LoadedMessageSchema,
  RunMessageSchema,
  StopMessageSchema,
  ViewMessageSchema,
  AddMessageSchema,
  ResetMessageSchema,
  SaveMessageSchema,
]);

export type ProviderMessage = v.InferOutput<typeof ProviderMessageSchema>;
