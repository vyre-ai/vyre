// @ts-check
// The runner's real ports, made from the kernel's own pieces (the module gets these from its host; tests pass fakes of the same shape):
//   sealer    the sealing client (kernel/seal/client.js): sealer.lease.issue / renew, called as a person's chain
//   offers    gateway.grants.offers (kernel/grants): active({ member, device }) and onRevoke(fn)
//   use       vault's leasedUse(...) (kernel/seal/uses.js), already bound to the session -> lease map and the core vault's resolver
//   deviceId  () => the id of THIS computer's device key, read from the surfaces (R-13): the lease and the offer are for this machine,
//             never a name a caller supplied
//   spec      ({ space, session }) => { command, args, env, routes, readOnly, labels }: the space's own definition of the session
//   server    (space) => { available, hasRoom, why }, and requestServer(space, session): the space's server, for placement and "move to server"

/**
 * @param {{ sealer: any, offers: any, use: (o: any) => Promise<string>, deviceId: () => string, member: string,
 *   spec: (o: { space: string, session: string }) => Promise<any>, server?: (space: string) => any, requestServer?: (space: string, session: string) => any,
 *   sync: any, labels?: (session: string) => any, sealState?: (s: any) => any, verifyState?: (s: any) => boolean, sessionState?: (session: string) => any }} o
 */
export function realPorts(o) {
  const device = o.deviceId();
  if (!device || typeof device !== "string") throw new Error("the runner needs this computer's device key identity");
  const active = () => o.offers.active({ member: o.member, device });
  const allowed = () => { const a = active(); return Boolean(a.spaceAllows && a.memberAccepts); };
  return {
    device,
    vault: {
      lease: ({ space }) => o.sealer.lease.issue({ space, device, allowed: allowed() }),
      // access is asked again on every renewal: a withdrawn offer ends the lease at the next one at the latest
      renew: ({ id }) => o.sealer.lease.renew({ id, allowed: allowed() }),
      credential: req => o.use(req),
    },
    sync: o.sync,
    grants: () => active(),
    onRevoke: fn => o.offers.onRevoke(info => { if (!info?.device || info.device === device) return fn(info); }),
    spec: o.spec, server: o.server, requestServer: o.requestServer,
    labels: o.labels, sealState: o.sealState, verifyState: o.verifyState, sessionState: o.sessionState,
  };
}
