import { useState, type ReactNode } from "react";
import { Platform, Pressable, Text as RNText, TextInput, View, type TextInputProps } from "react-native";
import { Appear, Segmented, VyreMark, useAppearance, useUiTheme } from "@vyre/ui";
import { hourOf } from "../../src/time/show.js";
import { pickGreeting } from "./greetings.js";
import { CONTENT_ID } from "./field-state.js";
import { THEME_CHOICES, THEME_ICONS, WELCOME_COPY, WELCOME_TONES as T, addressFrom, lastSpace } from "./welcome-model.js";
import { openExternal } from "../../src/shell/open-external";

const store = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

type ThemeChoice = "paper" | "system" | "dark";
const THEME_OPTIONS = THEME_CHOICES.map(([v, l]) => [v, l] as [ThemeChoice, string]);

/** The greeting and its line for this visit: picked once when the screen opens, never the same greeting twice in a row. The unlock cover uses it too. */
export function useGreeting() {
  const [g] = useState(() => {
    const s = store();
    let last = ""; try { last = s ? s.getItem("vyre-greet") || "" : ""; } catch { /* nothing remembered */ }
    const pick = pickGreeting({ hour: hourOf(Date.now()), last });
    try { if (s) s.setItem("vyre-greet", pick[0]); } catch { /* nothing remembered */ }
    return pick;
  });
  return g;
}

/** The Vyre mark, the wordmark beside it and the one-line description under them. Every colour is a theme token (WELCOME_TONES), so both read in light and dark. */
export function WelcomeBrand() {
  const { color } = useUiTheme();
  return (
    <View style={{ alignItems: "center", gap: 6, marginBottom: 28 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <VyreMark size="sm" state="static" />
        <RNText style={{ color: color[T.wordmark], fontSize: 15, fontWeight: "600", letterSpacing: 0.15 }}>Vyre</RNText>
      </View>
      <RNText style={{ color: color[T.sub], fontSize: 12.5 }}>{WELCOME_COPY.sub}</RNText>
    </View>
  );
}

/** The big greeting, rising word by word, and the muted line under it. */
export function WelcomeGreeting({ phone, greeting, line }: { phone: boolean; greeting: string; line: string }) {
  const { color } = useUiTheme();
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center" }} accessibilityRole="header">
        {greeting.split(" ").map((w, i) => (
          <Appear key={`${w}${i}`} index={i + 1}><RNText style={{ color: color[T.greeting], fontSize: phone ? 40 : 64, lineHeight: phone ? 44 : 68, fontWeight: "700", letterSpacing: phone ? -1.4 : -2.4 }}>{`${w} `}</RNText></Appear>
        ))}
      </View>
      <Appear index={5}><RNText style={{ color: color[T.line], fontSize: phone ? 16 : 18, marginTop: 14, textAlign: "center" }}>{line}</RNText></Appear>
    </>
  );
}

/**
 * The round field with the arrow inside it: a quiet lead ("Sign in to"), the input, an optional tail (".vyre.run") and extra control, then the round arrow that goes on.
 * Enter goes on too, unless `disabled`.
 */
export function PillField({ lead, tail, extra, value, onChangeText, onGo, goLabel, disabled, input }: {
  lead?: string; tail?: string; extra?: ReactNode; value: string; onChangeText: (v: string) => void; onGo: () => void; goLabel: string; disabled?: boolean; input: TextInputProps;
}) {
  const { color } = useUiTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 32, height: 54, width: "100%", maxWidth: 440, paddingLeft: 18, paddingRight: 6, borderRadius: 999, backgroundColor: color[T.surface], borderWidth: 0.5, borderColor: color[T.edge] }}>
      {lead ? <RNText style={{ color: color[T.fieldLead], fontSize: 14, marginRight: 8 }}>{lead}</RNText> : null}
      <TextInput value={value} onChangeText={onChangeText} onSubmitEditing={() => { if (!disabled) onGo(); }} placeholderTextColor={color[T.placeholder]} autoCapitalize="none" autoCorrect={false} spellCheck={false} returnKeyType="go" {...input}
        style={[{ flex: 1, minWidth: 0, color: color[T.fieldText], fontSize: 16, fontWeight: "500", textAlign: tail ? "right" : "left", paddingVertical: 0 }, { outlineStyle: "none" } as object, input.style]} />
      {tail ? <RNText style={{ color: color[T.fieldLead], fontSize: 16, marginLeft: 1, marginRight: 8 }}>{tail}</RNText> : null}
      {extra}
      <Pressable accessibilityRole="button" accessibilityLabel={goLabel} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onGo}
        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color[T.go], opacity: disabled ? 0.45 : 1, alignItems: "center", justifyContent: "center" }}>
        <RNText style={{ color: color[T.goInk], fontSize: 18, fontWeight: "600" }}>{"→"}</RNText>
      </Pressable>
    </View>
  );
}

/** The theme switch in the bottom-left corner: three icons (sun Light, laptop Match this device, moon Dark), each named for screen readers and in a tooltip. Sets the person's theme. */
export function ThemeToggle() {
  const person = useAppearance((s) => s.person);
  const setPerson = useAppearance((s) => s.setPerson);
  const picked = (person.theme || "system") as ThemeChoice;
  return (
    <View style={{ position: "absolute", left: 20, bottom: 20 }}>
      <Segmented<ThemeChoice> label="Theme" iconsOnly options={THEME_OPTIONS} icons={THEME_ICONS as Record<ThemeChoice, "sun" | "laptop" | "moon">} value={picked} onChange={(v) => setPerson({ theme: v })} />
    </View>
  );
}

/**
 * The first screen: the Vyre mark, a big greeting that rises word by word with a playful line, then sign-in right here ("Sign in to [space].vyre.run", the last Space filled in, Enter goes on),
 * "New here? Get started", a quiet "Sign in with GitHub". On the web and in the Mac app the caret starts in the Space field (a phone keeps its keyboard down until a tap). The corners carry the theme switch (three icons: Light, Match this device, Dark), Privacy and Terms, and who made it.
 * Every colour is a theme token named in WELCOME_TONES, so each line reads in light and dark.
 */
export function Welcome({ phone, failure, onSignIn, onStart, onGithub }: { phone: boolean; failure?: string; onSignIn: (space: string) => void; onStart: () => void; onGithub: () => void }) {
  const { color } = useUiTheme();
  const [greeting, line] = useGreeting();
  const [space, setSpace] = useState(() => lastSpace(store()));
  const [bad, setBad] = useState("");
  const go = () => {
    const a = addressFrom(space);
    if (!a) { setBad(WELCOME_COPY.badSpace); return; }
    setBad(""); onSignIn(a.space);
  };
  const open = (url: string) => { void openExternal(url); };
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
      <View id={CONTENT_ID} style={{ alignItems: "center", width: "100%", maxWidth: 720 }}>
        <Appear index={0}><WelcomeBrand /></Appear>
        <WelcomeGreeting phone={phone} greeting={greeting} line={line} />
        <Appear index={6} style={{ width: "100%", alignItems: "center" }}>
          <PillField lead={WELCOME_COPY.signInTo} tail={WELCOME_COPY.suffix} value={space} onChangeText={(v) => { setSpace(v); setBad(""); }} onGo={go} goLabel="Continue"
            input={{ placeholder: WELCOME_COPY.placeholder, accessibilityLabel: "Space name", autoFocus: Platform.OS === "web" }} />
          {bad || failure ? <RNText style={{ color: color[T.error], fontSize: 13, marginTop: 10 }} accessibilityLiveRegion="polite">{bad || failure}</RNText> : null}
        </Appear>
        <Appear index={7} style={{ alignItems: "center", gap: 14, marginTop: 20 }}>
          <Pressable accessibilityRole="button" onPress={onStart} style={{ height: 44, paddingHorizontal: 22, borderRadius: 999, alignItems: "center", justifyContent: "center", borderWidth: 0.5, borderColor: color[T.edge], backgroundColor: color[T.surface] }}>
            <RNText style={{ color: color[T.fieldText], fontSize: 14, fontWeight: "500" }}>{WELCOME_COPY.start}</RNText>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onGithub}><RNText style={{ color: color[T.link], fontSize: 13 }}>{WELCOME_COPY.github}</RNText></Pressable>
        </Appear>
      </View>
      <ThemeToggle />
      <View style={{ position: "absolute", right: 20, bottom: 24, flexDirection: "row", gap: 14 }}>
        <Pressable accessibilityRole="link" onPress={() => open(WELCOME_COPY.privacyUrl)}><RNText style={{ color: color[T.link], fontSize: 12 }}>{WELCOME_COPY.privacy}</RNText></Pressable>
        <Pressable accessibilityRole="link" onPress={() => open(WELCOME_COPY.termsUrl)}><RNText style={{ color: color[T.link], fontSize: 12 }}>{WELCOME_COPY.terms}</RNText></Pressable>
      </View>
      <Pressable accessibilityRole="link" onPress={() => open(WELCOME_COPY.footerUrl)} style={{ position: "absolute", bottom: 24, alignSelf: "center" }}>
        <RNText style={{ color: color[T.footer], opacity: 0.85, fontSize: 12, letterSpacing: 0.25 }}>{WELCOME_COPY.footer}</RNText>
      </Pressable>
    </View>
  );
}
