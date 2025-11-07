import type { ITestcase, Stdio } from "~shared/types";

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
}

export enum ProviderMessageType {
  LOADED = 0,
  NEXT = 1,
  ACTION = 2,
  SAVE = 3,
  VIEW = 4,
  STDIN = 5,
  TL = 6,
}
export interface ILoadedMessage {
  type: ProviderMessageType.LOADED;
}
export interface INextMessage {
  type: ProviderMessageType.NEXT;
}
export interface IActionMessage {
  type: ProviderMessageType.ACTION;
  id: number;
  action: Action;
}
export interface ISaveMessage {
  type: ProviderMessageType.SAVE;
  id: number;
  stdin: string;
  acceptedStdout: string;
}
export interface IViewMessage {
  type: ProviderMessageType.VIEW;
  id: number;
  stdio: Stdio;
}
export interface IStdinMessage {
  type: ProviderMessageType.STDIN;
  id: number;
  data: string;
}
export interface ISetTimeLimit {
  type: ProviderMessageType.TL;
  limit: number;
}
export type ProviderMessage =
  | ILoadedMessage
  | INextMessage
  | IActionMessage
  | ISaveMessage
  | IViewMessage
  | IStdinMessage
  | ISetTimeLimit;

export enum WebviewMessageType {
  NEW = 0,
  SET = 1,
  STDIO = 2,
  DELETE = 3,
  SAVE_ALL = 4,
  SHOW = 5,
  INITIAL_STATE = 6,
}
export interface INewMessage {
  type: WebviewMessageType.NEW;
  id: number;
}
export interface ISetMessage {
  type: WebviewMessageType.SET;
  id: number;
  property: keyof ITestcase;
  value: unknown;
}
export interface IStdioMessage {
  type: WebviewMessageType.STDIO;
  id: number;
  stdio: Stdio;
  data: string;
}
export interface IDeleteMessage {
  type: WebviewMessageType.DELETE;
  id: number;
}
export interface ISaveAllMessage {
  type: WebviewMessageType.SAVE_ALL;
}
export interface IShowMessage {
  type: WebviewMessageType.SHOW;
  visible: boolean;
}
export interface IInitialState {
  type: WebviewMessageType.INITIAL_STATE;
  timeLimit: number;
}
export type WebviewMessage =
  | INewMessage
  | ISetMessage
  | IStdioMessage
  | IDeleteMessage
  | ISaveAllMessage
  | IShowMessage
  | IInitialState;
