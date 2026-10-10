// Sample world only (a mock build): arms the notice proof, turns the kept connection on, shows one line, and closes its own screen so the proof can look at the phone's notifications with the app closed
// (apps/app/scripts/notices-android.sh).
import { useEffect, useState } from "react";
import { BackHandler, View } from "react-native";
import { ThemeProvider, Text, allowsMock } from "@vyre/ui";
import { armNoticesProof } from "../src/native/notices-proof";
import { syncKeepAlive } from "../src/native/keepalive";

export default function NoticesProof() {
  const [said, setSaid] = useState("starting");
  useEffect(() => {
    if (!allowsMock() || !armNoticesProof(25_000)) return;
    void syncKeepAlive().then(() => { setSaid("armed"); console.log("notices-proof armed"); setTimeout(() => BackHandler.exitApp(), 6_000); });
  }, []);
  if (!allowsMock()) return null;
  return (
    <ThemeProvider>
      <View style={{ flex: 1 }}><Text accessibilityLabel="Notices proof status" size="caption">{`notices: ${said}`}</Text></View>
    </ThemeProvider>
  );
}
