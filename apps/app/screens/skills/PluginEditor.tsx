import { useMemo } from "react";
import { View } from "react-native";
import { Button, Card, Field, Select, Text } from "@vyre/ui";
import type { PluginHook, PluginManifest, PluginMcp } from "./plugin-model";

export type ConnectionPick = { id: string; label: string };

const TRANSPORTS: [string, string][] = [["stdio", "On this box (stdio)"], ["http", "Remote (HTTP)"], ["sse", "Remote (SSE)"]];

export function PluginEditor({ value, onChange, connections }: { value: PluginManifest; onChange: (p: PluginManifest) => void; connections: ConnectionPick[] }) {
  const connOpts = useMemo(() => connections.map((c) => [c.id, c.label] as [string, string]), [connections]);
  const set = (patch: Partial<PluginManifest>) => onChange({ ...value, ...patch });
  const setMcp = (i: number, patch: Partial<PluginMcp>) => {
    const mcp = [...(value.mcp || [])];
    mcp[i] = { ...mcp[i], ...patch };
    set({ mcp });
  };
  const setHook = (i: number, patch: Partial<PluginHook>) => {
    const hooks = [...(value.hooks || [])];
    hooks[i] = { ...hooks[i], ...patch };
    set({ hooks });
  };
  const setSkill = (i: number, body: string) => {
    const skills = [...(value.skills || [])];
    skills[i] = { ...skills[i], body };
    set({ skills });
  };
  return (
    <View className="gap-s3">
      <Field label="Description" value={value.description} onChangeText={(description) => set({ description })} multiline />
      <Card flush>
        <View className="p-s3 gap-s2">
          <Text size="caption" strong>Skills in this plugin</Text>
          {(value.skills || []).map((s, i) => (
            <Field key={i} label={s.name || `Skill ${i + 1}`} value={s.body} onChangeText={(body) => setSkill(i, body)} multiline />
          ))}
          <View className="flex-row"><Button size="sm" kind="ghost" icon="plus" label="Add a skill" onPress={() => set({ skills: [...(value.skills || []), { name: `${value.name}-skill-${(value.skills?.length || 0) + 1}`, body: "" }] })} /></View>
        </View>
      </Card>
      <Card flush>
        <View className="p-s3 gap-s3">
          <Text size="caption" strong>Hooks (sandbox scripts)</Text>
          {(value.hooks || []).map((h, i) => (
            <View key={i} className="gap-s2">
              <View className="flex-row gap-s2 flex-wrap">
                <View className="min-w-[8rem] flex-1"><Field label="Hook id" value={h.id} onChangeText={(id) => setHook(i, { id })} /></View>
                <View className="min-w-[8rem] flex-1"><Field label="Event" value={h.event} onChangeText={(event) => setHook(i, { event })} placeholder="SessionStart" /></View>
              </View>
              <Field label="Hosts it may reach" value={(h.network || []).join(", ")} onChangeText={(t) => setHook(i, { network: t.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) })} placeholder="api.example.com" />
              <Field label="Script" value={h.script} onChangeText={(script) => setHook(i, { script })} multiline />
              <View className="flex-row"><Button size="sm" kind="ghost" icon="x" label="Remove hook" onPress={() => set({ hooks: (value.hooks || []).filter((_, k) => k !== i) })} /></View>
            </View>
          ))}
          <View className="flex-row"><Button size="sm" kind="ghost" icon="plus" label="Add a hook" onPress={() => set({ hooks: [...(value.hooks || []), { id: "hook", event: "Save", script: "export default async () => ({ ok: true });", network: [] }] })} /></View>
        </View>
      </Card>
      <Card flush>
        <View className="p-s3 gap-s3">
          <Text size="caption" strong>MCP servers</Text>
          <Text size="caption" tone="label">Each server becomes a Connection when the plugin is approved. Pick a Vault Connection for remote servers that need a key.</Text>
          {(value.mcp || []).map((m, i) => (
            <View key={i} className="gap-s2">
              <View className="flex-row gap-s2 flex-wrap">
                <View className="min-w-[6rem] flex-1"><Field label="Server name" value={m.name} onChangeText={(name) => setMcp(i, { name })} /></View>
                <View className="min-w-[10rem] flex-1"><Select label="Transport" value={m.transport} options={TRANSPORTS} onChange={(transport) => setMcp(i, { transport: transport as PluginMcp["transport"] })} /></View>
              </View>
              {m.transport === "stdio" ? (
                <>
                  <Field label="Command" value={m.command || ""} onChangeText={(command) => setMcp(i, { command })} />
                  <Field label="Arguments (comma-separated)" value={(m.args || []).join(", ")} onChangeText={(t) => setMcp(i, { args: t.split(",").map((x) => x.trim()).filter(Boolean) })} />
                </>
              ) : (
                <>
                  <Field label="URL" value={m.url || ""} onChangeText={(url) => setMcp(i, { url })} placeholder="https://mcp.example.com/" kind="url" />
                  <Select label="Vault Connection" value={m.connection || ""} options={[["", "No connection (public server)"], ...connOpts]} placeholder={connOpts.length ? "Choose a connection" : "No connections yet"} onChange={(connection) => setMcp(i, { connection: connection || undefined })} />
                </>
              )}
              <View className="flex-row"><Button size="sm" kind="ghost" icon="x" label="Remove server" onPress={() => set({ mcp: (value.mcp || []).filter((_, k) => k !== i) })} /></View>
            </View>
          ))}
          <View className="flex-row"><Button size="sm" kind="ghost" icon="plus" label="Add MCP server" onPress={() => set({ mcp: [...(value.mcp || []), { name: "server", transport: "http", url: "https://mcp.example.com/" }] })} /></View>
        </View>
      </Card>
    </View>
  );
}

export function PluginDeclaresView({ declares }: { declares?: { hooks?: { id: string; event: string; network?: string[] }[]; mcp?: { name: string; transport: string; command?: string; args?: string[]; url?: string }[] } }) {
  if (!declares) return null;
  const hooks = declares.hooks || [];
  const mcp = declares.mcp || [];
  if (!hooks.length && !mcp.length) return null;
  return (
    <Card>
      <View className="gap-s2">
        <Text size="caption" strong>What this plugin declares</Text>
        {hooks.length ? (
          <View className="gap-s1">
            <Text size="caption" tone="label">Hooks</Text>
            {hooks.map((h) => <Text key={h.id} size="caption">{h.id} on {h.event}{(h.network || []).length ? ` · may reach ${(h.network || []).join(", ")}` : ""}</Text>)}
          </View>
        ) : null}
        {mcp.length ? (
          <View className="gap-s1">
            <Text size="caption" tone="label">MCP servers</Text>
            {mcp.map((m) => <Text key={m.name} size="caption">{m.name} ({m.transport}){m.url ? ` · ${m.url}` : m.command ? ` · ${m.command}` : ""}</Text>)}
          </View>
        ) : null}
      </View>
    </Card>
  );
}
