// @ts-check
// Whether Vyre for Chrome learns each site's structure. ON by default (the user's ruling, 1 Oct 2026); off when the person turns
// the memory.site.learn setting off, or when config says learn: false. Config can only turn learning off: `learn: true` in config
// never overrides an off setting (standalone has no settings tool, so its config default of true is what stands there). The setting
// is read through settings.get and kept for 10 s. A read that fails keeps the last answer and, with none yet, stays off (the same rule as memory.site.put, which refuses
// again when the setting is off); a registry with no settings tool at all (a test, a bare module) means on.

/** @param {{ cfg: any, call: (tool: string, input: any) => Promise<any>, now?: () => number, ttlMs?: number }} o */
export function createLearnSwitch(o) {
  const now = o.now || Date.now, ttl = o.ttlMs ?? 10_000;
  let setting = /** @type {boolean | null} */ (null), at = -Infinity;
  const config = () => (o.cfg.learn === undefined ? true : (typeof o.cfg.learn === "function" ? o.cfg.learn() : o.cfg.learn) === true);
  return {
    /** Read the setting if the last read is older than the ttl; never throws. */
    async refresh(/** @type {boolean} */ force = false) {
      if (!force && now() - at < ttl) return;
      at = now();
      try {
        const r = await o.call("settings.get", { key: "memory.site.learn" });
        if (r && r.error) { if (r.error.code === "no_such_tool" || r.error.code === "not_found") setting = true; return; }
        const d = r && r.data !== undefined ? r.data : r;
        setting = d && typeof d.value === "boolean" ? d.value : d && d.value === undefined ? true : setting;
      } catch { /* keep the last answer */ }
    },
    on() { return config() && (setting === null ? false : setting); },
  };
}
