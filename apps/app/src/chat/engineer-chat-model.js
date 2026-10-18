// @ts-check
// The Engineer is one Space chat with everyone who may use it (work.engineer.chat). Its answer has the project chat's shape, so the plan is the same: make it, add the missing, drop the extra, or nothing.
import { projectChatPlan } from "./project-chat-model.js";

/** @param {any} a work.engineer.chat's answer (null when the person may not see it) */
export const engineerChatPlan = (a) => projectChatPlan(a);

/** The people a new Engineer thread is made for: the chat's people other than this person (work.chat.thread.new takes the others). @param {any} a @param {string} me */
export const engineerThreadPeople = (a, me) => (a && Array.isArray(a.people) ? a.people.map(String).filter((/** @type {string} */ p) => p !== me) : []);
