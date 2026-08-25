package nl.jochem.dm12picker;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Leest en bewaart programmagegevens van de DeepMind 12 via SysEx-dumps.
 *
 * Programmadata is 242 bytes waarin de bytepositie gelijk is aan het
 * NRPN-parameternummer (handleiding 19.2.4), met de programmanaam als
 * ASCII op positie 223 en de categorie op 240. Over MIDI komt die data
 * in "Packed MS bit"-formaat: per 8 verzonden 7-bits bytes zitten 7
 * databytes, met hun hoogste bits in de eerste byte van de groep.
 */
public class SysexLibrary {

    public static final String[] CATEGORIES = {
            "NONE", "BASS", "PAD", "LEAD", "MONO", "POLY", "STAB", "SFX", "ARP",
            "SEQ", "PERC", "AMBIENT", "MODULAR", "USER-1", "USER-2", "USER-3", "USER-4"};

    public static final int PROGRAM_BYTES = 242;
    /**
     * Globale instellingen. De handleiding van 2016 noemt 45 bytes, maar de
     * firmware stuurt er meer (gemeten: 64 ingepakte bytes = 56 waarden), dus
     * we pakken uit wat er werkelijk in het bericht zit en knippen niets af.
     */
    public static final int GLOBAL_BYTES_MAX = 256;
    private static final int NAME_OFFSET = 223;
    private static final int NAME_LEN = 16;
    private static final int CATEGORY_OFFSET = 240;
    private static final byte[] HEADER = {(byte) 0xF0, 0x00, 0x20, 0x32, 0x20};

    private final Object lock = new Object();
    private final String[][] names = new String[8][128];
    private final int[][] categories = new int[8][128];
    /** Ruwe, ingepakte programmadata precies zoals ontvangen (voor terugschrijven). */
    private final Map<String, byte[]> patches = new LinkedHashMap<>();
    private byte[] editBuffer;
    /** Globale instellingen: uitgepakt, de vorige lezing (om te vergelijken) en
     *  de ruwe ingepakte data, zodat terugschrijven byte-identiek blijft op de
     *  ene byte die we bewust veranderen. */
    private byte[] globals, prevGlobals, globalsPacked;
    public volatile int globalRev = 0;

    public volatile int curBank = -1, curProg = -1, deviceRxCh = -1, ifaceId = -1;
    /** Uit een antwoord van de synth afgeleid SysEx device-ID (-1 = nog onbekend). */
    public volatile int deviceId = -1;
    public volatile int nameDumps = 0, patchDumps = 0, badNames = 0;
    /** Tellers zodat de UI weet wanneer er nieuwe parameterwaarden zijn. */
    public volatile int paramRev = 0;
    /** Wat de synth ons stuurt: bewijs dat de andere richting werkt. */
    public volatile int rxCCs = 0, rxParams = 0;
    public volatile String lastMidiIn = "";
    public volatile String lastInfo = "";

    /** Leesbaar logboek van wat er langskomt, nieuwste eerst. */
    private final java.util.List<String> log =
            java.util.Collections.synchronizedList(new java.util.LinkedList<String>());
    public volatile int logRev = 0;
    private static final int LOG_MAX = 200;
    private int lastLogParam = -1;
    private long lastLogParamMs = 0;

    private void logAdd(String dir, String text, String tag, byte[] raw) {
        StringBuilder sb = new StringBuilder();
        sb.append(System.currentTimeMillis()).append("\t").append(dir).append("\t")
          .append(tag).append("\t").append(text).append("\t");
        if (raw != null) {
            int n = Math.min(raw.length, 64);
            for (int i = 0; i < n; i++) {
                sb.append(Character.forDigit((raw[i] >> 4) & 0xF, 16));
                sb.append(Character.forDigit(raw[i] & 0xF, 16));
            }
            if (raw.length > n) sb.append(" … (").append(raw.length).append(" bytes)");
        }
        synchronized (log) {
            log.add(0, sb.toString());
            while (log.size() > LOG_MAX) log.remove(log.size() - 1);
        }
        logRev++;
    }

    /** Logboek als JSON voor de interface. */
    public String logJson(int max) {
        StringBuilder sb = new StringBuilder("{\"rev\":").append(logRev).append(",\"lines\":[");
        synchronized (log) {
            int n = Math.min(max, log.size());
            for (int i = 0; i < n; i++) {
                String[] f = log.get(i).split("\t", 5);
                if (f.length < 5) continue;
                if (i > 0) sb.append(",");
                sb.append("{\"ms\":").append(f[0])
                  .append(",\"dir\":\"").append(esc(f[1]))
                  .append("\",\"tag\":\"").append(esc(f[2]))
                  .append("\",\"text\":\"").append(esc(f[3]))
                  .append("\",\"hex\":\"").append(esc(f[4])).append("\"}");
            }
        }
        return sb.append("]}").toString();
    }

    /** Beschrijft een uitgaand SysEx-bericht in gewone taal. */
    public static String describeOut(byte[] d) {
        if (d.length < 8 || (d[0] & 0xFF) != 0xF0 || d[1] != 0x00 || d[2] != 0x20
                || d[3] != 0x32) return null;
        int cmd = d[6] & 0xFF;
        switch (cmd) {
            case 0x00: return "app notify (device " + (d[5] & 0x0F) + ")";
            case 0x01: return "request program " + (char) ('A' + (d[7] & 7)) + ((d[8] & 0x7F) + 1);
            case 0x02: return "WRITE program " + (char) ('A' + (d[8] & 7)) + ((d[9] & 0x7F) + 1)
                    + " (" + (d.length - 11) + " packed bytes)";
            case 0x03: return "request edit buffer";
            case 0x04: return "load into edit buffer (" + (d.length - 9) + " packed bytes)";
            case 0x05: return "request global settings";
            case 0x06: return "WRITE global settings (" + (d.length - 9) + " packed bytes)";
            case 0x0A: return "request names of bank " + (char) ('A' + (d[7] & 7));
            default: return "sysex command 0x" + Integer.toHexString(cmd);
        }
    }

    public void logOut(byte[] msg) {
        String d = describeOut(msg);
        if (d != null) {
            logAdd("out", d, d.startsWith("WRITE") || d.startsWith("load") ? "write" : "req", msg);
        }
    }

    public SysexLibrary() {
        for (int b = 0; b < 8; b++) {
            for (int p = 0; p < 128; p++) categories[b][p] = -1;
        }
    }

    // ---------- CC -> parameternummer ----------

    /**
     * Omzetting van de CC's uit de implementatietabel (handleiding 16.2) naar
     * NRPN-parameternummers. Alleen doorlopende 0-255 parameters staan hierin:
     * bij keuzelijsten (FX-type, gain) is de schaling van een 7-bits CC naar het
     * parameterbereik niet gedocumenteerd, dus die worden overgeslagen.
     * Hiermee volgt de editor de synth ook als die op CC staat in plaats van NRPN.
     */
    private static final int[] CC_TO_PARAM = new int[128];

    static {
        for (int i = 0; i < 128; i++) CC_TO_PARAM[i] = -1;
        CC_TO_PARAM[5] = 34;    // portamento-tijd
        CC_TO_PARAM[12] = 157;  // arp-tempo
        CC_TO_PARAM[13] = 160;  // arp gate-tijd
        CC_TO_PARAM[16] = 0;    // LFO 1 rate
        CC_TO_PARAM[17] = 1;    // LFO 1 delay
        CC_TO_PARAM[18] = 7;    // LFO 2 rate
        CC_TO_PARAM[19] = 8;    // LFO 2 delay
        CC_TO_PARAM[20] = 21;   // OSC 1 pitch mod
        CC_TO_PARAM[21] = 25;   // OSC 1 PWM
        CC_TO_PARAM[23] = 29;   // OSC 2 pitch mod
        CC_TO_PARAM[24] = 28;   // OSC 2 tone mod
        CC_TO_PARAM[25] = 27;   // OSC 2 pitch
        CC_TO_PARAM[26] = 26;   // OSC 2 level
        CC_TO_PARAM[27] = 33;   // ruis
        CC_TO_PARAM[28] = 87;   // unison detune
        CC_TO_PARAM[29] = 39;   // VCF frequentie
        CC_TO_PARAM[30] = 41;   // VCF resonantie
        CC_TO_PARAM[31] = 42;   // VCF env-diepte
        CC_TO_PARAM[33] = 45;   // VCF LFO-diepte
        CC_TO_PARAM[34] = 49;   // VCF toetsvolging
        CC_TO_PARAM[35] = 40;   // HPF
        CC_TO_PARAM[36] = 80;   // VCA niveau
        CC_TO_PARAM[37] = 53;   // VCA attack
        CC_TO_PARAM[39] = 54;   // VCA decay
        CC_TO_PARAM[40] = 55;   // VCA sustain
        CC_TO_PARAM[41] = 56;   // VCA release
        CC_TO_PARAM[42] = 62;   // VCF attack
        CC_TO_PARAM[43] = 63;   // VCF decay
        CC_TO_PARAM[44] = 64;   // VCF sustain
        CC_TO_PARAM[45] = 65;   // VCF release
        CC_TO_PARAM[46] = 71;   // MOD attack
        CC_TO_PARAM[47] = 72;   // MOD decay
        CC_TO_PARAM[48] = 73;   // MOD sustain
        CC_TO_PARAM[49] = 74;   // MOD release
        for (int i = 0; i < 4; i++) {
            CC_TO_PARAM[50 + i] = 58 + i;  // VCA envelope-curves
            CC_TO_PARAM[54 + i] = 67 + i;  // VCF envelope-curves
            CC_TO_PARAM[58 + i] = 76 + i;  // MOD envelope-curves
        }
        // FX-slot 1: CC 62,63,65..74 -> parameters 167..178 (CC64 is sustainpedaal)
        int[] fx1 = {62, 63, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74};
        for (int i = 0; i < 12; i++) CC_TO_PARAM[fx1[i]] = 167 + i;
        // FX-slot 2: CC 75..86 -> 180..191
        for (int i = 0; i < 12; i++) CC_TO_PARAM[75 + i] = 180 + i;
        // FX-slot 3: CC 87..95 en 102..104 -> 193..204
        int[] fx3 = {87, 88, 89, 90, 91, 92, 93, 94, 95, 102, 103, 104};
        for (int i = 0; i < 12; i++) CC_TO_PARAM[fx3[i]] = 193 + i;
    }

    /** Parameternummer voor een CC, of -1 als die niet eenduidig te vertalen is. */
    public static int ccToParam(int cc) {
        return cc >= 0 && cc < 128 ? CC_TO_PARAM[cc] : -1;
    }

    /** 7-bits CC-waarde naar het 0-255 bereik van een parameter. */
    public static int ccToValue(int v) {
        return (v * 255) / 127;
    }

    // ---------- codering ----------

    /** Pakt "Packed MS bit"-data uit; stopt bij max databytes of einde bron. */
    public static byte[] unpack7(byte[] src, int off, int end, int max) {
        byte[] out = new byte[max];
        int n = 0, i = off;
        while (i < end && n < max) {
            int msbs = src[i++] & 0xFF;
            for (int j = 0; j < 7 && i < end && n < max; j++) {
                out[n++] = (byte) ((src[i++] & 0x7F) | (((msbs >> j) & 1) << 7));
            }
        }
        if (n == max) return out;
        byte[] trimmed = new byte[n];
        System.arraycopy(out, 0, trimmed, 0, n);
        return trimmed;
    }

    // ---------- verzoeken ----------

    private static byte[] msg(int dev, int cmd, int... rest) {
        byte[] m = new byte[7 + rest.length + 1];
        System.arraycopy(HEADER, 0, m, 0, 5);
        m[5] = (byte) (dev & 0x0F);
        m[6] = (byte) cmd;
        for (int i = 0; i < rest.length; i++) m[7 + i] = (byte) rest[i];
        m[m.length - 1] = (byte) 0xF7;
        return m;
    }

    public static byte[] reqAppNotify(int dev) { return msg(dev, 0x00, 0x00); }
    public static byte[] reqProgram(int dev, int bank, int prog) { return msg(dev, 0x01, bank, prog); }
    public static byte[] reqEditBuffer(int dev) { return msg(dev, 0x03); }
    public static byte[] reqGlobal(int dev) { return msg(dev, 0x05); }
    public static byte[] reqBankNames(int dev, int bank) { return msg(dev, 0x0A, bank); }

    /** Schrijft opgeslagen programmadata naar een slot in de synth (overschrijft!). */
    public static byte[] writeProgram(int dev, int bank, int prog, byte[] packed) {
        byte[] m = new byte[10 + packed.length + 1];
        System.arraycopy(HEADER, 0, m, 0, 5);
        m[5] = (byte) (dev & 0x0F);
        m[6] = 0x02;            // Program Dump Response
        m[7] = 0x06;            // Comms Protocol Version
        m[8] = (byte) bank;
        m[9] = (byte) prog;
        System.arraycopy(packed, 0, m, 10, packed.length);
        m[m.length - 1] = (byte) 0xF7;
        return m;
    }

    /** Laadt programmadata in de edit buffer: hoorbaar, maar niets wordt overschreven. */
    public static byte[] toEditBuffer(int dev, byte[] packed) {
        byte[] m = new byte[8 + packed.length + 1];
        System.arraycopy(HEADER, 0, m, 0, 5);
        m[5] = (byte) (dev & 0x0F);
        m[6] = 0x04;            // Edit Buffer Dump Response
        m[7] = 0x06;
        System.arraycopy(packed, 0, m, 8, packed.length);
        m[m.length - 1] = (byte) 0xF7;
        return m;
    }

    // ---------- ontvangen ----------

    public void handleSysEx(byte[] m) {
        if (m.length < 8 || (m[0] & 0xFF) != 0xF0) return;
        if (m[1] != 0x00 || m[2] != 0x20 || m[3] != 0x32 || m[4] != 0x20) return;
        deviceId = m[5] & 0x0F;
        int cmd = m[6] & 0xFF;
        int end = m.length - 1; // zonder afsluitende F7
        switch (cmd) {
            case 0x0B: { // Bank Program Names Dump Response
                if (m.length < 10) return;
                int bank = m[8] & 0x07;
                byte[] data = unpack7(m, 9, end, 128 * NAME_LEN);
                int good = 0, bad = 0;
                synchronized (lock) {
                    for (int p = 0; p < 128 && (p + 1) * NAME_LEN <= data.length; p++) {
                        String nm = text(data, p * NAME_LEN, NAME_LEN);
                        // alleen leesbare namen bewaren: raakt de uitpakking uit
                        // de maat, dan liever geen naam dan onzin
                        if (!isClean(nm)) { bad++; continue; }
                        if (!nm.isEmpty()) { names[bank][p] = nm; good++; }
                    }
                }
                nameDumps++;
                badNames += bad;
                lastInfo = "bank " + (char) ('A' + bank) + ": " + good + " names"
                        + (bad > 0 ? ", " + bad + " unreadable" : "");
                logAdd("in", "names of bank " + (char) ('A' + bank) + ": " + good + " names"
                        + (bad > 0 ? ", " + bad + " unreadable" : ""), "in", m);
                break;
            }
            case 0x02: { // Program Dump Response
                if (m.length < 11) return;
                int bank = m[8] & 0x07, prog = m[9] & 0x7F;
                byte[] packed = new byte[end - 10];
                System.arraycopy(m, 10, packed, 0, packed.length);
                byte[] data = unpack7(m, 10, end, PROGRAM_BYTES);
                synchronized (lock) {
                    patches.put(bank + "-" + prog, packed);
                    if (data.length > CATEGORY_OFFSET) {
                        String nm = text(data, NAME_OFFSET, NAME_LEN);
                        if (isClean(nm) && !nm.isEmpty()) names[bank][prog] = nm;
                        categories[bank][prog] = data[CATEGORY_OFFSET] & 0xFF;
                    }
                }
                patchDumps++;
                lastInfo = "patch " + (char) ('A' + bank) + (prog + 1) + " received";
                logAdd("in", "program " + (char) ('A' + bank) + (prog + 1)
                        + " \u201c" + (names[bank][prog] == null ? "" : names[bank][prog])
                        + "\u201d, " + data.length + " parameter bytes", "in", m);
                break;
            }
            case 0x04: { // Edit Buffer Dump Response
                if (m.length < 9) return;
                byte[] data = unpack7(m, 8, end, PROGRAM_BYTES);
                synchronized (lock) {
                    editBuffer = data;
                }
                paramRev++;
                lastInfo = "edit buffer received (" + data.length + " bytes)";
                logAdd("in", "edit buffer, " + data.length + " parameters", "in", m);
                break;
            }
            case 0x06: { // Global Parameter Dump Response
                if (m.length < 9) return;
                byte[] packed = new byte[end - 8];
                System.arraycopy(m, 8, packed, 0, packed.length);
                byte[] data = unpack7(m, 8, end, GLOBAL_BYTES_MAX);
                synchronized (lock) {
                    prevGlobals = globals;
                    globals = data;
                    globalsPacked = packed;
                }
                globalRev++;
                lastInfo = "global settings received (" + data.length + " bytes)";
                StringBuilder diff = new StringBuilder();
                if (prevGlobals != null) {
                    for (int i = 0; i < Math.min(data.length, prevGlobals.length); i++) {
                        if (data[i] != prevGlobals[i]) {
                            if (diff.length() > 0) diff.append(", ");
                            diff.append("#").append(i).append(": ")
                                .append(prevGlobals[i] & 0xFF).append(" \u2192 ")
                                .append(data[i] & 0xFF);
                        }
                    }
                }
                logAdd("in", "global settings, " + data.length + " bytes"
                        + (prevGlobals == null ? ""
                           : (diff.length() > 0 ? " \u2014 changed " + diff : " \u2014 unchanged")),
                        diff.length() > 0 ? "change" : "in", m);
                break;
            }
            case 0x10: { // Control App Notify Response
                if (m.length < 12) return;
                deviceRxCh = m[7] & 0x7F;
                ifaceId = m[9] & 0x7F;
                curBank = m[10] & 0x07;
                curProg = m[11] & 0x7F;
                lastInfo = "synth reports: bank " + (char) ('A' + curBank)
                        + (curProg + 1);
                String[] ifn = {"MIDI", "USB", "WiFi"};
                logAdd("in", "app notify reply: device " + deviceId + ", rx channel " + deviceRxCh
                        + ", interface " + (ifaceId >= 0 && ifaceId < 3 ? ifn[ifaceId] : ifaceId)
                        + ", now on " + (char) ('A' + curBank) + (curProg + 1), "in", m);
                break;
            }
            default:
                lastInfo = "SysEx 0x" + Integer.toHexString(cmd) + " received";
                logAdd("in", "unknown command 0x" + Integer.toHexString(cmd)
                        + " (" + m.length + " bytes)", "odd", m);
                break;
        }
    }

    /** Losse parameterwijziging van de synth (NRPN), houdt de editor in sync. */
    public void handleParam(int param, int value) {
        synchronized (lock) {
            if (editBuffer == null) editBuffer = new byte[PROGRAM_BYTES];
            if (param >= 0 && param < editBuffer.length) editBuffer[param] = (byte) value;
        }
        paramRev++;
        rxParams++;
        lastMidiIn = "par " + param + " = " + value;
        // een draaiende fader levert tientallen berichten: die op één regel houden
        long now = System.currentTimeMillis();
        synchronized (log) {
            if (param == lastLogParam && now - lastLogParamMs < 800 && !log.isEmpty()) {
                log.set(0, now + "\tin\tparam\tparameter " + param + " = " + value + "\t");
                logRev++;
            } else {
                logAdd("in", "parameter " + param + " = " + value, "param", null);
            }
        }
        lastLogParam = param;
        lastLogParamMs = now;
    }

    /** Elk binnenkomend CC meetellen, ook de plumbing van NRPN en wat we overslaan. */
    public void noteCC(int cc, int value) {
        rxCCs++;
        if (cc != 99 && cc != 98 && cc != 6 && cc != 38) {
            lastMidiIn = "CC " + cc + " = " + value;
        }
    }

    public void handleProgramChange(int bank, int prog) {
        if (bank >= 0) curBank = bank;
        curProg = prog;
    }

    /** Bestaat de tekst volledig uit leesbare ASCII-tekens? */
    private static boolean isClean(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c > 0x7E) return false;
        }
        return true;
    }

    private static String text(byte[] d, int off, int len) {
        int n = 0;
        while (n < len && off + n < d.length && d[off + n] != 0) n++;
        return new String(d, off, n, StandardCharsets.US_ASCII).trim();
    }

    // ---------- opvragen voor de UI ----------

    public String namesJson() {
        StringBuilder sb = new StringBuilder("{");
        synchronized (lock) {
            boolean first = true;
            for (int b = 0; b < 8; b++) {
                for (int p = 0; p < 128; p++) {
                    if (names[b][p] == null) continue;
                    if (!first) sb.append(",");
                    first = false;
                    sb.append("\"").append((char) ('A' + b)).append("-").append(p)
                            .append("\":[\"").append(esc(names[b][p])).append("\",")
                            .append(categories[b][p]).append(",")
                            .append(patches.containsKey(b + "-" + p) ? 1 : 0).append("]");
                }
            }
        }
        return sb.append("}").toString();
    }

    /** Parameterwaarden uit de laatst ontvangen edit buffer (index = NRPN-nummer). */
    public String paramsJson() {
        synchronized (lock) {
            if (editBuffer == null) return "null";
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < editBuffer.length; i++) {
                if (i > 0) sb.append(",");
                sb.append(editBuffer[i] & 0xFF);
            }
            return sb.append("]").toString();
        }
    }

    /**
     * Globale instellingen plus welke bytes veranderd zijn sinds de vorige
     * lezing. Die vergelijking is de manier om te achterhalen welke byte bij
     * welke instelling hoort: de handleiding noemt de instellingen wel, maar
     * niet hun plek in het blok van 45 bytes.
     */
    public String globalsJson() {
        synchronized (lock) {
            if (globals == null) return "null";
            StringBuilder sb = new StringBuilder("{\"rev\":").append(globalRev)
                    .append(",\"bytes\":[");
            for (int i = 0; i < globals.length; i++) {
                if (i > 0) sb.append(",");
                sb.append(globals[i] & 0xFF);
            }
            sb.append("],\"changed\":[");
            boolean first = true;
            if (prevGlobals != null) {
                for (int i = 0; i < Math.min(globals.length, prevGlobals.length); i++) {
                    if (globals[i] != prevGlobals[i]) {
                        if (!first) sb.append(",");
                        sb.append(i);
                        first = false;
                    }
                }
            }
            return sb.append("],\"hadPrevious\":").append(prevGlobals != null).append("}").toString();
        }
    }

    /**
     * Verandert één databyte binnen de ingepakte data. Zo blijft al het andere
     * byte-identiek aan wat de synth stuurde, inclusief de opvulling die de
     * DeepMind ruimer neemt dan strikt nodig.
     */
    static void setPackedByte(byte[] packed, int index, int value) {
        int group = index / 7, pos = index % 7;
        int msbAt = group * 8, at = msbAt + 1 + pos;
        if (msbAt >= packed.length || at >= packed.length) return;
        packed[at] = (byte) (value & 0x7F);
        if ((value & 0x80) != 0) packed[msbAt] |= (byte) (1 << pos);
        else packed[msbAt] &= (byte) ~(1 << pos);
    }

    /** Bericht om één globale instelling terug te schrijven, of null zonder lezing. */
    public byte[] globalWriteMsg(int dev, int index, int value) {
        synchronized (lock) {
            if (globalsPacked == null || index < 0 || globals == null || index >= globals.length) return null;
            byte[] packed = globalsPacked.clone();
            setPackedByte(packed, index, value);
            byte[] m = new byte[8 + packed.length + 1];
            System.arraycopy(HEADER, 0, m, 0, 5);
            m[5] = (byte) (dev & 0x0F);
            m[6] = 0x06;  // Global Parameter Dump Response
            m[7] = 0x06;  // Comms Protocol Version
            System.arraycopy(packed, 0, m, 8, packed.length);
            m[m.length - 1] = (byte) 0xF7;
            return m;
        }
    }

    public String statusJson() {
        synchronized (lock) {
            return "{\"names\":" + countNames() + ",\"patches\":" + patches.size()
                    + ",\"nameDumps\":" + nameDumps + ",\"patchDumps\":" + patchDumps
                    + ",\"badNames\":" + badNames
                    + ",\"curBank\":" + curBank + ",\"curProg\":" + curProg
                    + ",\"iface\":" + ifaceId + ",\"dev\":" + deviceId
                    + ",\"editBuffer\":" + (editBuffer != null) + ",\"paramRev\":" + paramRev
                    + ",\"globalRev\":" + globalRev
                    + ",\"rxCC\":" + rxCCs + ",\"rxPar\":" + rxParams
                    + ",\"rxLast\":\"" + esc(lastMidiIn) + "\""
                    + ",\"info\":\"" + esc(lastInfo) + "\"}";
        }
    }

    private int countNames() {
        int n = 0;
        for (int b = 0; b < 8; b++) for (int p = 0; p < 128; p++) if (names[b][p] != null) n++;
        return n;
    }

    public byte[] getPatch(int bank, int prog) {
        synchronized (lock) {
            return patches.get(bank + "-" + prog);
        }
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static byte[] unhex(String s) {
        int n = s.length() / 2;
        byte[] d = new byte[n];
        for (int i = 0; i < n; i++) {
            d[i] = (byte) ((Character.digit(s.charAt(i * 2), 16) << 4)
                    | Character.digit(s.charAt(i * 2 + 1), 16));
        }
        return d;
    }

    // ---------- opslag ----------

    public void save(File dir) {
        File f = new File(dir, "library.txt");
        try (FileWriter w = new FileWriter(f)) {
            synchronized (lock) {
                for (int b = 0; b < 8; b++) {
                    for (int p = 0; p < 128; p++) {
                        if (categories[b][p] >= 0) {
                            w.write("C " + b + " " + p + " " + categories[b][p] + "\n");
                        }
                        if (names[b][p] != null) {
                            w.write("N " + b + " " + p + " " + names[b][p].replace("\n", " ") + "\n");
                        }
                    }
                }
                for (Map.Entry<String, byte[]> e : patches.entrySet()) {
                    String[] k = e.getKey().split("-");
                    w.write("P " + k[0] + " " + k[1] + " " + hex(e.getValue()) + "\n");
                }
            }
        } catch (Exception e) {
            lastInfo = "saving failed: " + e.getMessage();
        }
    }

    public void load(File dir) {
        File f = new File(dir, "library.txt");
        if (!f.exists()) return;
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String line;
            synchronized (lock) {
                while ((line = r.readLine()) != null) {
                    String[] t = line.split(" ", 4);
                    if (t.length < 4) continue;
                    int b = Integer.parseInt(t[1]), p = Integer.parseInt(t[2]);
                    if (b < 0 || b > 7 || p < 0 || p > 127) continue;
                    switch (t[0]) {
                        case "N": names[b][p] = t[3]; break;
                        case "C": categories[b][p] = Integer.parseInt(t[3]); break;
                        case "P": patches.put(b + "-" + p, unhex(t[3])); break;
                        default: break;
                    }
                }
            }
        } catch (Exception e) {
            lastInfo = "loading failed: " + e.getMessage();
        }
    }
}
