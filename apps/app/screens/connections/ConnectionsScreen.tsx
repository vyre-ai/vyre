// Connections: the services Vyre is signed in to, the MCP servers behind the hub, and where each connection may be used. Any service connects the same way (Any app); there is no tab per service.
import { useState } from "react";
import { View } from "react-native";
import { Tabs } from "@vyre/ui";
import { Frame } from "../places/Frame";
import RealAccess from "./RealAccess";
import RealAnyApp from "./RealAnyApp";
import RealCatalog from "./RealCatalog";
import RealConnected from "./RealConnected";
import RealMcp from "./RealMcp";
import RealMine from "./RealMine";
import RealSending from "./RealSending";
import { PlaceTag } from "../../src/real/PlaceTag";

type Tab = "all" | "add" | "any" | "mcp" | "access";

export default function ConnectionsScreen() {
  const [tab, setTab] = useState<Tab>("all");
  return (
    <Frame title="Connections" sub="Services, servers and accounts Vyre can use.">
      <PlaceTag of="home" />
      <Tabs<Tab> value={tab} onChange={setTab} items={[["all", "Connected"], ["add", "Add"], ["any", "Any app"], ["mcp", "MCP"], ["access", "Access"]]} />
      <View>
        {tab === "all" ? <><RealConnected open={setTab} /><RealSending /></> : null}
        {tab === "add" ? <RealCatalog /> : null}
        {tab === "any" ? <RealAnyApp /> : null}
        {tab === "mcp" ? <><RealMcp /><RealMine /></> : null}
        {tab === "access" ? <RealAccess /> : null}
      </View>
    </Frame>
  );
}
