// Local notices on Android (android/) and iOS (ios/). The web build never imports this.
import { requireOptionalNativeModule } from "expo";

export type PermissionState = { granted: boolean; canAskAgain: boolean; status: string };

type Native = {
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  show(id: string, title: string, body: string | null, route: string | null): Promise<boolean>;
  /** Android: hold the app's connection to the home while the app is closed (a foreground service). False without the notice permission. */
  startKeepAlive?(): Promise<boolean>;
  stopKeepAlive?(): Promise<boolean>;
  keepAliveWanted?(): Promise<boolean>;
};

/** Null where there is no native side (the web). */
export default requireOptionalNativeModule<Native>("VyreNotify");
