/*
 * Bouwt de pc-versie: dezelfde interface als de Android-app, met de Web
 * MIDI-verbindingslaag ervoor geschoven. Zo blijft er één bron voor de
 * interface en verschilt alleen de manier waarop de synth bereikt wordt.
 *
 *   node web/build-web.js
 *
 * Resultaat: dm12-web.html in de hoofdmap, te openen in Chrome of Edge.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const appHtml = path.join(root, "android/app/src/main/assets/index.html");
const bridgeJs = path.join(__dirname, "bridge.js");
const outFile = path.join(root, "dm12-web.html");

let html = fs.readFileSync(appHtml, "utf8");
const bridge = fs.readFileSync(bridgeJs, "utf8");

// de verbindingslaag moet klaarstaan voordat de interface begint
const marker = '<script>\n"use strict";';
if (!html.includes(marker)) {
  console.error("kon het begin van het interface-script niet vinden");
  process.exit(1);
}
html = html.replace(marker, "<script>\n" + bridge + "</script>\n" + marker);

// kleine aanpassingen die alleen voor de pc-versie gelden
html = html
  .replace("<title>DeepMind 12 — Controller</title>",
           "<title>DeepMind 12 — Controller (pc)</title>")
  .replace('placeholder="IP van de synth"', 'placeholder="MIDI-poort (deel van de naam)"')
  .replace(/<input type="text" id="ssidInput"[^>]*>\s*<input type="text" id="pwInput"[^>]*>\s*<button class="mini" id="wifiBtn">WiFi<\/button>\s*<button class="mini" id="wifiOffBtn">Los<\/button>/,
           '<span style="font-size:12px;color:var(--muted)">Verbinding via USB of rtpMIDI'
           + ' — kies hierboven de MIDI-poort.</span>'
           + '<input type="text" id="ssidInput" style="display:none">'
           + '<input type="text" id="pwInput" style="display:none">'
           + '<button class="mini" id="wifiBtn" style="display:none"></button>'
           + '<button class="mini" id="wifiOffBtn" style="display:none"></button>')
  .replace(/<footer id="foot">(v[\d.]+)([^<]*)/,
           '<footer id="foot">$1 (pc-versie via Web MIDI) · Chrome of Edge, sta MIDI met SysEx toe.$2');

fs.writeFileSync(outFile, html, "utf8");
console.log("pc-versie geschreven: " + path.relative(root, outFile)
  + " (" + Math.round(html.length / 1024) + " kB)");
