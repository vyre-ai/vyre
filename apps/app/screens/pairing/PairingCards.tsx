import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Banner } from "@vyre/ui";
import { listen } from "../../src/api/box";
import { callT } from "../../src/real/call-tool";
import { phoneAnswerSession } from "../../src/real/pairing";
import { PairWords } from "../devices/PairParts";
import { pairingSource } from "./source";
import { PAIR_EVENTS, notPairedLine, pairedLine } from "./model";

const source = pairingSource(callT);

/**
 * A new device asking to pair, as a card on Now: three words to confirm (the same PairWords the Devices screen uses). Renders nothing when
 * no request is asking or the box has no pairing. It redraws on the wink.* events; nothing polls.
 */
export function PairingCards({ onPaired }: { onPaired?: (name: string) => void }) {
  const [wink, setWink] = useState<{ name: string; words: [string, string, string] | null } | null>(null);
  const [note, setNote] = useState("");
  const live = useRef(true);
  const load = useCallback(async () => {
    const w = await source.winkAsk();
    if (live.current) setWink(w);
    // a phone the person said yes to, whose key this computer signs onto the name's list (the server holds no identity)
    void source.serveEnrol();
  }, []);
  useEffect(() => {
    live.current = true;
    void load();
    const off = listen((e: { type?: string }) => { if (PAIR_EVENTS.test(String(e?.type || ""))) void load(); });
    return () => { live.current = false; off(); };
  }, [load]);
  const answerer = useMemo(() => (wink ? phoneAnswerSession(wink.words) : null), [wink]);
  if (!wink && !note) return null;
  return (
    <View className="gap-s3">
      {note ? <Banner>{note}</Banner> : null}
      {wink && answerer ? (
        <PairWords
          session={answerer}
          who={wink.name}
          onConfirmed={() => { setNote(pairedLine(wink.name)); onPaired?.(wink.name); setWink(null); void load(); }}
          onRejected={() => { setNote(notPairedLine(wink.name)); setWink(null); void load(); }}
        />
      ) : null}
    </View>
  );
}
