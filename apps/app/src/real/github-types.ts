export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; say: string };

/** What the relay read from GitHub: the numeric id (a login can change), the login, the avatar, and the Vyre name already linked to this id, if any. */
export type GithubUser = { id: number; login: string; displayName?: string; avatarUrl?: string; linkedName?: string };
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
  /** This device has a server (a pairing). False puts the Space step before Vault; unset counts as true. */
  paired?: boolean;
  /** Unpaired order: the Vault screen held until a server is set up, and what is already done. */
  vaultEntry?: string;
  vaultDone?: boolean;
  spaceDone?: boolean;
  /** Who GitHub said this is, after Continue with GitHub. It proves who the person is; it never opens the vault. */
  github?: GithubUser;
  /** The one-use GitHub ticket and its verifier, kept in memory only until the name is linked or the flow ends. */
  githubSession?: { ticket: string; cv: string } | null;
  /** The avatar to show: GitHub's, until the person picks another. */
  avatar?: string;
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
