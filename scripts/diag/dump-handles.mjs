// Diagnostic only (work/tailnet-hang): after 60 s, name what keeps this process alive.
const t = setInterval(() => {
  const h = process._getActiveHandles().map(x => x.constructor.name + (x.spawnfile ? ":" + x.spawnfile + " " + (x.spawnargs || []).join(" ") : "") + (x._idleTimeout ? ":timeout" + x._idleTimeout : "") + (x.remoteAddress ? ":" + x.remoteAddress + ":" + x.remotePort : ""));
  console.error("DUMPHANDLES", process.pid, process.argv.slice(1).join(" ").slice(0, 120), JSON.stringify(h), JSON.stringify(process.getActiveResourcesInfo()));
}, 60000);
t.unref();
