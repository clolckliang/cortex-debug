# Cortex-Debug Waveform Integration

Complete guide to the waveform monitoring system and Live Watch integration.

---

## 🎯 Quick Start

### Step 1: Add Variable to Waveform
```
Live Watch Variable → Right Click → "Add to Waveform"
```

### Step 2: Configure Display
```
Live Watch Variable → Right Click → "Configure for Waveform..."
```

### Step 3: View Waveform
```
Command Palette → "Cortex-Debug: Show Waveform"
```

---

## 📋 Context Menu Reference

### Complete Live Watch Context Menu Structure

```
┌─────────────────────────────────────────────┐
│  Variable: myVar                            │
├─────────────────────────────────────────────┤
│  [Edit]  Edit expression              ✏️   │
│  [▲]     Move expression up           ▲    │
│  [▼]     Move expression down         ▼    │
│  [×]     Remove expression            ×    │
├─────────────────────────────────────────────┤
│  Waveform                                   │
│    [📊]  Add to Waveform                    │
│    [⚙️]  Configure for Waveform...          │
│    [👁️]  Show in Waveform                   │
│    [🗑️]  Remove from Waveform               │
├─────────────────────────────────────────────┤
│  Waveform Analysis                          │
│    Set Waveform Style                       │
│    [📊]  Perform FFT Analysis               │
└─────────────────────────────────────────────┘
```

---

## 🔧 Features

### 1. **Real-time Monitoring**
- Continuous data collection during debug sessions
- Configurable sampling rate (0.1 - 20 Hz)
- Automatic buffer management

### 2. **Variable Configuration**
Each variable can be configured with:
- **Color**: 10 professional color schemes
- **Line Style**: Solid, Dashed, Dotted
- **Line Width**: 1-4 pixels
- **Opacity**: 0-100%
- **Sampling Rate**: Individual per variable

### 3. **Waveform Display**
- VSCode-native UI with theme support
- Zoom and pan controls
- Grid and legend toggle
- Measurement tools
- Export capabilities

### 4. **FFT Analysis**
Frequency domain analysis with:
- Configurable window sizes (256-4096 samples)
- Multiple window functions (Hanning, Hamming, Blackman, Rectangular)
- Results include:
  - Dominant frequency
  - Total Harmonic Distortion (THD)
  - Noise floor
  - Peak detection

---

## 🎨 Configuration Options

### Waveform Settings
Access via: `Command Palette → "Update Waveform Settings"`

```json
{
  "cortex-debug.waveformTimeSpan": 60,        // seconds
  "cortex-debug.waveformRefreshRate": 1.0,    // Hz
  "cortex-debug.waveformMaxDataPoints": 10000,
  "cortex-debug.waveformColorScheme": "professional",
  "cortex-debug.waveformAutoStart": true,
  "cortex-debug.waveformYAxisMode": "auto",
  "cortex-debug.waveformShowGrid": true,
  "cortex-debug.waveformShowLegend": true
}
```

### Color Schemes
- `professional` - Blue, orange, green tones (default)
- `colorblind` - Colorblind-friendly palette
- `highContrast` - High contrast colors
- `soft` - Pastel tones

---

## 📊 Workflow Examples

### Example 1: Monitor Motor Speed
```
1. Add variable: motorSpeed
2. Configure:
   - Color: Blue
   - Line width: 2
   - Style: Solid
3. Start recording
4. View real-time data
5. Perform FFT to check for vibrations
```

### Example 2: Compare Multiple Signals
```
1. Add variables: sensor1, sensor2, sensor3
2. Configure different colors for each
3. Enable legend
4. Zoom to area of interest
5. Export data for further analysis
```

### Example 3: Frequency Analysis
```
1. Add variable with periodic data
2. Right-click → "Perform FFT Analysis"
3. Choose window size: 1024
4. Choose window: Hanning
5. Review dominant frequencies and THD
```

---

## ⌨️ Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Zoom In | `+` or `=` |
| Zoom Out | `-` or `_` |
| Auto Fit | `f` or `F` |
| Reset View | `0` |
| Toggle Grid | `g` or `G` |
| Toggle Legend | `l` or `L` |
| Measurement Mode | `m` or `M` |
| Toggle Recording | `Space` |
| Close Panels | `Esc` |

---

## 💾 Data Export

### Export Data Formats

**JSON Format:**
```json
{
  "settings": { ... },
  "variables": [ ... ],
  "data": {
    "variableId": [
      { "timestamp": 0, "value": 1.23 },
      { "timestamp": 100, "value": 1.45 }
    ]
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

**CSV Format:**
```csv
timestamp,var1,var2,var3
0,1.23,4.56,7.89
100,1.45,4.78,8.01
```

### Configuration Export
Save/load complete waveform configurations including:
- Variable list
- Color settings
- Line styles
- Display preferences

---

## 🔍 Troubleshooting

### Variable not updating?
- Check if debug session is active
- Verify variable is in scope
- Check sampling rate settings
- Ensure recording is started

### Performance issues?
- Reduce refresh rate
- Limit number of variables
- Decrease time span
- Lower max data points

### FFT analysis fails?
- Ensure sufficient data points
- Window size must be ≤ available data
- Variable must have numeric values

---

## 🎓 Best Practices

### 1. Variable Selection
- Choose numeric variables only
- Avoid pointer values
- Use meaningful names

### 2. Performance
- Start with 1 Hz refresh rate
- Increase only if needed
- Monitor VSCode performance

### 3. Data Collection
- Clear old data periodically
- Export important datasets
- Save configurations for reuse

### 4. Analysis
- Use FFT for periodic signals
- Choose appropriate window size
- Consider window function impact

---

## 🔗 Integration Points

### From Debug Variables View
```
Debug Variable → Right Click → "Add to Live Watch"
  → Live Watch → Right Click → "Add to Waveform"
```

### From Live Watch
```
Live Watch → Right Click → Multiple Waveform Options
```

### From Command Palette
```
Ctrl+Shift+P → Search "Waveform" → Choose Command
```

---

## 📚 API Reference

### Commands

| Command ID | Description |
|------------|-------------|
| `cortex-debug.waveform.show` | Open waveform view |
| `cortex-debug.liveWatch.addToWaveform` | Add variable to waveform |
| `cortex-debug.liveWatch.configureForWaveform` | Configure variable for waveform |
| `cortex-debug.liveWatch.showInWaveform` | Focus waveform on variable |
| `cortex-debug.liveWatch.removeFromWaveform` | Remove from waveform |
| `cortex-debug.waveform.startRecording` | Start data recording |
| `cortex-debug.waveform.stopRecording` | Stop data recording |
| `cortex-debug.waveform.exportData` | Export waveform data |
| `cortex-debug.waveform.importConfig` | Import configuration |
| `cortex-debug.waveform.exportConfig` | Export configuration |
| `cortex-debug.waveform.updateSettings` | Update display settings |
| `cortex-debug.waveform.clearAll` | Clear all data |
| `cortex-debug.waveform.fftAnalysisFromNode` | FFT from Live Watch |
| `cortex-debug.waveform.setStyleFromNode` | Set style from Live Watch |

---

## 🎨 UI Themes

The waveform view automatically adapts to your VSCode theme:
- Light themes
- Dark themes
- High contrast themes

All colors use VSCode design tokens for perfect integration.

---

## 📝 Notes

- Waveform monitoring works only during active debug sessions
- Data is cleared when debug session ends
- Export data before ending session to preserve it
- Configuration persists across sessions
- Maximum recommended variables: 10 (for performance)

---

## 🚀 Advanced Features

### Custom Sampling Rates
Set different sampling rates for different variables:
```
Variable A: 10 Hz (fast changing)
Variable B: 1 Hz (slow changing)
```

### Multi-variable Analysis
Compare multiple variables simultaneously with synchronized time axes.

### Memory-efficient Buffer Management
Automatic cleanup of old data points to maintain performance.

---

## 📞 Support

For issues or feature requests:
- GitHub: https://github.com/Marus/cortex-debug
- Documentation: https://github.com/Marus/cortex-debug/wiki

---

*Last updated: 2025-01-05*
