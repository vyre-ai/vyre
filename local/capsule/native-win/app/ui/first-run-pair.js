import { startPairing } from "./pair.js";
  const seed = document.getElementById("seed"), err = document.getElementById("err");
  document.getElementById("pair").addEventListener("click", () => {
    err.textContent = "";
    startPairing({
      onSeed: (s) => { seed.textContent = "On your other Vyre, add this computer and enter: " + s; },
      onWaiting: (n) => { seed.textContent = "Found " + n + ". Check the window that opened."; },
      onError: (m) => { err.textContent = m; seed.textContent = ""; },
      onDone: () => {},
    });
  });
