// @ts-check
// Personal skills live on the identity (the home Space's kernel), not on each hosted Space's store. Every entry point that reads or writes a personal skill uses the same home kernel when the running Space is not the home.

/** @param {any} ctx module context from core/skills/index.js */
export function homeSpaceId(ctx) {
  if (ctx.homeSpacePinned) return String(ctx.homeSpacePinned);
  const fromDeps = ctx.registry && ctx.registry.deps && typeof ctx.registry.deps.homeSpace === "string" ? ctx.registry.deps.homeSpace : "";
  if (fromDeps) return fromDeps;
  const id = ctx.kernel && ctx.kernel.id && ctx.kernel.id.space;
  return id ? String(id) : String(ctx.kernel && ctx.kernel.space || "");
}

/** @param {any} ctx @param {string} space */
export function kernelInSpace(ctx, space) {
  if (!ctx.kernel || typeof ctx.kernel.for !== "function") return ctx.kernel;
  const h = ctx.kernel.for(space);
  return h && h.kernel ? h.kernel : ctx.kernel;
}

/** The kernel whose `skill` records hold personal-level skills for this home. @param {any} ctx */
export function identityKernel(ctx) {
  return kernelInSpace(ctx, homeSpaceId(ctx));
}

/** @param {any} ctx */
export function runningSpaceId(ctx) {
  return String(ctx.kernel && ctx.kernel.space || homeSpaceId(ctx));
}

/** Personal skills are identity-scoped: stored only on the home Space kernel. @param {any} ctx */
export function personalSkillsOnHome(ctx) {
  const home = homeSpaceId(ctx);
  if (!home) return false;
  return runningSpaceId(ctx) !== home;
}
