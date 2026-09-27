import { Empty, Screen } from "../../src/ui/Screen";
import { useNeedsCount } from "../../src/state/needs";

export default function Now() {
  const count = useNeedsCount();
  return <Screen title="Now">{count === 0 ? <Empty text="Nothing needs you" /> : null}</Screen>;
}
