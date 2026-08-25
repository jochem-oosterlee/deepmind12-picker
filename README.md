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
- On connecting, the app sends an **App Notify** SysEx. The synth then enables NRPN
  and SysEx on that interface and reports its device ID and current program.

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
python dm12-bridge.py                  # finds the synth on the network
python dm12-bridge.py 192.168.0.227    # or name it
```

Then open `http://localhost:8080` on that computer, or
`http://<its-ip>:8080` from a tablet or phone on the same network. Standard
library only, no installation. The page notices it is being served by the bridge
and uses it instead of Web MIDI.

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
