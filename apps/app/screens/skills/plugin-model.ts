// Plugin manifest shape for the install editor (the box stores JSON; the screen never asks for raw JSON).

export type PluginMcp = {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  /** Vault Connection id (connectors.connection.list); credentials are wired at approval, not in the manifest. */
  connection?: string;
};

export type PluginHook = { id: string; event: string; script: string; network?: string[] };

export type PluginManifest = {
  name: string;
  description: string;
  skills?: { name: string; body: string }[];
  commands?: { name: string; body: string }[];
  hooks?: PluginHook[];
  mcp?: PluginMcp[];
};

const skillTpl = (name: string) => `---\nname: ${name}\ndescription: Use when the work is about ${name}.\n---\n\n# ${name}\n\nSteps.\n`;

export function emptyPlugin(name: string): PluginManifest {
  const base = (name || "my-plugin").trim() || "my-plugin";
  return {
    name: base,
    description: "A plugin that adds skills for the Space.",
    skills: [{ name: `${base}-skill`, body: skillTpl(`${base}-skill`) }],
    hooks: [{ id: "on-save", event: "Save", script: "export default async () => ({ ok: true });", network: ["api.example.com"] }],
    mcp: [{ name: "helper", transport: "stdio", command: "echo", args: ["ok"] }],
  };
}

export function parsePluginJson(text: string): PluginManifest | null {
  try {
    const p = JSON.parse(text) as PluginManifest;
    if (!p || typeof p !== "object" || typeof p.name !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export function pluginBody(p: PluginManifest): string {
  return JSON.stringify(p, null, 2);
}
