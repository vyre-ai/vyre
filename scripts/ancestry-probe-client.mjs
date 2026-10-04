import net from "node:net";
const c = net.connect(process.argv[2]); c.on("connect", () => c.write(process.argv[3] + "\n")); c.on("data", () => {}); c.on("close", () => process.exit(0));
