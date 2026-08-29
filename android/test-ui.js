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
    // tekst zetten gooit de kinderen eruit, net als in een browser
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    // classList werkt op className, net als in een browser: de app leest soms
    // het een en zet het ander
    classList: {
      _all() { return String(this._el.className || "").split(/\s+/).filter(Boolean); },
      _put(a) { this._el.className = a.join(" "); },
      add(c) { const a = this._all(); if (!a.includes(c)) { a.push(c); this._put(a); } },
      remove(c) { this._put(this._all().filter(x => x !== c)); },
      contains(c) { return this._all().includes(c); },
      toggle(c, on) {
        if (on === undefined) on = !this.contains(c);
        on ? this.add(c) : this.remove(c);
      },
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
    contains(other) {
      if (other === this) return true;
      for (const c of this.children || []) if (c.contains && c.contains(other)) return true;
      return false;
    },
  };
  el.classList._el = el;
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
global.location = {protocol: "http:", hash: "#lfo"};
global.history = {
  replaceState(_a, _b, url) { global.location.hash = String(url); },
};
global.window = {
  set onerror(fn) { global.__onerror = fn; },
  get onerror() { return global.__onerror; },
  addEventListener() {},
  location: global.location,
};
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
};
// een skin met filmstrips nabootsen: dan gebruikt de app het spritepad
const SKIN_VARS = {
  "--sprite-scale": "1.4",
  "--fader-img": 'url("fader.png")', "--fader-frames": "99",
  "--fader-w": "36px", "--fader-h": "75px",
  "--knob-img": 'url("knob.png")', "--knob-frames": "99",
  "--knob-w": "45px", "--knob-h": "45px",
  "--switch2-img": 'url("switch2.png")', "--switch2-frames": "2",
  "--switch2-w": "30px", "--switch2-h": "45px",
};
// met --no-skin draait dezelfde suite zonder filmstrips, zodat beide paden
// (getekende regelaars en afbeeldingen) gedekt zijn
const NO_SKIN = process.argv.includes("--no-skin");
global.getComputedStyle = () => ({
  getPropertyValue: k => (NO_SKIN ? "" : (SKIN_VARS[k] || "")),
});

global.alert = m => errors.push("alert: " + m);
global.confirm = () => true;
global.Blob = class {};
global.URL = {createObjectURL: () => "blob:x", revokeObjectURL() {}};

// nagebootste native laag
let sent = [];
let globalRev = 1, globalChanged = [6];
let paramRev = 7;
let curProg = 5;   // welk programma de synth zegt te spelen
let reqEdits = 0;  // hoe vaak de app de inhoud opnieuw opvroeg
const paramBytes = Array.from({length: 242}, (_, i) => (i * 7) & 0xFF);
const globalBytes = Array.from({length: 45}, (_, i) => (i * 3) & 0xFF);
global.AndroidBridge = {
  getStatus: () => JSON.stringify({connected: true, status: "verbonden met FakeDM12",
    event: "", wifi: "WiFi verbonden: Deepmind12", wifiConnected: true, ip: "192.168.12.1"}),
  libStatus: () => JSON.stringify({names: 256, patches: 3, nameDumps: 2, patchDumps: 3,
    badNames: 0, curBank: 0, curProg: curProg, iface: 2, dev: 0, editBuffer: true, paramRev: paramRev,
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
  libParams: () => JSON.stringify(paramBytes),
  getWifiCreds: () => JSON.stringify({ssid: "Deepmind12", pw: "Passphrase"}),
  send: (b, p, c) => { sent.push(["prog", b, p, c]); return true; },
  sendCC: (cc, v, c) => { sent.push(["cc", cc, v, c]); return true; },
  // de nagebootste synth neemt over wat de app stuurt, net als het apparaat
  sendNRPN: (n, v, c) => { sent.push(["nrpn", n, v, c]);
    if (n < paramBytes.length) { paramBytes[n] = v & 0xFF; paramRev++; }
    return true; },
  appNotify: d => { sent.push(["notify", d]); return true; },
  panic: c => { sent.push(["panic", c]); return true; },
  setIp: ip => sent.push(["ip", ip]),
  connectWifi: (s, p) => sent.push(["wifi", s, p]),
  disconnectWifi: () => sent.push(["wifioff"]),
  requestBankNames: (b, d) => { sent.push(["reqNames", b, d]); return true; },
  requestProgram: (b, p, d) => { sent.push(["reqProg", b, p, d]); return true; },
  requestEditBuffer: d => { sent.push(["reqEdit", d]); reqEdits++; return true; },
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

// de tab uit de url moet gekozen zijn, zodat F5 op dezelfde pagina blijft
{
  const sel = document.getElementById("tabs").children.find(t =>
    String(t.className || "").includes("sel"));
  console.log("tab uit de url (#lfo):", sel ? sel.textContent : "geen");
  if (!sel || sel.textContent !== "LFO") {
    console.error("FOUT: tab niet uit de url overgenomen");
    process.exit(1);
  }
}

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
// de url zette ons op de LFO-tab; voor de rest van de controles naar Presets
tabs.children.find(t => t.textContent === "Presets").fire("click");
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
  tabsArr.find(t => t.textContent === "Mod").fire("click");
  const list = document.getElementById("paramList");
  sent = [];
  // met een skin zijn het draaiknoppen, zonder skin schuifregelaars
  const knob = findIn(list, e => String(e.className || "") === "sprite");
  if (knob) {
    knob.fire("pointerdown", {clientY: 200, preventDefault() {}, pointerId: 3});
    knob.fire("pointermove", {clientY: 150, preventDefault() {}, shiftKey: false});
    knob.fire("pointerup", {});
    console.log("draaiknop verzet ->", JSON.stringify(sent[sent.length - 1]));
  } else {
    const range = findIn(list, e => e.type === "range");
    range.value = 200;
    range.fire("input");
    range.fire("change");
    console.log("regelaar verzet ->", JSON.stringify(sent));
  }
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

  const plist = document.getElementById("paramList");

  const collect = (root, pred) => {
    const out = [];
    (function walk(e) {
      if (pred(e)) out.push(e);
      for (const c of e.children || []) walk(c);
    })(root);
    return out;
  };

  const lfoTab = [...document.getElementById("tabs").children]
    .find(t => t.textContent === "LFO");
  const pwmChecks = [];
  const envChecks = [];
  let fxCheck = null;
  let bendCheck = null;
  const progChecks = [];

  // ---- oscillatorpanelen, volgens het ontwerp ----
  {
    [...document.getElementById("tabs").children]
      .find(t => t.textContent === "OSC").fire("click");
    const op = document.getElementById("paramList");
    const panels = op.children.filter(e => String(e.className || "") === "pnl");
    const nameOf = pn => {
      const n = collect(pn, e => String(e.className || "") === "name")[0];
      return n ? n.textContent : "geen";
    };
    const count = (pn, cls) => collect(pn,
      e => String(e.className || "").split(" ").includes(cls)).length;

    console.log("panelen:", panels.map(nameOf).join(" + "));
    if (panels.length !== 2 || nameOf(panels[0]) !== "OSC 1"
        || nameOf(panels[1]) !== "OSC 2") {
      console.error("FOUT: de twee oscillatorpanelen staan er niet");
      failures++;
    } else {
      const one = panels[0], two = panels[1];
      const shape = pn => [count(pn, "lfader"), count(pn, "pick"),
                           count(pn, "seg"), count(pn, "dial"),
                           count(pn, "sw"), count(pn, "hbtn")].join("/");
      console.log("OSC 1 fader/pick/seg/dial/sw/kop:", shape(one),
                  "| OSC 2:", shape(two));
      if (shape(one) !== "2/2/2/2/1/2") {
        console.error("FOUT: OSC 1 heeft niet de regelaars uit het ontwerp");
        failures++;
      }
      if (shape(two) !== "4/2/1/2/0/1") {
        console.error("FOUT: OSC 2 heeft niet de regelaars uit het ontwerp");
        failures++;
      }

      // een stand kiezen in de balk, en die moet oplichten
      const seg = collect(one, e => String(e.className || "").split(" ").includes("seg"))[0];
      sent = [];
      seg.children[2].fire("click");                 // 4'
      const segMsg = sent.filter(x => x[0] === "nrpn" && x[1] === 14).pop();
      const litSeg = seg.children.filter(c => c.classList.contains("on"));
      console.log("range:", JSON.stringify(segMsg), "| opgelicht:",
                  litSeg.map(c => c.textContent).join(","));
      if (!segMsg || segMsg[2] !== 2 || litSeg.length !== 1
          || litSeg[0] !== seg.children[2]) {
        console.error("FOUT: de gekozen stand licht niet als enige op");
        failures++;
      }

      // p.mod mode staat in het ontwerp met OSC 1 vooraan; dat is waarde 1
      const segs = collect(one, e => String(e.className || "").split(" ").includes("seg"));
      const amber = segs[1];
      sent = [];
      amber.children[0].fire("click");
      const amberMsg = sent.filter(x => x[0] === "nrpn" && x[1] === 38).pop();
      console.log("p.mod mode ->", JSON.stringify(amberMsg),
                  "(" + amber.children.map(c => c.textContent).join(" | ") + ")");
      if (!amberMsg || amberMsg[2] !== 1) {
        console.error("FOUT: OSC 1 in P.mod mode stuurt niet waarde 1");
        failures++;
      }

      // knop in de kop, draaiknop en schakelaar
      sent = [];
      collect(one, e => String(e.className || "").split(" ").includes("hbtn"))[0].fire("click");
      const sawMsg = sent.filter(x => x[0] === "nrpn" && x[1] === 19).pop();
      sent = [];
      const d = collect(one, e => String(e.className || "").split(" ").includes("dial"))[0];
      d.fire("pointerdown", {clientY: 200, preventDefault() {}, pointerId: 9});
      d.fire("pointermove", {clientY: 150, preventDefault() {}, shiftKey: false});
      d.fire("pointerup", {});
      const dialMsg = sent.filter(x => x[0] === "nrpn" && x[1] === 23).pop();
      sent = [];
      collect(one, e => String(e.className || "").split(" ").includes("sw"))[0].fire("click");
      const swMsg = sent.filter(x => x[0] === "nrpn" && x[1] === 92).pop();
      console.log("kop:", JSON.stringify(sawMsg), "| knop:", JSON.stringify(dialMsg),
                  "| schakelaar:", JSON.stringify(swMsg));
      if (!sawMsg || !dialMsg || !swMsg) {
        console.error("FOUT: koptoets, draaiknop of schakelaar stuurt niets");
        failures++;
      }
      if (dialMsg && dialMsg[2] === 0) {
        console.error("FOUT: de draaiknop komt niet van zijn plaats");
        failures++;
      }

      // de pulsknop tekent de breedte die PWM nu heeft
      const pulseBtn = () => collect(document.getElementById("paramList"),
        e => String(e.className || "").split(" ").includes("hbtn"))
        .find(b => String(b.title).indexOf("Pulse") === 0);
      const edges = () => {
        const m = String(pulseBtn()._html || "").match(/points="([^"]+)"/g) || [];
        return m.map(g => g.match(/([0-9.]+),1 /) ? RegExp.$1 : "?");
      };
      paramBytes[25] = 0; paramBytes[16] = 0; paramRev++;
      const wide = () => String(pulseBtn()._html || "");
      const before = wide();
      paramBytes[25] = 250; paramRev++;
      pwmChecks.push(() => {
        const after = wide();
        console.log("pulsknop: bij PWM 0 en bij PWM 250 dezelfde tekening?",
                    after === before ? "ja (FOUT)" : "nee");
        if (after === before) {
          console.error("FOUT: de pulsknop volgt de PWM-waarde niet");
          failures++;
        }
        if ((after.match(/polyline/g) || []).length !== 1) {
          console.error("FOUT: met bron Manual hoort er één blokgolf te staan");
          failures++;
        }
      });

      // wat in een paneel staat, hoort er niet nog eens onder te staan
      const doubles = collect(op, e => panels.indexOf(e) === -1
        && ["PWM depth", "Oscillator 1", "Oscillator 2", "Pitch mod range", "Level"]
             .some(t => String(e.textContent) === t));
      console.log("dubbel getoond:", doubles.length,
                  doubles.map(e => e.textContent).join(", "));
      if (doubles.length) {
        console.error("FOUT: paneelparameters staan er ook nog los onder");
        failures++;
      }
    }
    lfoTab.fire("click");            // terug, de rest van de test gaat over LFO
  }
  // ---- alles op een tab ----
  {
    [...document.getElementById("tabs").children]
      .find(t => t.textContent === "Panel").fire("click");
    const ap = document.getElementById("paramList");
    const names = ap.children.map(pn => {
      const n = collect(pn, e => String(e.className || "") === "name")[0];
      return n ? n.textContent : "?";
    });
    console.log("paneeltab:", names.join(" "));
    const want = "LFO 1 LFO 2 OSC 1 OSC 2 VCF VCA HPF VCA ENV VCF ENV MOD ENV";
    if (names.join(" ") !== want) {
      console.error("FOUT: de panelen staan niet in de volgorde van het signaal");
      failures++;
    }
    const lanes = collect(ap, e => String(e.className || "").includes("lfader")).length;
    console.log("faders op de paneeltab:", lanes);
    if (lanes < 30) {
      console.error("FOUT: er ontbreken faders op de paneeltab");
      failures++;
    }
  }

  // ---- stemgedrag en stemming ----
  {
    [...document.getElementById("tabs").children]
      .find(t => t.textContent === "Voice").fire("click");
    const vp = document.getElementById("paramList");
    const cl4 = (e, c) => String(e.className || "").split(" ").includes(c);
    const panels = vp.children.filter(e => cl4(e, "pnl"));
    const names = panels.map(pn => {
      const n = collect(pn, e => String(e.className || "") === "name")[0];
      return n ? n.textContent : "?";
    });
    const caps = pn => collect(pn, e => String(e.className || "") === "vcap")
      .map(e => e.textContent);
    console.log("voice-tab:", names.join(" + "), "|", caps(panels[0]).join(", "),
                "|", caps(panels[1]).join(", "));
    if (names.join(" + ") !== "VOICE / PORTA + TUNE / DRIFT"
        || caps(panels[0]).join() !== "DETUNE,PORTA TIME,PORTA BAL"
        || caps(panels[1]).join() !== "GLOBAL,TRANS,BEND+,BEND-,OSC,PARAM,RATE") {
      console.error("FOUT: de voice-panelen staan er niet zoals ontworpen");
      failures++;
    } else {
      // stembuiging loopt van -24 tot +24, met teken in de byte
      {
        const bend = nm => collect(panels[1], e => String(e.className || "") === "vf")
          .find(b => caps(b)[0] === nm);
        // bend+ heeft -24 onderin, bend- juist +24 onderin
        [["BEND+", 36, 232, 24, "-24", "24"],
         ["BEND-", 37, 232, 24, "24", "-24"]].forEach(([nm, par, lo, hi, loT, hiT]) => {
          const box = bend(nm);
          const lane = collect(box, e => String(e.className || "").includes("lfader"))[0];
          const num = collect(box, e => String(e.className || "") === "vnum")[0];
          sent = [];
          lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 3});
          lane.fire("pointermove", {clientY: 900, preventDefault() {}, shiftKey: false});
          lane.fire("pointerup", {});
          const bottom = sent.filter(x => x[0] === "nrpn" && x[1] === par).pop();
          const bottomText = num.textContent;
          sent = [];
          lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 3});
          lane.fire("pointermove", {clientY: -900, preventDefault() {}, shiftKey: false});
          lane.fire("pointerup", {});
          const top = sent.filter(x => x[0] === "nrpn" && x[1] === par).pop();
          console.log(nm, "onderaan:", bottomText, "=", bottom && bottom[2],
                      "| bovenaan:", num.textContent, "=", top && top[2]);
          if (!bottom || bottom[2] !== lo || !top || top[2] !== hi) {
            console.error("FOUT: " + nm + " stuurt niet de bytes met teken");
            failures++;
          }
          if (bottomText !== loT || num.textContent !== hiT) {
            console.error("FOUT: " + nm + " toont niet -24 tot 24");
            failures++;
          }
        });
      }

      // een waarde buiten de schaal (uit het apparaat) hoort aan het uiteinde
      // te blijven staan, niet erbuiten
      {
        paramBytes[37] = 43;          // -43 zou buiten -24..24 vallen
        paramRev++;
        bendCheck = () => {
          const box = collect(document.getElementById("paramList"),
            e => String(e.className || "") === "vf")
            .find(b => collect(b, x => String(x.className || "") === "vcap")
                         .some(c => c.textContent === "BEND-"));
          const num = collect(box, e => String(e.className || "") === "vnum")[0];
          console.log("byte 43 buiten de schaal toont:", num.textContent);
          if (num.textContent !== "-24") {
            console.error("FOUT: een waarde buiten de schaal wordt niet begrensd");
            failures++;
          }
        };
      }

      // een waarde intikken: klikken, typen, enter
      {
        const box = collect(panels[1], e => String(e.className || "") === "vf")
          .find(b => caps(b)[0] === "TRANS");
        const num = collect(box, e => String(e.className || "") === "vnum")[0];
        sent = [];
        num.fire("click");
        const input = num.children[0];
        console.log("invoervak geopend:", input ? input.tagName : "geen",
                    "| begint op", input ? JSON.stringify(input.value) : "-");
        if (!input) {
          console.error("FOUT: klikken op een waarde opent geen invoervak");
          failures++;
        } else {
          input.value = "-12";
          input.fire("keydown", {key: "Enter", stopPropagation() {}});
          const m = sent.filter(x => x[0] === "nrpn" && x[1] === 241).pop();
          console.log("ingetikt -12 ->", JSON.stringify(m), "| toont", num.textContent);
          if (!m || m[2] !== 116 || num.textContent !== "-12") {
            console.error("FOUT: de ingetikte waarde komt niet goed aan");
            failures++;
          }
          if (num.children.length) {
            console.error("FOUT: het invoervak blijft open staan");
            failures++;
          }
        }
        // escape laat de waarde staan
        const before = num.textContent;
        num.fire("click");
        const inp2 = num.children[0];
        sent = [];
        inp2.value = "40";
        inp2.fire("keydown", {key: "Escape", stopPropagation() {}});
        console.log("escape:", JSON.stringify(before), "->", JSON.stringify(num.textContent));
        if (num.textContent !== before || sent.length) {
          console.error("FOUT: escape zet toch iets");
          failures++;
        }
      }

      // alles moet binnen het paneel passen: breedte tegen de inhoud
      {
        const w = parseInt(panels[1].style.width, 10);
        const fads = collect(panels[1], e => String(e.className || "") === "vf").length;
        console.log("tune-paneel:", w + "px voor", fads, "faders");
        if (!(w >= 400)) {
          console.error("FOUT: het tune-paneel is te smal voor zeven faders");
          failures++;
        }
      }

      // transpose telt van -48 tot +48, met 128 in het midden
      const box = collect(panels[1], e => String(e.className || "") === "vf")
        .find(b => caps(b)[0] === "TRANS");
      const lane = collect(box, e => String(e.className || "").includes("lfader"))[0];
      const num = collect(box, e => String(e.className || "") === "vnum")[0];
      sent = [];
      lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 7});
      lane.fire("pointermove", {clientY: -900, preventDefault() {}, shiftKey: false});
      lane.fire("pointerup", {});
      const top = sent.filter(x => x[0] === "nrpn" && x[1] === 241).pop();
      console.log("transpose helemaal omhoog ->", JSON.stringify(top), "toont", num.textContent);
      if (!top || top[2] !== 176 || num.textContent !== "48") {
        console.error("FOUT: transpose loopt niet van -48 tot +48");
        failures++;
      }
    }
  }

  // ---- envelopepanelen ----
  {
    [...document.getElementById("tabs").children]
      .find(t => t.textContent === "Env").fire("click");
    const ep = document.getElementById("paramList");
    const cl2 = (e, c) => String(e.className || "").split(" ").includes(c);
    const names = ep.children.map(pn => {
      const n = collect(pn, e => String(e.className || "") === "name")[0];
      return n ? n.textContent : "?";
    });
    const one = ep.children[0];
    const shape = [collect(one, e => cl2(e, "lfader")).length,
                   collect(one, e => cl2(e, "dial")).length,
                   collect(one, e => cl2(e, "pick")).length].join("/");
    console.log("envelopes:", names.join(" + "), "| fader/knop/keuze:", shape);
    if (names.join() !== "VCA ENV,VCF ENV,MOD ENV" || shape !== "4/4/1") {
      console.error("FOUT: de envelopepanelen staan er niet zoals ontworpen");
      failures++;
    } else {
      // de tekening moet meebewegen met de tijden én met de curves
      const svg = () => String(collect(one, e => cl2(e, "wavebox"))[0]._html || "");
      const before = svg();
      const dials = collect(one, e => cl2(e, "dial"));
      dials[0].fire("pointerdown", {clientY: 200, preventDefault() {}, pointerId: 8});
      dials[0].fire("pointermove", {clientY: 140, preventDefault() {}, shiftKey: false});
      dials[0].fire("pointerup", {});
      const afterCurve = svg();
      const lane = collect(one, e => cl2(e, "lfader"))[0];
      lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 9});
      lane.fire("pointermove", {clientY: 240, preventDefault() {}, shiftKey: false});
      lane.fire("pointerup", {});
      console.log("tekening verandert door de curve:", afterCurve !== before,
                  "| en door de attack:", svg() !== afterCurve);
      if (afterCurve === before) {
        console.error("FOUT: de curve-knop tekent de envelope niet opnieuw");
        failures++;
      }
      if (svg() === afterCurve) {
        console.error("FOUT: de attack-fader tekent de envelope niet opnieuw");
        failures++;
      }
      // hoe je de curves ook zet, de lijn hoort binnen het vak te blijven
      const outside = () => {
        const d = (svg().match(/ d="([^"]+)"/) || ["", ""])[1];
        const nums = (d.match(/-?[0-9.]+/g) || []).map(Number);
        const bad = [];
        for (let i = 0; i + 1 < nums.length; i += 2) {
          if (nums[i] < -0.5 || nums[i] > 264.5) bad.push("x=" + nums[i]);
          if (nums[i + 1] < 3.5 || nums[i + 1] > 44.5) bad.push("y=" + nums[i + 1]);
        }
        return bad;
      };
      let worst = [];
      // alle uitersten door elkaar: curves op nul en vol, houdniveau laag en hoog
      [[0, 0], [0, 255], [255, 0], [255, 255]].forEach(([v, sus]) => {
        [5, 6, 7, 8].forEach(off => { paramBytes[53 + off] = v; });
        paramBytes[55] = sus;
        paramRev++;
        envChecks.push(() => {
          const bad = outside();
          if (bad.length) worst = worst.concat(bad);
        });
      });
      envChecks.push(() => {
        // en hij hoort het vak ook helemaal te vullen
      const span = () => {
        const d = (svg().match(/ d="([^"]+)"/) || ["", ""])[1];
        const n = (d.match(/-?[0-9.]+/g) || []).map(Number);
        const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
        return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      };
      // de wijzer staat op nul linksonder en gaat langs de top naar rechtsonder
      {
        const d0 = collect(one, e => cl2(e, "dial"))[0];
        const needle = d0.children[0];
        const shown = +collect(d0.parentEl, e => cl2(e, "num"))[0].textContent;
        const m = String(needle.style.transform || "").match(/-?[0-9.]+/);
        const angle = m ? +m[0] : null;
        const want = -135 + (shown / 255) * 270;
        console.log("knopwijzer bij", shown, "staat op", angle,
                    "graden (verwacht", want.toFixed(1) + ")");
        if (angle === null || Math.abs(angle - want) > 0.6) {
          console.error("FOUT: de wijzer staat niet waar hij hoort");
          failures++;
        }
      }

      // dubbelklik op een knop zet hem in het midden
      {
        const dS = collect(one, e => cl2(e, "dial"))[2];      // de sustain-curve
        sent = [];
        dS.fire("dblclick");
        const m = sent.filter(x => x[0] === "nrpn" && x[1] === 60).pop();
        console.log("dubbelklik op S CURVE ->", JSON.stringify(m));
        if (!m || m[2] !== 128) {
          console.error("FOUT: dubbelklik zet de knop niet op 128");
          failures++;
        }
      }

      // aanslag, verval en release mogen elk hoogstens een kwart pakken
      [53, 54, 56].forEach(n => { paramBytes[n] = 255; });
      [5, 6, 7, 8].forEach(off => { paramBytes[53 + off] = 128; });
      paramRev++;
      envChecks.push(() => {
        const d = (svg().match(/ d="([^"]+)"/) || ["", ""])[1];
        const pts = d.split("L").slice(1).map(q => q.split(",").map(Number));
        // elke fase tekent twintig punten; het houdstuk ertussen een of twee
        const aEnd = pts[19][0], dEnd = pts[39][0], rStart = pts[pts.length - 21][0];
        const q = 264 / 4 + 0.5;
        console.log("met alles op 255 -> aanslag", aEnd.toFixed(0),
                    "| verval tot", dEnd.toFixed(0),
                    "| release vanaf", rStart.toFixed(0), "(kwart = 66)");
        if (aEnd > q || dEnd - aEnd > q || 264 - rStart > q) {
          console.error("FOUT: een fase pakt meer dan een kwart van de breedte");
          failures++;
        }
        // en de release verschuift de rest niet
        paramBytes[56] = 0;
        paramRev++;
        envChecks.push(() => {
          const d2 = (svg().match(/ d="([^"]+)"/) || ["", ""])[1];
          const p2 = d2.split("L").slice(1).map(z => z.split(",").map(Number));
          console.log("release terug op 0 -> aanslag", p2[19][0].toFixed(0),
                      "verval", p2[39][0].toFixed(0), "(waren", aEnd.toFixed(0),
                      "en", dEnd.toFixed(0) + ")");
          if (Math.abs(p2[19][0] - aEnd) > 0.6 || Math.abs(p2[39][0] - dEnd) > 0.6) {
            console.error("FOUT: de release verschuift de andere fasen");
            failures++;
          }
        });
      });

      const [x0, x1, y0, y1] = span();
      console.log("tekening vult het vak: x", x0.toFixed(0) + "-" + x1.toFixed(0),
                  "y", y0.toFixed(0) + "-" + y1.toFixed(0));
      if (x0 > 0.5 || x1 < 263.5 || y0 > 4.5 || y1 < 43.5) {
        console.error("FOUT: de tekening gebruikt niet de volle breedte of hoogte");
        failures++;
      }
      console.log("tekening buiten het vak bij de uiterste curves:",
                    worst.length ? worst.slice(0, 4).join(", ") : "nee");
        if (worst.length) {
          console.error("FOUT: de curve trekt de lijn buiten het vak");
          failures++;
        }
      });

      // de curve-knoppen sturen naar 58 t/m 61
      sent = [];
      collect(one, e => cl2(e, "dial")).forEach((d, i) => {
        d.fire("pointerdown", {clientY: 200, preventDefault() {}, pointerId: 8});
        d.fire("pointermove", {clientY: 190, preventDefault() {}, shiftKey: false});
        d.fire("pointerup", {});
      });
      const nums = sent.filter(x => x[0] === "nrpn").map(x => x[1]);
      console.log("curve-knoppen sturen naar", [...new Set(nums)].join(", "));
      if ([58, 59, 60, 61].some(n => nums.indexOf(n) === -1)) {
        console.error("FOUT: de curves gaan niet naar 58 t/m 61");
        failures++;
      }
    }
  }

  // ---- wisselt de synth van programma, dan halen we de inhoud opnieuw op ----
  {
    const before = reqEdits;
    curProg = (curProg + 1) % 128;
    progChecks.push(() => {
      const asked = reqEdits - before;
      console.log("programma gewisseld op de synth -> edit buffer opgevraagd:", asked);
      if (!asked) {
        console.error("FOUT: na een programmawissel wordt niets opnieuw gelezen");
        failures++;
      }
    });
  }

  // ---- effectpanelen: de namen volgen het geladen effect ----
  {
    [...document.getElementById("tabs").children]
      .find(t => t.textContent === "FX").fire("click");
    const xp = document.getElementById("paramList");
    const cl3 = (e, c) => String(e.className || "").split(" ").includes(c);
    const all = xp.children.filter(e => cl3(e, "pnl"));
    const routing = all[0];
    const panels = all.slice(1);
    const names = panels.map(pn => {
      const n = collect(pn, e => String(e.className || "") === "name")[0];
      return n ? n.textContent : "?";
    });
    const labels = pn => collect(pn, e => cl3(e, "lbl")).map(e => e.textContent);
    const routes = collect(routing, e => e.tagName === "BUTTON").length;
    const routeName = collect(routing, e => String(e.className || "") === "pick")[0];
    console.log("FX-tab:", collect(routing, e => String(e.className || "") === "name")[0].textContent,
                "op", routeName.textContent, "met", routes, "schema's |",
                names.join(" "), "| eerste slot:", labels(panels[0]).slice(0, 4).join(", "));
    if (routes !== 10) {
      console.error("FOUT: er staan geen tien routings om uit te kiezen");
      failures++;
    } else {
      sent = [];
      collect(routing, e => e.tagName === "BUTTON")[2].fire("click");
      const m2 = sent.filter(x => x[0] === "nrpn" && x[1] === 165).pop();
      console.log("routing gekozen ->", JSON.stringify(m2), "| kop:", routeName.textContent);
      if (!m2 || m2[2] !== 2 || routeName.textContent !== "M-3") {
        console.error("FOUT: een routing kiezen stuurt niet 165 of toont niet M-3");
        failures++;
      }
    }
    if (names.join(" ") !== "FX 1 FX 2 FX 3 FX 4") {
      console.error("FOUT: de vier effectslots staan er niet");
      failures++;
    } else if (!labels(panels[0]).length) {
      console.error("FOUT: het eerste slot toont geen parameternamen");
      failures++;
    } else {
      // een ander effect kiezen geeft andere namen
      const box = collect(panels[0], e => cl3(e, "pick"))[0];
      const pop = collect(box, e => String(e.className || "") === "shapepop")[0];
      console.log("keuzelijst met", pop.children.length, "effecten");
      sent = [];
      box.fire("click");
      pop.children[13].fire("click");                 // Delay
      const m = sent.filter(x => x[0] === "nrpn" && x[1] === 166).pop();
      const after = labels(document.getElementById("paramList").children[1]);
      console.log("gekozen:", JSON.stringify(m), "-> namen:", after.slice(0, 4).join(", "));
      if (!m || m[2] !== 13) {
        console.error("FOUT: het effecttype gaat niet naar parameter 166");
        failures++;
      }
      if (pop.children.length !== 36 || after.indexOf("FACTORL") === -1) {
        console.error("FOUT: de namen volgen het gekozen effect niet");
        failures++;
      }

      // de gain loopt tot 150; helemaal open moet dus 150 sturen
      {
        const box2 = collect(panels[0], e => String(e.className || "") === "vf")
          .find(b => collect(b, x => String(x.className || "") === "vcap")
                       .some(c => c.textContent === "GAIN"));
        const lane = collect(box2, e => String(e.className || "").includes("lfader"))[0];
        sent = [];
        lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 6});
        lane.fire("pointermove", {clientY: -900, preventDefault() {}, shiftKey: false});
        lane.fire("pointerup", {});
        const top = sent.filter(x => x[0] === "nrpn" && x[1] === 218).pop();
        console.log("gain helemaal open ->", JSON.stringify(top));
        if (!top || top[2] !== 150) {
          console.error("FOUT: de gain gaat niet tot 150");
          failures++;
        }
      }

      // en als de synth vier andere effecten meldt (nieuw programma), moeten
      // alle vier de slots meegaan
      // waarden zoals de synth ze nummert, gemeten op het apparaat
      [[166, 1], [179, 13], [192, 26], [205, 29]].forEach(([n, v]) => { paramBytes[n] = v; });
      paramRev++;
      fxCheck = () => {
        const want = ["HallRev", "Delay", "ChamberRev", "DualPitch"];
        // het eerste paneel is de routing, daarna de vier slots
        const slots = document.getElementById("paramList").children
          .filter(e => String(e.className || "").split(" ").includes("pnl")).slice(1);
        const shown = slots
          .map(pn => collect(pn, e => String(e.className || "").split(" ").includes("pick"))[0])
          .map(b => {
            // de naam zit in een span binnen het vakje, naast het uitklapmenu
            const sp = collect(b, e => e.tagName === "SPAN" && e.textContent)[0];
            return String(sp ? sp.textContent : "").replace(/\s*▾$/, "").trim();
          });
        console.log("na een nieuw programma tonen de slots:", shown.join(", "));
        if (shown.join() !== want.join()) {
          console.error("FOUT: de slots volgen de synth niet");
          failures++;
        }
      };
    }
  }

  // ---- filterpaneel ----
  {
    [...document.getElementById("tabs").children]
      .find(t => t.textContent === "Filter").fire("click");
    const fp = document.getElementById("paramList");
    const panel = fp.children[0], vca = fp.children[1], hpf = fp.children[2];
    const has = (root, c) => collect(root, e => String(e.className || "").split(" ").includes(c));
    const nameOf = pn => {
      const n = pn && collect(pn, e => String(e.className || "") === "name")[0];
      return n ? n.textContent : "geen";
    };
    const shape = pn => [has(pn, "lfader").length, has(pn, "seg").length,
                         has(pn, "sw").length, has(pn, "dial").length].join("/");
    console.log("filtertab:", [panel, vca, hpf].map(nameOf).join(" + "),
                "| fader/balk/schakelaar/knop:",
                [panel, vca, hpf].map(shape).join("  "));
    // de boost hoort bij de high-pass, en staat dus maar op een plek
    const boosts = collect(fp, e => String(e.className || "").split(" ").includes("lbl"))
      .filter(l => l.textContent === "BASS BOOST").length;
    if (nameOf(panel) !== "VCF" || shape(panel) !== "5/2/1/4"
        || nameOf(vca) !== "VCA" || shape(vca) !== "4/1/0/0"
        || nameOf(hpf) !== "HPF" || shape(hpf) !== "1/0/1/0" || boosts !== 1) {
      console.error("FOUT: de filterpanelen staan er niet zoals op het apparaat");
      failures++;
    } else {
      // faders lijnen uit, ook als het ene label langer is dan het andere:
      // de labelruimte staat vast, anders zakt zo'n kolom omlaag
      {
        const css = require("fs").readFileSync(process.argv[2], "utf8").split("</style>")[0];
        // de regel voor het faderlabel zelf, niet die van een variant erop
        const rule = (css.match(/^  \.vcap \{[^}]*\}/m) || [""])[0];
        const gridRule = (css.match(/\.cells \.lbl \{[^}]*\}/) || [""])[0];
        const headRule = (css.match(/\.pnl \.head \{[^}]*\}/) || [""])[0];
        if (!/height:\s*\d+px/.test(headRule)) {
          console.error("FOUT: zonder vaste hoogte lopen de titelbalken uiteen");
          failures++;
        }
        console.log("labelruimte vast:", /min-height/.test(rule) ? "fader ja" : "fader NEE",
                    "|", /min-height/.test(gridRule) ? "cel ja" : "cel NEE");
        if (!/min-height/.test(rule) || !/min-height/.test(gridRule)) {
          console.error("FOUT: zonder vaste labelruimte lijnen de faders niet uit");
          failures++;
        }
      }

      // pan spread is bipolair: de synth toont -128 tot +127
      {
        const box = collect(vca, e => String(e.className || "") === "vf")
          .find(b => collect(b, x => String(x.className || "") === "vcap")
                       .some(c => c.textContent === "PAN SPREAD"));
        const num = collect(box, e => String(e.className || "") === "vnum")[0];
        const lane = collect(box, e => String(e.className || "").includes("lfader"))[0];
        sent = [];
        lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 4});
        lane.fire("pointermove", {clientY: -900, preventDefault() {}, shiftKey: false});
        lane.fire("pointerup", {});
        const top = sent.filter(x => x[0] === "nrpn" && x[1] === 83).pop();
        console.log("pan spread helemaal open ->", JSON.stringify(top),
                    "toont", num.textContent);
        if (!top || top[2] !== 255 || num.textContent !== "+127") {
          console.error("FOUT: pan spread toont niet +127 bij 255");
          failures++;
        }
      }

      // VCA-MODE is een globale instelling: byte 47, dus NRPN 347
      {
        const bar = collect(vca, e => String(e.className || "").split(" ").includes("seg"))[0];
        sent = [];
        bar.children[1].fire("click");                 // BALLSY
        const m = sent.filter(x => x[0] === "nrpn").pop();
        console.log("VCA-mode ->", JSON.stringify(m),
                    "(" + bar.children.map(c => c.textContent).join(" | ") + ")");
        if (!m || m[1] !== 347 || m[2] !== 1) {
          console.error("FOUT: ballsy stuurt niet NRPN 347 = 1");
          failures++;
        }
        sent = [];
        bar.children[0].fire("click");                 // en terug
        const back = sent.filter(x => x[0] === "nrpn").pop();
        if (!back || back[2] !== 0) {
          console.error("FOUT: transparent stuurt niet NRPN 347 = 0");
          failures++;
        }
      }

      // envelope omkeren is de omgekeerde parameter: aan is nul
      const invCell = collect(panel, e => String(e.className || "").split(" ").includes("cell"))
        .find(c => collect(c, l => String(l.className || "") === "lbl")
                     .some(l => l.textContent === "ENV INVERT"));
      const invSw = collect(invCell, e => String(e.className || "").split(" ").includes("sw"))[0];
      const word = () => collect(invCell, e => String(e.className || "").split(" ").includes("word"))[0].textContent;
      sent = [];
      invSw.fire("click");
      const first = sent.filter(x => x[0] === "nrpn" && x[1] === 50).pop();
      const w1 = word();
      sent = [];
      invSw.fire("click");
      const second = sent.filter(x => x[0] === "nrpn" && x[1] === 50).pop();
      console.log("env invert:", JSON.stringify(first), w1, "->",
                  JSON.stringify(second), word());
      if (!first || !second || first[2] === second[2]
          || [first[2], second[2]].sort().join() !== "0,1") {
        console.error("FOUT: env invert schakelt niet tussen 0 en 1");
        failures++;
      }
      if ((first[2] === 0) !== (w1 === "On")) {
        console.error("FOUT: bij env invert hoort nul het woord On te geven");
        failures++;
      }

      // de high-pass staat nu als fader in het tweede paneel, en er blijft
      // niets los onder de panelen over
      const caps = collect(vca, e => String(e.className || "") === "vcap")
        .map(e => e.textContent);
      console.log("faders in VCA:", caps.join(", "),
                  "| in HPF:", collect(hpf, e => String(e.className || "") === "vcap")
                    .map(e => e.textContent).join(", "),
                  "| los eronder:", fp.children.length - 3);
      if (fp.children.length !== 3) {
        console.error("FOUT: er staat nog iets los onder de filterpanelen");
        failures++;
      }
    }
  }

  // ---- LFO-panelen, in dezelfde stijl als de oscillatoren ----
  lfoTab.fire("click");

  const cls = (e, c) => String(e.className || "").split(" ").includes(c);
  const pick = (root, c) => collect(root, e => cls(e, c));
  const faderNamed = (root, name) => {
    const box = collect(root, e => String(e.className || "") === "vf")
      .find(b => collect(b, x => String(x.className || "") === "vcap")
                   .some(c => String(c.textContent).indexOf(name) === 0));
    return box && {
      box: box,
      num: collect(box, e => String(e.className || "") === "vnum")[0],
      lane: collect(box, e => String(e.className || "").includes("lfader"))[0],
    };
  };

  const lfos = plist.children.filter(e => cls(e, "lfo"));
  const lanes = pick(plist, "lfader");
  const cellNamed = (root, name) => collect(root, e => cls(e, "cell"))
    .find(c => collect(c, x => cls(x, "lbl")).some(l => l.textContent === name));
  console.log("LFO-panelen:", lfos.length, "| faders:", lanes.length,
              "| vormvakken:", pick(plist, "pick").length,
              "| schakelaars:", pick(plist, "sw").length);
  if (lfos.length !== 2 || lanes.length !== 8 || pick(plist, "pick").length !== 2
      || pick(plist, "sw").length !== 6) {
    console.error("FOUT: LFO-panelen niet volledig opgebouwd");
    failures++;
  } else {
    const one = lfos[0];

    // vorm kiezen uit het vakje in de kop, met de tekeningen erin
    const box = pick(one, "pick")[0];
    if (!collect(one, e => cls(e, "head")).some(h => collect(h, e => e === box).length)) {
      console.error("FOUT: het vormvakje staat niet in de kop");
      failures++;
    }
    const pop = collect(box, e => String(e.className || "") === "shapepop")[0];
    console.log("vormen in het menu:", pop.children.length);
    if (pop.children.length !== 7) {
      console.error("FOUT: het vormmenu heeft geen zeven vormen");
      failures++;
    } else {
      box.fire("click");
      const opened = pop.style.display;
      sent = [];
      pop.children[2].fire("click");                 // blokgolf
      const lit = pop.children.filter(b => b.classList.contains("on"));
      console.log("vormmenu:", opened, "-> gekozen", JSON.stringify(sent[0]),
                  "| opgelicht:", lit.length === 1 && lit[0] === pop.children[2]
                    ? "de gekozen vorm" : lit.length);
      if (opened !== "grid") { console.error("FOUT: het vormmenu ging niet open"); failures++; }
      if (!sent.some(x => x[0] === "nrpn" && x[1] === 2 && x[2] === 2)) {
        console.error("FOUT: vormkeuze stuurt niet NRPN 2 = 2");
        failures++;
      }
      if (pop.style.display !== "none") {
        console.error("FOUT: het vormmenu bleef open na kiezen");
        failures++;
      }
      if (lit.length !== 1 || lit[0] !== pop.children[2]) {
        console.error("FOUT: de gekozen vorm licht niet als enige op");
        failures++;
      }
      sent = [];
      const box2 = pick(lfos[1], "pick")[0];
      box2.fire("click");
      collect(box2, e => String(e.className || "") === "shapepop")[0].children[3].fire("click");
      if (!sent.some(x => x[0] === "nrpn" && x[1] === 9)) {
        console.error("FOUT: LFO 2 stuurt niet naar parameter 9");
        failures++;
      }
    }

    // poly, mono of een faseverschil: één schakelaar die doorstapt
    const phaseCell = () => cellNamed(document.getElementById("paramList"), "PHASE");
    const wordIn = c => collect(c, e => cls(e, "word"))[0].textContent;
    const step = () => {
      sent = [];
      collect(phaseCell(), e => cls(e, "sw"))[0].fire("click");
      const m = sent.filter(x => x[0] === "nrpn" && x[1] === 5).pop();
      return [m ? m[2] : null, wordIn(phaseCell())];
    };
    const walk = [step(), step(), step()];
    console.log("standen:", walk.map(w => w[1] + "=" + w[0]).join(" -> "));
    const vals = walk.map(w => w[0]);
    if (vals.indexOf(0) === -1 || vals.indexOf(1) === -1
        || !vals.some(v => v > 1)) {
      console.error("FOUT: de schakelaar loopt niet langs poly, mono en faseverschil");
      failures++;
    }
    if (walk.some(w => !w[1])) {
      console.error("FOUT: er staat geen woord onder de schakelaar");
      failures++;
    }

    // de fase-fader toont graden en loopt van 1 tot 254
    const ph = faderNamed(document.getElementById("paramList"), "PHASE");
    if (!ph) {
      console.error("FOUT: faseregelaar niet gevonden");
      failures++;
    } else {
      const swipe = (from, to) => {
        sent = [];
        ph.lane.fire("pointerdown", {clientY: from, preventDefault() {}, pointerId: 5});
        ph.lane.fire("pointermove", {clientY: to, preventDefault() {}, shiftKey: false});
        ph.lane.fire("pointerup", {});
        return sent.filter(x => x[0] === "nrpn" && x[1] === 5).pop();
      };
      const low = swipe(100, 900), lowText = ph.num.textContent;
      const high = swipe(900, -900), highText = ph.num.textContent;
      console.log("fase omlaag ->", JSON.stringify(low), "toont", lowText,
                  "| omhoog ->", JSON.stringify(high), "toont", highText);
      if (!low || low[2] !== 2 || lowText !== "1\u00B0") {
        console.error("FOUT: laagste fase is niet 1 graad (parameter 2)");
        failures++;
      }
      if (!high || high[2] !== 255 || highText !== "254\u00B0") {
        console.error("FOUT: hoogste fase is niet 254 graden (parameter 255)");
        failures++;
      }
    }
  }

  // ---- de tekening loopt sneller als de rate hoger staat ----
  {
    const crossings = () => {
      const box = collect(document.getElementById("paramList"),
        e => cls(e, "wavebox"))[0];
      const m = String(box._html || "").match(/points="([^"]+)"/);
      if (!m) return -1;
      const ys = m[1].trim().split(/\s+/).map(pt => +pt.split(",")[1]);
      let n = 0;
      for (let i = 1; i < ys.length; i++) {
        if ((ys[i - 1] - 60) * (ys[i] - 60) < 0) n++;      // door het midden
      }
      return n;
    };
    paramBytes[0] = 0; paramRev++;
    const slow = crossings();
    paramBytes[0] = 255; paramRev++;
    setTimeout(() => {
      const fast = crossings();
      console.log("golfvorm door het midden: traag", slow, "-> snel", fast);
      if (fast < slow * 2) {
        console.error("FOUT: de tekening loopt bij een hoge rate niet dubbel zo snel");
        failures++;
      }
    }, 400);
  }

  // ---- met arp sync is de rate een notewaarde ----
  const rateOf = () => faderNamed(document.getElementById("paramList"), "RATE");
  const DIVS = ["4","3","2","1","1/2","3/8","1/3","1/4","3/16","1/6","1/8",
                "3/32","1/12","1/16","3/64","1/24","1/32","3/128","1/48","1/64"];
  console.log("arp sync staat aan, rate leest:", rateOf().num.textContent);
  if (DIVS.indexOf(rateOf().num.textContent) === -1) {
    console.error("FOUT: rate toont geen notewaarde terwijl arp sync aan staat");
    failures++;
  } else {
    // een sleep moet midden in een stand landen, niet ertussen
    sent = [];
    const lane = rateOf().lane;
    lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 3});
    lane.fire("pointermove", {clientY: 250, preventDefault() {}, shiftKey: false});
    lane.fire("pointerup", {});
    const last = sent.filter(x => x[0] === "nrpn" && x[1] === 0).pop();
    const idx = last ? Math.floor(last[2] / (256 / 20)) : -1;
    console.log("gesleept ->", JSON.stringify(last), "= stand", DIVS[idx],
                "| fader leest", rateOf().num.textContent);
    if (!last || DIVS[idx] !== rateOf().num.textContent) {
      console.error("FOUT: gestuurde waarde hoort niet bij de stand die er staat");
      failures++;
    }

    // arp sync uit via de knop in de kop: dan is het weer een gewone waarde
    const arpSw = () => {
      const c = collect(document.getElementById("paramList"), e => cls(e, "cell"))
        .find(x => collect(x, l => cls(l, "lbl")).some(l => l.textContent === "ARP SYNC"));
      return c && collect(c, e => cls(e, "sw"))[0];
    };
    if (!arpSw()) { console.error("FOUT: arp sync-schakelaar niet gevonden"); failures++; }
    else {
      arpSw().fire("click");
      console.log("arp sync uit, rate leest:", rateOf().num.textContent);
      if (!/^[0-9]+$/.test(String(rateOf().num.textContent))) {
        console.error("FOUT: rate toont geen gewone waarde na arp sync uit");
        failures++;
      }
      arpSw().fire("click");                                  // weer aan
    }
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

    // ---- houdt de tussenlaag beide kanten bij? ----
    const tabsNow = [...document.getElementById("tabs").children];
    tabsNow.find(t => t.textContent === "LFO").fire("click");
    const findAll = (root, pred) => {
      const out = [];
      (function walk(e) {
        if (pred(e)) out.push(e);
        for (const c of e.children || []) walk(c);
      })(root);
      return out;
    };
    paramRev++;                        // eerst laten uitrusten: standen gelijktrekken
    setTimeout(() => syncTest(findAll), 1700);
  }, 1800);

  function syncTest(findAll) {
    const plist2 = document.getElementById("paramList");
    // de faders op naam pakken: de kolomvolgorde in het paneel is niet die van de code
    const fader = name => {
      const box = findAll(plist2, e => String(e.className || "") === "vf")
        .find(b => findAll(b, x => String(x.className || "") === "vcap")
                     .some(c => String(c.textContent).indexOf(name) === 0));
      return {
        box: box,
        num: findAll(box, e => String(e.className || "") === "vnum")[0],
        lane: findAll(box, e => String(e.className || "").includes("lfader"))[0],
      };
    };
    const rate = fader("RATE"), slew = fader("SLEW");

    // 1. wat jij zet mag niet terugspringen door een verouderde lezing:
    // de synth is nog niet bij, dus de volgende lezing geeft de oude stand
    const rateWas = paramBytes[0];
    rate.lane.fire("pointerdown", {clientY: 300, preventDefault() {}, pointerId: 7});
    rate.lane.fire("pointermove", {clientY: 200, preventDefault() {}, shiftKey: false});
    rate.lane.fire("pointerup", {});
    const setByUi = rate.num.textContent;

    paramBytes[0] = rateWas;           // achterlopende lezing

    // 2. wat de synth meldt moet zichtbaar worden zonder herbouw
    paramBytes[6] = 91;
    paramRev++;

    setTimeout(() => {
      const live = e => findAll(document.getElementById("paramList"), x => x === e).length === 1;
      console.log("na een verouderde lezing staat rate op", rate.num.textContent,
                  "(door de gebruiker gezet op " + setByUi + ")",
                  live(rate.lane) ? "" : "(HERBOUWD)");
      if (rate.num.textContent !== setByUi || !live(rate.lane)) {
        console.error("FOUT: eigen wijziging overschreven door een oude lezing");
        failures++;
      }
      console.log("na een melding van de synth staat slew op", slew.num.textContent,
                  live(slew.lane) ? "(zelfde regelaar, geen herbouw)" : "(HERBOUWD)");
      if (slew.num.textContent !== "91") {
        console.error("FOUT: melding van de synth niet overgenomen");
        failures++;
      }
      if (!live(slew.lane)) {
        console.error("FOUT: pagina herbouwd voor een waardewijziging");
        failures++;
      }

      // laatste controle: verandert de synth iets, dan volgt het paneel
      [...document.getElementById("tabs").children]
        .find(t => t.textContent === "OSC").fire("click");
      const sawOf = () => collect(document.getElementById("paramList"),
        e => String(e.className || "").split(" ").includes("hbtn"))[0];
      const wasOn = sawOf().classList.contains("on");
      paramBytes[19] = wasOn ? 0 : 1;
      paramRev++;
      setTimeout(() => {
        pwmChecks.forEach(fn => fn());
        while (envChecks.length) envChecks.shift()();
        progChecks.forEach(fn => fn());
        const nowOn = sawOf().classList.contains("on");
        console.log("golfvormknop na een melding van de synth:",
                    nowOn ? "aan" : "uit", "(was " + (wasOn ? "aan" : "uit") + ")");
        if (nowOn === wasOn) {
          console.error("FOUT: de koptoets volgt de synth niet");
          failures++;
        }

        if (bendCheck) {
          [...document.getElementById("tabs").children]
            .find(t => t.textContent === "Voice").fire("click");
          bendCheck();
        }

        // deze wisselt van tabblad, dus als laatste
        if (fxCheck) {
          [...document.getElementById("tabs").children]
            .find(t => t.textContent === "FX").fire("click");
          fxCheck();
        }

        if (global.__onerror && errors.length) console.log("meldingen:", errors);
        console.log(failures ? "MISLUKT: " + failures + " fouten" : "ALLE UI-TESTS GESLAAGD");
        process.exit(failures ? 1 : 0);
      }, 700);
    }, 1700);
  }
}, 20);
