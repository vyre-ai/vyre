// Sample world only (a mock build): the phone's Glass page in relay mode, with its sockets opened to a fake screen server on the host of the emulator instead of the relay channel, so a hosted Android emulator can prove that
// the bundled page, link's WebSocket shim, the bridge and noVNC draw a frame in the real WebView (apps/app/scripts/glass-relay-android.sh). The relay channel itself is proven in core/computers/glass-relay.test.js.
import { useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { ThemeProvider, Text, allowsMock } from "@vyre/ui";
import { GlassFrame } from "../screens/glass/GlassFrame";
import type { GlassFrameHandle } from "../screens/glass/GlassFrame";

// the emulator's name for the machine it runs on; `?h=127.0.0.1:5999` (with `adb reverse`) names another way to reach it

export default function GlassRelayProof() {
  const q = useLocalSearchParams<{ h?: string }>();
  const HOST = `ws://${q.h || "10.0.2.2:5999"}`;
  const frame = useRef<GlassFrameHandle | null>(null);
  const [said, setSaid] = useState("starting");
  if (!allowsMock()) return null;
  return (
    <ThemeProvider>
      <View style={{ flex: 1 }}>
        <Text accessibilityLabel="Glass proof status" size="caption">{`glass: ${said}`}</Text>
        <View style={{ flex: 1 }}>
          <GlassFrame
            src=""
            relay
            label="Proof screen"
            frameRef={frame}
            openSocket={(path: string) => {
              // diagnostics for the emulator proof: say what the socket and a plain request do, so a failure names its cause
              void fetch(`http://${q.h || "10.0.2.2:5999"}/probe`).then((r) => console.log("glass-proof http probe", r.status), (e) => console.log("glass-proof http probe failed", String(e && e.message)));
              try {
                const w = new WebSocket(HOST + path);
                console.log("glass-proof socket made", HOST + path, w.readyState);
                w.addEventListener("open", () => console.log("glass-proof socket open"));
                w.addEventListener("error", (e: any) => console.log("glass-proof socket error", String(e && e.message)));
                w.addEventListener("close", (e: any) => console.log("glass-proof socket close", e && e.code, e && e.reason));
                return w;
              } catch (e) { console.log("glass-proof socket threw", String(e)); throw e; }
            }}
            onMessage={(m: { t: string; code?: number; reason?: string }) => {
              setSaid(m.t === "down" ? `down ${m.code} ${m.reason || ""}` : m.t);
              console.log("glass-proof", m.t, m.code, m.reason);
              if (m.t === "ready") frame.current?.post({ t: "connect", url: "ws://box.invalid/v1/streams/computers/glass?ticket=proof", quality: 4, compression: 4, fit: true });
            }}
          />
        </View>
      </View>
    </ThemeProvider>
  );
}
