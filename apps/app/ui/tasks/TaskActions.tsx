import { useState } from "react";
import { View } from "react-native";
import { aid } from "../../src/store-core/kernel-view.js";
import { simulatedProof } from "../../src/store-core/kernel-view.js";
import { AssignPicker } from "../../screens/teammates/AssignPicker";
import { handEvidence } from "../../src/store-core/tasks.js";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Sheet } from "../components/Sheet";
import { Text } from "../components/Text";
import { Banner } from "../components/Banner";
import { showToast } from "../components/Toast";
import { useStore } from "../store";
import { haptic } from "../motion/haptics";
import { TaskFacts, DraftBlock } from "./TaskFacts";
import { cardFor, nameOf, recordTitle, STATE_LABEL, taskFacts, draftOf, stateTone, type World } from "./model";

type Task = any;
type Open =
  | { kind: "proof"; task: Task; id: "send" | "approve" | "yes" }
  | { kind: "edit"; task: Task }
  | { kind: "fix"; task: Task }
  | { kind: "reassign"; task: Task }
  | { kind: "file"; task: Task }
  | { kind: "task"; task: Task }
  | null;

const say = (e: unknown) => showToast(String((e as { message?: string })?.message || e || "Something went wrong."));

/**
 * What a task's buttons do, and the sheets they open (Face ID, edit the draft, fix, reassign, add the file, the task in place). One per screen: it returns
 * `run(task, id, input)` for a card's button and `sheets` to render once. Everything goes through the Store; the store's subscribers redraw the screen.
 * For a drafted item that leaves the space, one Face ID tap is the checker's approval and the Gate approval at once (store.decide), never a second card.
 */
export function useTaskActions(world: World | undefined, go: (path: string) => void) {
  const store = useStore();
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);

  const run = async (task: Task, id: string, input?: string) => {
    if (!world) return;
    const rec = world.records.get(task.record);
    try {
      if (id === "open") { setOpen({ kind: "task", task }); return; }
      if (id === "send" || id === "approve" || id === "yes") { setOpen({ kind: "proof", task, id }); return; }
      if (id === "edit") { setOpen({ kind: "edit", task }); return; }
      if (id === "fix") { setOpen({ kind: "fix", task }); return; }
      if (id === "reassign") { setOpen({ kind: "reassign", task }); return; }
      if (id === "file") { setOpen({ kind: "file", task }); return; }
      if (id === "done") { await store.submit(task.id, handEvidence(task), world.me); haptic.approve(); showToast(`Done: ${task.title}.`); return; }
      if (id === "no") { await store.submit(task.id, { decision: { answer: "no", reason: "Declined." } }, world.me); haptic.selection(); showToast(`Declined: ${task.title}.`); return; }
      if (id === "save") {
        const name = cardFor(world, task).inline?.name;
        if (!name || !rec || !String(input || "").trim()) { showToast("Enter a value first."); return; }
        await store.update(rec.urn, { [name]: String(input).trim() }, rec.version, world.me);
        await store.submit(task.id, {}, world.me);
        haptic.approve();
        showToast(`Saved. ${task.title} is done.`);
      }
    } catch (e) { say(e); }
  };

  const confirmProof = async (task: Task, id: "send" | "approve" | "yes") => {
    if (!world) return;
    const proof = simulatedProof({ decision: id === "yes" ? "approve" : id, payload_hash: `task:${task.id}`, now: world.now });
    const before = world.records.get(task.record)?.data?.stage;
    try {
      if (id === "yes") {
        await store.submit(task.id, { decision: { answer: "yes", reason: "Approved with Face ID." } }, world.me);
        haptic.approve();
        showToast(`Approved: ${task.title}.`);
      } else {
        await store.decide(task.id, { outcome: "approved", proof });
        const after = await store.get(task.record);
        const to = after?.data?.stage;
        haptic.approve();
        if (to && before && to !== before) setTimeout(haptic.stage, 180);
        const target = typeof task.output?.target === "string" ? task.output.target : task.title;
        showToast(`${id === "send" ? "Sent" : "Approved"}: ${target}.${to && before && to !== before ? ` ${recordTitle(world, after)} moved to ${to}.` : ""}`);
      }
      close();
    } catch (e) { say(e); }
  };

  const sheets = world ? <Sheets world={world} open={open} close={close} confirmProof={confirmProof} run={run} go={go} /> : null;
  return { run, sheets };
}

function Sheets({ world, open, close, confirmProof, run, go }: { world: World; open: Open; close: () => void; confirmProof: (t: Task, id: "send" | "approve" | "yes") => void; run: (t: Task, id: string, i?: string) => void; go: (p: string) => void }) {
  const store = useStore();
  const task = open?.task;
  const rec = task ? world.records.get(task.record) : undefined;
  return (
    <>
      <Sheet open={open?.kind === "proof"} onClose={close} title={open?.kind === "proof" && open.id === "approve" ? "Approve with Face ID" : open?.kind === "proof" && open.id === "yes" ? "Approve with Face ID" : open?.kind === "proof" && /payment/i.test(String(task?.output?.target)) ? "Pay with Face ID" : "Send with Face ID"}>
        {open?.kind === "proof" ? (
          <>
            <Text>{open.id === "send" ? `${typeof task.output?.target === "string" ? task.output.target : task.title} for ${recordTitle(world, rec)} leaves your space when you confirm.` : open.id === "approve" ? `${task.title} is checked and done when you confirm.` : `${task.title}. This is your approval to go ahead.`}</Text>
            <Text size="caption" tone="label">Face ID confirms it is you. In this preview a button stands in for it, and nothing is sent.</Text>
            <View className="flex-row flex-wrap justify-end gap-s2 pt-s2">
              <Button kind="ghost" label="Cancel" onPress={close} />
              <Button kind="primary" icon="faceid" label="Confirm with Face ID" onPress={() => confirmProof(task, open.id)} />
            </View>
          </>
        ) : null}
      </Sheet>
      <Sheet open={open?.kind === "edit"} onClose={close} title="Edit the draft">{open?.kind === "edit" ? <EditDraft task={task} close={close} me={world.me} /> : null}</Sheet>
      <Sheet open={open?.kind === "fix"} onClose={close} title="Fix what stopped it">
        {open?.kind === "fix" ? (
          <>
            <Banner tone="warn"><Text><Text strong>{nameOf(world, aid(task.doer))} stopped on {task.title}.</Text> {task.stuck?.reason}</Text></Banner>
            <Text>{task.stuck?.suggested_fix?.text || "Fix it, then tell Vyre."}</Text>
            <View className="flex-row flex-wrap justify-end gap-s2 pt-s2">
              {/vault/i.test(task.stuck?.suggested_fix?.text || "") ? <Button label="Open the Vault" onPress={() => { close(); go("/u/vault"); }} /> : null}
              <Button kind="primary" label="I fixed it" onPress={async () => {
                try { await store.reassign(task.id, aid(task.doer), world.me); showToast(`${nameOf(world, aid(task.doer))} is on it again.`); close(); } catch (e) { say(e); }
              }} />
            </View>
          </>
        ) : null}
      </Sheet>
      <AssignPicker open={open?.kind === "reassign"} onClose={close} title={open?.kind === "reassign" ? `Reassign ${task.title}` : "Assign to"} actors={world.actors} exclude={open?.kind === "reassign" ? [aid(task.doer)] : []} onPick={async (a) => {
        try { await store.reassign(task.id, a.id, world.me); showToast(`${task.title} is with ${a.name}.`); close(); } catch (e) { say(e); }
      }} />
      <Sheet open={open?.kind === "file"} onClose={close} title={open?.kind === "file" ? `Add: ${typeof task.output?.target === "string" ? task.output.target : "the file"}` : undefined}>
        {open?.kind === "file" ? <AddFile task={task} close={close} me={world.me} /> : null}
      </Sheet>
      <Sheet open={open?.kind === "task"} onClose={close} title={task?.title}>
        {open?.kind === "task" ? <TaskInPlace world={world} task={task} close={close} run={run} go={go} /> : null}
      </Sheet>
    </>
  );
}

function EditDraft({ task, close, me }: { task: Task; close: () => void; me: string }) {
  const store = useStore();
  const d = task.ext?.result?.draft || { body: "" };
  const [subject, setSubject] = useState<string>(d.subject ?? "");
  const [body, setBody] = useState<string>(d.body ?? "");
  return (
    <>
      {d.subject !== undefined ? <Field label="Subject" value={subject} onChangeText={setSubject} /> : null}
      <Field label="Message" value={body} onChangeText={setBody} multiline />
      <View className="flex-row flex-wrap justify-end gap-s2 pt-s2">
        <Button kind="ghost" label="Cancel" onPress={close} />
        <Button kind="primary" label="Save" onPress={async () => {
          try { await store.editTask(task.id, { draft: { ...d, ...(d.subject !== undefined ? { subject } : {}), body } } as never, me); showToast("Draft saved."); close(); } catch (e) { say(e); }
        }} />
      </View>
    </>
  );
}

function AddFile({ task, close, me }: { task: Task; close: () => void; me: string }) {
  const store = useStore();
  const [name, setName] = useState("");
  return (
    <>
      <Field label="File name" value={name} onChangeText={setName} placeholder={typeof task.output?.target === "string" ? task.output.target : "File"} />
      <View className="flex-row flex-wrap justify-end gap-s2 pt-s2">
        <Button kind="ghost" label="Cancel" onPress={close} />
        <Button kind="primary" label="Add" onPress={async () => {
          if (!name.trim()) { showToast("Name the file first."); return; }
          try { await store.submit(task.id, { file: { name: name.trim() } }, me); showToast(`Added ${name.trim()}.`); close(); } catch (e) { say(e); }
        }} />
      </View>
    </>
  );
}

/** The same task, in a sheet: its state, its facts, its draft, and the buttons it would have on the card. */
function TaskInPlace({ world, task, close, run, go }: { world: World; task: Task; close: () => void; run: (t: Task, id: string, i?: string) => void; go: (p: string) => void }) {
  const m = cardFor(world, task);
  const rec = world.records.get(task.record);
  const draft = draftOf(world, task);
  const titles = new Map(world.tasks.map((t) => [t.id, t.title] as [string, string]));
  return (
    <>
      <Text tone="muted">{m.why}</Text>
      <View className="flex-row flex-wrap gap-s2"><Chip tone={stateTone(task.state) as never}>{STATE_LABEL[task.state]}</Chip>{rec ? <Chip>{recordTitle(world, rec)}</Chip> : null}</View>
      <TaskFacts world={world} facts={taskFacts(world, task, { titles })} />
      {draft ? <DraftBlock draft={draft} /> : null}
      <View className="flex-row flex-wrap justify-end gap-s2 pt-s2">
        <Button kind="ghost" label="Open the task page" onPress={() => { close(); go(`/u/task/${task.id}`); }} />
        {m.actions.filter((a) => a.id !== "open" && a.id !== "save").map((a) => <Button key={a.id} kind={a.kind} icon={a.icon as never} label={a.label} onPress={() => { close(); setTimeout(() => run(task, a.id), 0); }} />)}
      </View>
    </>
  );
}
