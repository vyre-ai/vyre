// Test stand-in: answers the two Drive tools the Windows app's link window calls, with the share the VM serves.
import fs from "node:fs";

const LOG = process.env.BOX_CALLS_LOG || "/srv/vyre-test/box/calls.log";
const note = (s) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`); } catch {} };

export default {
  async start(ctx) {
    ctx.tool("files.drive.candidates", {
      description: "Folders that could be shared (test stand-in).",
      input: { type: "object", properties: {} },
      run: async (_i, meta = {}) => {
        note(`files.drive.candidates caller=${meta && meta.caller}`);
        return { items: [{ path: "/projects", name: "projects", share: "projects", suggestedName: "projects", shared: true }] };
      },
    });
    ctx.tool("files.drive.address", {
      description: "Where a share is reached on the tailnet (test stand-in).",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" } } },
      run: async ({ share }, meta = {}) => {
        note(`files.drive.address share=${share} caller=${meta && meta.caller}`);
        const url = "http://100.100.100.100:8080/example.com/vyre/projects";
        return { url, unc: "\\\\100.100.100.100@8080\\example.com\\vyre\\projects", access: "rw", shared: true };
      },
    });
    return { async stop() {} };
  },
};
