# DeepMind 12 Controller

Control a Behringer DeepMind 12 from a tablet, phone or PC: pick presets, edit
parameters, and read or write the synth's own memory — over WiFi, USB, or a
network bridge.

| Variant | Where | Connection | Good for |
|---|---|---|---|
| Android app | `android/` | AppleMIDI / RTP-MIDI over WiFi | tablet or phone, no extra software |
| PC version | `dm12-web.html` | Web MIDI, or the network bridge | the same app with a real keyboard |
| Network bridge | `dm12-bridge.py` | AppleMIDI over WiFi, served over HTTP | any browser on the network, no driver |
| Preset picker | `deepmind-preset-picker.html` | Web MIDI | just picking presets, nothing to set up |

## What it does

- **Presets** — banks A–H, 1024 programs, search, favourites, and your own names
  on top of the ones read from the synth.
- **Editor** — over 150 parameters through NRPN: oscillators, filter, all three
  envelopes, LFOs, voice allocation, arpeggiator, control sequencer, the four FX
  slots (type, gain and twelve parameters each) and the modulation matrix.
- **Follows the synth** — it reads the edit buffer and puts every control on the
  synth's real values. Move a fader on the instrument and the app moves with it.
- **Library** — reads the real program names and categories out of the synth (one
  SysEx request per bank returns 128 names), fetches whole patches, stores them on
  the device, and sends them back to the edit buffer or writes them to a slot.
- **Global settings** — reads the synth's 45 global bytes and keeps re-reading
  while you are on that tab, so changing something in the synth's GLOBAL menu
  immediately highlights the byte it belongs to. Name it, name its values, and
  file it into menus you build yourself.

## How it works

The DeepMind 12 selects programs with **Bank Select LSB (CC32, value 0–7 for banks
A–H)** followed by a **Program Change (0–127)**. On the synth, set
*GLOBAL → MIDI SETTINGS → PROGRAM CHANGE* to *Rx* or *Both*.

Parameters travel as **NRPN**: the parameter number in CC99/CC98, the 0–255 value
in CC6/CC38. The parameter number from the manual's NRPN table is also the **byte
position inside the program data** (242 bytes), where the name sits as ASCII at
offset 223 and the category at 240. Program data is sent in "packed MS bit" form:
every 8 transmitted 7-bit bytes carry 7 data bytes, with their high bits in the
first byte of the group.

Two details cost real debugging time and are worth knowing:

- A large SysEx message is split across RTP packets. Per RFC 6295 a non-final
  segment **ends with `F0`** and a continuation **starts with `F7`**. Treating that
  trailing `F0` as data shifts everything after it — which shows up as unreadable
  preset names from the fourteenth name onwards.
- On connecting, the app sends an **App Notify** SysEx. The synth replies with its
  device ID, MIDI channel and current program. The manual claims this also switches
  the interface to NRPN automatically; measured on a DeepMind 12 it does **not** —
  set the control mode for the interface you use to NrPr yourself.

### Global settings (measured, not in the manual)

Everything below was measured on a DeepMind 12 running firmware **1.1.2-619**
(host, voice and DSP), boot 23, WiFi module 2.7.0.0 - worth knowing, because
some of it does not exist in earlier firmware and none of it is in the 2016
manual.

The manual documents 24 global settings and a 45-byte block. Neither still holds:

- The block is **56 bytes**. A DeepMind 12 answers a Global Parameter Dump Request
  with 64 packed bytes, so cutting off at 45 loses eleven settings — among them the
  three WiFi interface settings the 2016 manual does not mention at all.
- Global settings are ordinary **NRPN parameters at 300 + the byte position**.
  Verified on bytes 33, 36, 46 and 51. This is how the synth reports them too:
  change one on the panel and it sends that NRPN number.
- Writing the settings block back (a Global Parameter Dump Response) is accepted
  for some bytes and silently refused for others — byte 46 refused every value
  while byte 33 took them. NRPN is accepted for all of them, so that is what this
  app uses.
- SysEx command `0x17` (11 bytes) is sent when a setting is changed on the panel;
  it does not appear for changes made over MIDI. Undocumented, and not needed.
- **VCA-MODE is global byte 47** (so NRPN 347): 0 is transparent, 1 is ballsy -
  the louder VCA characteristic from before firmware 1.0.5. It arrived in 1.1.0
  and is in neither the 2016 manual nor its parameter table; found by switching
  it on the instrument and watching which number came past.
- Parameter names and value labels cannot be read from the synth — MIDI carries
  numbers only. The Global tab lets you name them once and export the result.

### Bipolar parameters, and one number that means two things

Ten parameters run from -128 to +127 while the wire carries 0-255: pan spread
(83), OSC portamento balance (91) and the eight mod depths (95, 98, 101, 104,
107, 110, 113, 116). The app shows them signed, the way the instrument does.

Note 113 in that list. As an NRPN it is Mod 7 Depth; as a control change it is
Analog Thru. Same number, different namespace - the two are unrelated and both
mappings in the app are correct.

### Two parameters the manual files under the oscillators

Numbers 91 and 92 are named "OSC Portamento Balance" and "OSC Key Down Reset"
in the parameter table, and key down reset gets its own drawing in the OSC 1
pages. Both sat under Voice here, which is where a synth editor tends to put
them; they belong with the oscillators.

### LFO phase (from the instrument's own menu)

Parameter 5 holds three settings in one byte, and the 256 values fit them
exactly: **0 is poly**, **1 is mono**, and **2 to 255 is a phase offset per
voice**, which the instrument shows in degrees as 1° to 254°. So the number on
screen is one less than the number on the wire. The app's fader reads degrees
and the two lamps beside it show poly and mono. Slew (parameter 6) is an
ordinary 0-255.

### An LFO rate that follows the clock (measured)

With arp sync on (parameter 4), the panel no longer shows a rate but a note
value: twenty of them, from four bars down to a sixty-fourth. The parameter
itself does not change shape — with sync on, turning the rate knob still sends
the full 0-255 range, so the twenty steps are bands of 256/20 across it. The
LFO panel snaps the fader to those bands and sends the middle of one.

## Android app

```
cd android
gradle assembleDebug   # or open the folder in Android Studio
```

The APK lands in `android/app/build/outputs/apk/debug/`; a built one is under
[Releases](../../releases). The app finds the synth by scanning the subnet, or you
type its IP address. In access-point mode it connects to the synth's own WiFi
network on request.

## PC version

`dm12-web.html` is the same app with Web MIDI instead of Android's WiFi layer.
Open it in Chrome or Edge, allow MIDI including SysEx, and pick a MIDI port by
typing part of its name. Connect over USB, or over WiFi with
[rtpMIDI](https://www.tobias-erichsen.de/software/rtpmidi.html) as a network port.
If `file://` will not do, serve it with `python -m http.server` and open
`http://localhost:8000/dm12-web.html`.

It is generated from the same interface as the Android app:

```
node web/build-web.js
```

## Network bridge

A browser cannot speak UDP, so this does it for the browser: it keeps an RTP-MIDI
session with the synth and passes MIDI through over HTTP. All DeepMind knowledge
stays in the page, so the bridge is pure transport.

```
python dm12-bridge.py                  # finds the synth by itself
python dm12-bridge.py 192.168.0.227    # or name it

The router usually hands the synth a different address every time, so the
bridge does not rely on one: it starts with the address that worked last
time and otherwise sweeps every network this computer is on until a device
answers. It keeps doing that while it runs, so a synth that is switched on
later, or that moves to another address, is picked up on its own.
```

Then open `http://localhost:8080` on that computer, or
`http://<its-ip>:8080` from a tablet or phone on the same network. Standard
library only, no installation. The page notices it is being served by the bridge
and uses it instead of Web MIDI.

The bridge listens on IPv4 **and** IPv6. That is not a nicety: Windows resolves
`localhost` to `::1` first, and if nothing answers there the browser waits about
two seconds before trying IPv4 — for every single request. Measured on this
machine: 2026 ms per request against `localhost`, 4 ms against `127.0.0.1`.
Listening on both, and keeping the connection open with HTTP/1.1, brought that
down to about 1 ms. If the app ever feels sluggish again, time a plain
`/status` request before blaming the WiFi.


## Tests

Three suites, none of which need an emulator or a device.

```
node android/test-ui.js android/app/src/main/assets/index.html
node android/test-ui.js dm12-web.html
```
runs the interface code against a stubbed DOM and native layer: it checks that
every tab, bank button and preset renders, clicks every button, and verifies the
MIDI that comes out.

```
javac -d out android/app/src/main/java/nl/jochem/dm12picker/RtpMidiParser.java \
      android/app/src/main/java/nl/jochem/dm12picker/SysexLibrary.java \
      android/test/RtpMidiParserTest.java
java -cp out nl.jochem.dm12picker.RtpMidiParserTest
```
tests the RTP-MIDI parsing and the SysEx library: a full bank-names dump is
packed, cut into segments the way RFC 6295 does it, and read back out with names,
category and patch data intact. `RtpMidiParser` and `SysexLibrary` are free of
Android dependencies for exactly this reason.

```
node web/test-bridge.js
python web/test-python-bridge.py
```
do the same for the PC version and the network bridge against a stubbed MIDI port
and a fake DeepMind, including the check that writing one global setting leaves
the other 44 bytes untouched.

## Licence

MIT — see [LICENSE](LICENSE). Not affiliated with Behringer or Music Tribe.
