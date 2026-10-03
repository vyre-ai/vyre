import { ScrollView, View } from "react-native";
import { Banner, Button, Card, Chip, Divider, Field, IconButton, Row, Text, useAppearance } from "@vyre/ui";

export default function Appearance() {
  const { person, setPerson } = useAppearance();
  return (
    <ScrollView contentContainerClassName="gap-s4 p-s4 max-w-page w-full self-center">
      <Text size="page" strong>Appearance</Text>
      <View className="flex-row gap-s2 flex-wrap">
        <Button kind="primary" label="Primary" />
        <Button label="Secondary" />
        <Button kind="ghost" label="Ghost" />
        <Button kind="danger" label="Danger" />
        <Button kind="hold" label="Remove Alex's Mac" />
        <IconButton icon="search" label="Search" />
        <Button label="Dark" onPress={() => setPerson({ theme: "dark" })} />
        <Button label="Paper" onPress={() => setPerson({ theme: "paper" })} />
      </View>
      <View className="flex-row gap-s2"><Chip>Plain</Chip><Chip tone="accent">Needs you</Chip><Chip tone="ok">Done</Chip><Chip tone="sealed">Sealed</Chip></View>
      <Card title="Contacts" flush>
        <Row title="Jane Doe" sub="Harlow Legal" end={<Chip tone="accent">Intake</Chip>} onPress={() => {}} />
        <Divider />
        <Row title="Northwind Bakery" sub="Customer" onPress={() => {}} />
      </Card>
      <Card><Field label="Name" value="Alex" /><Text>{person.theme}</Text></Card>
      <Banner tone="warn">Something to look at.</Banner>
    </ScrollView>
  );
}
