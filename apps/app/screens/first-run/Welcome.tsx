import { useState } from "react";
import { Pressable, Text as RNText, TextInput, View } from "react-native";
import { Appear, VyreMark, useAppearance, useUiTheme } from "@vyre/ui";
import { hourOf } from "../../src/time/show.js";
import { pickGreeting } from "./greetings.js";
import { CONTENT_ID } from "./field-state.js";
import { THEME_CHOICES, WELCOME_COPY, addressFrom, lastSpace } from "./welcome-model.js";
import { openLink } from "../../src/real/open-link";

const store = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

/** The greeting and its line for this visit: picked once when the screen opens, never the same greeting twice in a row. */
function useGreeting() {
  const [g] = useState(() => {
    const s = store();
    let last = ""; try { last = s ? s.getItem("vyre-greet") || "" : ""; } catch { /* nothing remembered */ }
    const pick = pickGreeting({ hour: hourOf(Date.now()), last });
    try { if (s) s.setItem("vyre-greet", pick[0]); } catch { /* nothing remembered */ }
    return pick;
  });
  return g;
}

/**
 * The first screen: the Vyre mark, a big greeting that rises word by word with a playful line, then sign-in right here ("Sign in to [space].vyre.run", the last Space filled in, Enter goes on),
 * "New here? Get started", a quiet "Sign in with GitHub". The corners carry the theme switch (Light / Match this device / Dark), Privacy and Terms, and who made it.
 */
export function Welcome({ phone, failure, onSignIn, onStart, onGithub }: { phone: boolean; failure?: string; onSignIn: (space: string) => void; onStart: () => void; onGithub: () => void }) {
  const { color } = useUiTheme();
  const [greeting, line] = useGreeting();
  const [space, setSpace] = useState(() => lastSpace(store()));
  const [bad, setBad] = useState("");
  const person = useAppearance((s) => s.person);
  const setPerson = useAppearance((s) => s.setPerson);
  const text = color.text, text2 = color.text2, faint = color.label, edge = color["edge-strong"], surface = color["surface-1"];
  const go = () => {
    const a = addressFrom(space);
    if (!a) { setBad(WELCOME_COPY.badSpace); return; }
    setBad(""); onSignIn(a.space);
  };
  const open = (url: string) => { void openLink(url); };
  const picked = person.theme || "system";
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
      <View id={CONTENT_ID} style={{ alignItems: "center", width: "100%", maxWidth: 720 }}>
        <Appear index={0}>
          <View style={{ alignItems: "center", gap: 6, marginBottom: 28 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <VyreMark size="sm" state="static" />
              <RNText style={{ color: text2, fontSize: 15, fontWeight: "600", letterSpacing: 0.15 }}>Vyre</RNText>
            </View>
            <RNText style={{ color: faint, fontSize: 12.5 }}>{WELCOME_COPY.sub}</RNText>
          </View>
        </Appear>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center" }} accessibilityRole="header">
          {greeting.split(" ").map((w, i) => (
            <Appear key={`${w}${i}`} index={i + 1}><RNText style={{ color: text, fontSize: phone ? 40 : 64, lineHeight: phone ? 44 : 68, fontWeight: "700", letterSpacing: phone ? -1.4 : -2.4 }}>{`${w} `}</RNText></Appear>
          ))}
        </View>
        <Appear index={5}><RNText style={{ color: text2, fontSize: phone ? 16 : 18, marginTop: 14, textAlign: "center" }}>{line}</RNText></Appear>
        <Appear index={6} style={{ width: "100%", alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 32, height: 54, width: "100%", maxWidth: 440, paddingLeft: 18, paddingRight: 6, borderRadius: 999, backgroundColor: surface, borderWidth: 0.5, borderColor: edge }}>
            <RNText style={{ color: faint, fontSize: 14, marginRight: 8 }}>{WELCOME_COPY.signInTo}</RNText>
            <TextInput value={space} onChangeText={(v) => { setSpace(v); setBad(""); }} onSubmitEditing={go} placeholder={WELCOME_COPY.placeholder} placeholderTextColor={edge} autoCapitalize="none" autoCorrect={false} spellCheck={false}
              accessibilityLabel="Space name" returnKeyType="go" style={[{ flex: 1, minWidth: 0, color: text, fontSize: 16, fontWeight: "500", textAlign: "right", paddingVertical: 0 }, { outlineStyle: "none" } as object]} />
            <RNText style={{ color: faint, fontSize: 16, marginLeft: 1, marginRight: 8 }}>{WELCOME_COPY.suffix}</RNText>
            <Pressable accessibilityRole="button" accessibilityLabel="Continue" onPress={go} style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: text, alignItems: "center", justifyContent: "center" }}>
              <RNText style={{ color: color.bg, fontSize: 18, fontWeight: "600" }}>{"→"}</RNText>
            </Pressable>
          </View>
          {bad || failure ? <RNText style={{ color: color.err, fontSize: 13, marginTop: 10 }} accessibilityLiveRegion="polite">{bad || failure}</RNText> : null}
        </Appear>
        <Appear index={7} style={{ alignItems: "center", gap: 14, marginTop: 20 }}>
          <Pressable accessibilityRole="button" onPress={onStart} style={{ height: 44, paddingHorizontal: 22, borderRadius: 999, alignItems: "center", justifyContent: "center", borderWidth: 0.5, borderColor: edge, backgroundColor: surface }}>
            <RNText style={{ color: text, fontSize: 14, fontWeight: "500" }}>{WELCOME_COPY.start}</RNText>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onGithub}><RNText style={{ color: faint, fontSize: 13 }}>{WELCOME_COPY.github}</RNText></Pressable>
        </Appear>
      </View>
      <View style={{ position: "absolute", left: 20, bottom: 20, flexDirection: "row", padding: 3, borderRadius: 999, backgroundColor: surface, borderWidth: 0.5, borderColor: edge }} accessibilityRole="radiogroup" accessibilityLabel="Theme">
        {THEME_CHOICES.map(([v, label]) => (
          <Pressable key={v} accessibilityRole="radio" accessibilityState={{ checked: picked === v }} onPress={() => setPerson({ theme: v as "paper" | "system" | "dark" })}
            style={{ paddingHorizontal: 12, height: 28, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: picked === v ? text : "transparent" }}>
            <RNText style={{ color: picked === v ? color.bg : faint, fontSize: 12, fontWeight: "500" }}>{label}</RNText>
          </Pressable>
        ))}
      </View>
      <View style={{ position: "absolute", right: 20, bottom: 24, flexDirection: "row", gap: 14 }}>
        <Pressable accessibilityRole="link" onPress={() => open(WELCOME_COPY.privacyUrl)}><RNText style={{ color: faint, fontSize: 12 }}>{WELCOME_COPY.privacy}</RNText></Pressable>
        <Pressable accessibilityRole="link" onPress={() => open(WELCOME_COPY.termsUrl)}><RNText style={{ color: faint, fontSize: 12 }}>{WELCOME_COPY.terms}</RNText></Pressable>
      </View>
      <Pressable accessibilityRole="link" onPress={() => open(WELCOME_COPY.footerUrl)} style={{ position: "absolute", bottom: 24, alignSelf: "center" }}>
        <RNText style={{ color: text, opacity: 0.85, fontSize: 12, letterSpacing: 0.25 }}>{WELCOME_COPY.footer}</RNText>
      </Pressable>
    </View>
  );
}
