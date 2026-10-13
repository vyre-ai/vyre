export type Device = "computer" | "phone";
export type AiState = "idle" | "working" | "connected" | "failed";
/** What the prototype remembers between screens. Nothing leaves the page. */
export type Ctx = {
  device: Device;
  /** The space allows sessions on computers. */
  allowed: boolean;
  /** Adding a space later: Space, Compute, Ready. */
  later: boolean;
  name: string;
  master: string;
  /** Setting a new master password after the recovery kit, not the first one. */
  reset: boolean;
  ai: Record<string, AiState>;
  aiSkipped: boolean;
  spaceName: string;
  server: "cloud" | "mac";
  created: boolean;
  runHere: boolean;
  role: "member" | "admin";
  inviteName: string;
  /** The wire role: admin, member, temp (a Guest) or a custom role id. */
  inviteRole: string;
  inviteProjects: string[];
  /** The seat level chosen per project id. */
  inviteLevels: Record<string, string>;
  inviteDays: string;
};
export type ScreenProps = {
  ctx: Ctx;
  set: (patch: Partial<Ctx> | ((c: Ctx) => Partial<Ctx>)) => void;
  go: (id: string) => void;
  back?: () => void;
  steps?: { labels: string[]; current: number };
};
