import { useStoreQuery } from "../store";
import { loadProject, loadWork, loadWorld } from "./world.js";

/** The world Now and the task page draw from, re-read whenever the store changes. Pass `epoch` when the store is swapped. */
export const useWorld = (epoch = 0) => useStoreQuery((s) => loadWorld(s), [epoch]);

/** A project page's data (the record, its type, its events and links), or `found: null` when there is no such project. */
export const useProject = (id: string) => useStoreQuery((s) => loadProject(s, id), [id]);

/** The world plus every record of a type that holds work, for the Projects list. */
export const useWork = () => useStoreQuery(async (s) => { const world = await loadWorld(s); return { world, items: await loadWork(world, s) }; }, []);
