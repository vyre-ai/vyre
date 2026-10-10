// Sample world only (a mock build): the phone's Glass page in relay mode, with its sockets opened to a fake screen server on the host of the emulator instead of the relay channel, so a hosted Android emulator can prove that
// the bundled page, link's WebSocket shim, the bridge and noVNC draw a frame in the real WebView (apps/app/scripts/glass-relay-android.sh). The relay channel itself is proven in core/computers/glass-relay.test.js.
import { useRef, useState } from "react";
import { View } from "react-native";
import { ThemeProvider, Text, allowsMock } from "@vyre/ui";
import { GlassFrame } from "../screens/glass/GlassFrame";
import type { GlassFrameHandle } from "../screens/glass/GlassFrame";

const HOST = "ws://10.0.2.2:5999"; // the emulator's name for the machine it runs on

export default function GlassRelayProof() {
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
            openSocket={(path: string) => new WebSocket(HOST + path)}
            onMessage={(m: { t: string }) => {
              setSaid(m.t);
              if (m.t === "ready") frame.current?.post({ t: "connect", url: "ws://box.invalid/v1/streams/computers/glass?ticket=proof", quality: 4, compression: 4, fit: true });
            }}
          />
        </View>
      </View>
    </ThemeProvider>
  );
}
