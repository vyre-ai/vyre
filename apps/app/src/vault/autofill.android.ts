// Vyre autofill on Android: the vault's native module (modules/vault-android, ADR 0028 decision 6).
// Only this file imports it; autofill.ts is the stub the web and iOS builds get.

import * as Native from "../../modules/vault-android";
import type { AutofillStatus, Paired } from "./autofill.ts";

export type { AutofillStatus, Paired };

export const supported: boolean = true;

export const setServer = (url: string): Promise<string> => Native.setServer(url);
export const pair = (url: string, code: string, name: string): Promise<Paired> => Native.pair(url, code, name);
export const status = (): Promise<AutofillStatus> => Native.status();
export const lock = (): Promise<boolean> => Native.lock();
export const unpair = (): Promise<boolean> => Native.unpair();
export const isEnabled = (): boolean => Native.isEnabled();
export const openSettings = (): boolean => Native.openSettings();
