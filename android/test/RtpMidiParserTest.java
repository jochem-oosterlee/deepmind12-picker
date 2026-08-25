package nl.jochem.dm12picker;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Test van de RTP-MIDI-ontleding en de SysEx-bibliotheek, zonder Android.
 *
 * Draaien:
 *   javac -d out android/app/src/main/java/nl/jochem/dm12picker/RtpMidiParser.java \
 *         android/app/src/main/java/nl/jochem/dm12picker/SysexLibrary.java \
 *         android/test/RtpMidiParserTest.java
 *   java -cp out nl.jochem.dm12picker.RtpMidiParserTest
 */
public class RtpMidiParserTest {

    private static int failures = 0;

    public static void main(String[] args) {
        testSimpleCC();
        testSingleSysEx();
        testSegmentedSysEx();
        testSegmentedWithDelta();
        testRawContinuation();
        testBankNamesEndToEnd();
        testProgramDumpEndToEnd();
        System.out.println(failures == 0 ? "ALLE PARSER-TESTS GESLAAGD"
                : "MISLUKT: " + failures + " fouten");
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---------- hulpmiddelen ----------

    static class Collector implements RtpMidiParser.Sink {
        final List<byte[]> sysex = new ArrayList<>();
        final List<int[]> cc = new ArrayList<>();
        final List<int[]> pc = new ArrayList<>();
        public void sysex(byte[] m) { sysex.add(m); }
        public void controlChange(int ch, int c, int v) { cc.add(new int[]{ch, c, v}); }
        public void programChange(int ch, int p) { pc.add(new int[]{ch, p}); }
    }

    /** Bouwt een RTP-MIDI-pakket met een MIDI-lijst; zonder delta-tijd vooraf. */
    static byte[] rtp(byte[] midiList) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (int i = 0; i < 12; i++) o.write(i == 0 ? 0x80 : (i == 1 ? 0x61 : 0));
        if (midiList.length < 16) {
            o.write(midiList.length);
        } else {
            o.write(0x80 | (midiList.length >> 8));
            o.write(midiList.length & 0xFF);
        }
        o.write(midiList, 0, midiList.length);
        return o.toByteArray();
    }

    /** Idem, maar met de Z-vlag: een delta-tijd van 0 voor het eerste bericht. */
    static byte[] rtpWithDelta(byte[] midiList) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (int i = 0; i < 12; i++) o.write(i == 0 ? 0x80 : (i == 1 ? 0x61 : 0));
        int len = midiList.length + 1; // plus de delta-byte
        if (len < 16) {
            o.write(0x20 | len);
        } else {
            o.write(0xA0 | (len >> 8));
            o.write(len & 0xFF);
        }
        o.write(0x00); // delta-tijd 0
        o.write(midiList, 0, midiList.length);
        return o.toByteArray();
    }

    static byte[] pack7(byte[] data) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (int i = 0; i < data.length; i += 7) {
            int n = Math.min(7, data.length - i), msbs = 0;
            for (int j = 0; j < n; j++) if ((data[i + j] & 0x80) != 0) msbs |= (1 << j);
            o.write(msbs);
            for (int j = 0; j < n; j++) o.write(data[i + j] & 0x7F);
        }
        return o.toByteArray();
    }

    /**
     * Splitst een compleet SysEx-bericht in delen zoals RFC 6295 dat codeert:
     * eerste deel F0..F0, tussenliggend F7..F0, laatste F7..F7.
     */
    static List<byte[]> segment(byte[] sysex, int chunk) {
        List<byte[]> out = new ArrayList<>();
        byte[] body = new byte[sysex.length - 2]; // zonder F0 en F7
        System.arraycopy(sysex, 1, body, 0, body.length);
        int pos = 0;
        boolean first = true;
        while (pos < body.length) {
            int n = Math.min(chunk, body.length - pos);
            boolean last = pos + n >= body.length;
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            o.write(first ? 0xF0 : 0xF7);
            o.write(body, pos, n);
            o.write(last ? 0xF7 : 0xF0);
            out.add(o.toByteArray());
            pos += n;
            first = false;
        }
        return out;
    }

    static void check(boolean ok, String what) {
        System.out.println((ok ? "  ok   " : "  FOUT ") + what);
        if (!ok) failures++;
    }

    static byte[] nameBlock(String[] names) {
        byte[] d = new byte[names.length * 16];
        for (int i = 0; i < names.length; i++) {
            byte[] b = names[i].getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            System.arraycopy(b, 0, d, i * 16, Math.min(16, b.length));
        }
        return d;
    }

    // ---------- tests ----------

    static void testSimpleCC() {
        System.out.println("CC in één pakket:");
        Collector c = new Collector();
        RtpMidiParser p = new RtpMidiParser(c);
        p.parse(rtp(new byte[]{(byte) 0xB0, 29, 100}));
        check(c.cc.size() == 1 && c.cc.get(0)[1] == 29 && c.cc.get(0)[2] == 100, "CC29 = 100");
    }

    static void testSingleSysEx() {
        System.out.println("SysEx in één pakket:");
        Collector c = new Collector();
        RtpMidiParser p = new RtpMidiParser(c);
        byte[] msg = {(byte) 0xF0, 0x00, 0x20, 0x32, 0x20, 0x00, 0x10, 1, 2, 3, 4, 5, (byte) 0xF7};
        p.parse(rtp(msg));
        check(c.sysex.size() == 1 && c.sysex.get(0).length == msg.length, "compleet bericht");
        check(p.framingErrors == 0, "geen uitlijnfouten");
    }

    static void testSegmentedSysEx() {
        System.out.println("SysEx in delen (RFC 6295):");
        Collector c = new Collector();
        RtpMidiParser p = new RtpMidiParser(c);
        byte[] body = new byte[600];
        for (int i = 0; i < body.length; i++) body[i] = (byte) (i % 0x7F);
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0xF0); o.write(body, 0, body.length); o.write(0xF7);
        byte[] msg = o.toByteArray();
        for (byte[] seg : segment(msg, 250)) p.parse(rtp(seg));
        check(c.sysex.size() == 1, "één samengevoegd bericht (" + c.sysex.size() + ")");
        if (c.sysex.size() == 1) {
            check(java.util.Arrays.equals(c.sysex.get(0), msg), "byte voor byte gelijk");
        }
        check(p.framingErrors == 0, "geen uitlijnfouten (" + p.framingErrors + ")");
    }

    static void testSegmentedWithDelta() {
        System.out.println("SysEx in delen, met delta-tijd voor elke markering:");
        Collector c = new Collector();
        RtpMidiParser p = new RtpMidiParser(c);
        byte[] body = new byte[400];
        for (int i = 0; i < body.length; i++) body[i] = (byte) (i % 0x7F);
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0xF0); o.write(body, 0, body.length); o.write(0xF7);
        byte[] msg = o.toByteArray();
        for (byte[] seg : segment(msg, 150)) p.parse(rtpWithDelta(seg));
        check(c.sysex.size() == 1 && java.util.Arrays.equals(c.sysex.get(0), msg),
                "byte voor byte gelijk");
        check(p.framingErrors == 0, "geen uitlijnfouten (" + p.framingErrors + ")");
    }

    static void testRawContinuation() {
        System.out.println("SysEx in delen zonder F7-markering (afwijkende zender):");
        Collector c = new Collector();
        RtpMidiParser p = new RtpMidiParser(c);
        byte[] body = new byte[300];
        for (int i = 0; i < body.length; i++) body[i] = (byte) (i % 0x7F);
        // deel 1: F0 + helft (geen afsluiter), deel 2: rest + F7
        ByteArrayOutputStream a = new ByteArrayOutputStream();
        a.write(0xF0); a.write(body, 0, 150);
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(body, 150, 150); b.write(0xF7);
        p.parse(rtp(a.toByteArray()));
        p.parse(rtp(b.toByteArray()));
        check(c.sysex.size() == 1, "bericht samengevoegd (" + c.sysex.size() + ")");
        if (c.sysex.size() == 1) check(c.sysex.get(0).length == body.length + 2, "juiste lengte");
    }

    static void testBankNamesEndToEnd() {
        System.out.println("Volledige banknamen-dump in delen, tot en met de bibliotheek:");
        String[] names = new String[128];
        for (int i = 0; i < 128; i++) names[i] = "Preset " + (i + 1) + " XY";
        byte[] data = nameBlock(names);
        byte[] packed = pack7(data);

        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0xF0); o.write(0x00); o.write(0x20); o.write(0x32); o.write(0x20);
        o.write(0x00);        // device id
        o.write(0x0B);        // bank names dump response
        o.write(0x06);        // protocolversie
        o.write(0x02);        // bank C
        o.write(packed, 0, packed.length);
        o.write(0xF7);
        byte[] msg = o.toByteArray();

        SysexLibrary lib = new SysexLibrary();
        RtpMidiParser p = new RtpMidiParser(new RtpMidiParser.Sink() {
            public void sysex(byte[] m) { lib.handleSysEx(m); }
            public void controlChange(int ch, int cc, int v) {}
            public void programChange(int ch, int pr) {}
        });
        List<byte[]> segs = segment(msg, 256);
        System.out.println("  (" + msg.length + " bytes in " + segs.size() + " delen)");
        for (byte[] s : segs) p.parse(rtp(s));

        check(p.framingErrors == 0, "geen uitlijnfouten (" + p.framingErrors + ")");
        String json = lib.namesJson();
        check(json.contains("\"C-0\":[\"Preset 1 XY\""), "eerste naam goed");
        check(json.contains("\"C-13\":[\"Preset 14 XY\""), "veertiende naam goed (hier ging het mis)");
        check(json.contains("\"C-127\":[\"Preset 128 XY\""), "laatste naam goed");
        check(lib.badNames == 0, "geen onleesbare namen (" + lib.badNames + ")");
        int count = json.split("\\],").length;
        check(count == 128, "alle 128 namen aanwezig (" + count + ")");
    }

    static void testProgramDumpEndToEnd() {
        System.out.println("Programma-dump in delen, met naam en categorie:");
        byte[] prog = new byte[SysexLibrary.PROGRAM_BYTES];
        for (int i = 0; i < 223; i++) prog[i] = (byte) (i & 0xFF); // parameterwaarden
        byte[] nm = "Blue Dolphin BC".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        System.arraycopy(nm, 0, prog, 223, nm.length);
        prog[240] = 2; // categorie PAD
        byte[] packed = pack7(prog);

        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0xF0); o.write(0x00); o.write(0x20); o.write(0x32); o.write(0x20);
        o.write(0x00); o.write(0x02); o.write(0x06);
        o.write(0x00);   // bank A
        o.write(0x07);   // programma 8
        o.write(packed, 0, packed.length);
        o.write(0xF7);

        SysexLibrary lib = new SysexLibrary();
        RtpMidiParser p = new RtpMidiParser(new RtpMidiParser.Sink() {
            public void sysex(byte[] m) { lib.handleSysEx(m); }
            public void controlChange(int ch, int cc, int v) {}
            public void programChange(int ch, int pr) {}
        });
        for (byte[] s : segment(o.toByteArray(), 128)) p.parse(rtp(s));

        String json = lib.namesJson();
        check(json.contains("\"A-7\":[\"Blue Dolphin BC\",2,1]"), "naam, categorie en patch: " + json);
        check(lib.getPatch(0, 7) != null, "patch bewaard voor terugschrijven");
        check(p.framingErrors == 0, "geen uitlijnfouten (" + p.framingErrors + ")");
    }
}
