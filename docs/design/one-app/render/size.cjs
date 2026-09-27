// Prints "w,h" for a board from its own $preview (so renders don't depend on canvas.json).
const fs = require("fs");
const s = fs.readFileSync(process.argv[2], "utf8");
const m = /"\$preview":\{"width":(\d+),"height":(\d+)\}/.exec(s);
console.log(m ? m[1] + "," + m[2] : "1440,900");
