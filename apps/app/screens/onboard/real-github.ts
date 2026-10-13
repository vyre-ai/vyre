// Continue with GitHub, behind one small door. In MOCK it answers from flow-model.js. Otherwise it asks the relay (relay/worker/github.js): the browser goes to GitHub, comes back
// with a one-use ticket, and the relay says who GitHub says this is and which Vyre name, if any, is linked to that numeric id. GitHub proves who; it never opens a vault.

import { MOCK } from "../../src/real/box";
import { GITHUB_MOCK } from "./flow-model.js";
import type { GithubUser } from "./types";
import type { Outcome } from "./real-identity";

/** `signin` picks the linked mock person, anything else the new one. */
export async function continueWithGithub(opts: { signin: boolean }): Promise<Outcome<{ user: GithubUser }>> {
  if (MOCK) return { ok: true, user: opts.signin ? GITHUB_MOCK.linked : GITHUB_MOCK.fresh };
  return { ok: false, say: "Sign in with GitHub is not available in this build yet. Use your name, or your recovery kit." };
}
