# Logic Analyzer Features Guide

## Overview

Cortex-Debug now includes advanced Logic Analyzer capabilities, allowing you to visualize variables in multiple display formats similar to professional tools like Keil Logic Analyzer. This feature extends the waveform monitoring system with support for:

- **Multi-display types**: Analog, Bit/Digital, State, Hexadecimal, and Binary representations
- **Signal grouping**: Organize related signals into hierarchical groups
- **Trigger conditions**: Capture data based on signal conditions (rising edge, falling edge, level, change)
- **Signal statistics**: Real-time calculation of min, max, average, RMS, duty cycle, frequency
- **Bit configuration**: Extract and display specific bits from multi-bit values

---

## Display Types

### 1. Analog Display
Traditional continuous waveform display for viewing variable values over time.

**Best for:**
- Sensor readings (temperature, voltage, etc.)
- PWM duty cycle monitoring
- PID controller outputs
- Any continuous numeric values

**Configuration:**
- Line color, style, and width
- Y-axis auto-scaling or manual range

### 2. Bit/Digital Display
Binary signal display showing 0 and 1 states, similar to a logic analyzer.

**Best for:**
- GPIO pin states
- Boolean flags
- Individual bits from status registers
- Clock and enable signals

**Configuration:**
- Threshold value (default 0.5) - values >= threshold display as 1
- Rising/falling edge detection
- Pulse width measurement

### 3. State Display
Multi-state digital bus display for visualizing numeric states.

**Best for:**
- State machines
- Enum values
- Multi-bit status codes
- Protocol states

**Configuration:**
- Bit width (1-32 bits)
- State value display format

### 4. Hexadecimal Display
Display variable values in hexadecimal format.

**Best for:**
- Register contents
- Memory addresses
- Protocol data
- Bit fields

**Configuration:**
- Bit width (determines padding)
- Bit mask for extracting specific fields

### 5. Binary Display
Display variable values in binary format.

**Best for:**
- Bit-level analysis
- Flag registers
- Binary protocols
- Bitwise operations debugging

**Configuration:**
- Bit width (determines display width)
- Bit mask and offset

---

## Getting Started

### Adding Variables to Waveform

1. **During a debug session**, add variables to the Live Watch view
2. **Right-click** on a variable in Live Watch
3. Select **"Add to Waveform"** from the context menu
4. The variable appears in the waveform viewer with default Analog display

### Changing Display Type

1. **Right-click** on a variable in the Live Watch view (that's already in waveform)
2. Navigate to the **Waveform Analysis** section in the context menu
3. Select **"Change Display Type..."**
4. Choose from:
   - Analog (continuous waveform)
   - Bit/Digital (0/1 display)
   - State (multi-state bus)
   - Hexadecimal (hex values)
   - Binary (binary values)

For bit-based displays, you'll be prompted to configure the bit width.

---

## Advanced Configuration

### Bit Width Configuration

For multi-bit signals (State, Hex, Binary), configure the bit width:

1. Right-click on variable → **"Configure Bit Width..."**
2. Enter bit width (1-32 bits)
3. The display adjusts to show the appropriate number of bits

**Example:**
- 8-bit value: 0xFF
- 16-bit value: 0xFFFF
- 32-bit value: 0xFFFFFFFF

### Digital Threshold

For Bit/Digital display, set the threshold that determines 0 vs 1:

1. Right-click on variable → **"Configure Digital Threshold..."**
2. Enter threshold value (0.0 - 1.0)
3. Values >= threshold display as 1, values < threshold display as 0

**Common thresholds:**
- 0.5 (default) - middle threshold
- 0.3 - TTL/CMOS low threshold
- 0.7 - TTL/CMOS high threshold

### Signal Grouping

Organize related signals into groups for better visualization:

1. Right-click on variable → **"Configure Signal Group..."**
2. Choose existing group or create new group
3. All variables in a group are displayed together

**Example groups:**
- Motor Control (speed, current, position)
- SPI Bus (MOSI, MISO, SCK, CS)
- State Machine (state, flags, counters)

### Trigger Configuration

Set up trigger conditions to capture specific signal events:

1. Right-click on variable → **"Configure Trigger..."**
2. Select trigger type:
   - **Rising Edge**: Capture when signal transitions from 0 → 1
   - **Falling Edge**: Capture when signal transitions from 1 → 0
   - **Change**: Capture on any value change
   - **Level**: Capture when signal meets a condition (==, !=, >, <, >=, <=)
3. For Level triggers, specify the threshold value and comparison operator

**Use cases:**
- Capture data when event flag is set (Rising Edge)
- Detect when signal goes low (Falling Edge)
- Monitor register writes (Change)
- Detect error conditions (Level > threshold)

---

## Signal Statistics

View real-time statistics for any signal:

1. Right-click on variable → **"Show Signal Statistics"**
2. View detailed statistics:
   - **Min**: Minimum value observed
   - **Max**: Maximum value observed
   - **Average**: Mean value
   - **RMS**: Root Mean Square (useful for AC signals)
   - **Duty Cycle**: Percentage of time signal is high (for digital signals)
   - **Frequency**: Estimated frequency (Hz)
   - **Period**: Estimated period (ms)

Statistics are calculated from all recorded data points.

---

## Workflow Examples

### Example 1: Debugging a State Machine

```c
typedef enum {
    STATE_IDLE = 0,
    STATE_INIT = 1,
    STATE_RUNNING = 2,
    STATE_ERROR = 3
} SystemState_t;

SystemState_t currentState;
```

**Setup:**
1. Add `currentState` to Live Watch
2. Add to Waveform
3. Change display type to **State**
4. Set bit width to **8**
5. Set trigger on **Level == STATE_ERROR** to capture error conditions

### Example 2: Analyzing SPI Communication

```c
uint8_t spi_mosi;
uint8_t spi_miso;
bool spi_clk;
bool spi_cs;
```

**Setup:**
1. Add all SPI signals to Live Watch
2. Add all to Waveform
3. Configure display types:
   - `spi_mosi`: **Hexadecimal** (bit width 8)
   - `spi_miso`: **Hexadecimal** (bit width 8)
   - `spi_clk`: **Bit/Digital**
   - `spi_cs`: **Bit/Digital**
4. Group all as "SPI Bus"
5. Set trigger on `spi_cs` **Falling Edge** to capture transactions

### Example 3: Monitoring GPIO Pins

```c
uint32_t GPIOA_IDR;  // GPIO Input Data Register
```

**Setup:**
1. Add `GPIOA_IDR` to Live Watch
2. Add to Waveform
3. Change display type to **Binary**
4. Set bit width to **16** (for GPIO pins 0-15)
5. Create separate views for specific pins using bit mask

### Example 4: PWM Signal Analysis

```c
float pwm_duty_cycle;  // 0.0 to 1.0
bool pwm_output;
```

**Setup:**
1. Add both variables to Live Watch
2. Add both to Waveform
3. Configure:
   - `pwm_duty_cycle`: **Analog** display
   - `pwm_output`: **Bit/Digital** display
4. Show statistics to view actual duty cycle percentage
5. Compare commanded vs actual duty cycle

---

## Command Reference

### Context Menu Commands (Live Watch)

Available when right-clicking on a variable in the Live Watch view:

**Waveform Control:**
- **Add to Waveform**: Add variable to waveform display
- **Configure for Waveform...**: Quick configuration dialog
- **Show in Waveform**: Focus the variable in waveform view
- **Remove from Waveform**: Remove variable from waveform

**Waveform Analysis:**
- **Change Display Type...**: Switch between Analog/Bit/State/Hex/Binary
- **Configure Signal Group...**: Organize variables into groups
- **Configure Trigger...**: Set up trigger conditions
- **Show Signal Statistics**: Display real-time statistics
- **Set Style...**: Change color, line width, etc.
- **FFT Analysis**: Frequency domain analysis

### Command Palette

Access via `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS):

- `Cortex-Debug: Change Display Type...`
- `Cortex-Debug: Configure Bit Width...`
- `Cortex-Debug: Configure Digital Threshold...`
- `Cortex-Debug: Configure Signal Group...`
- `Cortex-Debug: Show Signal Statistics`
- `Cortex-Debug: Configure Trigger...`
- `Cortex-Debug: Update Waveform Settings`
- `Cortex-Debug: Start Waveform Recording`
- `Cortex-Debug: Stop Waveform Recording`

---

## Tips and Best Practices

### Performance

- **Limit active variables**: Monitor 10-15 variables max for best performance
- **Adjust sampling rate**: Lower refresh rates (0.5-2 Hz) for long recordings
- **Use groups**: Organize related signals together for easier analysis
- **Clear old data**: Periodically clear data to free memory

### Display Types

- **Start with Analog**: Default view works for most variables
- **Use Bit for GPIO**: Binary signals are easier to read as digital
- **Hex for registers**: Register values are clearer in hexadecimal
- **State for enums**: Numeric states show patterns better than analog

### Triggers

- **Rising edge for events**: Capture when flags are set
- **Level for errors**: Detect when values exceed thresholds
- **Change for debugging**: See all modifications to a variable
- **Combine with groups**: Trigger on one signal, view related signals

### Statistics

- **Check duty cycle**: Verify PWM or timing signals
- **Monitor frequency**: Detect timing issues or glitches
- **RMS for AC signals**: More accurate than average for oscillating values
- **Min/max for ranges**: Verify values stay within expected bounds

---

## Keyboard Shortcuts

(When waveform view is active)

- **Ctrl+Z**: Zoom in
- **Ctrl+X**: Zoom out
- **Ctrl+0**: Auto-fit to window
- **Ctrl+G**: Toggle grid
- **Ctrl+L**: Toggle legend
- **Ctrl+E**: Export data
- **Ctrl+R**: Start/stop recording

---

## Troubleshooting

### Variable not showing in waveform

**Problem**: Added variable but no data appears

**Solutions:**
- Ensure debug session is active
- Check that recording is started (Status: Recording)
- Verify variable is in scope and has a valid value
- Check sampling rate is appropriate (try 1 Hz)

### Incorrect bit display

**Problem**: Bit/Digital display shows wrong values

**Solutions:**
- Check threshold setting (default 0.5)
- Verify bit width matches variable size
- Check if bit mask/offset is needed
- Ensure variable value is numeric (not string or struct)

### Missing trigger events

**Problem**: Trigger not capturing expected events

**Solutions:**
- Verify trigger condition matches signal behavior
- Check if variable updates frequently enough
- Increase sampling rate to catch fast transitions
- Use "Change" trigger to see all updates

### Statistics show unexpected values

**Problem**: Statistics don't match expectations

**Solutions:**
- Ensure enough data points collected (wait a few seconds)
- Check if signal is stable (look at waveform)
- Verify variable scale (0-100 vs 0.0-1.0)
- Clear data and restart recording for fresh statistics

---

## API Reference (for extension developers)

### Display Types

```typescript
type SignalDisplayType = 'analog' | 'bit' | 'state' | 'hex' | 'binary';
```

### Variable Configuration

```typescript
interface WaveformVariable {
    displayType?: SignalDisplayType;
    bitWidth?: number;
    bitMask?: number;
    bitOffset?: number;
    threshold?: number;
    trigger?: TriggerCondition;
    group?: string;
    statistics?: SignalStatistics;
}
```

### Trigger Conditions

```typescript
interface TriggerCondition {
    enabled: boolean;
    type: 'rising' | 'falling' | 'level' | 'change';
    value?: number;
    operator?: '==' | '!=' | '>' | '<' | '>=' | '<=';
}
```

### Signal Statistics

```typescript
interface SignalStatistics {
    min: number;
    max: number;
    avg: number;
    rms: number;
    duty: number;
    frequency?: number;
    period?: number;
}
```

---

## Related Features

- **FFT Analysis**: Frequency domain analysis for periodic signals
- **Waveform Export**: Export data to JSON/CSV for offline analysis
- **Configuration Import/Export**: Save and restore waveform setups
- **Live Watch Integration**: Seamless integration with Live Watch view

---

## Version History

### v1.13.0-pre6 (2025-01-05)
- Initial Logic Analyzer features
- Multi-display type support (Analog/Bit/State/Hex/Binary)
- Signal grouping and triggers
- Real-time statistics
- Bit width configuration

---

## Feedback and Support

- Report issues: https://github.com/Marus/cortex-debug/issues
- Feature requests: Use GitHub discussions
- Documentation: See WAVEFORM_INTEGRATION.md for more details

---

**Generated with Claude Code**
Last Updated: 2025-01-05
