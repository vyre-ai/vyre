import { useMemo } from "react";
import { Banner, allowsMock } from "@vyre/ui";
import { Page } from "../places/Frame";
import { RealAi } from "./RealAgents";
import { AiAccountsList } from "./AccountsCard";
import { sampleAccounts } from "./accounts-mock";

/** AI accounts in a mock build: the same one list the real box draws, over sample rows. */
export function SampleAiScreen() {
  const source = useMemo(sampleAccounts, []);
  return (
    <Page title="AI accounts" back="/u/settings">
      <Banner>Nobody's work runs on someone else's account. In a shared space, your chats still use your accounts and count against your budget.</Banner>
      <AiAccountsList source={source} />
    </Page>
  );
}

/** The sample page in a mock build; the box's own accounts everywhere else. */
export function AiScreen() {
  return allowsMock() ? <SampleAiScreen /> : <RealAi />;
}
