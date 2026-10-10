// @ts-check
// "New" in the Projects list: which way a new thing is made. A project goes through the work hub, which gives it a short name, a Drive folder and a memory (so chats and files can be kept under it);
// any other type is a plain record.

/** @param {string} type @returns {{ tool: string, input: { name: string } } | null} the work-hub call for a new project, or null for a plain record */
export function newThingCall(type) {
  return type === "project" ? { tool: "work.project.create", input: { name: "New project" } } : null;
}
