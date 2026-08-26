/*
 * Test dat uitgaande parameters samengevoegd worden als de app via de
 * netwerkbrug praat. Zonder dat stapelden tientallen berichten per seconde
 * zich op en kwam een faderbeweging seconden later aan.
 *
 *   node web/test-bridge-queue.js
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
const check = (ok, what) => {
  console.log((ok ? "  ok   " : "  FOUT ") + what);
  if (!ok) failures++;
};

const posts = [];
Object.defineProperty(global, "navigator", {
  configurable: true, writable: true, value: {clipboard: {}},
});
global.location = {protocol: "http:", hash: ""};
global.document = {
  createElement: () => ({style: {}, select() {}, click() {}, value: ""}),
  body: {appendChild() {}, removeChild() {}},
  head: null,
};
global.window = {};
global.fetch = (url, opt) => {
  if (url === "/status") {
    return Promise.resolve({json: () => Promise.resolve({
      transport: "bridge", connected: true, status: "verbonden", ip: "1.2.3.4",
      packets: 0, framing: 0,
    })});
  }
  if (String(url).startsWith("/recv")) return new Promise(() => {});   // blijft open
  if (url === "/midi") {
    posts.push(opt.body);
    return Promise.resolve({json: () => Promise.resolve({ok: true})});
  }
  return Promise.resolve({json: () => Promise.resolve({})});
};

new Function(fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8"))();
const B = () => global.window.AndroidBridge;

(async () => {
  await new Promise(r => setTimeout(r, 30));   // brug laten opstarten
  const st = JSON.parse(B().getStatus());
  check(st.connected === true, "brug in gebruik: " + st.status);

  // een faderbeweging: veel waarden voor dezelfde parameter, snel achter elkaar
  posts.length = 0;
  for (let v = 100; v <= 200; v += 5) B().sendNRPN(39, v, 0);
  await new Promise(r => setTimeout(r, 80));
  console.log("  verstuurde verzoeken:", posts.length);
  check(posts.length === 1, "21 waarden samengevoegd tot één verzoek");
  if (posts.length) {
    const lines = posts[0].split("\n");
    check(lines.length === 4, "vier berichten (parameter en waarde): " + lines.length);
    // laatste waarde 200 = 1 x 128 + 72
    check(lines[3] === "b02648", "de laatste waarde gaat mee (" + lines[3] + ")");
    check(lines[1] === "b06227", "parameternummer 39 blijft erbij (" + lines[1] + ")");
  }

  // twee verschillende parameters horen beide door te komen
  posts.length = 0;
  B().sendNRPN(39, 10, 0);
  B().sendNRPN(41, 20, 0);
  await new Promise(r => setTimeout(r, 80));
  const all = posts.join("\n").split("\n");
  check(all.filter(l => l === "b06227").length === 1, "parameter 39 erbij");
  check(all.filter(l => l === "b06229").length === 1, "parameter 41 erbij");

  console.log(failures ? "MISLUKT: " + failures + " fouten"
                       : "ALLE WACHTRIJ-TESTS GESLAAGD");
  process.exit(failures ? 1 : 0);
})();
