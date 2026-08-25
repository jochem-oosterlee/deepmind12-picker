# DeepMind 12 Program Picker

Preset/program picker voor de Behringer DeepMind 12: kies met één tik of klik een
programma (bank A–H, 1–128) op de synth. Drie varianten, van desktop tot tablet:

| Variant | Bestand | Verbinding | Voor |
|---|---|---|---|
| Web-app (desktop) | `deepmind-preset-picker.html` | USB-MIDI via Web MIDI (Chrome/Edge) | pc/Mac |
| WiFi-bridge | `dm12-bridge.py` | AppleMIDI / RTP-MIDI over WiFi | elk apparaat met Python (bijv. Termux) |
| Android-app | `android/` | AppleMIDI / RTP-MIDI over WiFi | Android-tablet/-telefoon |

Alle varianten hebben dezelfde features: banken A–H, hernoembare presets
(lokaal opgeslagen), favorieten met eigen tabblad, zoeken en back-up/herstel.

## Hoe het werkt

De DeepMind 12 selecteert programma's via MIDI **Bank Select LSB (CC32, waarde 0–7
voor bank A–H)** gevolgd door **Program Change (0–127)**. Zet op de synth
*GLOBAL → MIDI SETTINGS → PROGRAM CHANGE* op *Rx* of *Both*.

Voor de WiFi-varianten maakt de synth zelf een accesspoint of verbindt hij als
client (*GLOBAL → CONNECTIVITY → NETWORK SETTINGS*); de picker praat er
rechtstreeks AppleMIDI (RTP-MIDI, RFC 6295) tegen — sessie-handshake,
kloksynchronisatie en MIDI over UDP, zonder externe libraries.

## Web-app (desktop, USB)

Open `deepmind-preset-picker.html` in Chrome of Edge, sta MIDI-toegang toe en
kies de DeepMind als uitgang. Werkt ook over WiFi met een RTP-MIDI-driver zoals
[rtpMIDI](https://www.tobias-erichsen.de/software/rtpmidi.html) (Windows).

## WiFi-bridge (Python)

```
python dm12-bridge.py [ip-van-de-deepmind]
```

Open daarna `http://localhost:8080`. Alleen standaardbibliotheek — draait ook in
[Termux](https://termux.dev) op Android. Zonder IP-argument wordt het
gateway-adres van het netwerk gebruikt (in accesspoint-modus is dat de synth).

## Android-app

```
cd android
gradle assembleDebug   # of open de map in Android Studio
```

De APK verschijnt in `android/app/build/outputs/apk/debug/`; een gebouwde versie
staat onder [Releases](../../releases). De app detecteert de DeepMind automatisch
als WiFi-gateway. Tik = preset laden, lang indrukken = hernoemen.

## Licentie

MIT — zie [LICENSE](LICENSE).
