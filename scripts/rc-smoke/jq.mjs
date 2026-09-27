// A small jq for rc-smoke: `node jq.mjs '<expression of d>'` reads JSON on stdin and prints the
// expression's value (strings as they are, the rest as JSON). Not JSON: prints __notjson__.
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => (s += c)).on("end", () => {
  let d;
  try { d = JSON.parse(s); } catch { process.stdout.write("__notjson__"); return; }
  let v;
  try { v = new Function("d", `return (${process.argv[2]});`)(d); } catch (e) { v = `__error__ ${e.message}`; }
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v ?? null));
});
