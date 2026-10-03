// Local notices on Android (see android/). The web and iOS builds never import this.
import { requireOptionalNativeModule } from "expo";

export type PermissionState = { granted: boolean; canAskAgain: boolean; status: string };

type Native = {
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  show(id: string, title: string, body: string | null, route: string | null): Promise<boolean>;
};

/** Null where there is no native side (iOS today, the web). */
export default requireOptionalNativeModule<Native>("VyreNotify");
