// Connections: the services Vyre is signed in to, the MCP servers behind the hub, Google, GitHub, and where each connection may be used. One page, one tab each.
import { useState } from "react";
import { View } from "react-native";
import { Tabs } from "@vyre/ui";
import { Frame } from "../places/Frame";
import RealAccess from "./RealAccess";
import RealAnyApp from "./RealAnyApp";
import RealCatalog from "./RealCatalog";
import RealGithub from "./RealGithub";
import RealGoogle from "./RealGoogle";
import RealMcp from "./RealMcp";

type Tab = "add" | "any" | "mcp" | "google" | "github" | "access";

export default function ConnectionsScreen() {
  const [tab, setTab] = useState<Tab>("add");
  return (
    <Frame title="Connections" sub="Services, servers and accounts Vyre can use.">
      <Tabs<Tab> value={tab} onChange={setTab} items={[["add", "Add"], ["any", "Any app"], ["mcp", "MCP"], ["google", "Google"], ["github", "GitHub"], ["access", "Access"]]} />
      <View>
        {tab === "add" ? <RealCatalog /> : null}
        {tab === "any" ? <RealAnyApp /> : null}
        {tab === "mcp" ? <RealMcp /> : null}
        {tab === "google" ? <RealGoogle /> : null}
        {tab === "github" ? <RealGithub /> : null}
        {tab === "access" ? <RealAccess /> : null}
      </View>
    </Frame>
  );
}
