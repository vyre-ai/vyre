// @ts-check
// Several pipelines on one type, in the words a person edits: each has a name and stages, each stage a chance (0 to 100) and a colour. records.pipeline.set takes the whole list; the first is the default and a
// record picks another with its Pipeline field. One pipeline is sent as the plain { type, stages } the box has always taken.

import { requiresOf, LOST_REASON } from "./stage-rules.js";

export const COLOURS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
export const DEFAULT_PIPELINE = "Main";

/** @param {any[]} stages */
const rowsOf = (stages) => (Array.isArray(stages) ? stages : []).map((/** @type {any} */ s) => {
  const req = requiresOf(s.enter_if);
  return { name: String(s.name), ...(typeof s.probability === "number" ? { probability: s.probability } : {}), requires: req.filter((f) => f !== LOST_REASON), lost: req.includes(LOST_REASON) };
});

/** Every pipeline of a type: the default stages first, then the other stage sets. @param {any} def @returns {{ name: string, stages: { name: string, probability?: number, requires: string[], lost: boolean }[] }[]} */
export function pipelinesOf(def) {
  const pf = (def && Array.isArray(def.fields) ? def.fields : []).find((/** @type {any} */ f) => f && f.name === "pipeline");
  const first = pf && Array.isArray(pf.options) && pf.options.length ? String(pf.options[0]) : DEFAULT_PIPELINE;
  return [{ name: first, stages: rowsOf(def && def.stages) }, ...((def && def.stage_sets) || []).map((/** @type {any} */ s) => ({ name: String(s.name), stages: rowsOf(s.stages) }))];
}

const stageOut = (/** @type {any} */ r) => ({ name: r.name, ...(typeof r.probability === "number" ? { probability: r.probability } : {}), ...(r.requires && r.requires.length ? { requires: r.requires } : {}), ...(r.lost ? { lost: true } : {}) });

/** The input of records.pipeline.set. @param {string} type @param {{ name: string, stages: any[] }[]} pipelines */
export const pipelinesInput = (type, pipelines) => pipelines.length === 1 ? { type, stages: pipelines[0].stages.map(stageOut) } : { type, pipelines: pipelines.map((p) => ({ name: p.name, stages: p.stages.map(stageOut) })) };

/** A chance as a whole number from 0 to 100, or undefined for an empty box. @param {string} text */
export function chanceOf(text) {
  const t = String(text).trim().replace(/%$/, "");
  if (!t) return undefined;
  const n = Math.round(Number(t));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
}

/** Change one stage of one pipeline. @param {any[]} pipelines @param {number} p @param {number} i @param {Record<string, any>} patch */
export const patchStage = (pipelines, p, i, patch) => pipelines.map((x, a) => a === p ? { ...x, stages: x.stages.map((s, b) => b === i ? { ...s, ...patch } : s) } : x);

/** Move a stage up or down. @param {any[]} pipelines @param {number} p @param {number} i @param {-1|1} dir */
export function moveStageIn(pipelines, p, i, dir) {
  const j = i + dir;
  const st = pipelines[p].stages;
  if (j < 0 || j >= st.length) return pipelines;
  const next = [...st];
  [next[i], next[j]] = [next[j], next[i]];
  return pipelines.map((x, a) => a === p ? { ...x, stages: next } : x);
}

/** Add a stage called "New stage", "New stage 2" and so on. @param {any[]} pipelines @param {number} p */
export function addStageIn(pipelines, p) {
  const have = new Set(pipelines[p].stages.map((/** @type {any} */ s) => s.name.toLowerCase()));
  let n = "New stage", k = 2;
  while (have.has(n.toLowerCase())) n = `New stage ${k++}`;
  return pipelines.map((x, a) => a === p ? { ...x, stages: [...x.stages, { name: n, requires: [], lost: false }] } : x);
}

/** Take a stage out (the box refuses while records sit in it). @param {any[]} pipelines @param {number} p @param {number} i */
export const removeStageIn = (pipelines, p, i) => pipelines.map((x, a) => a === p ? { ...x, stages: x.stages.filter((/** @type {any} */ _s, b) => b !== i) } : x);

/** Add a pipeline with the stage names of the default, nothing required, named "Pipeline 2" and so on. @param {any[]} pipelines */
export function addPipeline(pipelines) {
  const have = new Set(pipelines.map((p) => p.name.toLowerCase()));
  let n = "Pipeline 2", k = 3;
  while (have.has(n.toLowerCase())) n = `Pipeline ${k++}`;
  return [...pipelines, { name: n, stages: pipelines[0].stages.map((/** @type {any} */ s) => ({ name: s.name, requires: [], lost: !!s.lost })) }];
}

/** The colour a stage is shown in, from the type's option colours; undefined when none was chosen. @param {any} def @param {string} stage */
export function stageColour(def, stage) {
  const sf = (def && Array.isArray(def.fields) ? def.fields : []).find((/** @type {any} */ f) => f && f.kind === "stage");
  const c = sf && def.option_colors && def.option_colors[sf.name] && def.option_colors[sf.name][stage];
  return typeof c === "string" ? c : undefined;
}

/** The input of records.type.update that sets one stage's colour. @param {any} def @param {string} stage @param {string} colour */
export function colourInput(def, stage, colour) {
  const sf = (def.fields || []).find((/** @type {any} */ f) => f && f.kind === "stage");
  return { name: def.name, option_colors: { [sf ? sf.name : "stage"]: { [stage]: colour } } };
}
