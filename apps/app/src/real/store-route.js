// @ts-check
// The ONE place the Store (store-core/gateway-adapter, behind Now, Tasks, Projects, Records, Calendar and Tags) picks where a read or a write goes. A call that names a team Space this device JOINED as a member
// goes to that team's door as her (real/box tool(): the member door map); every other call, her own home's Spaces, the owner's, All spaces, takes the path it always took (api/box call and send). A name the
// door has no row for is refused in words for a joined team: it never falls through to her own home as if it were the team.
//
// `deps`: joinedSpace(input) -> the joined team Space the call names (or the one showing), else null; door(name, input) -> the member door call (tool()); plain.read / plain.write -> today's calls;
// wired(name) -> does the door have a row for this name; notYet -> the words for one it has not; fail(err) -> the Error the screens expect (the Store's storeError): a refusal keeps its own words.

/**
 * @param {{ joinedSpace: (name: string, input: Record<string, unknown>) => Promise<string | null>, door: (name: string, input: Record<string, unknown>) => Promise<any>, wired: (name: string) => boolean,
 *   notYet: string, fail: (e: any) => Error, plain: { read: (name: string, input: Record<string, unknown>) => Promise<any>, write: (name: string, input: Record<string, unknown>, o: any) => Promise<any> } }} deps
 */
export function createStoreRoute(deps) {
  /** @param {string} name @param {Record<string, unknown>} input */
  const viaDoor = async (name, input) => {
    if (!deps.wired(name)) throw deps.fail({ code: "not_allowed", message: deps.notYet });
    try { return await deps.door(name, input); } catch (e) { throw deps.fail(e); }
  };
  return {
    /** @param {string} name @param {Record<string, unknown>} [input] */
    async read(name, input = {}) { return (await deps.joinedSpace(name, input)) ? viaDoor(name, input) : deps.plain.read(name, input); },
    /** @param {string} name @param {Record<string, unknown>} [input] @param {any} [o] */
    async write(name, input = {}, o = {}) { return (await deps.joinedSpace(name, input)) ? viaDoor(name, input) : deps.plain.write(name, input, o); },
  };
}
