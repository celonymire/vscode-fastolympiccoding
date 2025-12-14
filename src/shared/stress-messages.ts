import * as v from "valibot";
import { Status } from "~shared/enums";

export enum WebviewMessageType {
  STATUS = 0,
  STDIO = 1,
  CLEAR = 2,
  SHOW = 3,
}

export const StatusMessageSchema = v.object({
  type: v.literal(WebviewMessageType.STATUS),
  id: v.number(),
  status: v.enum(Status),
});

export const StdioMessageSchema = v.object({
  type: v.literal(WebviewMessageType.STDIO),
  id: v.number(),
  data: v.string(),
});

export const ClearMessageSchema = v.object({
  type: v.literal(WebviewMessageType.CLEAR),
});

export const ShowMessageSchema = v.object({
  type: v.literal(WebviewMessageType.SHOW),
  visible: v.boolean(),
});

export const WebviewMessageSchema = v.union([
  StatusMessageSchema,
  StdioMessageSchema,
  ClearMessageSchema,
  ShowMessageSchema,
]);

export type WebviewMessage = v.InferOutput<typeof WebviewMessageSchema>;

export enum ProviderMessageType {
  LOADED = 0,
  RUN = 1,
  STOP = 2,
  VIEW = 3,
  ADD = 4,
  CLEAR = 5,
}

export const LoadedMessageSchema = v.object({
  type: v.literal(ProviderMessageType.LOADED),
});

export const RunMessageSchema = v.object({
  type: v.literal(ProviderMessageType.RUN),
});

export const StopMessageSchema = v.object({
  type: v.literal(ProviderMessageType.STOP),
});

export const ViewMessageSchema = v.object({
  type: v.literal(ProviderMessageType.VIEW),
  id: v.number(),
});

export const AddMessageSchema = v.object({
  type: v.literal(ProviderMessageType.ADD),
  id: v.number(),
});

export const ResetMessageSchema = v.object({
  type: v.literal(ProviderMessageType.CLEAR),
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
