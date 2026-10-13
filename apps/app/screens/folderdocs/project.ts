import { callT as call } from "../../src/real/call-tool";
import { projectFolderApi } from "./project-source";

/** The Instructions and Context editors' API for one project: `import { projectFolder } from "../folderdocs/project"`, then `<DocsEditor api={projectFolder(slug)} who={name} />`. */
export const projectFolder = (project: string, canEdit = true) => projectFolderApi(call, project, canEdit);
