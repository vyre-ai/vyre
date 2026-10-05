import { callT as call } from "../../src/real/call-tool";
import { chromeSitesSource } from "./chrome-sites-source";

export const chromeSites = chromeSitesSource(call);
