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


def main():
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
