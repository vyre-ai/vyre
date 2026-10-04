import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AskCard, Avatar, Button, Card, Chip, Divider, EmptyState, IconTile, Row, Tabs, Text, allowsMock, showToast, markRef } from "@vyre/ui";
import RealDrive from "./RealDrive";
import { Block, FaceIdSheet } from "../places/Page";
import { Frame } from "../places/Frame";
import { SpaceBadge } from "../places/badge";
import { useScope } from "../places/scope";
import { driveRepo, EDITORS, PROJECTS, type DriveFile, type Link } from "./data";
import { addLink, filesIn, LINK_DAYS, projectsIn, restore, revoke, versionsOf } from "./logic.js";

type Tab = "files" | "links" | "computer";

function SampleDriveScreen() {
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
    <View key={f.id} className="gap-s2 pb-s2">
      <Row dense lead={<IconTile name={f.sealed ? "sealed" : "file"} tone={f.sealed ? "warn" : "text-2"} badge={<SpaceBadge sp={f.sp} />} />} title={f.name}
        sub={`${PROJECTS[f.proj]}, ${f.size}, ${f.mod} by ${f.by}`}
        end={<Chip>{`v${f.ver}`}</Chip>} />
      <View className="gap-s2 pr-s4" style={{ paddingLeft: 60 }}>
        {f.att ? <View className="self-start"><Button kind="ghost" size="sm" icon="link" label={`Attached to ${f.att.title}`} onPress={() => router.push(`/u/record/${f.att!.id}` as never)} /></View> : null}
        {f.sealed ? <Text size="caption" tone="label">{`${f.note}. Kept away from assistants: they see "${f.name}" as on file, sealed.`}</Text> : null}
        <View className="flex-row flex-wrap gap-s2">
          <Button kind="ghost" size="sm" label={versions === f.id ? "Hide versions" : "Versions"} onPress={() => setVersions(versions === f.id ? null : f.id)} />
          {f.sealed ? <Button kind="ghost" size="sm" icon="faceid" label="Open" onPress={() => setFace({ kind: "open", id: f.id })} /> : <Button kind="ghost" size="sm" label="Share a link" onPress={() => setLinkFor(f.id)} />}
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
    <Frame title="Drive" sub="Files per space and project, kept with their versions." scope>
      <Tabs<Tab> value={tab} onChange={setTab} items={[["files", "Files"], ["links", "Shared links"], ["computer", "On this computer"]]} />
      {tab !== "computer" ? linkAsk : null}
      {tab === "files" ? (
        <>
          <View className="flex-row flex-wrap gap-s2">
            {["all", ...projects].map((p) => (
              <Chip key={p} selected={proj === p || (!projects.includes(proj) && p === "all")} onPress={() => setProj(p)}>{p === "all" ? "All projects" : PROJECTS[p]}</Chip>
            ))}
          </View>
          <Card flush>{shown.length ? shown.map((f, i) => <View key={f.id}>{i ? <Divider inset={60} /> : null}{fileRow(f)}</View>) : <EmptyState title="No files" body="Nothing in this space or project." />}</Card>
        </>
      ) : null}
      {tab === "links" ? (
        <Card flush>
          {links.length ? links.map((l, i) => (
            <View key={l.id}>{i ? <Divider /> : null}
              <Row dense lead={<IconTile name="share" tone="accent" />} title={l.name} sub={`vyre.run/s/${l.code}, expires in ${LINK_DAYS} days`}
                end={<><Button kind="ghost" size="sm" label="Copy" onPress={() => showToast("Link copied.")} /><Button kind="holdText" size="sm" label="Revoke" onPress={() => { setLinks((xs) => revoke(xs, l.id)); showToast("Link revoked. It stops working now."); }} /></>} />
            </View>
          )) : <EmptyState title="No shared links" body="A link needs your Face ID. Sealed files cannot be shared." />}
        </Card>
      ) : null}
      {tab === "computer" ? (
        <Card>
          <View className="gap-s4">
            <View className="flex-row flex-wrap items-center gap-s3">
              <IconTile name="laptop" tone="accent" />
              <View className="min-w-0 flex-1"><Text strong>{`Vyre Drive on ${mount.computer}`}</Text><Text size="caption" tone="label">{mounted ? "Mounted as a folder. Open it like any other." : "Not mounted."}</Text></View>
              <Button kind={mounted ? "ghost" : "primary"} size="sm" label={mounted ? "Unmount" : "Mount"} onPress={() => setMounted(!mounted)} />
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
    </Frame>
  );
}

/** The sample files in a mock build; the vyred's own folders everywhere else. */
export default function DriveScreen() {
  return allowsMock() ? <SampleDriveScreen /> : <RealDrive />;
}
