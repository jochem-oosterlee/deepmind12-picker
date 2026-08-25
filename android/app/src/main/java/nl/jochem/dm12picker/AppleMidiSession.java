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
        byte[] buf = new byte[4096];
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
        if (pkt.length >= 4 && pkt[0] == (byte) 0xFF && pkt[1] == (byte) 0xFF) {
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
        }
        // anders: binnenkomende RTP-MIDI van de synth — genegeerd
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
