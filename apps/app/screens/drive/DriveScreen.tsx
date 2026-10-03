import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AskCard, Avatar, Button, Card, Chip, Divider, EmptyState, Row, Tabs, Text, showToast, markRef } from "@vyre/ui";
import { Block, FaceIdSheet, IconTile, Page, SpaceChip } from "../places/Page";
import { useScope } from "../places/scope";
import { driveRepo, EDITORS, PROJECTS, type DriveFile, type Link } from "./data";
import { addLink, filesIn, LINK_DAYS, projectsIn, restore, revoke, versionsOf } from "./logic.js";

type Tab = "files" | "links" | "computer";

export default function DriveScreen() {
  const scope = useScope((s) => s.scope);
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("files");
  const [proj, setProj] = useState("all");
  const [files, setFiles] = useState<DriveFile[]>(() => driveRepo.files());
  const [links, setLinks] = useState<Link[]>(() => driveRepo.links());
  const [versions, setVersions] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [face, setFace] = useState<{ kind: "link" | "open"; id: string } | null>(null);
  const [mounted, setMounted] = useState(true);
  const mount = driveRepo.mount();
  const projects = projectsIn(files, scope);
  const shown = filesIn(files, scope, projects.includes(proj) ? proj : "all") as DriveFile[];
  const target = files.find((f) => f.id === (linkFor ?? face?.id));

  const linkAsk = target && linkFor ? (
    <AskCard lead={<Avatar of={markRef("assistant", "kit")} size={40} />} title={`Share ${target.name} with a link?`}
      why={`Anyone with the link can read it for ${LINK_DAYS} days. It is not sealed, so it can leave. You can revoke the link at any time.`}
      actions={[{ label: "Create link with Face ID", kind: "primary", icon: "faceid", onPress: () => setFace({ kind: "link", id: target.id }) }, { label: "Not now", kind: "ghost", onPress: () => setLinkFor(null) }]} />
  ) : null;

  const fileRow = (f: DriveFile) => (
    <View key={f.id} className="gap-s2 px-s3 py-s2">
      <Row lead={<IconTile icon={f.sealed ? "shield" : "file"} tone={f.sealed ? "warn" : "text-2"} />} title={f.name}
        sub={`${PROJECTS[f.proj]} · ${f.size} · ${f.mod} by ${f.by}`}
        end={<><SpaceChip sp={f.sp} /><Chip>{`v${f.ver}`}</Chip></>} />
      <View className="gap-s2 pl-s12">
        {f.att ? <View className="self-start"><Button kind="ghost" size="sm" icon="link" label={`Attached to ${f.att.title}`} onPress={() => router.push(`/u/record/${f.att!.id}` as never)} /></View> : null}
        {f.sealed ? <View className="flex-row items-center gap-s2"><Chip tone="sealed" icon="shield">Kept away from assistants</Chip><Text size="caption" tone="muted" className="min-w-0 flex-1">{f.note}. They see "{f.name}" as on file, sealed.</Text></View> : null}
        <View className="flex-row flex-wrap gap-s2">
          <Button kind="ghost" size="sm" label={versions === f.id ? "Hide versions" : "Versions"} onPress={() => setVersions(versions === f.id ? null : f.id)} />
          {f.sealed ? <Button size="sm" icon="faceid" label="Open" onPress={() => setFace({ kind: "open", id: f.id })} /> : <Button size="sm" label="Share a link" onPress={() => setLinkFor(f.id)} />}
        </View>
        {versions === f.id ? (
          <Card flush>
            {versionsOf(f, EDITORS).map((v, i) => (
              <View key={v.n}>{i ? <Divider /> : null}
                <Row title={`Version ${v.n}`} sub={v.line} end={v.current ? <Chip tone="ok">Current</Chip> : <Button size="sm" label="Restore" onPress={() => { setFiles((xs) => restore(xs, f.id, v.n)); showToast(`Restored version ${v.n} as a new version.`); }} />} />
              </View>
            ))}
          </Card>
        ) : null}
      </View>
    </View>
  );

  return (
    <Page title="Drive" sub="Files per space and project, kept with their versions.">
      <Tabs<Tab> value={tab} onChange={setTab} items={[["files", "Files"], ["links", "Shared links"], ["computer", "On this computer"]]} />
      {tab !== "computer" ? linkAsk : null}
      {tab === "files" ? (
        <>
          <View className="flex-row flex-wrap gap-s2">
            {["all", ...projects].map((p) => (
              <Button key={p} size="sm" kind={proj === p || (!projects.includes(proj) && p === "all") ? "primary" : "secondary"} label={p === "all" ? "All projects" : PROJECTS[p]} onPress={() => setProj(p)} />
            ))}
          </View>
          <Card flush>{shown.length ? shown.map((f, i) => <View key={f.id}>{i ? <Divider /> : null}{fileRow(f)}</View>) : <EmptyState title="No files" body="Nothing in this space or project." />}</Card>
        </>
      ) : null}
      {tab === "links" ? (
        <Card flush>
          {links.length ? links.map((l, i) => (
            <View key={l.id}>{i ? <Divider /> : null}
              <Row lead={<IconTile icon="share" tone="accent" />} title={l.name} sub={`vyre.run/s/${l.code} · expires in ${LINK_DAYS} days · created just now by you`}
                end={<><Button size="sm" label="Copy" onPress={() => showToast("Link copied.")} /><Button kind="danger" size="sm" label="Revoke" onPress={() => { setLinks((xs) => revoke(xs, l.id)); showToast("Link revoked. It stops working now."); }} /></>} />
            </View>
          )) : <EmptyState title="No shared links" body="A link needs your Face ID. Sealed files cannot be shared." />}
        </Card>
      ) : null}
      {tab === "computer" ? (
        <Card>
          <View className="gap-s4">
            <View className="flex-row flex-wrap items-center gap-s3">
              <IconTile icon="laptop" tone="accent" />
              <View className="min-w-0 flex-1"><Text strong>{`Vyre Drive on ${mount.computer}`}</Text><Text size="caption" tone="label">{mounted ? "Mounted as a folder. Open it like any other." : "Not mounted."}</Text></View>
              <Button kind={mounted ? "secondary" : "primary"} size="sm" label={mounted ? "Unmount" : "Mount"} onPress={() => setMounted(!mounted)} />
            </View>
            {mounted ? (
              <>
                <Block label="File manager, Vyre Drive">
                  {mount.folders.map((m) => <View key={m.path} className="flex-row items-center gap-s2 py-s1"><Text className="flex-1">{m.path}</Text><Text size="caption" tone="label">{m.count}</Text></View>)}
                  {mount.sealed.map((n) => <View key={n} className="flex-row items-center gap-s2 py-s1"><Text tone="warn" className="flex-1">{n}</Text><Text size="caption" tone="label">Opens with Face ID</Text></View>)}
                </Block>
                <Text tone="muted">Files you star stay on this computer for offline work. Sealed files are never copied to disk until you open them with Face ID. Assistants working on this computer see the same folders you do, minus sealed files.</Text>
              </>
            ) : null}
          </View>
        </Card>
      ) : null}
      <FaceIdSheet open={!!face} onClose={() => setFace(null)} title={face?.kind === "open" ? "Open with Face ID" : "Create link with Face ID"}
        body={face?.kind === "open" ? `${target?.name ?? "The file"} opens for you only. It is not copied to disk and assistants never see it.` : `The link for ${target?.name ?? "the file"} works for ${LINK_DAYS} days.`}
        confirm="Approve with Face ID"
        onConfirm={() => {
          if (face?.kind === "link" && target) { setLinks((xs) => addLink(xs, target)); setLinkFor(null); setTab("links"); showToast("Link created. It is in Shared links."); }
          else showToast(`Opened ${target?.name ?? "the file"}.`);
        }} />
    </Page>
  );
}
