// The phone's recovery (restore.ts) must use the phone's identity store. "./store" is the platform file under Metro (store.native.ts on a phone, store.ts on the web); restore.ts
// itself names the web file so Node can run its test, so this hands it the right one at start. Imported once by the root layout.
import * as store from "./store";
import { useIdentityStore } from "./restore";

useIdentityStore(store);
