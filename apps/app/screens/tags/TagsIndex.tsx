import { useRouter } from "expo-router";
import { Card, EmptyState, ErrorState, LargeTitleScreen, LoadingState, Row, tallyTags, useRecordsWorld } from "@vyre/ui";
import { href } from "../../../../lib/tags.js";

/** /u/tags: every tag the Space's records carry, most used first. A row opens that tag's page, where it can be pinned to the sidebar as a saved filter. */
export function TagsIndex() {
  const router = useRouter();
  const { data: world, loading, error, reload } = useRecordsWorld();
  if (error && !world) return <ErrorState title="Tags did not load" reason={error.message} retry={reload} />;
  if (loading && !world) return <LargeTitleScreen title="Tags"><LoadingState rows={4} /></LargeTitleScreen>;
  const tags = world ? tallyTags(Object.values(world.byType).flat()) : [];
  return (
    <LargeTitleScreen title="Tags" own onRefresh={reload}>
      {tags.length === 0 ? <Card><EmptyState title="Nothing is tagged yet" body="Open a project, a contact, a task or a chat and press Add a tag. A tag is one word; the same word on different things finds them together." /></Card> : (
        <Card flush>{tags.map((t) => <Row key={t.tag} dense title={`#${t.tag}`} state={String(t.count)} chevron onPress={() => router.push(href(t.tag) as never)} />)}</Card>
      )}
    </LargeTitleScreen>
  );
}
