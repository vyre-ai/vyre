// The Connect apps screen: a search across apps, category chips, a short "Recommended for you", then one calm row per app (a mark, a name, one line, and an Add, Set up or Connected button), with "N connected" at the top.
// A connected app's button opens its own menu (Share with..., Disconnect). It draws what connect-model.js shapes and calls nothing itself: the screen owns the data and what a tap does. `ShareSheet` shares an
// app at a Vault level (a person at Fill in, Read or Edit and rotate; an agent only at Fill in); `SetupSheet` asks for what a row that needs setup needs first.

import { ScrollView, View } from "react-native";
import { Avatar } from "../components/Avatar";
import { markRef } from "../marks/useMark";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { Chip } from "../components/Chip";
import { Menu, type MenuItem } from "../components/Menu";
import { Row } from "../components/Row";
import { Segmented } from "../components/Segmented";
import { Sheet } from "../components/Sheet";
import { EmptyState } from "../components/States";
import { Text } from "../components/Text";
import { CATEGORIES, LEVEL_HELP, buttonOf, countLine, levelsFor, setupLine, shareLine, sharedLine, viewOf, withShare, withoutShare } from "./connect-model.js";

export type App = { id: string; name: string; vendor?: string; blurb: string; category: string; state: "connected" | "one-tap" | "setup"; setup?: "token" | "app"; recommended?: boolean; busy?: boolean; shares: Share[] };
export type Share = { who: string; kind: "person" | "agent"; level: string };

/** A group's label: sentence case, 12 and muted, as the sidebar's. */
function GroupLabel({ children, first }: { children: string; first?: boolean }) {
  return <Text accessibilityRole="header" size="caption" medium tone="label" style={{ fontSize: 12, lineHeight: 16, paddingTop: first ? 0 : 12, paddingBottom: 4 }}>{children}</Text>;
}

/** A row carries its own 16 of side padding; pulling the rows out by that much puts their marks and buttons on the same left and right edges as the search field and the labels. */
const ROWS = { marginHorizontal: -16 } as const;

function AppRow({ app, menu, onAdd }: { app: App; menu: MenuItem[]; onAdd: (a: App) => void }) {
  const action = app.state === "connected"
    ? <Menu align="end" trigger={<Button size="sm" kind="secondary" label="Connected" icon="check" accessibilityLabel={`${app.name} is connected. More`} />} items={menu} />
    : <Button size="sm" kind={app.state === "one-tap" ? "primary" : "secondary"} label={app.busy ? "Adding" : buttonOf(app)} loading={app.busy} disabled={app.busy} onPress={() => onAdd(app)} accessibilityLabel={`${buttonOf(app)} ${app.name}`} />;
  const sub = app.state === "connected" ? sharedLine(app.shares) : app.state === "setup" ? setupLine(app) : app.blurb;
  return <Row dense lead={<Avatar of={markRef("project", app.name)} size={40} />} title={app.name} sub={sub} end={action} />;
}

export function ConnectApps({ apps, query, onQuery, category, onCategory, onAdd, menuOf, onClose }: {
  apps: readonly App[]; query: string; onQuery: (q: string) => void; category: string; onCategory: (c: string) => void;
  /** Add (one tap) or Set up (opens setup): the screen decides by the app's state. */ onAdd: (a: App) => void;
  /** A connected app's own menu: Share with..., Disconnect. */ menuOf: (a: App) => MenuItem[];
  onClose?: () => void;
}) {
  const v = viewOf(apps as App[], { query, category });
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <Text strong size="headline">Connect apps</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text size="secondary" tone="label">{countLine(v.count)}</Text>
          {onClose ? <Button size="sm" kind="ghost" label="Done" onPress={onClose} /> : null}
        </View>
      </View>
      <Field name="Search apps" value={query} onChangeText={onQuery} placeholder="Search apps" onKey={(k) => { if (k === "Escape") onQuery(""); }} />
      {/* One row that scrolls sideways, so the chips never wrap onto a second line. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel="Categories" contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
        {CATEGORIES.map(([id, l]) => <Chip key={id} selected={id === category} onPress={() => onCategory(id)}>{l}</Chip>)}
      </ScrollView>
      {v.recommended.length ? (
        <View>
          <GroupLabel first>Recommended for you</GroupLabel>
          <View style={ROWS}>{v.recommended.map((a) => <AppRow key={a.id} app={a} menu={menuOf(a)} onAdd={onAdd} />)}</View>
        </View>
      ) : null}
      {v.list.length ? (
        <View>
          {v.recommended.length ? <GroupLabel>All apps</GroupLabel> : null}
          <View style={ROWS}>{v.list.map((a) => <AppRow key={a.id} app={a} menu={menuOf(a)} onAdd={onAdd} />)}</View>
        </View>
      ) : null}
      {v.empty ? <EmptyState title="No app matches" body="Try another word, or pick a different category." action={query || category !== "all" ? { label: "Clear", onPress: () => { onQuery(""); onCategory("all"); } } : undefined} /> : null}
    </View>
  );
}

/** Share a connected app: each person or agent, off or at a level. An agent can only be given Fill in. */
export function ShareSheet({ app, grantees, open, onClose, onChange, fillOnly }: { fillOnly?: boolean; app: App | null; grantees: readonly { who: string; kind: "person" | "agent" }[]; open: boolean; onClose: () => void; onChange: (shares: Share[]) => void }) {
  if (!app) return null;
  const shares = app.shares;
  return (
    <Sheet open={open} onClose={onClose} title={`Share ${app.name}`}>
      <View style={{ gap: 12 }}>
        <Text size="secondary" tone="label">{shareLine(shares)}. Anything that sends or changes data still waits for your yes.</Text>
        {grantees.map((g) => {
          const mine = shares.find((s) => s.who === g.who && s.kind === g.kind);
          return (
            <Row key={`${g.kind}:${g.who}`} dense lead={<Avatar of={markRef(g.kind, g.who)} size={32} />} title={g.who} sub={g.kind === "agent" ? "Agent. Fill in only." : fillOnly ? "Person. Fill in only." : "Person"}
              end={mine
                ? <Button size="sm" kind="ghost" label="Stop" accessibilityLabel={`Stop sharing ${app.name} with ${g.who}`} onPress={() => onChange(withoutShare(shares, g.who, g.kind))} />
                : <Button size="sm" kind="secondary" label="Share" accessibilityLabel={`Share ${app.name} with ${g.who}`} onPress={() => onChange(withShare(shares, { ...g, level: "fill" }))} />} />
          );
        })}
        {fillOnly ? null : shares.filter((s) => s.kind === "person").map((s) => (
          <View key={s.who} style={{ gap: 6 }}>
            <Text size="secondary" tone="label">{`${s.who} can`}</Text>
            <Segmented label={`${s.who}'s level`} options={levelsFor("person")} value={s.level} onChange={(level) => onChange(withShare(shares, { who: s.who, kind: "person", level }))} />
            <Text size="caption" tone="label">{LEVEL_HELP[s.level]}</Text>
          </View>
        ))}
      </View>
    </Sheet>
  );
}

/** What a row that needs setup needs first: a token the person pastes, or your team's own developer app. */
export function SetupSheet({ app, open, onClose, onDone }: { app: App | null; open: boolean; onClose: () => void; onDone: (a: App) => void }) {
  if (!app) return null;
  const token = app.setup !== "app";
  return (
    <Sheet open={open} onClose={onClose} title={`Set up ${app.name}`}>
      <View style={{ gap: 12 }}>
        <Text>{token ? `${app.name} signs in with a token. Make one in your ${app.name} account and paste it here. It goes straight into the Vault and is never shown again.` : `${app.name} needs an app made in your team's own ${app.name} account. Make it there, then enter its client ID and secret here. They go straight into the Vault.`}</Text>
        {token ? <Field label={`${app.name} token`} kind="password" value="" onChangeText={() => {}} /> : <><Field label="Client ID" value="" onChangeText={() => {}} /><Field label="Client secret" kind="password" value="" onChangeText={() => {}} /></>}
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button kind="ghost" label="Cancel" onPress={onClose} />
          <Button kind="primary" label="Connect" onPress={() => onDone(app)} />
        </View>
      </View>
    </Sheet>
  );
}

