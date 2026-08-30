package nl.jochem.dm12picker;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiNetworkSpecifier;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import java.util.concurrent.FutureTask;

public class MainActivity extends Activity {

    // Het accesspoint van de synth. Vast gegeven, net als het adres dat de
    // DeepMind daar altijd heeft; het wachtwoord is hoofdlettergevoelig.
    private static final String AP_SSID = "Deepmind12";
    private static final String AP_PW = "PassPhrase";
    private static final String AP_IP = "192.168.12.1";

    // Het accesspoint van de synth bestaat pas nadat iemand het op het instrument
    // aanzet: de DeepMind komt na het opstarten altijd op Disabled terug. Een
    // enkele poging bij het starten van de app is dus bijna altijd te vroeg.
    private static final long AUTO_WIFI_FIRST = 4000;
    private static final long AUTO_WIFI_MIN = 15000;
    private static final long AUTO_WIFI_MAX = 120000;

    private AppleMidiSession session;
    private SysexLibrary lib;
    private WebView web;
    private SharedPreferences prefs;
    private ConnectivityManager cm;
    private int rxParamMsb = 0, rxParamLsb = 0, rxDataMsb = 0;
    private ConnectivityManager.NetworkCallback specCallback;
    private volatile boolean specActive = false;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Runnable autoWifiTick;
    private boolean specPending = false;    // er loopt al een aanvraag
    private boolean saidWifiOff = false;    // die melding maar een keer
    private long autoWifiWait = AUTO_WIFI_MIN;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        prefs = getSharedPreferences("dm12", MODE_PRIVATE);

        // Het DeepMind-accesspoint heeft geen internet; Android stuurt verkeer dan
        // standaard via een andere route (bijv. mobiele data). Bind het hele proces
        // aan het WiFi-netwerk zodat de UDP-pakketten echt via WiFi gaan.
        bindToWifi();

        lib = new SysexLibrary();
        lib.load(getFilesDir());

        session = new AppleMidiSession(guessDeepMindIp(), AppleMidiSession.APPLEMIDI_PORT);
        session.setListener(new AppleMidiSession.MidiListener() {
            @Override
            public void onSysEx(byte[] msg) {
                lib.handleSysEx(msg);
            }

            @Override
            public void onControlChange(int ch, int cc, int value) {
                // NRPN van de synth volgen, zodat de editor meebeweegt met de faders
                lib.noteCC(cc, value);
                switch (cc) {
                    case 99: rxParamMsb = value; rxDataMsb = 0; break;
                    case 98: rxParamLsb = value; rxDataMsb = 0; break;
                    case 6: rxDataMsb = value; break;
                    case 38:
                        lib.handleParam((rxParamMsb << 7) | rxParamLsb,
                                (rxDataMsb << 7) | value);
                        break;
                    default: {
                        // de synth kan ook gewone CC's sturen (WiFi-modus op CC)
                        int p = SysexLibrary.ccToParam(cc);
                        if (p >= 0) lib.handleParam(p, SysexLibrary.ccToValue(value));
                        break;
                    }
                }
            }

            @Override
            public void onProgramChange(int ch, int program) {
                lib.handleProgramChange(-1, program);
                // op de synth is een ander programma gekozen: nieuwe waarden ophalen
                session.sendSysEx(SysexLibrary.reqEditBuffer(
                        lib.deviceId >= 0 ? lib.deviceId : 0));
            }
        });

        // Verbind zelf met het accesspoint van de synth zolang de sessie niet staat.
        // Blijven proberen, want het accesspoint komt pas op als het bij het
        // instrument aangezet wordt - vaak lang nadat de app al open staat.
        autoWifiTick = new Runnable() {
            @Override
            public void run() {
                if (specActive || specPending || session.connected) {
                    scheduleAutoWifi(AUTO_WIFI_MIN);
                    return;
                }
                connectSpecifier(AP_SSID, AP_PW);
                scheduleAutoWifi(autoWifiWait);
            }
        };
        scheduleAutoWifi(AUTO_WIFI_FIRST);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setBackgroundColor(0xFFF3F5F9);   // zelfde grondtoon als de pagina
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (autoWifiTick != null) ui.removeCallbacks(autoWifiTick);
        disconnectSpecifier();
        if (lib != null) lib.save(getFilesDir());
        if (session != null) session.close();
    }

    /** Volgende poging op het accesspoint van de synth inplannen. */
    private void scheduleAutoWifi(long delayMs) {
        if (autoWifiTick == null) return;
        ui.removeCallbacks(autoWifiTick);
        ui.postDelayed(autoWifiTick, delayMs);
    }

    private void bindToWifi() {
        try {
            NetworkRequest req = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .build();
            // callback op de main-thread, zodat `session` dan zeker bestaat
            cm.requestNetwork(req, new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    if (specActive) return; // in-app WiFi-verbinding heeft voorrang
                    cm.bindProcessToNetwork(network);
                    if (session != null) session.bindTo(network);
                }

                @Override
                public void onLost(Network network) {
                    if (!specActive) cm.bindProcessToNetwork(null);
                }
            }, new Handler(Looper.getMainLooper()));
        } catch (Exception e) {
            Toast.makeText(this, "WiFi binding failed: " + e.getMessage(),
                    Toast.LENGTH_LONG).show();
        }
    }

    /** Verbind (app-gebonden) met het accesspoint van de DeepMind. Android 10+. */
    private void connectSpecifier(String ssid, String password) {
        if (Build.VERSION.SDK_INT < 29) return;  // dan is het handwerk in de instellingen
        try {
            WifiManager wm = (WifiManager) getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm != null && !wm.isWifiEnabled()) {
                if (!saidWifiOff) {
                    saidWifiOff = true;
                    Toast.makeText(this, "WiFi is off - turn WiFi on in Android",
                            Toast.LENGTH_LONG).show();
                }
                return;
            }
        } catch (Exception ignored) {
        }
        disconnectSpecifier();
        saidWifiOff = false;
        WifiNetworkSpecifier.Builder spec = new WifiNetworkSpecifier.Builder()
                .setSsid(ssid);
        if (password != null && !password.isEmpty()) {
            spec.setWpa2Passphrase(password);
        }
        NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(spec.build())
                .build();
        specCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                specActive = true;
                specPending = false;
                autoWifiWait = AUTO_WIFI_MIN;
                cm.bindProcessToNetwork(network);
                if (session != null) session.bindTo(network);
                // de synth is de gateway van zijn eigen accesspoint
                retargetToGateway();
            }

            @Override
            public void onUnavailable() {
                specActive = false;
                specPending = false;
                // Afgewezen of niets gevonden: rustiger aan doen, anders staat de
                // systeemdialoog elke vijftien seconden weer in beeld.
                autoWifiWait = Math.min(autoWifiWait * 2, AUTO_WIFI_MAX);
                specCallback = null;
            }

            @Override
            public void onLost(Network network) {
                specActive = false;
                specPending = false;
                cm.bindProcessToNetwork(null);
            }
        };
        try {
            specPending = true;
            cm.requestNetwork(req, specCallback, new Handler(Looper.getMainLooper()));
        } catch (Exception e) {
            specPending = false;
            specCallback = null;
        }
    }

    private void disconnectSpecifier() {
        if (specCallback != null) {
            try {
                cm.unregisterNetworkCallback(specCallback);
            } catch (Exception ignored) {
            }
            specCallback = null;
        }
        specPending = false;
        if (specActive) {
            specActive = false;
            cm.bindProcessToNetwork(null);
        }
    }

    /** Het accesspoint (de DeepMind) is normaal de gateway van het WiFi-netwerk. */
    private String guessDeepMindIp() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            DhcpInfo d = wm.getDhcpInfo();
            if (d != null && d.gateway != 0) {
                int gw = d.gateway; // little-endian int
                return (gw & 0xFF) + "." + ((gw >> 8) & 0xFF) + "."
                        + ((gw >> 16) & 0xFF) + "." + ((gw >> 24) & 0xFF);
            }
        } catch (Exception ignored) {
        }
        return AP_IP;
    }

    /** Na een nieuwe WiFi-verbinding kan het gateway-IP veranderd zijn. */
    private void retargetToGateway() {
        String ip = guessDeepMindIp();
        if (session != null) session.retarget(ip);
    }

    private static String jsonEscape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /** Wordt vanuit JavaScript in de WebView aangeroepen (binder-thread). */
    private class Bridge {

        @JavascriptInterface
        public boolean send(int bank, int prog, int ch) {
            bank = Math.max(0, Math.min(7, bank));
            prog = Math.max(0, Math.min(127, prog));
            ch = Math.max(0, Math.min(15, ch));
            return session.sendProgram(bank, prog, ch);
        }

        @JavascriptInterface
        public String getStatus() {
            // op Android loopt alles over AppleMIDI, dus altijd WiFi
            return "{\"connected\":" + session.connected
                    + ",\"link\":\"WiFi\""
                    + ",\"status\":\"" + jsonEscape(session.status)
                    + "\",\"event\":\"" + jsonEscape(session.lastEvent)
                    + "\",\"ip\":\"" + jsonEscape(session.getPeerIp()) + "\"}";
        }

        @JavascriptInterface
        public void setIp(String ip) {
            if (ip != null && !ip.trim().isEmpty()) {
                session.retarget(ip.trim());
            }
        }

                @JavascriptInterface
        public void discover() {
            session.discover();
        }

        @JavascriptInterface
        public String discovered() {
            StringBuilder sb = new StringBuilder("{\"running\":")
                    .append(session.discovering).append(",\"status\":\"")
                    .append(jsonEscape(session.discoverStatus)).append("\",\"found\":[");
            synchronized (session.discovered) {
                for (int i = 0; i < session.discovered.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append("\"").append(jsonEscape(session.discovered.get(i))).append("\"");
                }
            }
            return sb.append("]}").toString();
        }

                @JavascriptInterface
        public boolean sendCC(int cc, int value, int ch) {
            return session.sendCC(Math.max(0, Math.min(127, cc)),
                    Math.max(0, Math.min(127, value)), Math.max(0, Math.min(15, ch)));
        }

        @JavascriptInterface
        public boolean sendNRPN(int param, int value, int ch) {
            return session.sendNRPN(Math.max(0, Math.min(16383, param)),
                    Math.max(0, Math.min(255, value)), Math.max(0, Math.min(15, ch)));
        }

        /**
         * App Notify: hiermee meldt een bedieningsapp zich aan. De synth zet dan
         * NRPN en SysEx aan op deze interface (handleiding 19.2.2).
         */
        @JavascriptInterface
        public boolean appNotify(int deviceId) {
            if (deviceId < 0) { // device-ID onbekend: alle 16 proberen, de synth antwoordt op de zijne
                boolean ok = false;
                for (int id = 0; id < 16; id++) {
                    ok |= session.sendSysEx(SysexLibrary.reqAppNotify(id));
                }
                return ok;
            }
            return session.sendSysEx(SysexLibrary.reqAppNotify(Math.min(15, deviceId)));
        }

        // ---------- bibliotheek ----------

        @JavascriptInterface
        public boolean requestBankNames(int bank, int dev) {
            return session.sendSysEx(SysexLibrary.reqBankNames(dev, Math.max(0, Math.min(7, bank))));
        }

        @JavascriptInterface
        public boolean requestProgram(int bank, int prog, int dev) {
            return session.sendSysEx(SysexLibrary.reqProgram(dev,
                    Math.max(0, Math.min(7, bank)), Math.max(0, Math.min(127, prog))));
        }

        @JavascriptInterface
        public boolean requestEditBuffer(int dev) {
            return session.sendSysEx(SysexLibrary.reqEditBuffer(dev));
        }

        /** Stuurt een opgeslagen patch naar de edit buffer: hoorbaar, niets overschreven. */
        @JavascriptInterface
        public boolean patchToEditBuffer(int bank, int prog, int dev) {
            byte[] p = lib.getPatch(bank, prog);
            if (p == null) return false;
            return session.sendSysEx(SysexLibrary.toEditBuffer(dev, p));
        }

        /** Schrijft een opgeslagen patch naar een slot in de synth — overschrijft dat slot. */
        @JavascriptInterface
        public boolean patchToSlot(int srcBank, int srcProg, int dstBank, int dstProg, int dev) {
            byte[] p = lib.getPatch(srcBank, srcProg);
            if (p == null) return false;
            return session.sendSysEx(SysexLibrary.writeProgram(dev,
                    Math.max(0, Math.min(7, dstBank)), Math.max(0, Math.min(127, dstProg)), p));
        }

        @JavascriptInterface
        public boolean requestGlobals(int dev) {
            return session.sendSysEx(SysexLibrary.reqGlobal(dev));
        }

        @JavascriptInterface
        public String globals() {
            return lib.globalsJson();
        }

        /** Schrijft één globale instelling terug; de rest blijft byte-identiek. */
        @JavascriptInterface
        public boolean writeGlobal(int index, int value, int dev) {
            byte[] m = lib.globalWriteMsg(dev, index, Math.max(0, Math.min(255, value)));
            return m != null && session.sendSysEx(m);
        }

        @JavascriptInterface
        public boolean writeGlobalBlock(String valuesJson, int dev) {
            try {
                String s = valuesJson.trim();
                if (s.startsWith("[")) s = s.substring(1);
                if (s.endsWith("]")) s = s.substring(0, s.length() - 1);
                String[] parts = s.split(",");
                int[] vals = new int[parts.length];
                for (int i = 0; i < parts.length; i++) {
                    vals[i] = Integer.parseInt(parts[i].trim());
                }
                byte[] m = lib.globalBlockMsg(dev, vals);
                if (m == null) return false;
                lib.logOut(m);
                return session.sendSysEx(m);
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String libNames() {
            return lib.namesJson();
        }

        @JavascriptInterface
        public String log() {
            return lib.logJson(60);
        }

        @JavascriptInterface
        public String libStatus() {
            String s = lib.statusJson();
            // diagnose van de ontvangstkant erbij, zodat de UI kan tonen wat er aankomt
            return s.substring(0, s.length() - 1)
                    + ",\"pkts\":" + session.parser.packets
                    + ",\"sysex\":" + session.parser.sysexCount
                    + ",\"sysexLen\":" + session.parser.lastSysexLen
                    + ",\"segs\":" + session.parser.segments
                    + ",\"framing\":" + session.parser.framingErrors + "}";
        }

        @JavascriptInterface
        public String libParams() {
            return lib.paramsJson();
        }

        @JavascriptInterface
        public void libSave() {
            lib.save(getFilesDir());
        }

        @JavascriptInterface
        public boolean panic(int ch) {
            int c = Math.max(0, Math.min(15, ch));
            boolean a = session.sendCC(123, 0, c); // All Notes Off
            boolean b = session.sendCC(120, 0, c); // All Sound Off
            return a && b;
        }

                @JavascriptInterface
        public void useGatewayIp() {
            retargetToGateway();
        }

        @JavascriptInterface
        public void copyToClipboard(String text) {
            runOnUiThread(() -> {
                ClipboardManager cmgr = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cmgr.setPrimaryClip(ClipData.newPlainText("dm12-presets", text));
                Toast.makeText(MainActivity.this,
                        "Backup copied to the clipboard", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public String readClipboard() {
            FutureTask<String> task = new FutureTask<>(() -> {
                ClipboardManager cmgr = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cmgr.hasPrimaryClip() && cmgr.getPrimaryClip().getItemCount() > 0) {
                    CharSequence t = cmgr.getPrimaryClip().getItemAt(0).getText();
                    return t != null ? t.toString() : "";
                }
                return "";
            });
            runOnUiThread(task);
            try {
                return task.get();
            } catch (Exception e) {
                return "";
            }
        }
    }
}
