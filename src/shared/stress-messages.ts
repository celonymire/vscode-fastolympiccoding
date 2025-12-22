import * as v from "valibot";
import { StatusSchema } from "./enums";

export const WebviewMessageTypeValues = ["STATUS", "STDIO", "CLEAR", "SHOW", "INIT"] as const;

export type WebviewMessageTypeValue = (typeof WebviewMessageTypeValues)[number];

export const WebviewMessageTypeSchema = v.picklist(WebviewMessageTypeValues);

export const StatusMessageSchema = v.object({
  type: v.literal("STATUS"),
  id: v.number(),
  status: StatusSchema,
});

export const StdioMessageSchema = v.object({
  type: v.literal("STDIO"),
  id: v.number(),
  data: v.string(),
});

export const ClearMessageSchema = v.object({
  type: v.literal("CLEAR"),
});

export const ShowMessageSchema = v.object({
  type: v.literal("SHOW"),
  visible: v.boolean(),
});

export const InitStateSchema = v.object({
  data: v.string(),
  status: StatusSchema,
});

export const InitMessageSchema = v.object({
  type: v.literal("INIT"),
  states: v.tuple([InitStateSchema, InitStateSchema, InitStateSchema]),
});

export const WebviewMessageSchema = v.union([
  StatusMessageSchema,
  StdioMessageSchema,
  ClearMessageSchema,
  ShowMessageSchema,
  InitMessageSchema,
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
  id: v.number(),
});

export const AddMessageSchema = v.object({
  type: v.literal("ADD"),
  id: v.number(),
});

export const ResetMessageSchema = v.object({
  type: v.literal("CLEAR"),
});

export const ProviderMessageSchema = v.union([
  LoadedMessageSchema,
  RunMessageSchema,
  StopMessageSchema,
  ViewMessageSchema,
  AddMessageSchema,
  ResetMessageSchema,
]);

export type ProviderMessage = v.InferOutput<typeof ProviderMessageSchema>;
