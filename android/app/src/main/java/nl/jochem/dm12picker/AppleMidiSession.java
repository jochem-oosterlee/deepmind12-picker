package nl.jochem.dm12picker;

import java.io.ByteArrayOutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Random;

/**
 * Minimale AppleMIDI (RTP-MIDI) initiator: sessie opzetten met de DeepMind 12,
 * kloksynchronisatie beantwoorden en MIDI-berichten versturen.
 * Directe port van dm12-bridge.py.
 */
public class AppleMidiSession {

    private static final byte[] SIG = {(byte) 0xFF, (byte) 0xFF};
    public static final int APPLEMIDI_PORT = 5004;

    private final Object lock = new Object();
    private final Random rnd = new Random();
    private final String name = "DM12 Picker";
    private final int ssrc = rnd.nextInt();
    private final long startNanos = System.nanoTime();

    private volatile String peerIp;
    private volatile int peerPort;
    private volatile boolean stop = false;

    volatile boolean connected = false;
    volatile String status = "wacht op verbinding";
    volatile String lastEvent = "";

    /** Meldingen over binnenkomende MIDI van de synth. */
    public interface MidiListener {
        void onSysEx(byte[] msg);
        void onControlChange(int ch, int cc, int value);
        void onProgramChange(int ch, int program);
    }

    private volatile MidiListener listener;
    private final ByteArrayOutputStream sysex = new ByteArrayOutputStream();

    /** Diagnose van de ontvangstkant. */
    public volatile int midiPackets = 0, sysexCount = 0, lastSysexLen = 0,
            sysexSegments = 0, framingErrors = 0;

    public void setListener(MidiListener l) {
        this.listener = l;
    }

    private DatagramSocket ctrl;
    private DatagramSocket data;
    private int seq = new Random().nextInt(0xFFFF);
    private int phase = 0; // 0=idle, 1=IN op control verstuurd, 2=IN op data verstuurd
    private int token = 0;
    private long lastRxMs = 0;
    private long lastSyncMs = 0;
    private long lastInviteMs = 0;
    private int inviteCount = 0;

    public AppleMidiSession(String ip, int port) {
        this.peerIp = ip;
        this.peerPort = port;
        bindPair();
        Thread rc = new Thread(() -> rxLoop(ctrl), "am-rx-ctrl");
        Thread rd = new Thread(() -> rxLoop(data), "am-rx-data");
        Thread mt = new Thread(this::maintLoop, "am-maint");
        rc.setDaemon(true); rd.setDaemon(true); mt.setDaemon(true);
        rc.start(); rd.start(); mt.start();
    }

    public String getPeerIp() { return peerIp; }

    private void bindPair() {
        for (int p = 5006; p < 5100; p += 2) {
            try {
                DatagramSocket c = new DatagramSocket(null);
                DatagramSocket d = new DatagramSocket(null);
                c.setReuseAddress(false);
                d.setReuseAddress(false);
                c.bind(new InetSocketAddress(p));
                try {
                    d.bind(new InetSocketAddress(p + 1));
                } catch (Exception e) {
                    c.close(); d.close();
                    continue;
                }
                c.setSoTimeout(500);
                d.setSoTimeout(500);
                ctrl = c; data = d;
                return;
            } catch (Exception ignored) {
                // volgende poortpaar proberen
            }
        }
        throw new RuntimeException("geen vrije UDP-poorten");
    }

    public void retarget(String ip) {
        synchronized (lock) {
            sendBye();
            peerIp = ip;
            connected = false;
            phase = 0;
            lastInviteMs = 0;
            inviteCount = 0;
            status = "wacht op verbinding";
        }
    }

    /** Bind de bestaande sockets aan een specifiek netwerk (Android WiFi-fix). */
    public void bindTo(android.net.Network network) {
        synchronized (lock) {
            try {
                network.bindSocket(ctrl);
                network.bindSocket(data);
            } catch (Exception e) {
                status = "WiFi-binding mislukt: " + e.getMessage();
                return;
            }
            connected = false;
            phase = 0;
            lastInviteMs = 0;
            inviteCount = 0;
        }
    }

    private long tsNow() {
        return (System.nanoTime() - startNanos) / 100_000L; // eenheden van 100 us
    }

    // ---------- pakketten ----------
    private byte[] cmdPacket(char c1, char c2, int tok) {
        byte[] nm = name.getBytes(StandardCharsets.UTF_8);
        ByteBuffer b = ByteBuffer.allocate(16 + nm.length + 1);
        b.put(SIG).put((byte) c1).put((byte) c2);
        b.putInt(2).putInt(tok).putInt(ssrc);
        b.put(nm).put((byte) 0);
        return b.array();
    }

    private void udpSend(DatagramSocket s, byte[] pkt, String ip, int port) {
        try {
            s.send(new DatagramPacket(pkt, pkt.length, InetAddress.getByName(ip), port));
        } catch (Exception e) {
            status = "netwerkfout: " + e.getMessage();
        }
    }

    private void sendInvites() {
        long now = System.currentTimeMillis();
        if (now - lastInviteMs < 2000) return;
        lastInviteMs = now;
        if (phase == 0) {
            token = rnd.nextInt();
            phase = 1;
        }
        inviteCount++;
        if (phase == 1) {
            udpSend(ctrl, cmdPacket('I', 'N', token), peerIp, peerPort);
        } else if (phase == 2) {
            udpSend(data, cmdPacket('I', 'N', token), peerIp, peerPort + 1);
        }
        if (!connected && !status.startsWith("netwerkfout")
                && !status.startsWith("WiFi-binding")) {
            status = "zoekt " + peerIp + " (poging " + inviteCount + ")";
        }
    }

    private void sendBye() {
        if (connected || phase > 0) {
            udpSend(ctrl, cmdPacket('B', 'Y', token), peerIp, peerPort);
        }
    }

    private void sendCk(int count, long ts1, long ts2, long ts3) {
        ByteBuffer b = ByteBuffer.allocate(36);
        b.put(SIG).put((byte) 'C').put((byte) 'K');
        b.putInt(ssrc);
        b.put((byte) count).put((byte) 0).put((byte) 0).put((byte) 0);
        b.putLong(ts1).putLong(ts2).putLong(ts3);
        udpSend(data, b.array(), peerIp, peerPort + 1);
    }

    // ---------- lussen ----------
    private void maintLoop() {
        while (!stop) {
            synchronized (lock) {
                if (!connected) {
                    sendInvites();
                } else {
                    long now = System.currentTimeMillis();
                    if (now - lastSyncMs > 8000) {
                        lastSyncMs = now;
                        sendCk(0, tsNow(), 0, 0);
                    }
                    if (now - lastRxMs > 60000) {
                        connected = false;
                        phase = 0;
                        lastInviteMs = 0;
                        status = "verbinding verloren, opnieuw verbinden";
                    }
                }
            }
            try { Thread.sleep(500); } catch (InterruptedException e) { return; }
        }
    }

    private void rxLoop(DatagramSocket sock) {
        // ruim genoeg voor de grootste dump (banknamen: ~2360 bytes)
        byte[] buf = new byte[16384];
        while (!stop) {
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            try {
                sock.receive(p);
            } catch (SocketTimeoutException e) {
                continue;
            } catch (Exception e) {
                return; // socket gesloten
            }
            byte[] pkt = new byte[p.getLength()];
            System.arraycopy(buf, 0, pkt, 0, p.getLength());
            synchronized (lock) {
                handle(sock, pkt, p.getAddress(), p.getPort());
            }
        }
    }

    private void handle(DatagramSocket sock, byte[] pkt, InetAddress from, int fromPort) {
        lastRxMs = System.currentTimeMillis();
        boolean isCommand = pkt.length >= 4
                && pkt[0] == (byte) 0xFF && pkt[1] == (byte) 0xFF;
        lastEvent = isCommand
                ? "ontving " + (char) (pkt[2] & 0xFF) + (char) (pkt[3] & 0xFF)
                        + " van " + from.getHostAddress()
                : "ontving MIDI-data van " + from.getHostAddress();
        if (isCommand) {
            ByteBuffer b = ByteBuffer.wrap(pkt);
            char c1 = (char) (pkt[2] & 0xFF);
            char c2 = (char) (pkt[3] & 0xFF);
            String cmd = "" + c1 + c2;
            switch (cmd) {
                case "OK":
                    if (pkt.length >= 16 && b.getInt(8) == token) {
                        if (phase == 1 && sock == ctrl) {
                            phase = 2;
                            lastInviteMs = 0;
                            sendInvites();
                        } else if (phase == 2 && sock == data) {
                            connected = true;
                            String peerName = extractName(pkt, 16);
                            status = "verbonden met " + (peerName.isEmpty() ? peerIp : peerName);
                            lastSyncMs = System.currentTimeMillis();
                            sendCk(0, tsNow(), 0, 0);
                        }
                    }
                    break;
                case "NO":
                    status = "verbinding geweigerd door apparaat";
                    phase = 0;
                    break;
                case "IN":
                    if (pkt.length >= 16) {
                        int theirToken = b.getInt(8);
                        byte[] resp = cmdPacket('O', 'K', theirToken);
                        try {
                            sock.send(new DatagramPacket(resp, resp.length, from, fromPort));
                        } catch (Exception ignored) {
                        }
                    }
                    break;
                case "CK":
                    if (pkt.length >= 36) {
                        int count = pkt[8] & 0xFF;
                        long ts1 = b.getLong(12);
                        long ts2 = b.getLong(20);
                        if (count == 0) {
                            sendCk(1, ts1, tsNow(), 0);
                        } else if (count == 1) {
                            sendCk(2, ts1, ts2, tsNow());
                        }
                    }
                    break;
                case "BY":
                    connected = false;
                    phase = 0;
                    lastInviteMs = 0;
                    status = "apparaat verbrak de verbinding";
                    break;
                default:
                    break;
            }
        } else {
            parseRtpMidi(pkt);
        }
    }

    /**
     * Ontleedt de MIDI-command-sectie van een RTP-MIDI-pakket (RFC 6295):
     * headerbyte(s) met lengte, dan MIDI-berichten gescheiden door delta-tijden,
     * met running status. SysEx kan over meerdere pakketten verdeeld zijn.
     */
    private void parseRtpMidi(byte[] pkt) {
        if (pkt.length < 13) return;
        midiPackets++;
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

        // Vervolg van een SysEx die in een eerder pakket begon. Implementaties
        // verschillen in of er een delta-tijd vóór de F7-markering staat, dus
        // zoek die markering op beide plekken. Eén byte verkeerd gokken zou de
        // hele rest van de dump uit de maat laten lopen.
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

            MidiListener l = listener;
            if (l != null) {
                int ch = st & 0x0F;
                if ((st & 0xF0) == 0xB0) l.onControlChange(ch, d1, d2);
                else if ((st & 0xF0) == 0xC0) l.onProgramChange(ch, d1);
            }
        }
    }

    private static int dataByteCount(int status) {
        if (status >= 0x80 && status < 0xC0) return 2;   // note off/on, aftertouch, CC
        if (status < 0xE0) return 1;                     // program change, channel pressure
        if (status < 0xF0) return 2;                     // pitch bend
        if (status == 0xF1 || status == 0xF3) return 1;
        if (status == 0xF2) return 2;
        return 0;
    }

    /** Slaat een delta-tijd over: bytes met het hoogste bit gezet, plus de afsluitende. */
    private static int skipDelta(byte[] pkt, int i, int end) {
        while (i < end && (pkt[i] & 0x80) != 0) i++;
        return i < end ? i + 1 : i;
    }

    /**
     * Leest SysEx-payload tot de afsluitende F7 of tot het pakket op is (dan
     * volgt het vervolg in een later pakket). Een statusbyte binnen een SysEx
     * kan niet: dan is de uitlijning kwijt en gooien we de buffer weg in plaats
     * van onzin door te geven.
     */
    private int consumeSysEx(byte[] pkt, int i, int end) {
        sysexSegments++;
        while (i < end) {
            int v = pkt[i++] & 0xFF;
            if (v == 0xF7) {
                sysex.write(0xF7);
                flushSysEx();
                return i;
            }
            if (v >= 0x80) {
                framingErrors++;
                sysex.reset();
                return i - 1;
            }
            sysex.write(v);
        }
        return i;
    }

    private void flushSysEx() {
        byte[] msg = sysex.toByteArray();
        sysex.reset();
        sysexCount++;
        lastSysexLen = msg.length;
        MidiListener l = listener;
        if (l != null) l.onSysEx(msg);
    }

    private static String extractName(byte[] pkt, int offset) {
        int end = offset;
        while (end < pkt.length && pkt[end] != 0) end++;
        return new String(pkt, offset, end - offset, StandardCharsets.UTF_8);
    }

    // ---------- MIDI versturen ----------
    public boolean sendMidi(List<byte[]> messages) {
        synchronized (lock) {
            if (!connected) return false;
            ByteArrayOutputStream payload = new ByteArrayOutputStream();
            boolean first = true;
            for (byte[] msg : messages) {
                if (!first) payload.write(0x00); // delta-tijd 0
                payload.write(msg, 0, msg.length);
                first = false;
            }
            byte[] pl = payload.toByteArray();
            byte[] header = pl.length < 16
                    ? new byte[]{(byte) pl.length}
                    : new byte[]{(byte) (0x80 | (pl.length >> 8)), (byte) (pl.length & 0xFF)};
            seq = (seq + 1) & 0xFFFF;
            ByteBuffer b = ByteBuffer.allocate(12 + header.length + pl.length);
            b.put((byte) 0x80).put((byte) 0x61);
            b.putShort((short) seq);
            b.putInt((int) (tsNow() & 0xFFFFFFFFL));
            b.putInt(ssrc);
            b.put(header).put(pl);
            try {
                data.send(new DatagramPacket(b.array(), b.capacity(),
                        InetAddress.getByName(peerIp), peerPort + 1));
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }

    public boolean sendCC(int cc, int value, int ch) {
        return sendMidi(List.of(new byte[]{
                (byte) (0xB0 | ch), (byte) (cc & 0x7F), (byte) (value & 0x7F)}));
    }

    /**
     * NRPN volgens de DeepMind-handleiding: parameternummer via CC99/CC98,
     * waarde (0-255) via Data Entry MSB (CC6) en LSB (CC38).
     * De param-select wordt altijd meegestuurd: UDP kan pakketten verliezen en
     * een gemiste select zou de waarde op de vorige parameter laten landen.
     */
    public boolean sendNRPN(int param, int value, int ch) {
        byte st = (byte) (0xB0 | ch);
        return sendMidi(List.of(
                new byte[]{st, 99, (byte) ((param >> 7) & 0x7F)},
                new byte[]{st, 98, (byte) (param & 0x7F)},
                new byte[]{st, 6, (byte) ((value >> 7) & 0x7F)},
                new byte[]{st, 38, (byte) (value & 0x7F)}));
    }

    public boolean sendSysEx(byte[] data) {
        return sendMidi(List.of(data));
    }

    public boolean sendProgram(int bank, int prog, int ch) {
        // DeepMind 12: bank A-H = Bank Select LSB (CC32) 0-7, MSB (CC0) = 0
        return sendMidi(List.of(
                new byte[]{(byte) (0xB0 | ch), 0x00, 0x00},
                new byte[]{(byte) (0xB0 | ch), 0x20, (byte) bank},
                new byte[]{(byte) (0xC0 | ch), (byte) prog}
        ));
    }

    public void close() {
        stop = true;
        synchronized (lock) {
            sendBye();
        }
        ctrl.close();
        data.close();
    }
}
