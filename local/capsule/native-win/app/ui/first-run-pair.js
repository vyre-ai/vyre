import { startPairing } from "./pair.js";
import { showSeed } from "./seed.js";
  let clear = null;
  const box = document.getElementById("seedbox");
  const seed = document.getElementById("seed"), err = document.getElementById("err");
  document.getElementById("pair").addEventListener("click", () => {
    err.textContent = "";
    startPairing({
      onSeed: async (s) => { clear = await showSeed(box, s); seed.textContent = "On your other Vyre, choose Add a Windows PC, then scan this or type the words."; },
      onEnd: () => { if (clear) { clear(); clear = null; } },
      onWaiting: (n) => { seed.textContent = "Found " + n + ". Check the window that opened."; },
      onError: (m) => { err.textContent = m; seed.textContent = ""; },
      onDone: () => {},
    });
  });
