// Local notices on Android (android/) and iOS (ios/). The web build never imports this.
import { requireOptionalNativeModule } from "expo";

export type PermissionState = { granted: boolean; canAskAgain: boolean; status: string };

type Native = {
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  show(id: string, title: string, body: string | null, route: string | null): Promise<boolean>;
};

/** Null where there is no native side (the web). */
export default requireOptionalNativeModule<Native>("VyreNotify");
