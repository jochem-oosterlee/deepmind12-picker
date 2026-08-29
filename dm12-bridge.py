#!/usr/bin/env python3
"""
DeepMind 12 — netwerkbrug voor de webversie.

Een browser kan geen UDP praten, dus dit programma doet dat: het houdt een
RTP-MIDI-sessie (AppleMIDI) met de synth open en geeft MIDI door van en naar de
webpagina. Alle kennis over de DeepMind zelf zit in de pagina; dit is puur
transport.

    python dm12-bridge.py                  # zoekt de synth zelf op
    python dm12-bridge.py 192.168.0.227    # of geef het IP-adres op

De router geeft de synth meestal elke keer een ander adres. Zonder argument
begint de brug met het adres dat de vorige keer werkte, en zoekt hij anders
elk net waar deze computer aan hangt af tot er een apparaat antwoordt. Ook
tijdens het draaien: valt de verbinding weg of komt de synth later aan, dan
pikt hij dat vanzelf op.

Open daarna http://localhost:8080 op deze computer, of
http://<ip-van-deze-computer>:8080 op een tablet of telefoon in hetzelfde
netwerk. Het IP van de synth staat op het apparaat onder
GLOBAL -> CONNECTIVITY -> NETWORK SETTINGS.

Alleen de Python-standaardbibliotheek; geen installatie nodig.
"""

import json
import os
import random
import re
import select
import socket
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

APPLEMIDI_SIG = b"\xff\xff"
APPLEMIDI_PORT = 5004
START = time.monotonic()
HERE = os.path.dirname(os.path.abspath(__file__))
APP_FILE = os.path.join(HERE, "dm12-web.html")
# De synth krijgt van de router elke keer een ander adres; het laatste dat
# werkte is de beste eerste gok bij de volgende start.
LAST_IP_FILE = os.path.join(HERE, ".dm12-last-ip")
# Staat er nog geen adres, dan praten we tegen een adres uit de
# documentatieband: dat bestaat nergens, dus het zoeken begint vanzelf.
NO_IP = "192.0.2.1"


def remembered_ip():
    try:
        with open(LAST_IP_FILE, encoding="utf-8") as f:
            ip = f.read().strip()
        return ip if _is_lan(ip) else None
    except OSError:
        return None


def remember_ip(ip):
    if not _is_lan(ip):
        return          # een test of een tunnel: niet het moeite waard
    try:
        with open(LAST_IP_FILE, "w", encoding="utf-8") as f:
            f.write(ip)
    except OSError:
        pass


def ts_now():
    """AppleMIDI-klok: eenheden van 100 microseconden sinds start."""
    return int((time.monotonic() - START) * 10000)


def data_byte_count(status):
    if 0x80 <= status < 0xC0:
        return 2
    if status < 0xE0:
        return 1
    if status < 0xF0:
        return 2
    if status in (0xF1, 0xF3):
        return 1
    if status == 0xF2:
        return 2
    return 0


class AppleMIDISession:
    """Minimale AppleMIDI-initiator: sessie opzetten, kloksync beantwoorden en
    MIDI-berichten heen en weer geven."""

    def __init__(self, peer_ip, peer_port=APPLEMIDI_PORT, name="DM12 Web"):
        self.peer_ip = peer_ip
        self.peer_port = peer_port
        self.name = name
        self.ssrc = random.getrandbits(32)
        self.seq = random.getrandbits(16)
        self.lock = threading.Lock()
        self.stop_flag = False
        self.connected = False
        self.status = "waiting for a connection"
        self.last_rx = 0.0
        self.last_sync = 0.0
        self.last_invite = 0.0
        self.invites = 0
        self.phase = 0  # 0=niets, 1=IN op controlepoort, 2=IN op datapoort
        self.token = 0
        # zelf blijven zoeken zolang er geen verbinding is
        self.searching = False
        self.next_search = 3

        # ontvangen MIDI, met een oplopend nummer zodat de pagina kan bijhouden
        # wat ze al gezien heeft
        self.rx = []
        self.rx_seq = 0
        self.rx_event = threading.Condition(self.lock)
        self.sysex = bytearray()
        self.segments = 0
        self.framing_errors = 0
        self.packets = 0

        self.ctrl, self.data = self._bind_pair()
        threading.Thread(target=self._run, daemon=True).start()

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
        raise RuntimeError("no free UDP ports found")

    def retarget(self, ip, port=APPLEMIDI_PORT):
        with self.lock:
            self._send_bye()
            self.peer_ip = ip
            self.peer_port = port
            self.connected = False
            self.phase = 0
            self.invites = 0
            self.last_invite = 0.0
            self.next_search = 3
            self.status = "waiting for a connection"

    # ---------- zelf de synth opzoeken ----------

    def _maybe_search(self):
        """Antwoordt dit adres niet, kijk dan wie er op het net wel antwoordt."""
        if self.connected or self.searching or self.invites < self.next_search:
            return
        self.next_search = self.invites + 6
        self.searching = True
        threading.Thread(target=self._search, daemon=True).start()

    def _search(self):
        try:
            found = discover()
        except Exception:
            found = []
        ip = pick_synth(found)
        with self.lock:
            self.searching = False
            if self.connected or ip == self.peer_ip:
                return
            if not ip:
                self.status = ("no synth answered on this network; still trying "
                               "(attempt %d)" % self.invites)
                return
        self.retarget(ip)
        self.status = "found the synth at " + ip

    # ---------- pakketten ----------

    def _cmd(self, cmd, token, ssrc=None):
        return (APPLEMIDI_SIG + cmd
                + struct.pack(">III", 2, token, self.ssrc if ssrc is None else ssrc)
                + self.name.encode("utf-8") + b"\x00")

    def _send_invites(self):
        now = time.monotonic()
        if now - self.last_invite < 2.0:
            return
        self.last_invite = now
        if self.phase == 0:
            self.token = random.getrandbits(32)
            self.phase = 1
        self.invites += 1
        if self.phase == 1:
            self.ctrl.sendto(self._cmd(b"IN", self.token), (self.peer_ip, self.peer_port))
        elif self.phase == 2:
            self.data.sendto(self._cmd(b"IN", self.token), (self.peer_ip, self.peer_port + 1))
        if not self.connected:
            self.status = ("searching the network for the synth (attempt %d)"
                           % self.invites) if self.peer_ip == NO_IP else (
                "looking for %s (attempt %d)" % (self.peer_ip, self.invites))
            self._maybe_search()

    def _send_bye(self):
        if self.connected or self.phase > 0:
            try:
                self.ctrl.sendto(self._cmd(b"BY", self.token), (self.peer_ip, self.peer_port))
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
                        self.status = "connection lost, reconnecting"
            try:
                readable, _, _ = select.select([self.ctrl, self.data], [], [], 0.5)
            except OSError:
                break
            for sock in readable:
                try:
                    pkt, addr = sock.recvfrom(16384)
                except OSError:
                    continue
                with self.lock:
                    self._handle(sock, pkt, addr)

    def _handle(self, sock, pkt, addr):
        self.last_rx = time.monotonic()
        if len(pkt) >= 4 and pkt[:2] == APPLEMIDI_SIG:
            cmd = pkt[2:4]
            if cmd == b"OK" and len(pkt) >= 16:
                token = struct.unpack(">I", pkt[8:12])[0]
                if token != self.token:
                    return
                if self.phase == 1 and sock is self.ctrl:
                    self.phase = 2
                    self.last_invite = 0.0
                    self._send_invites()
                elif self.phase == 2 and sock is self.data:
                    self.connected = True
                    remember_ip(self.peer_ip)
                    peer = pkt[16:].split(b"\x00")[0].decode("utf-8", "replace")
                    self.status = "connected to " + (peer or self.peer_ip)
                    self.last_sync = time.monotonic()
                    self._send_ck(0, ts_now(), 0, 0)
            elif cmd == b"NO":
                self.status = "connection refused by the device"
                self.phase = 0
            elif cmd == b"IN" and len(pkt) >= 16:
                token = struct.unpack(">I", pkt[8:12])[0]
                sock.sendto(self._cmd(b"OK", token), addr)
            elif cmd == b"CK" and len(pkt) >= 36:
                count = pkt[8]
                ts1, ts2, _ = struct.unpack(">QQQ", pkt[12:36])
                if count == 0:
                    self._send_ck(1, ts1, ts_now(), 0)
                elif count == 1:
                    self._send_ck(2, ts1, ts2, ts_now())
            elif cmd == b"BY":
                self.connected = False
                self.phase = 0
                self.last_invite = 0.0
                self.status = "the device closed the connection"
        else:
            self._parse_rtp_midi(pkt)

    # ---------- MIDI ontvangen ----------

    @staticmethod
    def _skip_delta(pkt, i, end):
        while i < end and (pkt[i] & 0x80):
            i += 1
        return i + 1 if i < end else i

    def _emit(self, msg):
        self.rx_seq += 1
        self.rx.append((self.rx_seq, msg))
        del self.rx[:-500]
        self.rx_event.notify_all()

    def _consume_sysex(self, pkt, i, end):
        self.segments += 1
        while i < end:
            v = pkt[i]
            i += 1
            if v == 0xF7:                      # laatste deel: bericht compleet
                self.sysex.append(0xF7)
                self._emit(bytes(self.sysex))
                self.sysex = bytearray()
                return i
            if v == 0xF0:                      # deel af, vervolg komt later
                return i
            if v in (0xF4, 0xF5):              # afgebroken
                self.sysex = bytearray()
                return i
            if v >= 0x80:                      # uitlijning kwijt
                self.framing_errors += 1
                self.sysex = bytearray()
                return i - 1
            self.sysex.append(v)
        return i

    def _parse_rtp_midi(self, pkt):
        """Zelfde codering als RFC 6295: een niet-laatste SysEx-deel eindigt met
        F0 en een vervolg begint met F7."""
        if len(pkt) < 13:
            return
        self.packets += 1
        b0 = pkt[12]
        if b0 & 0x80:
            if len(pkt) < 14:
                return
            length = ((b0 & 0x0F) << 8) | pkt[13]
            off = 14
        else:
            length = b0 & 0x0F
            off = 13
        leading_delta = bool(b0 & 0x20)
        end = min(len(pkt), off + length)
        i = off
        first = True
        running = 0

        if self.sysex:
            if i < end and pkt[i] == 0xF7:
                s = i + 1
            else:
                d = self._skip_delta(pkt, i, end)
                s = d + 1 if d < end and pkt[d] == 0xF7 else i
            i = self._consume_sysex(pkt, s, end)
            first = False

        while i < end:
            if not first or leading_delta:
                i = self._skip_delta(pkt, i, end)
            first = False
            if i >= end:
                break
            st = pkt[i]
            if st == 0xF0:
                self.sysex = bytearray([0xF0])
                i = self._consume_sysex(pkt, i + 1, end)
                continue
            if st == 0xF7 and self.sysex:
                i = self._consume_sysex(pkt, i + 1, end)
                continue
            if st >= 0x80:
                i += 1
                if st < 0xF0:
                    running = st
            else:
                st = running
            if st == 0:
                break
            n = data_byte_count(st)
            if i + n > end:
                break
            self._emit(bytes([st]) + bytes(pkt[i:i + n]))
            i += n

    def take(self, since, wait=0.0):
        """Berichten met een nummer hoger dan `since`, eventueel even wachtend."""
        with self.lock:
            if wait > 0 and (not self.rx or self.rx[-1][0] <= since):
                self.rx_event.wait(wait)
            msgs = [(n, m) for (n, m) in self.rx if n > since]
            nxt = self.rx[-1][0] if self.rx else since
            return nxt, [m.hex() for (_, m) in msgs]

    # ---------- MIDI versturen ----------

    def send_midi(self, messages):
        with self.lock:
            if not self.connected:
                return False
            payload = b""
            for idx, msg in enumerate(messages):
                if idx:
                    payload += b"\x00"     # delta-tijd 0
                payload += bytes(msg)
            if len(payload) < 16:
                header = bytes([len(payload)])
            else:
                header = bytes([0x80 | (len(payload) >> 8), len(payload) & 0xFF])
            self.seq = (self.seq + 1) & 0xFFFF
            rtp = struct.pack(">BBHII", 0x80, 0x61, self.seq,
                              ts_now() & 0xFFFFFFFF, self.ssrc)
            try:
                self.data.sendto(rtp + header + payload, (self.peer_ip, self.peer_port + 1))
                return True
            except OSError:
                return False

    def close(self):
        self.stop_flag = True
        with self.lock:
            self._send_bye()
        self.ctrl.close()
        self.data.close()


# ======================================================================
#  Zoeken op het netwerk
# ======================================================================

def local_ipv4():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 9))  # verstuurt niets
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def local_ipv4s():
    """Alle bruikbare eigen adressen: een pc hangt vaak aan meer dan een net."""
    ips = []
    first = local_ipv4()
    if first:
        ips.append(first)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    # Een pc met zowel wifi als kabel geeft via de naam vaak maar een adres
    # terug; het systeem zelf weet ze allemaal.
    try:
        cmd = ["ipconfig"] if os.name == "nt" else ["ip", "-4", "-o", "addr"]
        out = subprocess.run(cmd, capture_output=True, timeout=5).stdout.decode(
            "utf-8", "replace")
        for ip in re.findall(r"(\d{1,3}(?:\.\d{1,3}){3})", out):
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    # Alleen echte adressen in een thuisnet: geen netmaskers, geen loopback en
    # geen 169.254.x (een net zonder DHCP, daar staat niets).
    return [ip for ip in ips if _is_lan(ip)]


def _is_lan(ip):
    try:
        a, b = (int(x) for x in ip.split(".")[:2])
    except ValueError:
        return False
    if ip.endswith(".0") or ip.endswith(".255"):
        return False
    return (a == 10) or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31)


def pick_synth(found):
    """Kiest uit wat er antwoordde het apparaat dat naar een DeepMind klinkt."""
    if not found:
        return None
    for entry in found:
        name = entry.split(" ", 1)[1].lower() if " " in entry else ""
        if "deepmind" in name or "dm12" in name or "behringer" in name:
            return entry.split(" ")[0]
    return found[0].split(" ")[0]


def discover(timeout=2.5):
    """Nodigt elk adres op de eigen netten uit en kijkt wie antwoordt."""
    subnets = []
    for own in local_ipv4s():
        base = own.rsplit(".", 1)[0] + "."
        if base not in subnets:
            subnets.append(base)
    if not subnets:
        return []
    mine = set(local_ipv4s())
    ssrc = random.getrandbits(32)
    token = random.getrandbits(32)
    probe = (APPLEMIDI_SIG + b"IN" + struct.pack(">III", 2, token, ssrc)
             + b"DM12 Web\x00")
    found = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.25)
    try:
        for base in subnets:
            for host in range(1, 255):
                ip = base + str(host)
                if ip in mine:
                    continue
                try:
                    s.sendto(probe, (ip, APPLEMIDI_PORT))
                except OSError:
                    pass
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                pkt, addr = s.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            if len(pkt) >= 4 and pkt[:2] == APPLEMIDI_SIG and pkt[2:4] in (b"OK", b"NO"):
                name = pkt[16:].split(b"\x00")[0].decode("utf-8", "replace").strip()
                entry = addr[0] + (" (%s)" % name if name else "")
                if entry not in found:
                    found.append(entry)
                try:  # netjes afmelden, we maken geen sessie
                    s.sendto(APPLEMIDI_SIG + b"BY"
                             + struct.pack(">III", 2, token, ssrc) + b"DM12 Web\x00", addr)
                except OSError:
                    pass
    finally:
        s.close()
    return found


# ======================================================================
#  Webserver
# ======================================================================

class Handler(BaseHTTPRequestHandler):
    session = None
    discovery = {"running": False, "found": [], "status": ""}

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _start_discovery(self):
        if Handler.discovery["running"]:
            return
        Handler.discovery = {"running": True, "found": [], "status": "searching…"}

        def run():
            found = discover()
            Handler.discovery = {
                "running": False, "found": found,
                "status": ("%d device(s) found" % len(found)) if found
                          else "nothing found on this network",
            }
        threading.Thread(target=run, daemon=True).start()

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        s = Handler.session

        if url.path == "/":
            if not os.path.exists(APP_FILE):
                self.send_error(500, "dm12-web.html is missing - run "
                                     "'node web/build-web.js' first")
                return
            with open(APP_FILE, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif url.path.startswith("/local-assets/"):
            # Eigen afbeeldingen en stijl van de gebruiker. Blijft buiten het
            # project; alleen bestanden binnen deze map worden geserveerd.
            rel = url.path[len("/local-assets/"):]
            base = os.path.join(HERE, "local-assets")
            target = os.path.abspath(os.path.join(base, rel))
            if not target.startswith(os.path.abspath(base) + os.sep)                     or not os.path.isfile(target):
                self.send_error(404, "not found")
                return
            ext = os.path.splitext(target)[1].lower()
            types = {".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
                     ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
                     ".webp": "image/webp", ".woff2": "font/woff2"}
            with open(target, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", types.get(ext, "application/octet-stream"))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif url.path == "/status":
            self._json({
                "connected": s.connected, "status": s.status,
                "ip": "" if s.peer_ip == NO_IP else s.peer_ip,
                "packets": s.packets, "segments": s.segments,
                "framing": s.framing_errors, "transport": "bridge",
            })

        elif url.path == "/config":
            ip = q.get("ip", [""])[0].strip()
            if ip:
                s.retarget(ip)
            self._json({"ok": True, "ip": s.peer_ip})

        elif url.path == "/discover":
            if q.get("start"):
                self._start_discovery()
            self._json(Handler.discovery)

        elif url.path == "/recv":
            try:
                since = int(q.get("since", ["0"])[0])
            except ValueError:
                since = 0
            wait = 1.0 if q.get("wait") else 0.0
            nxt, msgs = s.take(since, wait)
            self._json({"next": nxt, "msgs": msgs, "connected": s.connected})

        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/midi":
            self._json({"error": "not found"}, 404)
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(n).decode("ascii", "replace")
        except Exception:
            self._json({"ok": False}, 400)
            return
        ok = True
        for line in body.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                msg = bytes.fromhex(line)
            except ValueError:
                ok = False
                continue
            # elk bericht apart, zodat de volgorde gegarandeerd blijft
            if not Handler.session.send_midi([msg]):
                ok = False
        self._json({"ok": ok})

    def log_message(self, *args):
        pass  # geen HTTP-geruis in de terminal


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    http_port = 8080
    for o in [a for a in sys.argv[1:] if a.startswith("--")]:
        if o.startswith("--http-port="):
            http_port = int(o.split("=", 1)[1])

    searching = False
    if args:
        ip = args[0]
    else:
        ip = remembered_ip()
        if ip:
            print("Trying the address that worked last time: %s" % ip)
        else:
            # niets om te proberen: de sessie gaat vanzelf het net afzoeken
            ip = NO_IP
            searching = True

    session = AppleMIDISession(ip)
    Handler.session = session
    server = ThreadingHTTPServer(("0.0.0.0", http_port), Handler)
    own = local_ipv4() or "localhost"

    print("DeepMind 12 - network bridge")
    print("  synth      : %s" % ("searching the network..." if searching else ip))
    print("  this pc    : http://localhost:%d" % http_port)
    print("  tablet     : http://%s:%d" % (own, http_port))
    print("  stop       : Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        session.close()
        server.server_close()


if __name__ == "__main__":
    main()
