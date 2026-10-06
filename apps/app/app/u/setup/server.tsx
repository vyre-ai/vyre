import { InstallScreen } from "../../../screens/install/InstallScreen";

/** Set up My Cloud on the person's own server (SERVER_SETUP_ROUTE in screens/install/first-run.js): the question's second answer, and where "Add your own server" links to. */
export default function SetupServer() { return <InstallScreen start="server" />; }
