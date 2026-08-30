"""
Test van dm12-bridge.py tegen een nagemaakte DeepMind: sessie opzetten, MIDI
sturen via HTTP, en een banknamen-dump in stukken terugkrijgen zoals RFC 6295
die codeert (niet-laatste deel eindigt op F0, vervolg begint met F7).

    python web/test-python-bridge.py
"""
import importlib.util
import json
import os
import socket
import struct
import sys
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("dm12", os.path.join(ROOT, "dm12-bridge.py"))
dm12 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dm12)

SIG = b"\xff\xff"
CTRL = 15104
HTTP = 18081
failures = 0


def check(ok, what):
    global failures
    print(("  ok   " if ok else "  FOUT ") + what)
    if not ok:
        failures += 1


def pack7(data):
    out = bytearray()
    for i in range(0, len(data), 7):
        chunk = data[i:i + 7]
        msbs = 0
        for j, b in enumerate(chunk):
            if b & 0x80:
                msbs |= 1 << j
        out.append(msbs)
        out.extend(b & 0x7F for b in chunk)
    return bytes(out)


def rtp(midi_list):
    """RTP-MIDI-pakket zonder delta-tijd voor het eerste bericht."""
    head = struct.pack(">BBHII", 0x80, 0x61, 1, 0, 0x2222)
    if len(midi_list) < 16:
        return head + bytes([len(midi_list)]) + midi_list
    return head + bytes([0x80 | (len(midi_list) >> 8), len(midi_list) & 0xFF]) + midi_list


def segments(sysex, chunk):
    """Knipt een compleet SysEx-bericht op zoals RFC 6295: F0..F0, F7..F0, F7..F7."""
    body, out, pos, first = sysex[1:-1], [], 0, True
    while pos < len(body):
        n = min(chunk, len(body) - pos)
        last = pos + n >= len(body)
        out.append(bytes([0xF0 if first else 0xF7]) + body[pos:pos + n]
                   + bytes([0xF7 if last else 0xF0]))
        pos += n
        first = False
    return out


received = []


def fake_deepmind():
    ctrl = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    data = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ctrl.bind(("127.0.0.1", CTRL))
    data.bind(("127.0.0.1", CTRL + 1))
    my_ssrc = 0x33445566
    peer = {}
    import select as sel
    while True:
        r, _, _ = sel.select([ctrl, data], [], [], 0.2)
        for s in r:
            pkt, addr = s.recvfrom(16384)
            if pkt[:2] == SIG:
                cmd = pkt[2:4]
                if cmd == b"IN":
                    token = struct.unpack(">I", pkt[8:12])[0]
                    s.sendto(SIG + b"OK" + struct.pack(">III", 2, token, my_ssrc)
                             + b"FakeDeepMind\x00", addr)
                    if s is data:
                        peer["addr"] = addr
                elif cmd == b"CK":
                    count = pkt[8]
                    ts1, _, _ = struct.unpack(">QQQ", pkt[12:36])
                    if count == 0:
                        s.sendto(SIG + b"CK" + struct.pack(">I", my_ssrc)
                                 + bytes([1, 0, 0, 0])
                                 + struct.pack(">QQQ", ts1, 1234, 0), addr)
            else:
                # binnenkomende MIDI van de brug uitpakken
                header = pkt[12]
                if header & 0x80:
                    length = ((header & 0x0F) << 8) | pkt[13]
                    payload = pkt[14:14 + length]
                else:
                    payload = pkt[13:13 + (header & 0x0F)]
                received.append(payload.hex())
                # op een edit-buffer-verzoek antwoorden met een dump in stukken
                if payload[:1] == b"\xf0" and len(payload) > 6 and payload[6] == 0x03:
                    send_dump(data, peer.get("addr", addr))


def send_dump(sock, addr):
    names = bytearray()
    for i in range(128):
        nm = ("Test %d AB" % (i + 1)).encode("ascii")
        names += nm + bytes(16 - len(nm))
    msg = (b"\xf0\x00\x20\x32\x20\x00\x0b\x06\x02" + pack7(bytes(names)) + b"\xf7")
    seq = 100
    for seg in segments(msg, 256):
        seq += 1
        head = struct.pack(">BBHII", 0x80, 0x61, seq, 0, 0x2222)
        body = bytes([0x80 | (len(seg) >> 8), len(seg) & 0xFF]) + seg if len(seg) >= 16 \
            else bytes([len(seg)]) + seg
        sock.sendto(head + body, addr)
        time.sleep(0.005)


def check_helpers():
    print("de synth opzoeken:")
    check(dm12._is_lan("192.168.0.227") and dm12._is_lan("10.1.2.3")
          and dm12._is_lan("172.20.0.5"), "thuisadressen tellen mee")
    check(not dm12._is_lan("255.255.255.0") and not dm12._is_lan("8.8.8.8")
          and not dm12._is_lan("169.254.1.2") and not dm12._is_lan("192.168.0.255"),
          "netmaskers, internet en 169.254 vallen af")
    check(dm12.pick_synth(["192.168.0.5 (Studio Mac)", "192.168.0.44 (DeepMind12)"])
          == "192.168.0.44", "kiest het apparaat dat DeepMind heet")
    check(dm12.pick_synth(["192.168.0.9"]) == "192.168.0.9",
          "zonder naam: dan maar de eerste")
    check(dm12.pick_synth([]) is None, "niets gevonden is geen adres")

    # het laatst werkende adres onthouden, en onzin niet
    keep = dm12.LAST_IP_FILE
    dm12.LAST_IP_FILE = os.path.join(ROOT, ".dm12-test-ip")
    try:
        dm12.remember_ip("192.168.0.227")
        check(dm12.remembered_ip() == "192.168.0.227", "adres onthouden")
        dm12.remember_ip("127.0.0.1")
        check(dm12.remembered_ip() == "192.168.0.227", "loopback overschrijft niets")
    finally:
        try:
            os.remove(dm12.LAST_IP_FILE)
        except OSError:
            pass
        dm12.LAST_IP_FILE = keep


# Uitvoer van netsh, zoals een Nederlandse Windows hem geeft: de meldingen en de
# meeste sleutels zijn vertaald, "SSID" niet. De code mag dus alleen daarop
# afgaan, en op de vorm van de blokken.
NETSH_HEAD = """Er is %d interface op het systeem:
"""
NETSH_IFACE = """
    Naam                   : %s
    Stuurprogramma         : Testadapter
    GUID                   : 40cab3d4-8905-4dcb-9a74-0f7f9880e081
    Status                 : %s
    SSID                   : %s
    AP BSSID               : 02:11:22:33:44:55
"""
NETSH_NET = """    SSID 1 : Thuisnet
    SSID 2 : Deepmind12
"""
NETSH_NET_HOME = """    SSID 1 : Thuisnet
"""
NETSH_PROFILE = """    Profiel voor alle gebruikers : %s
"""


def check_ap():
    """Verbinden met het accesspoint van de synth, met netsh nagemaakt."""
    print("accesspoint van de synth:")
    calls = []
    # een pc met een ingebouwde adapter op het thuisnet en een tweede erbij
    state = {"ifaces": [["Wi-Fi", "Thuisnet"], ["Wi-Fi 2", ""]],
             "profiles": [], "in_range": True, "xml": ""}

    def find(name):
        for iface in state["ifaces"]:
            if iface[0] == name:
                return iface
        return None

    def fake_netsh(*args):
        calls.append(" ".join(args))
        if args[:2] == ("show", "interfaces"):
            out = NETSH_HEAD % len(state["ifaces"])
            for name, ssid in state["ifaces"]:
                out += NETSH_IFACE % (
                    name, "verbonden" if ssid else "niet verbonden", ssid)
            return out
        if args[:2] == ("show", "networks"):
            return NETSH_NET if state["in_range"] else NETSH_NET_HOME
        if args[:2] == ("show", "profiles"):
            return "".join(NETSH_PROFILE % p for p in state["profiles"])
        if args[:2] == ("add", "profile"):
            with open(args[2].split("=", 1)[1], encoding="utf-8") as f:
                state["xml"] = f.read()
            state["profiles"].append("Deepmind12")
            return "Profiel Deepmind12 is toegevoegd aan interface Wi-Fi."
        if args[0] == "connect":
            iface = find(args[2].split("=", 1)[1])
            if iface:
                iface[1] = args[1].split("=", 1)[1]
            return "Verbindingsaanvraag is voltooid."
        return ""

    keep_netsh, keep_win = dm12._netsh, dm12._windows
    dm12._netsh, dm12._windows = fake_netsh, lambda: True
    dm12.AP.update(back_to=None, iface=None, takeover=False, said=False)
    dm12._here["at"] = 0.0
    try:
        names = [i["name"] for i in dm12.wlan_interfaces()]
        check(names == ["Wi-Fi", "Wi-Fi 2"], "beide adapters gelezen: %s" % names)
        check(dm12.wlan_in_range("Deepmind12"), "accesspoint staat in de lucht")
        check(not dm12.on_ap(), "we zitten er nog niet op")

        state["in_range"] = False
        check(dm12.ap_join() is False and find("Wi-Fi 2")[1] == "",
              "accesspoint uit: niets doen")

        state["in_range"] = True
        check(dm12.ap_join() is True, "accesspoint aan: erbij verbinden")
        check(find("Wi-Fi")[1] == "Thuisnet", "het thuisnet blijft waar het was")
        check(find("Wi-Fi 2")[1] == "Deepmind12", "de vrije adapter pakt de synth")
        check(dm12.AP["back_to"] is None, "niets om naar terug te keren")
        check("PassPhrase" in state["xml"] and "WPA2PSK" in state["xml"],
              "profiel met het wachtwoord erin")
        check(not os.path.exists(os.path.join(ROOT, ".dm12-ap-profile.xml")),
              "profielbestand weer opgeruimd")

        dm12._here["at"] = 0.0
        calls[:] = []
        check(dm12.ap_join() is False
              and not any(c.startswith("connect") for c in calls),
              "al verbonden: niet opnieuw")

        # en met maar een adapter, die bezet is: afblijven
        state["ifaces"] = [["Wi-Fi", "Thuisnet"]]
        dm12._here["at"] = 0.0
        calls[:] = []
        check(dm12.ap_join() is False
              and not any(c.startswith("connect") for c in calls)
              and find("Wi-Fi")[1] == "Thuisnet",
              "enige adapter is bezet: het thuisnet blijft staan")
        check("adapter" in dm12.AP["note"], "en zegt waarom: %r" % dm12.AP["note"])

        # tenzij erom gevraagd is
        dm12.AP["takeover"] = True
        dm12._here["at"] = 0.0
        check(dm12.ap_join() is True and find("Wi-Fi")[1] == "Deepmind12",
              "met --ap-takeover mag hij hem toch overnemen")
        check(dm12.AP["back_to"] == "Thuisnet" and dm12.AP["iface"] == "Wi-Fi",
              "onthoudt waar die adapter vandaan kwam")
        dm12.ap_restore()
        check(find("Wi-Fi")[1] == "Thuisnet", "en zet hem bij het afsluiten terug")
    finally:
        dm12._netsh, dm12._windows = keep_netsh, keep_win
        dm12.AP.update(back_to=None, iface=None, takeover=False, said=False)
        dm12._here["ifaces"] = None
        dm12._here["at"] = 0.0


def main():
    check_helpers()
    check_ap()
    threading.Thread(target=fake_deepmind, daemon=True).start()
    time.sleep(0.2)

    session = dm12.AppleMIDISession("127.0.0.1", CTRL)
    dm12.Handler.session = session
    from http.server import ThreadingHTTPServer
    srv = ThreadingHTTPServer(("127.0.0.1", HTTP), dm12.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    print("sessie opzetten:")
    deadline = time.time() + 10
    while time.time() < deadline and not session.connected:
        time.sleep(0.1)
    check(session.connected, "verbonden: " + session.status)

    base = "http://127.0.0.1:%d" % HTTP
    st = json.loads(urllib.request.urlopen(base + "/status").read())
    check(st["connected"] and st["transport"] == "bridge", "status via HTTP: %s" % st["status"])

    print("MIDI sturen via HTTP:")
    body = "b0000a\nb0200a\nc029".encode("ascii")
    req = urllib.request.Request(base + "/midi", data=body, method="POST")
    res = json.loads(urllib.request.urlopen(req).read())
    time.sleep(0.4)
    check(res["ok"], "POST /midi geaccepteerd")
    check("b0000a" in received and "c029" in received,
          "drie berichten aangekomen in volgorde: %s" % received[-3:])

    print("dump in stukken terugkrijgen:")
    req = urllib.request.Request(base + "/midi",
                                 data=b"f000203220000" + b"3f7", method="POST")
    # (verzoek om de edit buffer: f0 00 20 32 20 00 03 f7)
    req = urllib.request.Request(base + "/midi", data=b"f0002032200003f7", method="POST")
    urllib.request.urlopen(req).read()

    got = []
    nxt = 0
    deadline = time.time() + 6
    while time.time() < deadline:
        d = json.loads(urllib.request.urlopen(base + "/recv?since=%d&wait=1" % nxt).read())
        nxt = d["next"]
        got += d["msgs"]
        if any(m.startswith("f000203220000b") for m in got):
            break
    dumps = [m for m in got if m.startswith("f000203220000b")]
    check(len(dumps) == 1, "één samengevoegd bericht (%d)" % len(dumps))
    check(session.framing_errors == 0, "geen uitlijnfouten (%d)" % session.framing_errors)
    if dumps:
        raw = bytes.fromhex(dumps[0])
        check(len(raw) > 2300, "volledige lengte: %d bytes" % len(raw))
        # namen eruit halen zoals de webpagina dat doet
        packed = raw[9:-1]
        out = bytearray()
        i = 0
        while i < len(packed) and len(out) < 2048:
            msbs = packed[i]
            i += 1
            for j in range(7):
                if i >= len(packed) or len(out) >= 2048:
                    break
                out.append((packed[i] & 0x7F) | (((msbs >> j) & 1) << 7))
                i += 1
        first = bytes(out[0:16]).split(b"\x00")[0].decode()
        n14 = bytes(out[13 * 16:14 * 16]).split(b"\x00")[0].decode()
        last = bytes(out[127 * 16:128 * 16]).split(b"\x00")[0].decode()
        check(first == "Test 1 AB", "eerste naam: %r" % first)
        check(n14 == "Test 14 AB", "veertiende naam: %r" % n14)
        check(last == "Test 128 AB", "laatste naam: %r" % last)

    session.close()
    srv.shutdown()
    print("MISLUKT: %d fouten" % failures if failures else "ALLE BRIDGE-TESTS GESLAAGD")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
