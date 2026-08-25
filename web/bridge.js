/*
 * Verbindingslaag voor de pc-versie: dezelfde interface als de Android-app,
 * maar bovenop Web MIDI in plaats van AppleMIDI over WiFi.
 *
 * De app spreekt met de synth via één object (AndroidBridge). Door dat hier na
 * te bouwen werkt de complete interface -- presets, editor, bibliotheek en de
 * globale instellingen -- ongewijzigd in Chrome of Edge op de pc.
 *
 * Verbinding met de synth: via USB, of over WiFi met rtpMIDI erbij als
 * netwerkpoort. Web MIDI levert SysEx als complete berichten, dus het in delen
 * knippen dat op Android nodig was speelt hier niet.
 */
(function () {
  "use strict";

  const BANKS = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const PROGRAM_BYTES = 242;
  const GLOBAL_BYTES = 45;
  const NAME_OFFSET = 223, NAME_LEN = 16, CATEGORY_OFFSET = 240;

  // CC's uit de implementatietabel naar parameternummers; alleen de doorlopende
  // 0-255 parameters, net als in de Android-versie.
  const CC2P = {5:34, 12:157, 13:160, 16:0, 17:1, 18:7, 19:8, 20:21, 21:25, 23:29,
    24:28, 25:27, 26:26, 27:33, 28:87, 29:39, 30:41, 31:42, 33:45, 34:49, 35:40,
    36:80, 37:53, 39:54, 40:55, 41:56, 42:62, 43:63, 44:64, 45:65, 46:71, 47:72,
    48:73, 49:74, 50:58, 51:59, 52:60, 53:61, 54:67, 55:68, 56:69, 57:70, 58:76,
    59:77, 60:78, 61:79,
    62:167, 63:168, 65:169, 66:170, 67:171, 68:172, 69:173, 70:174, 71:175, 72:176,
    73:177, 74:178,
    75:180, 76:181, 77:182, 78:183, 79:184, 80:185, 81:186, 82:187, 83:188, 84:189,
    85:190, 86:191,
    87:193, 88:194, 89:195, 90:196, 91:197, 92:198, 93:199, 94:200, 95:201,
    102:202, 103:203, 104:204};

  const S = {
    status: "MIDI wordt geladen…", connected: false, portName: "",
    names: {}, cats: {}, patches: {},
    editBuffer: null, globals: null, prevGlobals: null, globalsPacked: null,
    paramRev: 0, globalRev: 0, nameDumps: 0, patchDumps: 0, badNames: 0,
    rxCC: 0, rxPar: 0, rxLast: "", dev: -1, curBank: -1, curProg: -1, iface: -1,
    sysex: 0, sysexLen: 0, pkts: 0, info: "",
  };

  let midi = null, out = null, preferred = "";
  let rxParamMsb = 0, rxParamLsb = 0, rxDataMsb = 0;

  // ---------- codering ----------

  function unpack7(src, off, end, max) {
    const o = [];
    let i = off;
    while (i < end && o.length < max) {
      const msbs = src[i++];
      for (let j = 0; j < 7 && i < end && o.length < max; j++) {
        o.push((src[i++] & 0x7F) | (((msbs >> j) & 1) << 7));
      }
    }
    return o;
  }

  /** Verandert één databyte binnen ingepakte data; de rest blijft identiek. */
  function setPackedByte(packed, index, value) {
    const group = Math.floor(index / 7), pos = index % 7;
    const msbAt = group * 8, at = msbAt + 1 + pos;
    if (at >= packed.length) return;
    packed[at] = value & 0x7F;
    if (value & 0x80) packed[msbAt] |= (1 << pos);
    else packed[msbAt] &= ~(1 << pos) & 0xFF;
  }

  /** Tekst uit databytes; null als er onleesbare tekens in staan. */
  function text(d, off, len) {
    let s = "";
    for (let i = 0; i < len && off + i < d.length; i++) {
      const c = d[off + i];
      if (c === 0) break;
      if (c < 0x20 || c > 0x7E) return null;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  // ---------- ontvangen ----------

  function setParam(p, v) {
    if (!S.editBuffer) S.editBuffer = new Array(PROGRAM_BYTES).fill(0);
    if (p >= 0 && p < PROGRAM_BYTES) S.editBuffer[p] = v;
    S.paramRev++;
    S.rxPar++;
    S.rxLast = "par " + p + " = " + v;
  }

  function onCC(cc, v) {
    S.rxCC++;
    if (cc !== 99 && cc !== 98 && cc !== 6 && cc !== 38) S.rxLast = "CC " + cc + " = " + v;
    if (cc === 99) { rxParamMsb = v; rxDataMsb = 0; }
    else if (cc === 98) { rxParamLsb = v; rxDataMsb = 0; }
    else if (cc === 6) { rxDataMsb = v; }
    else if (cc === 38) { setParam((rxParamMsb << 7) | rxParamLsb, (rxDataMsb << 7) | v); }
    else if (CC2P[cc] !== undefined) { setParam(CC2P[cc], Math.round(v * 255 / 127)); }
  }

  function handleSysEx(d) {
    S.sysex++;
    S.sysexLen = d.length;
    if (d.length < 8 || d[0] !== 0xF0) return;
    if (!(d[1] === 0x00 && d[2] === 0x20 && d[3] === 0x32 && d[4] === 0x20)) return;
    S.dev = d[5] & 0x0F;
    const cmd = d[6], end = d.length - 1;

    if (cmd === 0x0B) {                       // banknamen
      const bank = d[8] & 7;
      const data = unpack7(d, 9, end, 128 * NAME_LEN);
      let good = 0, bad = 0;
      for (let p = 0; p < 128 && (p + 1) * NAME_LEN <= data.length; p++) {
        const nm = text(data, p * NAME_LEN, NAME_LEN);
        if (nm === null) { bad++; continue; }
        if (nm) { S.names[BANKS[bank] + "-" + p] = nm; good++; }
      }
      S.nameDumps++;
      S.badNames += bad;
      S.info = "bank " + BANKS[bank] + ": " + good + " namen"
             + (bad ? ", " + bad + " onleesbaar" : "");
    } else if (cmd === 0x02) {                // programma-dump
      const bank = d[8] & 7, prog = d[9] & 0x7F;
      S.patches[bank + "-" + prog] = Array.from(d.slice(10, end));
      const data = unpack7(d, 10, end, PROGRAM_BYTES);
      if (data.length > CATEGORY_OFFSET) {
        const nm = text(data, NAME_OFFSET, NAME_LEN);
        if (nm) S.names[BANKS[bank] + "-" + prog] = nm;
        S.cats[BANKS[bank] + "-" + prog] = data[CATEGORY_OFFSET];
      }
      S.patchDumps++;
      S.info = "patch " + BANKS[bank] + (prog + 1) + " ontvangen";
    } else if (cmd === 0x04) {                // edit buffer
      S.editBuffer = unpack7(d, 8, end, PROGRAM_BYTES);
      S.paramRev++;
      S.info = "edit buffer ontvangen (" + S.editBuffer.length + " bytes)";
    } else if (cmd === 0x06) {                // globale instellingen
      S.prevGlobals = S.globals;
      S.globals = unpack7(d, 8, end, GLOBAL_BYTES);
      S.globalsPacked = Array.from(d.slice(8, end));
      S.globalRev++;
      S.info = "globale instellingen ontvangen (" + S.globals.length + " bytes)";
    } else if (cmd === 0x10) {                // aanmelding bevestigd
      S.iface = d[9] & 0x7F;
      S.curBank = d[10] & 7;
      S.curProg = d[11] & 0x7F;
      S.info = "synth meldt zich: bank " + BANKS[S.curBank] + (S.curProg + 1);
    } else {
      S.info = "SysEx 0x" + cmd.toString(16) + " ontvangen";
    }
  }

  function onMessage(e) {
    const d = e.data;
    S.pkts++;
    if (d[0] === 0xF0) handleSysEx(d);
    else if ((d[0] & 0xF0) === 0xB0) onCC(d[1], d[2]);
    else if ((d[0] & 0xF0) === 0xC0) { S.curProg = d[1]; }
  }

  // ---------- verbinding ----------

  function pickPorts() {
    if (!midi) return;
    const outs = [...midi.outputs.values()];
    out = (preferred && outs.find(o => o.name.toLowerCase().includes(preferred)))
       || outs.find(o => /deepmind/i.test(o.name))
       || outs[0] || null;
    for (const i of midi.inputs.values()) i.onmidimessage = onMessage;
    S.connected = !!out;
    S.portName = out ? out.name : "";
    S.status = out ? "verbonden: " + out.name
                   : "geen MIDI-uitgang gevonden — sluit de DeepMind aan via USB of start rtpMIDI";
  }

  function init() {
    if (typeof navigator === "undefined" || !navigator.requestMIDIAccess) {
      S.status = "deze browser ondersteunt geen Web MIDI — gebruik Chrome of Edge";
      return;
    }
    navigator.requestMIDIAccess({sysex: true}).then(access => {
      midi = access;
      midi.onstatechange = pickPorts;
      pickPorts();
    }, () => {
      S.status = "MIDI-toegang geweigerd (SysEx moet toegestaan zijn)";
    });
  }

  function send(bytes) {
    if (!out) return false;
    try { out.send(bytes); return true; } catch { return false; }
  }

  function sysexMsg(dev, cmd, rest) {
    return [0xF0, 0x00, 0x20, 0x32, 0x20, dev & 0x0F, cmd].concat(rest || []).concat([0xF7]);
  }

  function clip(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(t);
  }

  // ---------- dezelfde interface als op Android ----------

  window.AndroidBridge = {
    getStatus: () => JSON.stringify({
      connected: S.connected, status: S.status, event: "",
      wifi: "", wifiConnected: false, ip: S.portName,
    }),

    libStatus: () => JSON.stringify({
      names: Object.keys(S.names).length,
      patches: Object.keys(S.patches).length,
      nameDumps: S.nameDumps, patchDumps: S.patchDumps, badNames: S.badNames,
      curBank: S.curBank, curProg: S.curProg, iface: S.iface, dev: S.dev,
      editBuffer: !!S.editBuffer, paramRev: S.paramRev, globalRev: S.globalRev,
      rxCC: S.rxCC, rxPar: S.rxPar, rxLast: S.rxLast, info: S.info,
      pkts: S.pkts, sysex: S.sysex, sysexLen: S.sysexLen, segs: S.sysex, framing: 0,
    }),

    libNames: () => {
      const o = {};
      for (const k in S.names) {
        const [b, p] = k.split("-");
        o[k] = [S.names[k], S.cats[k] === undefined ? -1 : S.cats[k],
                S.patches[BANKS.indexOf(b) + "-" + p] ? 1 : 0];
      }
      return JSON.stringify(o);
    },

    libParams: () => JSON.stringify(S.editBuffer),
    globals: () => JSON.stringify(S.globals ? {
      rev: S.globalRev, bytes: S.globals, hadPrevious: !!S.prevGlobals,
      changed: S.prevGlobals
        ? S.globals.map((v, i) => v !== S.prevGlobals[i] ? i : -1).filter(i => i >= 0)
        : [],
    } : null),

    send: (bank, prog, ch) => send([0xB0 | ch, 0x00, 0x00])
        && send([0xB0 | ch, 0x20, bank]) && send([0xC0 | ch, prog]),
    sendCC: (cc, v, ch) => send([0xB0 | ch, cc & 0x7F, v & 0x7F]),
    sendNRPN: (p, v, ch) => send([0xB0 | ch, 99, (p >> 7) & 0x7F])
        && send([0xB0 | ch, 98, p & 0x7F])
        && send([0xB0 | ch, 6, (v >> 7) & 0x7F])
        && send([0xB0 | ch, 38, v & 0x7F]),
    panic: ch => send([0xB0 | ch, 123, 0]) && send([0xB0 | ch, 120, 0]),

    appNotify: dev => {
      if (dev < 0) {
        let ok = false;
        for (let i = 0; i < 16; i++) ok = send(sysexMsg(i, 0x00, [0x00])) || ok;
        return ok;
      }
      return send(sysexMsg(dev, 0x00, [0x00]));
    },
    requestBankNames: (bank, dev) => send(sysexMsg(dev, 0x0A, [bank & 7])),
    requestProgram: (bank, prog, dev) => send(sysexMsg(dev, 0x01, [bank & 7, prog & 0x7F])),
    requestEditBuffer: dev => send(sysexMsg(dev, 0x03, [])),
    requestGlobals: dev => send(sysexMsg(dev, 0x05, [])),

    writeGlobal: (index, value, dev) => {
      if (!S.globalsPacked || index < 0 || index >= GLOBAL_BYTES) return false;
      const packed = S.globalsPacked.slice();
      setPackedByte(packed, index, value);
      return send([0xF0, 0x00, 0x20, 0x32, 0x20, dev & 0x0F, 0x06, 0x06]
        .concat(packed).concat([0xF7]));
    },

    patchToEditBuffer: (bank, prog, dev) => {
      const p = S.patches[bank + "-" + prog];
      if (!p) return false;
      return send([0xF0, 0x00, 0x20, 0x32, 0x20, dev & 0x0F, 0x04, 0x06]
        .concat(p).concat([0xF7]));
    },
    patchToSlot: (sb, sp, db, dp, dev) => {
      const p = S.patches[sb + "-" + sp];
      if (!p) return false;
      return send([0xF0, 0x00, 0x20, 0x32, 0x20, dev & 0x0F, 0x02, 0x06, db & 7, dp & 0x7F]
        .concat(p).concat([0xF7]));
    },

    // op de pc bewaart de browser zelf; de bibliotheek gaat mee via de back-up
    libSave: () => { S.info = "op de pc bewaart de browser dit zelf"; },

    // de MIDI-poort kiezen op een deel van zijn naam
    setIp: t => { preferred = (t || "").trim().toLowerCase(); pickPorts(); },
    getWifiCreds: () => JSON.stringify({ssid: "", pw: ""}),
    connectWifi: () => { S.info = "op de pc loopt de verbinding via USB of rtpMIDI"; },
    disconnectWifi: () => { S.info = "op de pc loopt de verbinding via USB of rtpMIDI"; },

    copyToClipboard: clip,
    readClipboard: () => (navigator.clipboard && navigator.clipboard.readText)
      ? navigator.clipboard.readText().catch(() => "")
      : Promise.resolve(""),
  };

  init();
})();
