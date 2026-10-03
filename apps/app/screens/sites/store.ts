// The sites held in memory for this session, so the list and a site's page agree. A real publisher replaces `sitesRepo.sites`; this stays.
import { create } from "zustand";
import { sitesRepo, type Site } from "./data";

type S = { sites: Site[]; setSites: (f: (xs: Site[]) => Site[]) => void };
const useStore = create<S>((set) => ({ sites: sitesRepo.sites(), setSites: (f) => set((s) => ({ sites: f(s.sites) })) }));
export const useSites = useStore;
