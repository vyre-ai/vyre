import { useEffect } from "react";
import { useLocalSearchParams } from "expo-router";
import { refreshVault, useVaultItem, useVaultItems } from "../../src/state/vault";
import { Screen } from "../../src/ui/Screen";
import { ItemDetail, NoItem } from "../../src/vault/views";

/** One vault item on a phone-width screen: values hidden, Reveal and Copy or the trust card. */
export default function VaultItemScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const items = useVaultItems();
  const item = useVaultItem(String(name));
  // Opened straight from a link: read the list first.
  useEffect(() => {
    if (!items) void refreshVault();
  }, [items]);
  return (
    <Screen title="Vault" back>
      {item ? <ItemDetail item={item} /> : <NoItem text={items ? "No such item in the vault" : " "} />}
    </Screen>
  );
}
