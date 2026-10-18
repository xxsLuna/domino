package ui.domino.runtime;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Draw behind the status/navigation bars; the web app pads itself with
        // the safe-area insets Capacitor's SystemBars plugin provides.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
