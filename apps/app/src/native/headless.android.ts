// The notice loop with no screen: the foreground service (modules/vyre-notify KeepAliveService) starts the "VyreNotices" headless task, which brings up the app's connection to the home and runs the same
// loop that tells the person while the app is open (notices.ts). The task never ends; it stops with the service. Registered at load, by the entry (index.js), so it exists when the service starts with no activity.
import { AppRegistry } from "react-native";
import "../identity/webcrypto";
import "../identity/restore-wire";
import { connect } from "../api/box";
import { startNotices } from "./notices";

AppRegistry.registerHeadlessTask("VyreNotices", () => async () => {
  await connect().catch(() => {});
  startNotices();
  await new Promise<void>(() => {});
});
