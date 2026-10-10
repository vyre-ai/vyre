// Types for Vyre modules, module API 1 (ADR 0033, frozen by ADR 0047).
//
// A module is a folder with module.json and an entry file whose default export has start(ctx).
// Everything a module may rely on is in ModuleContext without an @internal tag. @internal members
// exist for Vyre's own (built in) modules, are absent in the module host an added module runs in,
// and may change in any release. Members tagged @planned are part of module API 1 but not built in
// vyred yet; check with ctx.api.has() before using them. @vyre/module-sdk/testing fakes all of them.
// Members tagged @deprecated keep working through 0.3 (ADR 0047 section 8).
//
//   /** @type {import("@vyre/module-sdk").Module} */
//   export default { async start(ctx) { ... return { async stop() {} }; } };

/** The module API major this file describes. */
export declare const API_VERSION: 1;
/** The module contract version this file describes (contract.json "current"). */
export declare const CONTRACT_VERSION: "1.0";

// ---- The manifest (module.json); the schema is manifest.schema.json --------------------------

/** A tool name: "<module>.<verb>". */
export type ToolName = `${string}.${string}`;
/** An event type: "<noun>.<past-verb>". */
export type EventType = `${string}.${string}`;
/** An event pattern: a type, "noun.*" or "*". */
export type EventPattern = EventType | `${string}.*` | "*";
/** A UI slot: panel, settings, route, view, now, renderer or slash, optionally ":<name>". */
export type Slot = `${"panel" | "settings" | "route" | "view" | "now" | "renderer" | "slash"}${"" | `:${string}`}`;

/** Who may call a tool (ADR 0047 section 2). */
export type Reach = "anyone" | "asked" | "person" | "modules" | "hook";
/** A tool that acts as the person outside: the registry routes every call to it through the Gate. */
export type Outward = "send" | "post" | "pay" | "delete";

/** One tool under does.tools, in the object form every added module uses. */
export interface ToolEntry {
  name: ToolName;
  /** A short lowercase line for the install card and the capability manifest. */
  summary?: string;
  /**
   * anyone (default): the person, any agent, and modules that list it under needs.tools.
   * asked: the person, and an agent only when the person's own turn asked for it; otherwise the
   * call answers { error: { code: "not_asked" } }. person: reserved for Vyre's own tools.
   * modules: other modules only, hidden from people and agents. hook: the webhook route only.
   */
  reach?: Reach;
  /** It acts as the person outside. From the person's own surface it runs; from anyone else it is held at the Gate. */
  outward?: Outward;
  /** It spends money through the module's own model or API use. */
  cost?: "paid";
  /** What the tool does to state: "read" changes nothing, "write" does. Undeclared, a read verb at the end of the name (list, get, status ...) is a read, else a write. A write with no `callers` list is open to the person's surfaces and modules only; declare `callers` to open it to anyone else. */
  effect?: "read" | "write";
  /** The input field (or fields) holding a project: an agent calling for a project it is not granted is refused (not_found) before the tool runs, and the tool gets meta.reach for listings. */
  projectArg?: string | string[];
  /** The input field (or fields) holding a folder: mapped to its project, and refused for an agent not granted that project (or for a folder in no project). */
  cwdArg?: string | string[];
  /** The tool keys by the Project record's id: the registry checks an agent's grant on the short name as usual but hands the tool the id (or address) that was given. */
  projectIsRecord?: true;
  /** Built in only, for an asked tool: an internal tool of this module that answers { to: [string] }, what one call acts on, so the person's yes binds that thing and not the whole tool. */
  target?: string;
  [experimental: `x-${string}`]: unknown;
}

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
  choicesFrom?: { tool: ToolName; read?: string };
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
  confirm?: true | { values: unknown[] } | { drops: true };
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
  /**
   * The module contract it is written for: the major ("1"), or "1.2" when it needs something added
   * in minor 2. Required for an added module; a Vyre that doesn't speak it never imports the module.
   */
  vyre?: string;
  /** @deprecated Use vyre. Read as "vyre": "1". */
  apiVersion?: 1;
  /** One plain sentence for the install card. Required for an added module. */
  description?: string;
  /** The entry file, relative to the module folder. Default index.js. */
  main?: string;
  /** box: the server. local: any device's local node; mac and windows narrow it. Default ["box"] for an added module. */
  roles?: ("box" | "local" | "mac" | "windows")[];
  /** Names, or (planned) names with a semver range. */
  requires?: string[] | Record<string, string>;
  /** @planned Set to this module's own name to replace the first-party module of that name. */
  replaces?: string;
  /** Built in only: this module's tools the setup channel may call before sign-in. An added module that declares it fails to load. */
  setupTools?: string[];
  /** What this module offers the # tag picker. `search` and `resolve` are this module's own read tools. An added module's `kind` is its own name (or `<name>-...`), and what resolve returns is cut to words: no grant, no hosts, always outside text. */
  mentions?: { kind: string; label: string; icon?: string; search: string; resolve: string }[];
  /** The screens this module serves, which the app can put in the sidebar. `path` is relative to /m/<module>/. */
  screens?: { id: string; label: string; path?: string; icon?: string }[];
  /** The screens this module describes and Vyre draws (list, board, summary, form), by id; no module code runs in the app. */
  views?: Record<string, { title: string; icon?: string; keywords?: string[]; root?: boolean; arg?: Record<string, unknown>; list?: Record<string, unknown>; board?: Record<string, unknown>; summary?: Record<string, unknown>; forms?: Record<string, unknown> }>;
  does?: {
    /** A name is the built in grace form (reach anyone). Added modules use ToolEntry. */
    tools?: (ToolName | ToolEntry)[];
    /** The tools of this module that change nothing. A tool open to anyone that is not named here (or given effect: "read" on its entry) is a write: open to the person's surfaces and modules only until its callers list says otherwise. */
    reads?: ToolName[];
    /** Session drivers (ADR 0030). Built in only in 0.2. */
    providers?: string[];
    /** Watcher preset files it ships (relative .json paths). A preset only describes; it runs no code. */
    watchers?: string[];
    /** Kit files it ships (relative .json paths): record types and their parts, installed only when the person approves. */
    kits?: string[];
    /** @planned Harness points, each served by one of this module's tools. pretool only tightens. */
    hooks?: { brief?: ToolName; enrich?: ToolName; pretool?: ToolName; stop?: ToolName };
    /** @deprecated Mark the tool outward instead. Gate sender types: type name to the tool that sends after the Gate approved. */
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
  /** What the module adds to Flows. A step is one of its own tools a Flow's call step may run; a trigger is an event it emits or a watcher it hosts, offered by name. */
  flow?: {
    steps?: {
      /** One of its own tools (object form, reach anyone). */
      name: ToolName;
      label: string;
      inputs?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
      outputs?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
      /** The step leaves Vyre; the tool must be marked outward too. */
      outward?: boolean;
    }[];
    triggers?: {
      name: string;
      label: string;
      /** An event in watches.emits: the trigger is an `event` trigger on it. */
      event?: EventType;
      /** A watcher it hosts: the trigger is a `watcher` trigger on it. */
      watcher?: string;
      inputs?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
    }[];
  };
  watches?: {
    emits?: EventType[];
    /** @planned Event patterns it subscribes to. */
    on?: EventPattern[];
  };
  shows?: {
    deck?: Slot[];
    capsule?: string[] | Record<string, CapsuleEntry>;
    /** @deprecated Use does.commands. */
    cli?: string[];
    /** WebSocket streams. Built in only in 0.2. */
    streams?: string[];
    /** @planned Notice kinds it raises, rendered from needs.list on every surface. */
    notices?: string[];
  };
  /** @planned Settings, drawn in the Deck's Settings and `vyre config` with no UI work. */
  settings?: SettingDef[];
  needs?: {
    /** Vault item names, or "per-<thing>" for items named at run time. Built in only in 0.2. */
    vault?: string[];
    /** Vendor-hosted MCP connections it reads through ctx.connections.call. */
    connections?: { provider: string; purpose: string }[];
    /** Its default daily cap on core/spend. */
    spend?: { dailyUsd: number };
    /** Daemon services handed to a built in module (names the loader knows: kernelSession, chatFor, agentActor, kernelThreads, sandbox, flowsHost, credentials, dataStores, devStandIn, modulesListReset, modulesListResetPayload). */
    daemon?: string[];
    /** The record types and Drive folders it may reach, as narrow verbs on `ctx.kernel` (an added module; shown on the install card). Not the kernel handle: no defining types, no removing records. */
    kernel?: { records?: string[]; files?: string[] };
    /** @planned Tools it calls with ctx.call, or "module.*". */
    tools?: string[];
    /** @planned Hosts it talks to. A declaration the person approves, not a wall, while in process. */
    network?: string[];
    /** @planned UI slots it fills. */
    slots?: Slot[];
    /** What it needs from the Vault, which the vault lists and fills (ADR 0028, 9a). */
    credentials?: CredentialNeed[];
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

export type Surface = "capsule" | "deck" | "chat" | "phone" | "cli" | "glass" | "statusline";

/** One need under needs.credentials (ADR 0028, 9a). */
export interface CredentialNeed {
  id: string;
  kind: string;
  provider: string;
  purpose: string;
  /** The vault item; omitted, it is "<module>-<id>". */
  item?: string;
  group?: string;
  optional?: boolean;
  /** More than one of it may be connected. */
  multiple?: boolean;
  [experimental: `x-${string}`]: unknown;
}

/**
 * What a tool answers when it is called with render: true, and the `view` that `vyre <cmd> --view`
 * frames carry ({ v: 1, cmd, view, data }, docs/reference/cli-json.md), so the Capsule, chat and the
 * CLI draw one set of views. Every kind may carry a title and actions.
 */
export type Render = (
  | { kind: "table"; columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; /** Shown when there are no rows. */ empty?: string }
  | { kind: "card"; fields: { label: string; value: unknown }[]; state?: CheckState }
  | { kind: "text"; lines: string[] }
  | { kind: "qr"; /** The payload to draw. */ text: string; caption?: string }
  | { kind: "checks"; /** ids let a live view update a check in place. */ items: { id: string; label: string; state: CheckState; note?: string }[] }
  | ({ kind: "prompt" } & RenderPrompt)
  | { kind: "error"; code: string; message: string; next?: string }
) & { title?: string; actions?: RenderAction[] };

export type CheckState = "ok" | "wait" | "failed" | "unknown";

/** Something the person can do from the view: a tool call. */
export interface RenderAction { label: string; tool: ToolName; input?: Record<string, unknown> }

/**
 * A question the surface asks. `label` is the question. The CLI answers by running the verb again
 * (argv: args plus how the answer is given); a tool called with render: true is answered by
 * calling `tool` with `input` and the answer under `name`.
 */
export type RenderPrompt = { name: string; label: string; choices?: string[]; secret?: boolean } & (
  | { args: string[]; answer: "word" | "flag" | "stdin" | "confirm"; flag?: string }
  | { tool: ToolName; input?: Record<string, unknown> }
);

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
  /** Who is calling, as vyred established it: never from input. */
  who?: "person" | "agent" | "module" | "hook";
  /** Set only when vyred verified the calling agent. */
  agent?: string;
  /** Set only when vyred verified the calling session's thread. */
  thread?: string;
  /** The project the call is made in, when there is one. */
  project?: string;
  /** True when vyred's P17 match found the person's own words in their own turn asking for this. */
  asked?: boolean;
  /**
   * For an outward tool: how this run was cleared, and the Gate item that cleared it. via is
   * "person" for the person's own words (a command they typed), "asked" when the Gate's P17 match
   * ran it at once, "approved" when the person approved a hold (called as module:gate with the
   * approved content). The item lets exactly one vault or connection write through (M3).
   */
  gate?: { via: "person" | "asked" | "approved"; item: string };
  /** True when the call is a tap on a control the module drew (a slot). An outward tool never runs from one. */
  slot?: boolean;
  /** How a person proved presence for this call, when the tool needed it. Never the proof. */
  presence?: { method: string; keyId: string | null };
  idempotencyKey?: string;
  /** The chat's id for this tool call, on a session's own paths only. Unverified: for linking, never for a decision. */
  call?: string;
  [k: string]: unknown;
}

export interface ToolDef<I = any, O = any> {
  description?: string;
  /** JSON Schema for the input. */
  input?: InputSchema;
  /** JSON Schema for the answer. Optional; the conformance test checks answers are JSON. */
  output?: InputSchema;
  /** At least one input the conformance test calls (ADR 0047 section 7). Each validates against input. */
  examples?: { input: I; title?: string }[];
  /** Returns JSON, or throws an Error carrying a short lowercase `code`. */
  run(input: I, meta: CallMeta): O | Promise<O>;
  /** @deprecated for added modules: declare reach in module.json. The caller kinds that may use it. Omitted: all. */
  callers?: string[];
  /** @internal Presence is never an added module's to declare (C25); the host refuses it. */
  presence?: boolean | { when?: (input: I) => boolean; summary?: (input: I) => string; session?: boolean };
  /** @internal Only other modules may call it, and it is left out of every listing. Added modules use reach "modules". */
  internal?: boolean;
  /** @internal Reachable only as the webhook route POST /v1/<module>/<name>/hook. Added modules use reach "hook". */
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
  /** The caller class the running call came from, past module hops, or undefined when nothing is running. A module that stores work for later stores this beside it (RG-2). */
  origin(): string | undefined;
  /** Run `fn` as the call `origin` came from (the origin stored with a job or an event), so what it calls is judged as that caller class. With no origin it just runs `fn`. */
  withOrigin<T>(origin: string | undefined, fn: () => T): T | Promise<T>;
  /** Events after an id, oldest first. */
  since(id?: number, opts?: { type?: string; project?: string; limit?: number }): VyreEvent[];
  /** One thread's own events, oldest first (an indexed read of the log). */
  ofThread(thread: string, opts?: { types?: string[]; limit?: number; tail?: boolean }): VyreEvent[];
  /** @internal Built in only: delete every event of a thread (the threads module's alone, when the person deletes it). */
  eraseThread(thread: string): number;
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
  /** needs.credentials, for the vault. */
  credentials?: CredentialNeed[];
  /** Calls to its tools from people, surfaces and models (never modules or webhooks). lastUsed is ms since the epoch. */
  use: { calls: number; lastUsed: number | null };
}

/** A tool as GET /v1/tools lists it to a caller. */
export interface ToolListing { name: ToolName; module: string; description: string; input: InputSchema; presence?: true }

export interface ModuleLog {
  (message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  debug(message: string, extra?: unknown): void;
}

/** A vendor API call carrying a granted credential the module never sees (vault P5). */
export interface VaultRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}
/** A scrubbed response, or { held } when a write waits at the Gate. */
export type VaultResponse = { status: number; headers: Record<string, string>; body: unknown } | { held: string };

export interface ModuleContext {
  /** This module's name. */
  readonly name: string;
  /** This module's version, from module.json. */
  readonly version: string;
  /**
   * The module contract this Vyre speaks, like "1.0", and feature tests for additions inside the
   * major: a module that can do without a newer member checks for it and works either way.
   */
  readonly api: { version: string; has(feature: string): boolean };
  /** Logs prefixed with the module's name: `vyre logs <module>`. */
  log: ModuleLog;
  /**
   * Another module's tool, as module:<name>, held to needs.tools. Resolves { data } or
   * { error: { code, message } }; never throws for a refusal. The only way to use another module.
   * @internal The third argument `{ as }` is for built in modules only.
   */
  call<T = any>(tool: ToolName, input?: Record<string, unknown>, opts?: { as?: string }): Promise<CallResult<T>>;
  /**
   * Register a tool declared under does.tools. run(input, meta) returns JSON or throws an Error
   * with a short lowercase `code`. meta is set by vyred, never from input.
   */
  tool<I = any, O = any>(name: ToolName, def: ToolDef<I, O>): void;
  /** Emit types declared under watches.emits; subscribe to patterns under watches.on. */
  events: ModuleEvents;
  /** Read only: every module's status row (a copy). */
  readonly modules: {
    status(): ModuleStatus[];
    /** @internal The tools a given caller may use. */
    tools(caller?: Caller): ToolListing[];
  };
  /** This module's own declared settings, resolved project over account over default. set writes only plain keys. */
  settings: {
    get<T = unknown>(key: string, opts?: { project?: string }): Promise<T>;
    set(key: string, value: unknown, opts?: { project?: string }): Promise<void>;
    on(key: string, fn: (value: unknown, change: { key: string; project?: string }) => void): () => void;
  };
  /**
   * Its own SQLite tables. An added module's database is its own file in its data folder; a
   * built in module's tables are prefixed in vyre.db.
   */
  store: {
    /** A node:sqlite DatabaseSync, for a built in module in the daemon. A module installed from outside runs in a sandbox and has no `db`: use `exec`, `query` and `migrate`, which work everywhere. */
    db?: any;
    /** Ordered SQL steps, forward only, each applied once. Tables start with the module's name and an underscore. */
    migrate(steps: string[]): void | Promise<void>;
    /** Run one statement with `?` parameters. Answers { changes, lastInsertRowid }. */
    exec(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
    /** Run one query with `?` parameters. Answers the rows. */
    query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  };
  /**
   * What `needs.kernel` declared, as narrow verbs for the Space's own records and Drive (an added module; never the kernel's handle). They run under the person who installed the module, with the module
   * beside them as an outside hop, and only on the declared record types and folders. Present only when declared.
   */
  kernel?: {
    records?: {
      create(type: string, data: Record<string, unknown>): Promise<{ urn: string; id: string; type: string; data: Record<string, unknown>; version: number }>;
      get(urn: string): Promise<{ urn: string; data: Record<string, unknown>; version: number } | null>;
      list(type: string, opts?: { filter?: unknown; limit?: number }): Promise<{ rows: Array<{ urn: string; data: Record<string, unknown>; version: number }>; next_cursor: string | null }>;
      update(urn: string, patch: Record<string, unknown>, baseVersion: number): Promise<{ urn: string; data: Record<string, unknown>; version: number }>;
    };
    files?: {
      /** Write a file into a declared Drive folder as a new version: `{ path, text }` or `{ path, base64 }`, at most 8 MB. */
      write(file: { path: string; text?: string; base64?: string }): Promise<{ path: string; version: number; size: number }>;
    };
  };
  /** @internal Every path but data is for built in modules. */
  paths: {
    /** This module's own folder, <home>/data/<module>/, the only place it may write. */
    readonly data: string;
    /** @internal */ readonly [k: string]: string;
  };
  vault: {
    /**
     * A vendor API call with a credential declared under needs.credentials, attached by the vault;
     * the module never sees it. Reads run at once. Writes (send, spend, delete) hold at the Gate
     * unless the person's own words asked. The response is scrubbed.
     */
    request(credentialId: string, req: VaultRequest): Promise<VaultResponse>;
    /** @internal A vault item declared under needs.vault, if the person granted it. Built in only. */
    fetch(name: string, opts?: { field?: string }): Promise<unknown>;
  };
  /** @planned A tool on a vendor-hosted MCP connection declared under needs.connections. Writes hold at the Gate. */
  connections: { call<T = any>(provider: string, tool: string, input?: Record<string, unknown>): Promise<CallResult<T>> };
  /**
   * @planned An uncredentialed GET or HEAD, with no body, to a needs.network host; anything else
   * throws code "method_not_allowed". Private, loopback, link-local, CGNAT, tailnet and metadata
   * addresses are refused after DNS and on every redirect. To send data, use ctx.vault.request or
   * an outward tool.
   */
  fetch(url: string, init?: { method?: "GET" | "HEAD"; headers?: Record<string, string> }): Promise<{ status: number; headers: Record<string, string>; text(): Promise<string>; json(): Promise<any> }>;
  /** @planned Propose an outward act through an existing sender (the mail module, say). */
  gate: { request(req: { kind: string; via: ToolName; to?: string; content: unknown; why?: string }): Promise<{ held: string } | { sent: unknown }> };
  memory: {
    /**
     * @planned A memory row through iq's memory.write (needs.tools must list it). vyred sets
     * from: "module:<name>", forces untrusted: true for an added module, and dedupes by source_ref.
     */
    write(row: { kind: "fact" | "note"; project?: string; text: string; subject?: string; source_ref?: string }): Promise<CallResult<{ id: string }>>;
    /** @deprecated Use write({ kind: "fact" }). Hands the curator a fact of a kind declared under teaches.memory. */
    teach(kind: string, fact: unknown): Promise<boolean>;
  };
  /** @planned A one-shot model read with no tools, billed on core/spend as module:<name>/<purpose>. */
  ask(prompt: string, opts: { purpose: string; maxUsd?: number; model?: string }): Promise<{ text: string; usd: number } | { error: CallError }>;
  /** @planned The cost of its own paid API use, on core/spend. */
  spend: {
    record(entry: { usd: number; purpose: string; estimated?: boolean }): Promise<void>;
    check(purpose: string): Promise<{ ok: boolean; spentUsd: number; capUsd: number | null }>;
  };
  /** @planned Ask to notify the person, inside core/push's one daily budget and quiet hours. */
  push: { offer(n: { title: string; body: string; url?: string; kind: string }): Promise<"sent" | "deferred"> };
  /** @planned Declare the inverse of an action it just took, for the shared undo log. Only a declared inverse is replayed. */
  undo: { record(entry: { tool: ToolName; input: unknown; inverse: { tool: ToolName; input: unknown } }): Promise<void> };
  /** @internal A WebSocket at /v1/streams/<module>/<name>, declared under shows.streams. */
  upgrade(name: string, handler: (req: any, socket: any, head: any, caller: Caller) => void): void;
  /** @internal A raw HTTP route at /v1/<module>/<name>, for what a tool can't carry. */
  route(name: string, fn: (req: any, res: any, at: { caller: Caller; url: URL }) => unknown): void;
  /**
   * @internal Register a session driver declared under does.providers (ADR 0030). The driver's
   * full shape is core/sessions/provider.js, and it must pass core/sessions/conformance.js.
   */
  provider(name: string, driver: SessionDriver): void;
  /** @internal The registered drivers, for the Switchboard. */
  providers: { get(name: string): SessionDriver | null; list(): string[] };
  /** @internal Every running module's declared settings, tagged with its module. For the settings module. */
  /** Offer a value to the modules that asked for it, once (a name another module reads); the loader refuses a second provider of the same name. */
  provide(name: string, value: unknown): void;
  declaredSettings(): (SettingDef & { module: string })[];
  /** @internal The tools shipped modules list under setupTools, for the relay's pre-claim setup channel. Only a built-in module's field counts. */
  declaredSetupTools(): string[];
  /** @internal vyre-core's key store (lib/vyre-core-keys.js), handed to the relay module alone; null for every other module and where core holds no keys. */
  coreKeys: unknown;
  /** @internal Every running module's teaches.tips, for the tips module (core/tips). firstParty: shipped in the repo. */
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
