#!/usr/bin/env python3
"""
DeepMind 12 WiFi Program Picker — bridge + web-UI in 1 bestand.

Draai dit op het apparaat dat met het WiFi-accesspoint van de DeepMind 12
verbonden is (bijv. je Android-tablet via Termux, of een pc):

    python dm12-bridge.py                # DeepMind-IP wordt gegokt (gateway)
    python dm12-bridge.py 192.168.1.1    # of geef het IP expliciet op

Open daarna een browser op http://localhost:8080 (zelfde apparaat) of
http://<ip-van-dit-apparaat>:8080 (ander apparaat op hetzelfde netwerk).

Het IP van de DeepMind staat op de synth onder
GLOBAL -> CONNECTIVITY -> NETWORK SETTINGS (regel "IP").

Alleen Python-standaardbibliotheek, geen pip-installaties nodig.
"""

import json
import random
import select
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

APPLEMIDI_SIG = b"\xff\xff"
APPLEMIDI_PORT = 5004  # standaard controlepoort; datapoort = +1
START = time.monotonic()


def ts_now():
    """AppleMIDI-klok: eenheden van 100 microseconden sinds start."""
    return int((time.monotonic() - START) * 10000)


class AppleMIDISession:
    """Minimale AppleMIDI (RTP-MIDI) initiator: sessie opzetten, kloksync
    beantwoorden en MIDI-berichten versturen."""

    def __init__(self, peer_ip, peer_port=APPLEMIDI_PORT, name="DM12 Picker"):
        self.peer_ip = peer_ip
        self.peer_port = peer_port
        self.name = name
        self.ssrc = random.getrandbits(32)
        self.seq = random.getrandbits(16)
        self.lock = threading.Lock()
        self.stop_flag = False
        self.connected = False
        self.status = "wacht op verbinding"
        self.peer_ssrc = None
        self.last_rx = 0.0
        self.last_sync = 0.0
        self.last_invite = 0.0
        self.phase = 0  # 0=idle, 1=IN op control verstuurd, 2=IN op data verstuurd
        self.token = 0
        self.ctrl, self.data = self._bind_pair()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    # ---------- sockets ----------
    def _bind_pair(self):
        for p in range(5006, 5100, 2):
            c = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            d = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                c.bind(("0.0.0.0", p))
                d.bind(("0.0.0.0", p + 1))
                return c, d
            except OSError:
                c.close()
                d.close()
        raise RuntimeError("geen vrije UDP-poorten gevonden")

    def retarget(self, ip, port=APPLEMIDI_PORT):
        with self.lock:
            self._send_bye()
            self.peer_ip = ip
            self.peer_port = port
            self.connected = False
            self.phase = 0
            self.last_invite = 0.0
            self.status = "wacht op verbinding"

    # ---------- pakketten ----------
    def _cmd(self, cmd, token):
        return (APPLEMIDI_SIG + cmd + struct.pack(">III", 2, token, self.ssrc)
                + self.name.encode("utf-8") + b"\x00")

    def _send_invites(self):
        now = time.monotonic()
        if now - self.last_invite < 2.0:
            return
        self.last_invite = now
        if self.phase == 0:
            self.token = random.getrandbits(32)
            self.phase = 1
        if self.phase == 1:
            self.ctrl.sendto(self._cmd(b"IN", self.token),
                             (self.peer_ip, self.peer_port))
        elif self.phase == 2:
            self.data.sendto(self._cmd(b"IN", self.token),
                             (self.peer_ip, self.peer_port + 1))

    def _send_bye(self):
        if self.connected or self.phase > 0:
            try:
                self.ctrl.sendto(self._cmd(b"BY", self.token),
                                 (self.peer_ip, self.peer_port))
            except OSError:
                pass

    def _send_ck(self, count, ts1, ts2, ts3):
        pkt = (APPLEMIDI_SIG + b"CK" + struct.pack(">I", self.ssrc)
               + bytes([count, 0, 0, 0]) + struct.pack(">QQQ", ts1, ts2, ts3))
        try:
            self.data.sendto(pkt, (self.peer_ip, self.peer_port + 1))
        except OSError:
            pass

    # ---------- hoofdlus ----------
    def _run(self):
        while not self.stop_flag:
            with self.lock:
                if not self.connected:
                    self._send_invites()
                else:
                    now = time.monotonic()
                    if now - self.last_sync > 8.0:
                        self.last_sync = now
                        self._send_ck(0, ts_now(), 0, 0)
                    if now - self.last_rx > 60.0:
                        self.connected = False
                        self.phase = 0
                        self.last_invite = 0.0
                        self.status = "verbinding verloren, opnieuw verbinden"
            try:
                readable, _, _ = select.select([self.ctrl, self.data], [], [], 0.5)
            except OSError:
                break
            for sock in readable:
                try:
                    pkt, addr = sock.recvfrom(4096)
                except OSError:
                    continue
                with self.lock:
                    self._handle(sock, pkt, addr)

    def _handle(self, sock, pkt, addr):
        self.last_rx = time.monotonic()
        if len(pkt) >= 4 and pkt[:2] == APPLEMIDI_SIG:
            cmd = pkt[2:4]
            if cmd == b"OK" and len(pkt) >= 16:
                token, ssrc = struct.unpack(">II", pkt[8:16])
                if token != self.token:
                    return
                self.peer_ssrc = ssrc
                if self.phase == 1 and sock is self.ctrl:
                    self.phase = 2
                    self.last_invite = 0.0
                    self._send_invites()
                elif self.phase == 2 and sock is self.data:
                    self.connected = True
                    peer_name = pkt[16:].split(b"\x00")[0].decode("utf-8", "replace")
                    self.status = "verbonden met " + (peer_name or self.peer_ip)
                    self.last_sync = time.monotonic()
                    self._send_ck(0, ts_now(), 0, 0)
            elif cmd == b"NO":
                self.status = "verbinding geweigerd door apparaat"
                self.phase = 0
            elif cmd == b"IN" and len(pkt) >= 16:
                # peer nodigt ons uit: accepteren
                token = struct.unpack(">I", pkt[8:12])[0]
                sock.sendto(self._cmd(b"OK", token), addr)
            elif cmd == b"CK" and len(pkt) >= 36:
                count = pkt[8]
                ts1, ts2, ts3 = struct.unpack(">QQQ", pkt[12:36])
                if count == 0:
                    self._send_ck(1, ts1, ts_now(), 0)
                elif count == 1:
                    self._send_ck(2, ts1, ts2, ts_now())
            elif cmd == b"BY":
                self.connected = False
                self.phase = 0
                self.last_invite = 0.0
                self.status = "apparaat verbrak de verbinding"
        # anders: binnenkomende RTP-MIDI van de synth — genegeerd

    # ---------- MIDI versturen ----------
    def send_midi(self, messages):
        """messages: lijst van MIDI-berichten (elk een bytes/lijst), samen
        verstuurd in 1 RTP-MIDI-pakket met delta-tijd 0 ertussen."""
        with self.lock:
            if not self.connected:
                return False
            payload = b""
            for i, msg in enumerate(messages):
                if i > 0:
                    payload += b"\x00"  # delta-tijd 0
                payload += bytes(msg)
            if len(payload) < 16:
                header = bytes([len(payload)])
            else:
                header = bytes([0x80 | (len(payload) >> 8), len(payload) & 0xFF])
            self.seq = (self.seq + 1) & 0xFFFF
            rtp = struct.pack(">BBHII", 0x80, 0x61, self.seq,
                              ts_now() & 0xFFFFFFFF, self.ssrc)
            try:
                self.data.sendto(rtp + header + payload,
                                 (self.peer_ip, self.peer_port + 1))
                return True
            except OSError:
                return False

    def close(self):
        self.stop_flag = True
        with self.lock:
            self._send_bye()
        self.ctrl.close()
        self.data.close()


def guess_deepmind_ip():
    """Gok: het accesspoint (de DeepMind) is de .1 van ons eigen subnet."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 9))  # verstuurt niets, kiest alleen interface
        own = s.getsockname()[0]
        s.close()
        return own.rsplit(".", 1)[0] + ".1"
    except OSError:
        return "192.168.4.1"


# ======================================================================
#  Web-UI
# ======================================================================

PAGE = r"""<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepMind 12 — Program Picker</title>
<style>
  :root {
    --bg:#14161a; --panel:#1d2026; --panel2:#23272e; --border:#32363e;
    --text:#e8eaed; --muted:#8a919c; --accent:#4da3ff; --accent-dim:#2a5a8f;
    --active:#ffb547; --star:#ffd24d; --radius:10px;
  }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  body { background:var(--bg); color:var(--text); font-family:"Segoe UI",system-ui,sans-serif; padding:12px; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:12px; }
  h1 { font-size:17px; font-weight:600; margin-right:auto; white-space:nowrap; }
  h1 span { color:var(--accent); }
  select, input[type="text"], button {
    background:var(--panel2); color:var(--text); border:1px solid var(--border);
    border-radius:var(--radius); padding:10px 12px; font-size:14px; outline:none;
  }
  select:focus, input:focus { border-color:var(--accent); }
  button { cursor:pointer; }
  #status { display:flex; align-items:center; gap:8px; font-size:13px; padding:8px 12px;
    border-radius:var(--radius); background:var(--panel); border:1px solid var(--border); color:var(--muted); }
  #dot { width:10px; height:10px; border-radius:50%; background:#ff7b72; flex:none; }
  #dot.ok { background:#6fd487; }
  #ipInput { width:130px; }
  .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  #search { flex:1; min-width:150px; }
  .banks { display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; }
  .bank-btn { flex:1; min-width:44px; padding:12px 0; text-align:center; font-weight:600; font-size:15px; }
  .bank-btn.selected { background:var(--accent-dim); border-color:var(--accent); color:#fff; }
  .bank-btn.fav-tab.selected { background:#5c4a15; border-color:var(--star); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; }
  .prog { position:relative; background:var(--panel); border:1px solid var(--border);
    border-radius:var(--radius); padding:12px 12px 10px; cursor:pointer; user-select:none; min-height:64px; }
  .prog:active { background:var(--panel2); border-color:var(--accent); }
  .prog.current { border-color:var(--active); background:#2c2415; }
  .prog .num { font-size:11px; color:var(--muted); }
  .prog.current .num { color:var(--active); }
  .prog .name { font-size:14px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .prog .name input { width:100%; padding:4px; font-size:14px; border-radius:6px; }
  .prog .star { position:absolute; top:4px; right:4px; font-size:16px; padding:6px; color:var(--border); }
  .prog .star.on { color:var(--star); }
  footer { margin-top:16px; font-size:12px; color:var(--muted); line-height:1.7; }
  .empty { grid-column:1/-1; color:var(--muted); padding:30px; text-align:center; }
</style>
</head>
<body>

<header>
  <h1>DeepMind <span>12</span> — WiFi Picker</h1>
  <div id="status"><span id="dot"></span><span id="statusText">verbinden…</span></div>
  <input type="text" id="ipInput" placeholder="IP DeepMind" title="IP van de DeepMind (GLOBAL → CONNECTIVITY → NETWORK SETTINGS)">
  <button id="ipBtn">Verbind</button>
  <label style="font-size:12px;color:var(--muted)">Kanaal</label>
  <select id="midiCh"></select>
</header>

<div class="toolbar">
  <input type="text" id="search" placeholder="Zoek preset…">
  <button id="exportBtn">Exporteren</button>
  <button id="importBtn">Importeren</button>
  <input type="file" id="importFile" accept=".json" style="display:none">
</div>

<div class="banks" id="bankTabs"></div>
<div class="grid" id="grid"></div>

<footer>
  <b>Tik</b> = preset laden · <b>lang indrukken</b> = hernoemen · <b>★</b> = favoriet (eigen tabblad) ·
  namen worden op dit apparaat bewaard, gebruik Exporteren als back-up.<br>
  Zet op de synth <i>GLOBAL → MIDI SETTINGS → PROGRAM CHANGE</i> op <i>Rx</i> of <i>Both</i>.
</footer>

<script>
"use strict";
const BANKS = ["A","B","C","D","E","F","G","H"];
const PROGS = 128;

const store = {
  load(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
let names = store.load("dm12.names", {});
let favs = new Set(store.load("dm12.favs", []));
let channel = store.load("dm12.channel", 0);
let currentBank = store.load("dm12.bank", "A");
let current = store.load("dm12.current", null);

// ---------- status & instellingen ----------
const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const ipInput = document.getElementById("ipInput");

async function poll() {
  try {
    const r = await fetch("/status");
    const s = await r.json();
    dot.className = s.connected ? "ok" : "";
    statusText.textContent = s.status;
    if (document.activeElement !== ipInput) ipInput.value = s.ip;
  } catch {
    dot.className = "";
    statusText.textContent = "bridge niet bereikbaar";
  }
}
setInterval(poll, 2000); poll();

document.getElementById("ipBtn").addEventListener("click", () => {
  fetch("/config?ip=" + encodeURIComponent(ipInput.value.trim())).then(poll);
});

const chSel = document.getElementById("midiCh");
for (let i = 0; i < 16; i++) {
  const o = document.createElement("option");
  o.value = i; o.textContent = i + 1; chSel.appendChild(o);
}
chSel.value = channel;
chSel.addEventListener("change", () => { channel = +chSel.value; store.save("dm12.channel", channel); });

// ---------- versturen ----------
async function sendProgram(bank, prog) {
  const bankIdx = BANKS.indexOf(bank);
  try {
    const r = await fetch(`/send?bank=${bankIdx}&prog=${prog}&ch=${channel}`);
    const res = await r.json();
    if (res.ok) {
      current = bank + "-" + prog;
      store.save("dm12.current", current);
      statusText.textContent = `verstuurd: ${bank}${prog + 1}`;
      dot.className = "ok";
    } else {
      statusText.textContent = "niet verbonden met DeepMind";
      dot.className = "";
    }
  } catch { statusText.textContent = "bridge niet bereikbaar"; }
  updateCurrent();
}

// actieve preset markeren zonder het grid te herbouwen
function updateCurrent() {
  for (const el of document.querySelectorAll(".prog")) {
    el.classList.toggle("current", el.dataset.key === current);
  }
}

// ---------- UI ----------
const grid = document.getElementById("grid");
const bankTabs = document.getElementById("bankTabs");
const search = document.getElementById("search");

function progName(key) { return names[key] || ""; }
function progLabel(b, p) { return names[b + "-" + p] || `Preset ${b}${p + 1}`; }

function buildTabs() {
  bankTabs.innerHTML = "";
  for (const b of BANKS.concat(["FAV"])) {
    const btn = document.createElement("button");
    const isFav = b === "FAV";
    btn.className = "bank-btn" + (isFav ? " fav-tab" : "") + (currentBank === b ? " selected" : "");
    btn.textContent = isFav ? "★" : b;
    btn.addEventListener("click", () => {
      currentBank = b; store.save("dm12.bank", b); search.value = ""; render();
    });
    bankTabs.appendChild(btn);
  }
}

function visibleProgs() {
  const q = search.value.trim().toLowerCase();
  const list = [];
  if (q) {
    for (const b of BANKS) for (let p = 0; p < PROGS; p++) {
      const label = (progName(b + "-" + p) || `preset ${b}${p + 1}`).toLowerCase();
      if (label.includes(q) || (b + (p + 1)).toLowerCase() === q || String(p + 1) === q) list.push([b, p]);
    }
    return list;
  }
  if (currentBank === "FAV") {
    for (const key of favs) { const [b, p] = key.split("-"); list.push([b, +p]); }
    list.sort((x, y) => x[0] === y[0] ? x[1] - y[1] : BANKS.indexOf(x[0]) - BANKS.indexOf(y[0]));
    return list;
  }
  for (let p = 0; p < PROGS; p++) list.push([currentBank, p]);
  return list;
}

let pressTimer = null, longPressed = false;

function render() {
  buildTabs();
  grid.innerHTML = "";
  const progs = visibleProgs();
  if (!progs.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = currentBank === "FAV" && !search.value
      ? "Nog geen favorieten — tik op de ★ van een preset." : "Geen presets gevonden.";
    grid.appendChild(d);
    return;
  }
  for (const [bank, prog] of progs) {
    const key = bank + "-" + prog;
    const div = document.createElement("div");
    div.className = "prog" + (current === key ? " current" : "");
    div.dataset.key = key;

    const num = document.createElement("div");
    num.className = "num";
    num.textContent = bank + String(prog + 1).padStart(3, "0");
    div.appendChild(num);

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = progLabel(bank, prog);
    if (!progName(key)) name.style.color = "var(--muted)";
    div.appendChild(name);

    const star = document.createElement("span");
    star.className = "star" + (favs.has(key) ? " on" : "");
    star.textContent = "★";
    star.addEventListener("click", e => {
      e.stopPropagation();
      if (favs.has(key)) favs.delete(key); else favs.add(key);
      store.save("dm12.favs", [...favs]);
      render();
    });
    div.appendChild(star);

    // tik = versturen, lang indrukken = hernoemen
    const startPress = () => {
      longPressed = false;
      pressTimer = setTimeout(() => { longPressed = true; startRename(div, key, bank, prog); }, 550);
    };
    const endPress = () => clearTimeout(pressTimer);
    div.addEventListener("touchstart", startPress, { passive: true });
    div.addEventListener("touchend", endPress);
    div.addEventListener("touchmove", endPress, { passive: true });
    div.addEventListener("mousedown", startPress);
    div.addEventListener("mouseup", endPress);
    div.addEventListener("mouseleave", endPress);
    div.addEventListener("click", () => { if (!longPressed) sendProgram(bank, prog); });
    div.addEventListener("contextmenu", e => e.preventDefault());
    grid.appendChild(div);
  }
}

function startRename(div, key, bank, prog) {
  const nameEl = div.querySelector(".name");
  const input = document.createElement("input");
  input.type = "text";
  input.value = progName(key);
  input.placeholder = `Preset ${bank}${prog + 1}`;
  nameEl.innerHTML = "";
  nameEl.appendChild(input);
  input.focus();
  const finish = save => {
    if (save) {
      const v = input.value.trim();
      if (v) names[key] = v; else delete names[key];
      store.save("dm12.names", names);
    }
    render();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", e => e.stopPropagation());
}

search.addEventListener("input", render);

// ---------- import / export ----------
document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ names, favs: [...favs] }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deepmind12-presets.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
const importFile = document.getElementById("importFile");
document.getElementById("importBtn").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const f = importFile.files[0];
  if (!f) return;
  f.text().then(t => {
    try {
      const d = JSON.parse(t);
      if (d.names && typeof d.names === "object") names = d.names;
      if (Array.isArray(d.favs)) favs = new Set(d.favs);
      store.save("dm12.names", names);
      store.save("dm12.favs", [...favs]);
      render();
    } catch { alert("Geen geldig JSON-bestand"); }
  });
  importFile.value = "";
});

render();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    session = None  # wordt door main() gezet

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        s = Handler.session
        if url.path == "/":
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/status":
            self._json({"connected": s.connected, "status": s.status,
                        "ip": s.peer_ip})
        elif url.path == "/config":
            ip = q.get("ip", [""])[0].strip()
            if ip:
                s.retarget(ip)
            self._json({"ok": True, "ip": s.peer_ip})
        elif url.path == "/send":
            try:
                bank = max(0, min(7, int(q.get("bank", ["0"])[0])))
                prog = max(0, min(127, int(q.get("prog", ["0"])[0])))
                ch = max(0, min(15, int(q.get("ch", ["0"])[0])))
            except ValueError:
                self._json({"ok": False, "error": "bad params"}, 400)
                return
            # DeepMind 12: bank A-H = Bank Select LSB (CC32) 0-7, MSB (CC0) = 0
            ok = s.send_midi([
                [0xB0 | ch, 0x00, 0x00],
                [0xB0 | ch, 0x20, bank],
                [0xC0 | ch, prog],
            ])
            self._json({"ok": ok})
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, *args):
        pass  # geen HTTP-spam in de terminal


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = [a for a in sys.argv[1:] if a.startswith("--")]
    http_port = 8080
    peer_port = APPLEMIDI_PORT
    for o in opts:
        if o.startswith("--http-port="):
            http_port = int(o.split("=", 1)[1])
        elif o.startswith("--peer-port="):
            peer_port = int(o.split("=", 1)[1])
    ip = args[0] if args else guess_deepmind_ip()

    session = AppleMIDISession(ip, peer_port)
    Handler.session = session
    server = ThreadingHTTPServer(("0.0.0.0", http_port), Handler)

    print("DeepMind 12 WiFi Picker")
    print(f"  DeepMind-IP : {ip}   (aanpasbaar in de web-UI)")
    print(f"  Web-UI      : http://localhost:{http_port}")
    print("  Stoppen     : Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        session.close()
        server.server_close()


if __name__ == "__main__":
    main()
