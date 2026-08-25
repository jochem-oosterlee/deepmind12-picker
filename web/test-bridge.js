/*
 * Test van de Web MIDI-verbindingslaag met een nagebootste MIDI-poort.
 * Controleert dat de pc-versie dumps net zo uitpakt als de Android-versie en
 * dat het terugschrijven van één globale instelling de rest ongemoeid laat.
 *
 *   node web/test-bridge.js
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
const check = (ok, what) => {
  console.log((ok ? "  ok   " : "  FOUT ") + what);
  if (!ok) failures++;
};

// ---------- nagebootste omgeving ----------
let sent = [];
const input = {};
const output = {name: "DeepMind12 MIDI 1", send: b => sent.push(Array.from(b))};

// Node heeft zelf een navigator-object dat niet overschreven mag worden
Object.defineProperty(global, "navigator", {
  configurable: true,
  writable: true,
  value: {
    requestMIDIAccess: () => Promise.resolve({
      inputs: new Map([["i", input]]),
      outputs: new Map([["o", output]]),
      onstatechange: null,
    }),
    clipboard: {writeText: () => Promise.resolve(), readText: () => Promise.resolve("")},
  },
});
global.document = {
  createElement: () => ({select() {}, style: {}, value: ""}),
  body: {appendChild() {}, removeChild() {}},
};
global.window = {};

new Function(fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8"))();
const B = () => global.window.AndroidBridge;

// ---------- hulpmiddelen ----------
function pack7(data) {
  const o = [];
  for (let i = 0; i < data.length; i += 7) {
    const chunk = data.slice(i, i + 7);
    let msbs = 0;
    chunk.forEach((b, j) => { if (b & 0x80) msbs |= (1 << j); });
    o.push(msbs, ...chunk.map(b => b & 0x7F));
  }
  return o;
}

function unpack7(src, off, end, max) {
  const o = [];
  let i = off;
  while (i < end && o.length < max) {
    const msbs = src[i++];
    for (let j = 0; j < 7 && i < end && o.length < max; j++) {
      o.push((src[i++] & 0x7F) | (((msbs >> j) & 1) << 7));
    }
  }
  return o;
}

const feed = bytes => input.onmidimessage({data: new Uint8Array(bytes)});
const sysex = (cmd, rest) => [0xF0, 0x00, 0x20, 0x32, 0x20, 0x00, cmd, ...rest, 0xF7];

function nameBlock(names) {
  const d = new Array(names.length * 16).fill(0);
  names.forEach((n, i) => {
    for (let c = 0; c < n.length && c < 16; c++) d[i * 16 + c] = n.charCodeAt(c);
  });
  return d;
}

// ---------- tests ----------
(async () => {
  await new Promise(r => setTimeout(r, 10)); // wacht op requestMIDIAccess

  console.log("verbinding:");
  const st = JSON.parse(B().getStatus());
  check(st.connected === true, "poort gevonden: " + st.status);
  check(typeof input.onmidimessage === "function", "ingang wordt beluisterd");

  console.log("preset kiezen:");
  sent = [];
  B().send(3, 41, 0);
  check(JSON.stringify(sent) === JSON.stringify([[176, 0, 0], [176, 32, 3], [192, 41]]),
    "bank D, programma 42: " + JSON.stringify(sent));

  console.log("parameter sturen (NRPN):");
  sent = [];
  B().sendNRPN(39, 200, 0);
  check(JSON.stringify(sent) === JSON.stringify(
    [[176, 99, 0], [176, 98, 39], [176, 6, 1], [176, 38, 72]]),
    "waarde 200 als 1×128 + 72: " + JSON.stringify(sent));

  console.log("banknamen ontvangen:");
  const names = Array.from({length: 128}, (_, i) => "Naam " + (i + 1) + " AB");
  feed(sysex(0x0B, [0x06, 0x02, ...pack7(nameBlock(names))]));
  const got = JSON.parse(B().libNames());
  check(got["C-0"] && got["C-0"][0] === "Naam 1 AB", "eerste naam");
  check(got["C-13"] && got["C-13"][0] === "Naam 14 AB", "veertiende naam");
  check(got["C-127"] && got["C-127"][0] === "Naam 128 AB", "laatste naam");
  check(Object.keys(got).length === 128, "alle 128 namen (" + Object.keys(got).length + ")");

  console.log("parameterwaarden van de synth volgen:");
  feed([0xB0, 99, 0]); feed([0xB0, 98, 41]); feed([0xB0, 6, 1]); feed([0xB0, 38, 3]);
  const pars = JSON.parse(B().libParams());
  check(pars && pars[41] === 131, "NRPN 41 = 131 (" + (pars ? pars[41] : "geen") + ")");
  feed([0xB0, 29, 127]); // CC-modus: filterfrequentie
  const pars2 = JSON.parse(B().libParams());
  check(pars2[39] === 255, "CC 29 omgerekend naar 255 (" + pars2[39] + ")");

  console.log("globale instellingen lezen en één byte terugschrijven:");
  const globals = Array.from({length: 45}, (_, i) => (i * 5) & 0xFF);
  feed(sysex(0x06, [0x06, ...pack7(globals)]));
  const g = JSON.parse(B().globals());
  check(g && g.bytes.length === 45, "45 bytes gelezen");
  check(JSON.stringify(g.bytes) === JSON.stringify(globals), "waarden gelijk aan wat is gestuurd");

  sent = [];
  const ok = B().writeGlobal(6, 200, 0);
  check(ok === true && sent.length === 1, "bericht verstuurd");
  const msg = sent[0];
  check(msg[6] === 0x06 && msg[7] === 0x06, "global dump response met versiebyte");
  const back = unpack7(msg, 8, msg.length - 1, 45);
  check(back[6] === 200, "byte #6 is nu 200 (" + back[6] + ")");
  let others = true;
  for (let i = 0; i < 45; i++) if (i !== 6 && back[i] !== globals[i]) others = false;
  check(others, "alle andere 44 bytes ongewijzigd");

  // tweede lezing: veranderde bytes moeten opvallen
  const changed = globals.slice();
  changed[12] = 9;
  feed(sysex(0x06, [0x06, ...pack7(changed)]));
  const g2 = JSON.parse(B().globals());
  check(JSON.stringify(g2.changed) === "[12]", "vergelijking wijst byte #12 aan: "
    + JSON.stringify(g2.changed));

  console.log(failures ? "MISLUKT: " + failures + " fouten" : "ALLE BRIDGE-TESTS GESLAAGD");
  process.exit(failures ? 1 : 0);
})();
