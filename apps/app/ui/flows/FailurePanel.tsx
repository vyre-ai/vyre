import { useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Select } from "../components/Select";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { FormulaBox } from "./FormulaBox";
import { RETRY_WHY, offers, span } from "./failure.js";
import type { DraftStep } from "./logic.js";

const TIME_LIMITS: [string, string][] = [["", "The usual for this kind of step"], ["10000", "10 seconds"], ["30000", "30 seconds"], ["60000", "1 minute"], ["300000", "5 minutes"], ["900000", "15 minutes"], ["3600000", "1 hour"]];
const TRIES: [string, string][] = [["", "The usual for this kind of step"], ["off", "Do not try again"], ["2", "Up to 2 tries"], ["3", "Up to 3 tries"], ["4", "Up to 4 tries"], ["5", "Up to 5 tries"], ["8", "Up to 8 tries"]];
const WAITS: [string, string][] = [["", "The usual wait"], ["0", "No wait"], ["1000", "1 second"], ["5000", "5 seconds"], ["30000", "30 seconds"], ["60000", "1 minute"], ["300000", "5 minutes"]];

/** A stored value that is not one of the listed choices still shows, so opening a Flow never hides a setting. */
const withCurrent = (list: [string, string][], v: string, words: string): [string, string][] => (v && !list.some(([x]) => x === v) ? [...list, [v, words]] : list);

/**
 * The failure panel of one step: how long one try may take, whether to try again, how the work is checked, and what happens if it still fails. It writes the step's own keys (`timeout_ms`, `retry`,
 * `verify`, `on_fail`); the steps to run if it fails are drawn under the card as a lane, like Then and Else. Only what the engine does for this kind of step is offered.
 */
export function FailurePanel({ s, setStep, inHandler }: { s: DraftStep; setStep: (patch: Partial<DraftStep>) => void; inHandler?: boolean }) {
  const o = offers(s.kind);
  const set = Boolean(s.timeout_ms !== undefined || s.retry !== undefined || s.verify || s.on_fail);
  const [open, setOpen] = useState(set);
  const fail = o.fail && !inHandler;
  if (s.kind === "advanced" || (!o.timeout && !o.retry && !o.verify && !fail)) return null;
  if (!open) return <View className="flex-row"><Button kind="ghost" size="sm" icon="warning" label={set ? "If something goes wrong: set" : "If something goes wrong"} onPress={() => setOpen(true)} /></View>;

  const retry = s.retry === false ? null : (s.retry ?? {});
  const tries = s.retry === false ? "off" : retry?.attempts !== undefined ? String(retry.attempts) : "";
  const waitFor = Array.isArray(retry?.backoff_ms) ? null : retry?.backoff_ms !== undefined ? String(retry.backoff_ms) : "";
  const only: string[] = retry?.on ?? [];
  const setRetry = (next: Record<string, unknown> | false | undefined) => setStep({ retry: next === undefined || (next !== false && !Object.keys(next).length) ? undefined : next });
  const patchRetry = (patch: Record<string, unknown>) => { const merged = { ...(retry ?? {}), ...patch }; for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]; setRetry(merged); };
  const v = s.verify;
  const patchVerify = (patch: Record<string, unknown>) => { const merged = { ...(v ?? {}), ...patch }; for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === "") delete merged[k]; setStep({ verify: merged }); };

  return (
    <View className="gap-s3 border-t border-edge pt-s3">
      <View className="flex-row items-center justify-between gap-s2">
        <Text strong>If something goes wrong</Text>
        <Button kind="ghost" size="sm" label="Hide" onPress={() => setOpen(false)} />
      </View>

      {o.timeout ? (
        <Select label="Give up on one try after" value={s.timeout_ms !== undefined ? String(s.timeout_ms) : ""} options={withCurrent(TIME_LIMITS, s.timeout_ms !== undefined ? String(s.timeout_ms) : "", span(s.timeout_ms ?? 0))}
          onChange={(x) => setStep({ timeout_ms: x ? Number(x) : undefined })} />
      ) : null}

      {o.retry ? (
        <View className="gap-s2">
          <Select label="Try again" value={tries} options={withCurrent(TRIES, tries, `Up to ${tries} tries`)} onChange={(x) => (x === "off" ? setRetry(false) : patchRetry({ attempts: x ? Number(x) : undefined }))} />
          {s.retry !== false ? (
            Array.isArray(retry?.backoff_ms)
              ? <View className="flex-row flex-wrap items-center gap-s2"><Text size="caption" tone="label">{`Waits between tries: ${retry.backoff_ms.map((n: number) => span(n)).join(", ")}`}</Text><Button kind="ghost" size="sm" label="Use one wait" onPress={() => patchRetry({ backoff_ms: undefined })} /></View>
              : <Select label="Wait between tries" value={waitFor ?? ""} options={withCurrent(WAITS, waitFor ?? "", span(Number(waitFor)))} onChange={(x) => patchRetry({ backoff_ms: x === "" ? undefined : Number(x) })} />
          ) : null}
          {s.retry !== false && tries !== "off" ? (
            <View className="gap-s1">
              <Text size="caption" strong tone="label">Try again only when</Text>
              {RETRY_WHY.map(([code, words]) => (
                <View key={code} className="flex-row items-center justify-between gap-s2">
                  <Text>{words}</Text>
                  <Switch label={words} on={!only.length || only.includes(code)} onChange={(on) => {
                    const all = RETRY_WHY.map(([c]) => c);
                    const now = only.length ? only : all;
                    const next = on ? [...now, code] : now.filter((c) => c !== code);
                    patchRetry({ on: next.length === all.length || !next.length ? undefined : all.filter((c) => next.includes(c)) });
                  }} />
                </View>
              ))}
              <Text size="caption" tone="label">Anything else, such as a refusal for lack of access, is never tried again.</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {o.verify ? (
        <View className="gap-s2">
          <View className="flex-row items-center justify-between gap-s2">
            <Text strong>Check the work</Text>
            <Switch label="Check the work" on={Boolean(v)} onChange={(on) => setStep({ verify: on ? { check: "" } : undefined })} />
          </View>
          {v ? (
            <>
              <FormulaBox label="The work is right when (a formula over output)" value={v.check ?? ""} onChange={(check) => patchVerify({ check })} placeholder="For example output.record.id" />
              {o.readback ? (
                <View className="flex-row items-center justify-between gap-s2">
                  <Text>Read the record back and compare it with what was written</Text>
                  <Switch label="Read the record back" on={v.readback === true} onChange={(on) => patchVerify({ readback: on ? true : undefined })} />
                </View>
              ) : null}
              <Field label="Say what is wrong when the check fails" value={v.say ?? ""} onChangeText={(say) => patchVerify({ say })} placeholder="For example The refund was not recorded." />
              <View className="flex-row items-center justify-between gap-s2">
                <Text>Stop this step when the check fails</Text>
                <Switch label="Stop this step when the check fails" on={v.essential !== false} onChange={(on) => patchVerify({ essential: on ? undefined : false })} />
              </View>
              <Text size="caption" tone="label">{v.essential === false ? "A failed check is written on the run and flagged for attention. The Flow goes on." : "A failed check fails the step, so its retry and failure steps apply."}</Text>
            </>
          ) : null}
        </View>
      ) : null}

      {fail ? (
        <View className="gap-s2">
          <View className="flex-row items-center justify-between gap-s2">
            <Text strong>If this fails, run other steps</Text>
            <Switch label="If this fails, run other steps" on={Boolean(s.on_fail)} onChange={(on) => setStep({ on_fail: on ? { steps: [], then: "stop" } : undefined })} />
          </View>
          {s.on_fail ? (
            <>
              <Select label="After those steps" value={s.on_fail.then === "continue" ? "continue" : "stop"} options={[["stop", "Stop the Flow here"], ["continue", "Carry on with the next step"]]} onChange={(then) => setStep({ on_fail: { ...s.on_fail, then } })} />
              <Text size="caption" tone="label">Add the steps in the "If this fails" lane under this card. They can read what went wrong as {"{error.message}"}.</Text>
            </>
          ) : null}
        </View>
      ) : null}
      {inHandler ? <Chip>This step already runs because something failed, so it has no failure steps of its own.</Chip> : null}
    </View>
  );
}
