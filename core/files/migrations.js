// @ts-check
// The files module's ONE migration list. The store numbers a module's steps by position and a step already done is skipped, so two lists migrated under the same module name collide:
// mentions took version 1 and shared links (space-links.js), whose list was also migrated as "version 1", never got its table. Every part of the module migrates THIS list, and a new
// part appends to it (never reorders: a number is a step already run on someone's box). It is a function so the parts that import it can import each other without a cycle.
import { MIGRATIONS as MENTION_MIGRATIONS } from "./mentions.js";
import { LINK_MIGRATIONS } from "./space-links.js";
import { LINKED_MIGRATIONS } from "./linked.js";
import { INDEX_MIGRATIONS } from "./linked-index.js";

export const filesMigrations = () => [...MENTION_MIGRATIONS, ...LINK_MIGRATIONS, ...LINKED_MIGRATIONS, ...INDEX_MIGRATIONS];
