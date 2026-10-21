import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Text } from "@vyre/ui";

/** A project's Site tab: the published site, opened on its own page. */
export function ProjectSite({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Card>
      <View className="gap-s3">
        <Text size="page" strong>Site</Text>
        <Text tone="label">This project's published site.</Text>
        <View className="self-start"><Button kind="secondary" size="sm" label="Open the site" onPress={() => router.push(`/u/sites/${encodeURIComponent(id)}` as never)} /></View>
      </View>
    </Card>
  );
}
