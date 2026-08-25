package nl.jochem.dm12picker;

import java.io.ByteArrayOutputStream;

/**
 * Ontleedt de MIDI-command-sectie van RTP-MIDI-pakketten (RFC 6295).
 *
 * Een groot SysEx-bericht past niet in één pakket en wordt in delen gestuurd.
 * De RFC codeert dat zo:
 *
 *   eerste deel    : F0 <data> F0
 *   tussenliggend  : F7 <data> F0
 *   laatste deel   : F7 <data> F7
 *
 * De afsluitende F0 hoort dus niet bij de data en de F7 aan het begin van een
 * vervolg is een markering. Eén byte verkeerd behandelen laat de hele rest van
 * de stroom uit de maat lopen, wat bij ingepakte dumps direct onleesbare tekst
 * oplevert.
 *
 * Deze klasse is bewust vrij van Android-afhankelijkheden, zodat de ontleding
 * los te testen is met android/test/RtpMidiParserTest.java.
 */
public class RtpMidiParser {

    public interface Sink {
        void sysex(byte[] msg);
        void controlChange(int ch, int cc, int value);
        void programChange(int ch, int program);
    }

    public volatile int packets = 0, sysexCount = 0, lastSysexLen = 0,
            segments = 0, framingErrors = 0;

    private final Sink sink;
    private final ByteArrayOutputStream sysex = new ByteArrayOutputStream();

    public RtpMidiParser(Sink sink) {
        this.sink = sink;
    }

    public void parse(byte[] pkt) {
        if (pkt.length < 13) return;
        packets++;
        int b0 = pkt[12] & 0xFF;
        int len, off;
        if ((b0 & 0x80) != 0) { // lange vorm: 12-bits lengte
            if (pkt.length < 14) return;
            len = ((b0 & 0x0F) << 8) | (pkt[13] & 0xFF);
            off = 14;
        } else {
            len = b0 & 0x0F;
            off = 13;
        }
        boolean leadingDelta = (b0 & 0x20) != 0; // Z-bit
        int end = Math.min(pkt.length, off + len);
        int i = off;
        boolean first = true;
        int running = 0;

        // Vervolg van een SysEx uit een eerder pakket. Of er een delta-tijd vóór
        // de F7-markering staat verschilt per implementatie, dus kijk op beide
        // plekken; zonder markering is alles vanaf het begin payload.
        if (sysex.size() > 0) {
            int s;
            if (off < end && (pkt[off] & 0xFF) == 0xF7) {
                s = off + 1;
            } else {
                int d = skipDelta(pkt, off, end);
                s = (d < end && (pkt[d] & 0xFF) == 0xF7) ? d + 1 : off;
            }
            i = consumeSysEx(pkt, s, end);
            first = false;
        }

        while (i < end) {
            if (!first || leadingDelta) i = skipDelta(pkt, i, end);
            first = false;
            if (i >= end) break;

            int st = pkt[i] & 0xFF;
            if (st == 0xF0) {
                sysex.reset();
                sysex.write(0xF0);
                i = consumeSysEx(pkt, i + 1, end);
                continue;
            }
            if (st == 0xF7 && sysex.size() > 0) {
                i = consumeSysEx(pkt, i + 1, end);
                continue;
            }

            if (st >= 0x80) {
                i++;
                if (st < 0xF0) running = st; // system-berichten wissen running status
            } else {
                st = running;
            }
            if (st == 0) break;

            int n = dataByteCount(st);
            if (i + n > end) break;
            int d1 = n > 0 ? pkt[i] & 0x7F : 0;
            int d2 = n > 1 ? pkt[i + 1] & 0x7F : 0;
            i += n;

            int ch = st & 0x0F;
            if ((st & 0xF0) == 0xB0) sink.controlChange(ch, d1, d2);
            else if ((st & 0xF0) == 0xC0) sink.programChange(ch, d1);
        }
    }

    /** Slaat een delta-tijd over: bytes met het hoogste bit gezet, plus de afsluitende. */
    private static int skipDelta(byte[] pkt, int i, int end) {
        while (i < end && (pkt[i] & 0x80) != 0) i++;
        return i < end ? i + 1 : i;
    }

    /**
     * Leest SysEx-payload tot een van de deelmarkeringen: F7 sluit het hele
     * bericht af, F0 sluit een deel af waarvan het vervolg later komt. Loopt het
     * pakket zonder markering af, dan volgt het vervolg ook later.
     */
    private int consumeSysEx(byte[] pkt, int i, int end) {
        segments++;
        while (i < end) {
            int v = pkt[i++] & 0xFF;
            if (v == 0xF7) {          // laatste deel: bericht compleet
                sysex.write(0xF7);
                byte[] msg = sysex.toByteArray();
                sysex.reset();
                sysexCount++;
                lastSysexLen = msg.length;
                sink.sysex(msg);
                return i;
            }
            if (v == 0xF0) return i;  // deel afgesloten, vervolg komt later
            if (v == 0xF4 || v == 0xF5) { // afgebroken bericht
                sysex.reset();
                return i;
            }
            if (v >= 0x80) {          // hier kan geen statusbyte staan: uitlijning kwijt
                framingErrors++;
                sysex.reset();
                return i - 1;
            }
            sysex.write(v);
        }
        return i;
    }

    private static int dataByteCount(int status) {
        if (status >= 0x80 && status < 0xC0) return 2;   // note off/on, aftertouch, CC
        if (status < 0xE0) return 1;                     // program change, channel pressure
        if (status < 0xF0) return 2;                     // pitch bend
        if (status == 0xF1 || status == 0xF3) return 1;
        if (status == 0xF2) return 2;
        return 0;
    }
}
