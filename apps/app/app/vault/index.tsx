import { useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useRouter } from "expo-router";
import { refreshVault, useVaultError, useVaultItems, useVaultLocked } from "../../src/state/vault";
import { useTheme } from "../../src/theme/theme";
import { tokens } from "../../src/theme/tokens";
import { Empty, Screen } from "../../src/ui/Screen";
import { ItemDetail, NoItem, VaultList } from "../../src/vault/views";

/** Side by side from this width (README layout: detail beside the list from 900). */
const SPLIT = 900;

/**
 * The Vault place: names, kinds and sites from vault.list. Under 900 wide an item is a pushed
 * screen; from 900 it opens beside the list. Width only, never the platform.
 */
export default function Vault() {
  const items = useVaultItems();
  const error = useVaultError();
  const locked = useVaultLocked();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { color } = useTheme();
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    void refreshVault();
  }, []);
  const split = width >= SPLIT;
  const open = (name: string) => (split ? setPicked(name) : router.push({ pathname: "/vault/[name]", params: { name } }));

  let body;
  if (!items) body = <Empty text={error ? `The vault did not answer: ${error}` : " "} />;
  else if (items.length === 0) body = <Empty text={locked ? "The vault is locked on your home" : "Nothing in the vault yet"} />;
  else body = <VaultList items={items} onOpen={open} />;

  const item = split && picked ? items?.find((i) => i.name === picked) ?? null : null;
  return (
    <Screen title="Vault" back>
      {split ? (
        <View style={styles.split}>
          <View style={[styles.list, { borderRightColor: color.rule }]}>{body}</View>
          <View style={styles.pane}>{item ? <ItemDetail item={item} /> : <NoItem text={items?.length ? "Pick an item" : " "} />}</View>
        </View>
      ) : (
        body
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  split: { flex: 1, flexDirection: "row" },
  list: { width: tokens.layout.list, borderRightWidth: StyleSheet.hairlineWidth },
  pane: { flex: 1, minWidth: 0 },
});
