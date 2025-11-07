import type { Status } from "~shared/types";

export enum WebviewMessageType {
  STATUS = 0,
  STDIO = 1,
  CLEAR = 2,
  SHOW = 3,
  RUNNING = 4,
}
export interface IStatusMessage {
  type: WebviewMessageType.STATUS;
  id: number;
  status: Status;
}
export interface IStdioMessage {
  type: WebviewMessageType.STDIO;
  id: number;
  data: string;
}
export interface IClearMessage {
  type: WebviewMessageType.CLEAR;
}
export interface IShowMessage {
  type: WebviewMessageType.SHOW;
  visible: boolean;
}
export interface IRunningMessage {
  type: WebviewMessageType.RUNNING;
  value: boolean;
}
export type WebviewMessage =
  | IStatusMessage
  | IStdioMessage
  | IClearMessage
  | IShowMessage
  | IRunningMessage;

export enum ProviderMessageType {
  LOADED = 0,
  RUN = 1,
  STOP = 2,
  VIEW = 3,
  ADD = 4,
  CLEAR = 5,
}
export interface ILoadedMessage {
  type: ProviderMessageType.LOADED;
}
export interface IRunMessage {
  type: ProviderMessageType.RUN;
}
export interface IStopMessage {
  type: ProviderMessageType.STOP;
}
export interface IViewMessage {
  type: ProviderMessageType.VIEW;
  id: number;
}
export interface IAddMessage {
  type: ProviderMessageType.ADD;
  id: number;
}
export interface IResetMessage {
  type: ProviderMessageType.CLEAR;
}
export type ProviderMessage =
  | ILoadedMessage
  | IRunMessage
  | IStopMessage
  | IViewMessage
  | IAddMessage
  | IResetMessage;
