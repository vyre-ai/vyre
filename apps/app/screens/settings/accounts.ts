import { callT as call } from "../../src/real/call-tool";
import { accountsSource } from "./accounts-source";

export const accounts = accountsSource(call);
