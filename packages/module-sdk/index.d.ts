// Types for Vyre modules, module API 1 (ADR 0033).
//
// A module is a folder with module.json and an entry file whose default export has start(ctx).
// Everything a module may rely on is in ModuleContext without an @internal tag. @internal members
// exist for Vyre's own modules and may change in any release. Members tagged @planned are part of
// module API 1 but not built yet; check with ctx.api.has() before using them.
//
//   /** @type {import("@vyre/module-sdk").Module} */
//   export default { async start(ctx) { ... return { async stop() {} }; } };

/** The module API major this file describes. */
export declare const API_VERSION: 1;

// ---- The manifest (module.json); the schema is manifest.schema.json --------------------------

/** A tool name: "<module>.<verb>". */
export type ToolName = `${string}.${string}`;
/** An event type: "<noun>.<past-verb>". */
export type EventType = `${string}.${string}`;
/** An event pattern: a type, "noun.*" or "*". */
export type EventPattern = EventType | `${string}.*` | "*";
/** A UI slot: panel, settings, route, view, now, renderer or slash, optionally ":<name>". */
export type Slot = `${"panel" | "settings" | "route" | "view" | "now" | "renderer" | "slash"}${"" | `:${string}`}`;

export interface CapsuleEntry { title?: string; input?: Record<string, unknown>; hide?: boolean }

export interface SettingDef {
  /** "<module>.<key>" */
  key: string;
  group?: string;
  label: string;
  help?: string;
  type: "enum" | "bool" | "int" | "number" | "string" | "list" | "object" | "model";
  enum?: string[];
  /** The allowed numbers for an int. */
  choices?: number[];
  /** A tool of this module that lists the choices when the schema is read, within 500 ms (ADR 0035). */
  choicesFrom?: { tool: ToolName };
  /** A tool of this module asked { ok } or { ok: false, message } before a value is stored, within 500 ms; off or late refuses (ADR 0035). */
  check?: { tool: ToolName };
  min?: number;
  max?: number;
  default?: unknown;
  /** Where it may be set. session > device > project > account > default (ADR 0035). */
  levels: ("account" | "project" | "device" | "session")[];
  /** live: at once; session: from the next session; restart: when vyred next starts. */
  apply: "live" | "session" | "restart";
  advanced?: boolean;
  /** Masked for anyone but the person. */
  secret?: boolean;
  /** A label per enum value. */
  labels?: Record<string, string>;
  /** The setting can loosen what Vyre allows; the Deck marks it. */
  security?: "loosens";
  /** What it loosens, in a few words. */
  loosens?: string;
  /** Ask the person before a change: always, or only for these values. */
  confirm?: true | { values: unknown[] };
  /** Where the value is kept. Omitted: Vyre's settings table. "$value" and "$project" fill a tool store's input. */
  store?:
    | { config: string }
    | { claude: string }
    | { tool: { get: { tool: ToolName; input?: unknown; read?: string }; set: { tool: ToolName; input?: unknown } } };
}

export interface Manifest {
  $schema?: string;
  name: string;
  version: string;
  /** The module API major this module is written for. */
  apiVersion?: 1;
  description?: string;
  /** The entry file, relative to the module folder. Default index.js. */
  main?: string;
  roles?: ("box" | "local")[];
  /** Names, or (planned) names with a semver range. */
  requires?: string[] | Record<string, string>;
  /** @planned Set to this module's own name to replace the first-party module of that name. */
  replaces?: string;
  does?: {
    tools?: ToolName[];
    /** Session drivers (ADR 0030). */
    providers?: string[];
    /** @planned Harness points, each served by one of this module's tools. pretool only tightens. */
    hooks?: { brief?: ToolName; enrich?: ToolName; pretool?: ToolName; stop?: ToolName };
    /** @planned Gate sender types: type name to the tool that sends after the Gate approved. */
    senders?: Record<string, ToolName>;
    /** @planned @App adapters. */
    apps?: Record<string, { app: string; bundleIds?: string[]; actions: Record<string, ToolName> }>;
    /** @planned CLI verbs: `vyre <module> <verb>` runs `tool`; positional args fill `args` input keys in order. */
    commands?: { verb: string; tool: ToolName; summary: string; args?: string[] }[];
    /** @planned The tool that returns this module's connection rows (docs/design/cohesion.md). */
    connections?: ToolName;
    /** @planned The tool that answers suggest.query for this module, inside a 25 ms deadline. */
    suggest?: ToolName;
  };
  watches?: {
    emits?: EventType[];
    /** @planned Event patterns it subscribes to. */
    on?: EventPattern[];
  };
  shows?: {
    deck?: Slot[];
    capsule?: string[] | Record<string, CapsuleEntry>;
    cli?: string[];
    streams?: string[];
    /** @planned Notice kinds it raises, rendered from needs.list on every surface. */
    notices?: string[];
  };
  /** @planned Settings, drawn in the Deck's Settings and `vyre config` with no UI work. */
  settings?: SettingDef[];
  needs?: {
    /** Vault item names, or "per-<thing>" for items named at run time. */
    vault?: string[];
    /** @planned Tools it calls with ctx.call, or "module.*". */
    tools?: string[];
    /** @planned Hosts it talks to. A declaration the person approves, not a wall, while in process. */
    network?: string[];
    /** @planned UI slots it fills. */
    slots?: Slot[];
  };
  teaches?: {
    /** Fact kinds it hands the curator. */
    memory?: string[];
    /** @planned Prompt layers: markdown files in the module. */
    prompt?: { level: "account" | "project" | "agent"; file: string }[];
    /** @planned Short tips the tips module shows. text is at most 140 characters. */
    tips?: Tip[];
  };
  [experimental: `x-${string}`]: unknown;
}

export type Surface = "capsule" | "deck" | "chat" | "phone" | "cli" | "glass";

export interface Tip {
  id: string;
  text: string;
  surfaces: Surface[];
  level: "first-use" | "power" | "discovery";
  trigger: "on-use" | "idle" | "never-used" | "after-update";
  /** The version the tip arrived in. */
  since: string;
  key?: string;
  command?: string;
  /** A relative .md path, with an optional #anchor. */
  docs?: string;
  about?: string;
  [experimental: `x-${string}`]: unknown;
}

// ---- Tools ------------------------------------------------------------------------------------

/** A JSON Schema for a tool's input. The registry checks type, required, properties, enum and items. */
export type InputSchema = { type?: string; [k: string]: unknown };

/** Who is calling, as vyred established it. "module:<name>" for another module. */
export type Caller = string;

export interface CallMeta {
  caller: Caller;
  /** Set only when vyred verified the calling agent. */
  agent?: string;
  /** Set only when vyred verified the calling session's thread. */
  thread?: string;
  /** How a person proved presence for this call, when the tool needed it. Never the proof. */
  presence?: { method: string; keyId: string | null };
  idempotencyKey?: string;
  /** The chat's id for this tool call, on a session's own paths only. Unverified: for linking, never for a decision. */
  call?: string;
  [k: string]: unknown;
}

export interface ToolDef<I = any, O = any> {
  description?: string;
  input?: InputSchema;
  run(input: I, meta: CallMeta): O | Promise<O>;
  /** The caller kinds that may use it ("cli", "local", "deck", "capsule", "mcp", "module"). Omitted: all. */
  callers?: string[];
  /** Needs a person's presence proof, or only in some cases. */
  presence?: boolean | { when?: (input: I) => boolean; summary?: (input: I) => string; session?: boolean };
  /** @internal Only other modules may call it, and it is left out of every listing. */
  internal?: boolean;
  /** @internal Reachable only as the webhook route POST /v1/<module>/<name>/hook. */
  hook?: boolean;
}

export interface CallError { code: string; message: string; [k: string]: unknown }
/** What ctx.call resolves to: data on success, error otherwise. It never throws for a refusal. */
export type CallResult<T = any> = { data: T; error?: undefined } | { data?: undefined; error: CallError };

// ---- Events -----------------------------------------------------------------------------------

export interface VyreEvent<P = any> {
  id: number;
  type: EventType;
  /** The module that emitted it. */
  source: string;
  at: number;
  project: string | null;
  thread: string | null;
  payload: P;
}

export interface ModuleEvents {
  /** Emit a type declared under watches.emits. */
  emit<P = any>(type: EventType, payload?: P, where?: { project?: string; thread?: string }): VyreEvent<P>;
  /** Subscribe to a type, "noun.*" or "*". Returns an unsubscribe function. */
  on(pattern: EventPattern, fn: (event: VyreEvent) => void): () => void;
  /** Events after an id, oldest first. */
  since(id?: number, opts?: { type?: string; project?: string; limit?: number }): VyreEvent[];
  /** The id a read is current to, so a view can follow the stream from it with no gap. */
  latestId(): number;
  /** @internal Delete this module's own redundant events of a declared type. */
  prune(type: EventType, opts?: Record<string, unknown>): unknown;
}

// ---- The context ------------------------------------------------------------------------------

/** One row of GET /v1/modules, which ctx.modules.status() also returns. */
export interface ModuleStatus {
  name: string;
  version?: string;
  state: "pending" | "running" | "off" | "failed" | "invalid";
  error?: string;
  shows?: Manifest["shows"];
  commands?: NonNullable<Manifest["does"]>["commands"];
  connections?: ToolName;
  suggest?: ToolName;
  notices?: string[];
  emits?: EventType[];
  /** Calls to its tools from people, surfaces and models (never modules or webhooks). lastUsed is ms since the epoch. */
  use: { calls: number; lastUsed: number | null };
}

/** A tool as GET /v1/tools lists it to a caller. */
export interface ToolListing { name: ToolName; module: string; description: string; input: InputSchema; presence?: true }

export interface ModuleLog {
  (message: string, extra?: unknown): void;
  /** @planned */ info(message: string, extra?: unknown): void;
  /** @planned */ warn(message: string, extra?: unknown): void;
  /** @planned */ error(message: string, extra?: unknown): void;
  /** @planned */ debug(message: string, extra?: unknown): void;
}

export interface ModuleContext {
  /** This module's name. */
  readonly name: string;
  /** @planned The module API this vyred speaks, and feature tests inside it. */
  readonly api: { version: 1; has(feature: string): boolean };
  /** Logs prefixed with the module's name. */
  log: ModuleLog;
  /** Another module's tool, through the same checks as any caller. The only way to use another module. */
  call<T = any>(tool: ToolName, input?: Record<string, unknown>): Promise<CallResult<T>>;
  /** Register a tool declared under does.tools. */
  tool<I = any, O = any>(name: ToolName, def: ToolDef<I, O>): void;
  events: ModuleEvents;
  /** Read only: every module's status row (a copy), and the tools a given caller may use. */
  readonly modules: { status(): ModuleStatus[]; tools(caller?: Caller): ToolListing[] };
  /** @planned This module's own settings, resolved project over account over default. */
  settings: {
    get<T = unknown>(key: string, opts?: { project?: string }): Promise<T>;
    set(key: string, value: unknown, opts?: { project?: string }): Promise<void>;
    on(key: string, fn: (value: unknown, change: { key: string; project?: string }) => void): () => void;
  };
  /** This module's tables in vyre.db. Migrations are bound to its name, so tables carry that prefix. */
  store: {
    /** A node:sqlite DatabaseSync. Write only your own tables; use tools for anyone else's. */
    db: any;
    /** Ordered SQL steps, each applied once. */
    migrate(steps: string[]): void;
  };
  paths: {
    /** @planned This module's own folder, <home>/data/<module>/. */
    readonly data: string;
    /** @internal */ readonly [k: string]: string;
  };
  /** A vault item declared under needs.vault, if the person granted it. */
  vault: { fetch(name: string, opts?: { field?: string }): Promise<unknown> };
  /** Hand the curator a fact of a kind declared under teaches.memory. Resolves false without Memory. */
  memory: { teach(kind: string, fact: unknown): Promise<boolean> };
  /** A WebSocket at /v1/streams/<module>/<name>, declared under shows.streams. */
  upgrade(name: string, handler: (req: any, socket: any, head: any, caller: Caller) => void): void;
  /** A raw HTTP route at /v1/<module>/<name>, for what a tool can't carry. */
  route(name: string, fn: (req: any, res: any, at: { caller: Caller; url: URL }) => unknown): void;
  /**
   * Register a session driver declared under does.providers (ADR 0030). The driver's full shape is
   * core/sessions/provider.js, and it must pass core/sessions/conformance.js.
   */
  provider(name: string, driver: SessionDriver): void;
  /** @internal The registered drivers, for the Switchboard. */
  providers: { get(name: string): SessionDriver | null; list(): string[] };
  /** @internal Every running module's declared settings, tagged with its module. For the settings module. */
  declaredSettings(): (SettingDef & { module: string })[];
  /** Every running module's teaches.tips, for the tips module (core/tips). firstParty: shipped in the repo. */
  declaredTips(): { module: string; version: string; firstParty: boolean; tips: Tip[] }[];
  /** @internal The whole merged config.json. Modules move to ctx.settings. */
  readonly config: any;
  /** @internal A tool on the linked box, from a module on the Mac. */
  remote<T = any>(tool: ToolName, input?: Record<string, unknown>): Promise<CallResult<T>>;
  /** @internal vyred's router, for a module that opens a listener of its own. */
  handler(policy: unknown): unknown;
  /** @internal The stream router, for the same. */
  upgrader(policy: unknown): unknown;
}

/** A session driver (ADR 0030). run() is required; the rest is defined by core/sessions/provider.js. */
export interface SessionDriver { run(...args: any[]): unknown; [k: string]: unknown }

export interface Module {
  start(ctx: ModuleContext): Promise<{ stop(): Promise<void> | void } | void> | { stop(): Promise<void> | void } | void;
}
