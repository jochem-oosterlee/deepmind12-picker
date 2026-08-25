# DeepMind 12 Program Picker

Preset/program picker voor de Behringer DeepMind 12: kies met één tik of klik een
programma (bank A–H, 1–128) op de synth. Drie varianten, van desktop tot tablet:

| Variant | Bestand | Verbinding | Voor |
|---|---|---|---|
| Android-app | `android/` | AppleMIDI / RTP-MIDI over WiFi | tablet of telefoon |
| Pc-versie | `dm12-web.html` | Web MIDI (USB of rtpMIDI) | dezelfde app op een pc, met een echt toetsenbord |
| Losse preset-picker | `deepmind-preset-picker.html` | Web MIDI | alleen presets kiezen, niets in te stellen |
| WiFi-bridge | `dm12-bridge.py` | AppleMIDI / RTP-MIDI over WiFi | elk apparaat met Python (bijv. Termux) |

Alle varianten kunnen presets kiezen: banken A–H, hernoembare presets, favorieten
met eigen tabblad, zoeken en back-up/herstel. De Android-app is daarnaast een
volledige controller:

- **Editor** — ruim 150 parameters via NRPN: oscillatoren, filter, alle drie
  envelopes, LFO's, stemmenverdeling, arpeggiator, control sequencer, de vier
  FX-slots (type, gain, 12 parameters elk) en de modulatiematrix.
- **Uitlezen** — de app vraagt de edit buffer op en zet alle regelaars op de
  werkelijke waarden van de synth. Draai je aan een fader op het apparaat, dan
  beweegt de app mee (de synth stuurt NRPN na een App Notify-aanmelding).
- **Bibliotheek** — leest de echte programmanamen en categorieën uit de synth
  (één SysEx-verzoek per bank levert 128 namen), haalt complete patches op,
  bewaart ze op het apparaat en stuurt ze terug naar de edit buffer of
  schrijft ze terug naar een slot.

## Hoe het werkt

De DeepMind 12 selecteert programma's via MIDI **Bank Select LSB (CC32, waarde 0–7
voor bank A–H)** gevolgd door **Program Change (0–127)**. Zet op de synth
*GLOBAL → MIDI SETTINGS → PROGRAM CHANGE* op *Rx* of *Both*.

Parameters gaan via **NRPN**: parameternummer in CC99/CC98, waarde 0–255 in
CC6/CC38. Het parameternummer uit de NRPN-tabel van de handleiding is tegelijk de
**bytepositie in de programmadata** (242 bytes), waarin de naam als ASCII op
positie 223 staat en de categorie op 240. Programmadata gaat over MIDI in
"Packed MS bit"-formaat: per 8 verzonden 7-bits bytes zitten 7 databytes met hun
hoogste bits in de eerste byte van de groep. De app stuurt bij verbinden een
**App Notify**-SysEx, waarna de synth NRPN en SysEx op die interface aanzet en
zijn device-ID en huidige programma terugmeldt.

Voor de WiFi-varianten maakt de synth zelf een accesspoint of verbindt hij als
client (*GLOBAL → CONNECTIVITY → NETWORK SETTINGS*); de picker praat er
rechtstreeks AppleMIDI (RTP-MIDI, RFC 6295) tegen — sessie-handshake,
kloksynchronisatie en MIDI over UDP, zonder externe libraries.

## Pc-versie

`dm12-web.html` is exact dezelfde app, met Web MIDI in plaats van de
WiFi-verbinding van Android. Open het bestand in Chrome of Edge, sta MIDI met
SysEx toe en kies bovenin eventueel een andere MIDI-poort door een deel van de
naam te typen. Handig om de globale instellingen te benoemen en in te delen:
dat is typewerk.

Verbinding via USB, of over WiFi met
[rtpMIDI](https://www.tobias-erichsen.de/software/rtpmidi.html) als netwerkpoort.
Werkt het niet vanaf `file://`, dan serveren via `python -m http.server` en
`http://localhost:8000/dm12-web.html` openen.

Het bestand wordt gebouwd uit dezelfde interface als de Android-app:

```
node web/build-web.js
```

Je indeling van de globale instellingen (namen, waardelabels, menu's) staat per
apparaat in de browseropslag; wissel hem uit met de knoppen *Exporteer indeling*
en *Importeer* via het klembord.

## Losse preset-picker

`deepmind-preset-picker.html` doet alleen presets kiezen via Web MIDI, zonder
editor of bibliotheek.

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
staat onder [Releases](../../releases).

Twee testsuites, beide zonder emulator of apparaat:

```
node android/test-ui.js android/app/src/main/assets/index.html
```
draait de interface-code met een nagebootste DOM en native laag, klikt elke tab
en knop aan en controleert de MIDI-berichten die eruit komen.

```
javac -d out android/app/src/main/java/nl/jochem/dm12picker/RtpMidiParser.java \
      android/app/src/main/java/nl/jochem/dm12picker/SysexLibrary.java \
      android/test/RtpMidiParserTest.java
java -cp out nl.jochem.dm12picker.RtpMidiParserTest
```
test de RTP-MIDI-ontleding en de bibliotheek: een complete banknamen-dump wordt
ingepakt, in stukken geknipt zoals RFC 6295 dat doet en er weer uitgehaald,
inclusief namen, categorie en patchdata. `RtpMidiParser` en `SysexLibrary` zijn
daarom vrij van Android-afhankelijkheden.

```
node web/test-bridge.js
```
doet hetzelfde voor de pc-versie met een nagebootste MIDI-poort, inclusief de
controle dat het terugschrijven van één globale instelling de andere 44 bytes
onaangeroerd laat. De app detecteert de DeepMind automatisch
als WiFi-gateway. Tik = preset laden, lang indrukken = hernoemen.

## Licentie

MIT — zie [LICENSE](LICENSE).
