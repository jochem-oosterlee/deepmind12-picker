/*
 * Voert de JavaScript uit index.html echt uit met een minimale DOM-nabootsing.
 * Vangt fouten die pas bij het opstarten opvallen (zoals variabelen die te
 * vroeg worden gebruikt) en klikt daarna elke knop en tab aan.
 */
const fs = require("fs");
const path = process.argv[2];
const html = fs.readFileSync(path, "utf8");
// alle scriptblokken, zodat ook de pc-versie (met verbindingslaag ervoor) werkt
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join("\n;\n");

const errors = [];
const elements = new Map();

function makeEl(id) {
  const el = {
    id,
    children: [],
    handlers: {},
    style: {},
    dataset: {},
    _text: "",
    _html: "",
    className: "",
    value: "",
    files: [],
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
    },
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parentEl = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this.parentEl) this.parentEl.removeChild(this); },
    querySelector() { return makeEl("sub"); },
    querySelectorAll() { return []; },
    focus() {}, select() {}, click() { this.fire("click"); },
    fire(ev, arg) {
      const e = arg || {stopPropagation() {}, preventDefault() {}, key: "", target: {}};
      for (const fn of this.handlers[ev] || []) fn(e);
      // de dialoogknoppen gebruiken onclick in plaats van addEventListener
      if (ev === "click" && typeof this.onclick === "function") this.onclick(e);
    },
    getBoundingClientRect() { return {top: 0, left: 0, width: 100, height: 20}; },
    setAttribute() {}, getAttribute() { return null; },
  };
  return el;
}

global.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  },
  createElement(tag) { const e = makeEl("new-" + tag); e.tagName = tag.toUpperCase(); return e; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
  body: makeEl("body"),
};
global.window = {
  set onerror(fn) { global.__onerror = fn; },
  get onerror() { return global.__onerror; },
};
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
};
global.alert = m => errors.push("alert: " + m);
global.confirm = () => true;
global.Blob = class {};
global.URL = {createObjectURL: () => "blob:x", revokeObjectURL() {}};

// nagebootste native laag
let sent = [];
let globalRev = 1, globalChanged = [6];
const globalBytes = Array.from({length: 45}, (_, i) => (i * 3) & 0xFF);
global.AndroidBridge = {
  getStatus: () => JSON.stringify({connected: true, status: "verbonden met FakeDM12",
    event: "", wifi: "WiFi verbonden: Deepmind12", wifiConnected: true, ip: "192.168.12.1"}),
  libStatus: () => JSON.stringify({names: 256, patches: 3, nameDumps: 2, patchDumps: 3,
    badNames: 0, curBank: 0, curProg: 5, iface: 2, dev: 0, editBuffer: true, paramRev: 7,
    info: "edit buffer ontvangen", pkts: 42, sysex: 2, sysexLen: 2353, segs: 10, framing: 0,
    globalRev: globalRev, rxCC: 12, rxPar: 3, rxLast: "par 39 = 200"}),
  globals: () => JSON.stringify({rev: globalRev, hadPrevious: true, changed: globalChanged,
    bytes: globalBytes}),
  requestGlobals: d => { sent.push(["reqGlobals", d]); return true; },
  discover: () => sent.push(["discover"]),
  log: () => JSON.stringify({rev: 3, lines: [
    {ms: 1756000000000, dir: "in", tag: "change", hex: "f00020322000060601",
     text: "global settings, 56 bytes — changed #06: 3 → 2"},
    {ms: 1756000001000, dir: "out", tag: "req", hex: "f0002032200005f7",
     text: "request global settings"},
  ]}),
  discovered: () => JSON.stringify({running: false, status: "1 apparaat gevonden",
    found: ["192.168.0.227 (DeepMind12)"]}),
  writeGlobal: (i, v, d) => { sent.push(["writeGlobal", i, v, d]); return true; },
  writeGlobalBlock: (json, d) => { sent.push(["writeGlobalBlock", JSON.parse(json).length, d]); return true; },
  libNames: () => JSON.stringify({"A-0": ["Blue Dolphin", 2, 1], "A-1": ["Bass Pong", 1, 0]}),
  libParams: () => JSON.stringify(Array.from({length: 242}, (_, i) => (i * 7) & 0xFF)),
  getWifiCreds: () => JSON.stringify({ssid: "Deepmind12", pw: "Passphrase"}),
  send: (b, p, c) => { sent.push(["prog", b, p, c]); return true; },
  sendCC: (cc, v, c) => { sent.push(["cc", cc, v, c]); return true; },
  sendNRPN: (n, v, c) => { sent.push(["nrpn", n, v, c]); return true; },
  appNotify: d => { sent.push(["notify", d]); return true; },
  panic: c => { sent.push(["panic", c]); return true; },
  setIp: ip => sent.push(["ip", ip]),
  connectWifi: (s, p) => sent.push(["wifi", s, p]),
  disconnectWifi: () => sent.push(["wifioff"]),
  requestBankNames: (b, d) => { sent.push(["reqNames", b, d]); return true; },
  requestProgram: (b, p, d) => { sent.push(["reqProg", b, p, d]); return true; },
  requestEditBuffer: d => { sent.push(["reqEdit", d]); return true; },
  patchToEditBuffer: (b, p, d) => { sent.push(["toEdit", b, p, d]); return true; },
  patchToSlot: (sb, sp, db, dp, d) => { sent.push(["toSlot", sb, sp, db, dp, d]); return true; },
  libSave: () => sent.push(["libSave"]),
  copyToClipboard: t => sent.push(["clip", t.length]),
  readClipboard: () => JSON.stringify({names: {"A-0": "Eigen naam"}, favs: ["A-2"], vals: {}}),
};

// één instelling voorzien van een bereik, om de weergave daarvan te controleren
// Ook een ingeklapt menu met een instelling erin: dan zijn er minder kaartjes
// gebouwd dan er instellingen zijn, wat het bijwerken niet mag verstoren.
global.localStorage.setItem("dm12.gmeta", JSON.stringify({
  groups: [{id: "g1", name: "MIDI", open: false, order: 1}], sets: [],
  bytes: {
    "3": {name: "Transpose", type: "range", from: -48, unit: "semitones"},
    "7": {name: "Hidden one", group: "g1"},
  },
}));

// script uitvoeren
try {
  new Function(script)();
} catch (e) {
  console.error("FOUT bij opstarten:", e.message);
  console.error(e.stack.split("\n").slice(0, 3).join("\n"));
  process.exit(1);
}
console.log("opstarten: ok");

// controleer dat de interface daadwerkelijk is opgebouwd
const tabs = document.getElementById("tabs");
const grid = document.getElementById("grid");
const bankTabs = document.getElementById("bankTabs");
console.log("tabs:", tabs.children.length, "| bankknoppen:", bankTabs.children.length,
            "| presets:", grid.children.length);
if (tabs.children.length < 5) { console.error("FOUT: tabs niet opgebouwd"); process.exit(1); }
if (!tabs.children.some(t => t.textContent === "Global")
    || !tabs.children.some(t => t.textContent === "Library")) {
  console.error("FOUT: Global-tab ontbreekt"); process.exit(1);
}
if (grid.children.length !== 128) { console.error("FOUT: presetraster niet opgebouwd"); process.exit(1); }

let rangeField = null;

// kaartjes zitten nu in rasters per menu, dus recursief tellen
function countCards(el) {
  let n = String(el.className || "").includes("gcard") ? 1 : 0;
  for (const c of el.children || []) n += countCards(c);
  return n;
}

// elke tab openen en de inhoud renderen
let failures = 0;
for (const t of [...tabs.children]) {
  sent = [];
  try {
    t.fire("click");
    const list = document.getElementById("paramList");
    const glist = document.getElementById("gList");
    const cards = countCards(glist);
    console.log("tab", JSON.stringify(t.textContent), "-> parameters:", list.children.length,
                t.textContent === "Global" ? "| globale instellingen: " + cards : "");
    // één instelling zit in een ingeklapt menu, dus 44 van de 45 zichtbaar
    if (t.textContent === "Global" && cards !== 44) {
      console.error("FOUT: globale instellingen niet gerenderd (" + cards + ")");
      failures++;
    }
  } catch (e) {
    console.error("FOUT in tab", t.textContent, ":", e.message);
    failures++;
  }
}

// een preset aanklikken
sent = [];
try {
  document.getElementById("tabs").children[0].fire("click");
  grid.children[3].fire("click");
  console.log("preset klik ->", JSON.stringify(sent[0]));
} catch (e) { console.error("FOUT bij preset klikken:", e.message); failures++; }

// alle knoppen in de kop en de bibliotheek
for (const id of ["gearBtn","ipBtn","wifiBtn","wifiOffBtn","notifyBtn","panicBtn",
                  "backupBtn","restoreBtn","scanNames","scanBankPatches","libSaveBtn",
                  "libExportBtn","readBtn","pushBtn","autoBtn","gReadBtn","gHelpBtn",
                  "findBtn","gWatchBtn","gExportBtn","gSnapBtn","gSnapRestore","themeBtn"]) {
  try {
    sent = [];
    document.getElementById(id).fire("click");
    console.log("knop", id, "-> ok", sent.length ? JSON.stringify(sent[0]) : "");
  } catch (e) { console.error("FOUT bij knop", id, ":", e.message); failures++; }
}

// een parameterregelaar verzetten (laatste param-tab is nog actief gerenderd)
try {
  const tabsArr = [...document.getElementById("tabs").children];
  tabsArr.find(t => t.textContent === "Filter").fire("click");
  const list = document.getElementById("paramList");
  const box = list.children[0];
  const range = box.children.find(c => c.type === "range");
  sent = [];
  range.value = 200;
  range.fire("input");
  range.fire("change");
  console.log("regelaar verzet ->", JSON.stringify(sent));
  if (!sent.some(s => s[0] === "nrpn")) { console.error("FOUT: geen NRPN verstuurd"); failures++; }
} catch (e) { console.error("FOUT bij regelaar:", e.message); failures++; }

// menu aanmaken via de eigen dialoog (asynchroon, dus met een tik wachten)
const globalTab = [...document.getElementById("tabs").children].find(t => t.textContent === "Global");
globalTab.fire("click");
const gBefore = document.getElementById("gList").children.length;
document.getElementById("gNewMenu").fire("click");
document.getElementById("modalInput").value = "MIDI-instellingen";
document.getElementById("modalYes").fire("click");

// labels invoeren op de snelle manier: waardes lopen automatisch van 0 op
function findIn(el, pred) {
  if (pred(el)) return el;
  for (const c of el.children || []) {
    const hit = findIn(c, pred);
    if (hit) return hit;
  }
  return null;
}

function testLabels() {
  const glist = document.getElementById("gList");
  const card = findIn(glist, e => String(e.className || "").includes("gcard"));
  if (!card) { console.error("FOUT: geen kaartje gevonden"); failures++; return; }
  const abc = findIn(card, e => e.textContent === "abc");
  if (!abc) { console.error("FOUT: labelknop ontbreekt"); failures++; return; }
  abc.fire("click");

  const card2 = findIn(document.getElementById("gList"),
    e => String(e.className || "").includes("gcard"));
  const inputs = [];
  (function walk(e) {
    if (e.className === "l") inputs.push(e);
    for (const c of e.children || []) walk(c);
  })(card2);
  console.log("labeleditor open, invoervelden:", inputs.length);
  // Tab moet van tekstveld naar tekstveld gaan, niet langs de kruisjes
  const crosses = [];
  (function walk(e) {
    if (e.textContent === "×") crosses.push(e);
    for (const c of e.children || []) walk(c);
  })(card2);
  const inOrder = crosses.filter(x => x.tabIndex !== -1);
  console.log("kruisjes buiten de tab-volgorde:", crosses.length - inOrder.length,
              "van", crosses.length);
  if (inOrder.length) {
    console.error("FOUT: Tab loopt langs de verwijderknoppen");
    failures++;
  }
  if (inputs.length < 2) { console.error("FOUT: labelregels ontbreken"); failures++; return; }
  inputs[0].value = "Rx";
  inputs[1].value = "Tx";
  const save = findIn(card2, e => e.textContent === "Save");
  if (!save) { console.error("FOUT: opslaanknop ontbreekt"); failures++; return; }
  save.fire("click");

  const stored = JSON.parse(localStorage.getItem("dm12.gmeta"));
  const labels = stored.bytes && stored.bytes["0"] && stored.bytes["0"].labels;
  console.log("opgeslagen labels:", JSON.stringify(labels));
  if (!labels || labels["0"] !== "Rx" || labels["1"] !== "Tx") {
    console.error("FOUT: labels niet bewaard met waardes 0 en 1");
    failures++;
  }
}

setTimeout(() => {
  const gAfter = document.getElementById("gList").children.length;
  console.log("menu aanmaken:", gBefore, "->", gAfter, "elementen in de lijst");
  if (gAfter <= gBefore) { console.error("FOUT: menu niet toegevoegd"); failures++; }
  if (countCards(document.getElementById("gList")) !== 44) {
    console.error("FOUT: instellingen kwijt na het aanmaken van een menu");
    failures++;
  }
  testLabels();

  // bereik-instelling: byte 3 is 9, met verschuiving -48 en eenheid
  const rangeCard = findIn(document.getElementById("gList"),
    e => e.dataset && String(e.dataset.byte) === "3");
  if (!rangeCard) { console.error("FOUT: kaartje #03 niet gevonden"); failures++; }
  else {
    const rv = findIn(rangeCard, e => e.className === "val");
    console.log("bereik-weergave #03:", JSON.stringify(rv.textContent));
    if (rv.textContent !== "-39 semitones") {
      console.error("FOUT: bereik niet als getal met eenheid weergegeven");
      failures++;
    }
  }

  // bereik instellen: -48 intikken mag niet terugspringen naar 0
  const byteCardOf = n => findIn(document.getElementById("gList"),
    e => e.dataset && String(e.dataset.byte) === String(n));
  let rc = byteCardOf(5);
  findIn(rc, e => e.textContent === "abc").fire("click");
  rc = byteCardOf(5);
  const modeBtn = findIn(rc, e => e.textContent === "number range");
  if (!modeBtn) { console.error("FOUT: bereik-knop ontbreekt"); failures++; }
  else {
    modeBtn.fire("click");
    rc = byteCardOf(5);
    rangeField = findIn(rc, e => e.className === "v");
    rangeField.value = "-48";
    rangeField.fire("input");
    const shown = findIn(byteCardOf(5), e => e.className === "val").textContent;
    console.log("bereik ingevuld: veld", JSON.stringify(rangeField.value),
                "| kaartje toont", JSON.stringify(shown));
    if (shown !== "-33") {
      console.error("FOUT: kaartje volgt de verschuiving niet (verwacht -33)");
      failures++;
    }
  }

  // LFO-paneel: vormknoppen en regelaars moeten de juiste parameters sturen
  const lfoTab = [...document.getElementById("tabs").children]
    .find(t => t.textContent === "LFO");
  lfoTab.fire("click");
  const plist = document.getElementById("paramList");
  const shapeBtns = [];
  (function walk(e) {
    if (e.dataset && e.dataset.shape !== undefined) shapeBtns.push(e);
    for (const c of e.children || []) walk(c);
  })(plist);
  console.log("LFO-panelen:", plist.children.length, "| vormknoppen:", shapeBtns.length);
  if (plist.children.length !== 2 || shapeBtns.length !== 14) {
    console.error("FOUT: LFO-panelen niet volledig opgebouwd");
    failures++;
  } else {
    sent = [];
    shapeBtns[2].fire("click");             // blokgolf op LFO 1 = parameter 2
    console.log("vorm gekozen ->", JSON.stringify(sent[0]));
    if (!sent.some(s => s[0] === "nrpn" && s[1] === 2 && s[2] === 2)) {
      console.error("FOUT: vormkeuze stuurt niet NRPN 2 = 2");
      failures++;
    }
    sent = [];
    shapeBtns[9].fire("click");             // tweede paneel: parameter 9
    console.log("vorm op LFO 2 ->", JSON.stringify(sent[0]));
    if (!sent.some(s => s[0] === "nrpn" && s[1] === 9)) {
      console.error("FOUT: LFO 2 stuurt niet naar parameter 9");
      failures++;
    }
    // verticale faders: vier per paneel (rate, slew, delay, spread)
    const vfs = [];
    (function walk(e) {
      if (String(e.className || "") === "vf") vfs.push(e);
      for (const c of e.children || []) walk(c);
    })(plist);
    console.log("verticale faders:", vfs.length);
    if (vfs.length !== 8) { console.error("FOUT: verwacht 8 faders"); failures++; }
    // rate-fader van LFO 1 verzetten moet parameter 0 sturen
    sent = [];
    const rateInput = findIn(vfs[0], e => e.type === "range");
    rateInput.value = 200;
    rateInput.fire("input");
    setTimeout(() => {}, 0);
  }

  // terug naar de Global-tab: de controles hieronder gaan daarover
  [...document.getElementById("tabs").children]
    .find(t => t.textContent === "Global").fire("click");

  // logboek openen en een regel uitklappen
  document.getElementById("logBtn").fire("click");
  const logList = document.getElementById("logList");
  console.log("logboek:", logList.children.length, "regels");
  if (logList.children.length !== 2) { console.error("FOUT: logregels ontbreken"); failures++; }
  else {
    logList.children[0].fire("click");
    const after = document.getElementById("logList").children.length;
    console.log("regel uitgeklapt -> " + after + " elementen (met ruwe bytes)");
    if (after !== 3) { console.error("FOUT: ruwe bytes niet uitgeklapt"); failures++; }
  }

  // Volgen mag de kaartjes niet herbouwen: dan raakt elk invoerveld en elke
  // open keuzelijst zijn focus kwijt bij iedere lezing.
  const glist = document.getElementById("gList");
  const card = findIn(glist, e => String(e.className || "").includes("gcard"));
  const valEl = findIn(card, e => e.className === "val");
  const before = valEl.textContent;
  globalBytes[0] = 99;
  globalChanged = [0];
  globalRev++;

  setTimeout(() => {
    const same = findIn(document.getElementById("gList"), e => e === card);
    console.log("na een nieuwe lezing:", same ? "zelfde kaartje" : "HERBOUWD",
                "| waarde", JSON.stringify(before), "->", JSON.stringify(valEl.textContent));
    if (!same) { console.error("FOUT: kaartjes herbouwd tijdens het volgen"); failures++; }
    if (valEl.textContent !== "99") {
      console.error("FOUT: waarde niet bijgewerkt zonder herbouw");
      failures++;
    }

    // het bereik-veld moet de lezing overleven, en bewaard zijn
    if (rangeField) {
      const stored = JSON.parse(localStorage.getItem("dm12.gmeta"));
      const from = stored.bytes && stored.bytes["5"] && stored.bytes["5"].from;
      console.log("bereik na een lezing: veld", JSON.stringify(rangeField.value),
                  "| bewaard als", from);
      if (rangeField.value !== "-48") {
        console.error("FOUT: ingevulde verschuiving teruggesprongen");
        failures++;
      }
      if (from !== -48) { console.error("FOUT: verschuiving niet bewaard"); failures++; }
    }

    if (global.__onerror && errors.length) console.log("meldingen:", errors);
    console.log(failures ? "MISLUKT: " + failures + " fouten" : "ALLE UI-TESTS GESLAAGD");
    process.exit(failures ? 1 : 0);
  }, 1800);
}, 20);
