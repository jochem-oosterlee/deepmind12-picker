/*
 * Voert de JavaScript uit index.html echt uit met een minimale DOM-nabootsing.
 * Vangt fouten die pas bij het opstarten opvallen (zoals variabelen die te
 * vroeg worden gebruikt) en klikt daarna elke knop en tab aan.
 */
const fs = require("fs");
const path = process.argv[2];
const html = fs.readFileSync(path, "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

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
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    querySelector() { return makeEl("sub"); },
    querySelectorAll() { return []; },
    focus() {}, select() {}, click() { this.fire("click"); },
    fire(ev, arg) {
      for (const fn of this.handlers[ev] || []) fn(arg || {stopPropagation() {}, preventDefault() {}, key: "", target: {}});
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
global.AndroidBridge = {
  getStatus: () => JSON.stringify({connected: true, status: "verbonden met FakeDM12",
    event: "", wifi: "WiFi verbonden: Deepmind12", wifiConnected: true, ip: "192.168.12.1"}),
  libStatus: () => JSON.stringify({names: 256, patches: 3, nameDumps: 2, patchDumps: 3,
    curBank: 0, curProg: 5, iface: 2, dev: 0, editBuffer: true, paramRev: 7, info: "edit buffer ontvangen"}),
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
if (grid.children.length !== 128) { console.error("FOUT: presetraster niet opgebouwd"); process.exit(1); }

// elke tab openen en de inhoud renderen
let failures = 0;
for (const t of [...tabs.children]) {
  sent = [];
  try {
    t.fire("click");
    const list = document.getElementById("paramList");
    console.log("tab", JSON.stringify(t.textContent), "-> parameters:", list.children.length);
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
                  "libExportBtn","readBtn","pushBtn"]) {
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

if (global.__onerror && errors.length) console.log("meldingen:", errors);
console.log(failures ? "MISLUKT: " + failures + " fouten" : "ALLE UI-TESTS GESLAAGD");
process.exit(failures ? 1 : 0);
