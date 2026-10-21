package ui.domino.runtime;

import android.graphics.Color;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Draw behind the status/navigation bars; the web app pads itself with
        // the safe-area insets Capacitor's SystemBars plugin provides.
        // Bars start DARK (light icons, transparent): auto-detection keyed off
        // the old light window theme and washed the dark UI with a light
        // scrim. The web still refines the style per opened app via SystemBars.
        EdgeToEdge.enable(
            this,
            SystemBarStyle.dark(Color.TRANSPARENT, Color.TRANSPARENT),
            SystemBarStyle.dark(Color.TRANSPARENT, Color.TRANSPARENT)
        );
        super.onCreate(savedInstanceState);
    }
}
