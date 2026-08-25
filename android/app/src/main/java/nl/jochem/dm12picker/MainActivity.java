package nl.jochem.dm12picker;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
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

    private AppleMidiSession session;
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Het DeepMind-accesspoint heeft geen internet; Android stuurt verkeer dan
        // standaard via een andere route (bijv. mobiele data). Bind het hele proces
        // aan het WiFi-netwerk zodat de UDP-pakketten echt via WiFi gaan.
        bindToWifi();

        session = new AppleMidiSession(guessDeepMindIp(), AppleMidiSession.APPLEMIDI_PORT);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setBackgroundColor(0xFF14161A);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (session != null) session.close();
    }

    private void bindToWifi() {
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkRequest req = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .build();
            // callback op de main-thread, zodat `session` dan zeker bestaat
            cm.requestNetwork(req, new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    cm.bindProcessToNetwork(network);
                    if (session != null) session.bindTo(network);
                }

                @Override
                public void onLost(Network network) {
                    cm.bindProcessToNetwork(null);
                }
            }, new Handler(Looper.getMainLooper()));
        } catch (Exception e) {
            Toast.makeText(this, "WiFi-binding mislukt: " + e.getMessage(),
                    Toast.LENGTH_LONG).show();
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
        return "192.168.4.1";
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
            return "{\"connected\":" + session.connected
                    + ",\"status\":\"" + jsonEscape(session.status)
                    + "\",\"ip\":\"" + jsonEscape(session.getPeerIp()) + "\"}";
        }

        @JavascriptInterface
        public void setIp(String ip) {
            if (ip != null && !ip.trim().isEmpty()) {
                session.retarget(ip.trim());
            }
        }

        @JavascriptInterface
        public void copyToClipboard(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("dm12-presets", text));
                Toast.makeText(MainActivity.this,
                        "Back-up naar klembord gekopieerd", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public String readClipboard() {
            FutureTask<String> task = new FutureTask<>(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence t = cm.getPrimaryClip().getItemAt(0).getText();
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
