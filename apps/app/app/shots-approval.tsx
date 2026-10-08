// Sample world only: the held group as a card (three emails), and its closing line, for the screenshot pass. Nothing is sent.
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ThemeProvider, Text, useUiTheme } from "@vyre/ui";
import { GroupApprovals } from "../screens/shell/GroupApprovals";

const mail = (id: string, who: string, name: string, body: string) => ({
  id, op: "mail.send", space: "juniper", title: `Email to ${name}`, line: `Email to ${name}`, group: "g1", payload_hash: `h-${id}`, fields: {}, partial: false, edited: false,
  words: [{ field: "to", text: who }, { field: "subject", text: "A reminder about your open invoice" }, { field: "body", text: body }],
});
const GROUP = [{
  id: "g1", line: "3 emails to Northwind, Oakline, Brightwell",
  items: [
    mail("a1", "accounts@northwind.example", "Northwind Bakery", "Hello,\n\nA friendly reminder that invoice 1042 for $2,600 is now 34 days past due. Could you let us know when we can expect payment?\n\nThank you,\nJuniper Studio"),
    mail("a2", "ap@oakline.example", "Oakline Dental", "Hello,\n\nInvoice 1051 for $900 was due on 4 September. If it has crossed with your payment, please ignore this note."),
    mail("a3", "billing@brightwell.example", "Brightwell Law", "Hello,\n\nInvoice 1038 for $1,700 is 41 days past due. We would be glad to set up a short call if that is easier."),
  ],
}] as never;

export default function ShotsApproval() {
  const q = useLocalSearchParams<{ done?: string }>();
  return (
    <ThemeProvider>
      <Page>
        <GroupApprovals sample={GROUP} {...(q.done === "1" ? { doneLine: "Sent 3 emails. Each is logged on its client." } : {})} />
      </Page>
    </ThemeProvider>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  const { color } = useUiTheme();
  return (
    <View style={{ flex: 1, backgroundColor: color["surface-1"], paddingTop: 24 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}><Text strong size="title">Waiting for you</Text></View>
      {children}
    </View>
  );
}
