# Live Watch High-Speed Sampling

## Overview

The Live Watch feature now supports:

1. **High-speed background sampling** - Sample variables at 1-100ms intervals
2. **Run-time variable modification** - Modify variables while the target is running (like Keil)

These features are particularly useful for:

- Capturing fast-changing variables (e.g., ADC readings, sensor data)
- Monitoring real-time control loop variables
- Tuning PID parameters on-the-fly without stopping execution
- Detecting brief signal changes that might be missed at lower sampling rates
- Feeding data to waveform displays for visualization

## Run-Time Variable Modification (像Keil一样)

Live Watch现在支持在程序运行时直接修改变量值，无需停止目标设备。这个功能类似于Keil的Live Watch。

### How to Modify Variables While Running

1. 确保在`launch.json`中启用了Live Watch：
   ```json
   "liveWatch": {
       "enabled": true
   }
   ```

2. 在Live Watch树视图中，点击任何变量的值部分

3. 输入新值并按Enter键

4. 变量会立即在运行的目标设备上更新，无需暂停程序

### Supported Value Formats

- **十进制**: `123`, `-456`, `3.14`
- **十六进制**: `0x1A2B`, `0xFF00`
- **二进制**: `0b10101010`
- **字符串**: `"Hello"`, `'World'`
- **字符**: `'A'`
- **布尔值**: `true`, `false`

### Technical Implementation

Live Watch使用独立的GDB连接，通过`var-assign`命令在程序运行时修改变量。这允许：

- ✅ 无需暂停目标设备
- ✅ 不影响主调试会话
- ✅ 修改全局变量、静态变量和结构体成员
- ✅ 实时看到修改后的效果

### Example Use Cases

**PID调参**：
```c
// 在程序运行时调整PID参数
float kp = 1.0;
float ki = 0.1;
float kd = 0.01;
```
通过Live Watch实时修改这些值，无需重新编译或重启。

**信号注入**：
```c
// 在运行时注入测试信号
int test_signal = 0;
bool enable_test_mode = false;
```
实时切换测试模式和注入不同的测试值。

**阈值调整**：
```c
// 动态调整传感器阈值
uint16_t adc_threshold = 2048;
float temperature_limit = 85.0;
```
在实际运行中找到最优阈值。

## How It Works

The high-speed sampling mechanism operates independently in the background using a separate GDB connection:

1. **Backend Sampling Thread**: Runs at configurable intervals (1-100ms) to sample all Live Watch variables
2. **Cached Data**: Sampled values are stored in a cache with timestamps
3. **Frontend Display**: The UI continues to refresh at its own rate (200-5000ms) to avoid overwhelming the interface
4. **Decoupled Architecture**: Backend sampling and frontend display rates are independent

## Configuration

Add the `highSpeedSampling` configuration to your `launch.json`:

```json
{
    "type": "cortex-debug",
    "request": "launch",
    "name": "Debug with High-Speed Live Watch",
    "servertype": "jlink",
    "device": "STM32F407VG",
    "executable": "./build/firmware.elf",
    "liveWatch": {
        "enabled": true,
        "samplesPerSecond": 4,  // UI refresh rate (4 Hz)
        "highSpeedSampling": {
            "enabled": true,
            "intervalMs": 10    // Backend samples at 100 Hz (10ms interval)
        }
    }
}
```

### Configuration Options

#### `liveWatch.enabled`
- **Type**: `boolean`
- **Required**: Yes
- **Description**: Enables Live Watch feature

#### `liveWatch.samplesPerSecond`
- **Type**: `number`
- **Default**: 4
- **Range**: 0.2 - 5 (corresponds to 200-5000ms UI refresh)
- **Description**: UI refresh rate in samples per second. This controls how often the tree view updates.

#### `liveWatch.highSpeedSampling.enabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enables high-speed background sampling

#### `liveWatch.highSpeedSampling.intervalMs`
- **Type**: `number`
- **Default**: 10
- **Range**: 1 - 100
- **Description**: Backend sampling interval in milliseconds. Smaller values = faster sampling.
  - `1ms` = 1000 Hz sampling rate
  - `10ms` = 100 Hz sampling rate
  - `50ms` = 20 Hz sampling rate
  - `100ms` = 10 Hz sampling rate

## Usage Example

### Example 1: Monitoring ADC at 100Hz
```json
"liveWatch": {
    "enabled": true,
    "samplesPerSecond": 2,  // UI updates twice per second
    "highSpeedSampling": {
        "enabled": true,
        "intervalMs": 10    // Sample ADC every 10ms (100 Hz)
    }
}
```

### Example 2: Ultra-fast sampling for motor control
```json
"liveWatch": {
    "enabled": true,
    "samplesPerSecond": 4,
    "highSpeedSampling": {
        "enabled": true,
        "intervalMs": 1     // Sample every 1ms (1000 Hz)
    }
}
```

### Example 3: Standard Live Watch (no high-speed sampling)
```json
"liveWatch": {
    "enabled": true,
    "samplesPerSecond": 4   // UI-driven sampling only
}
```

## API for Custom Extensions

If you're building custom extensions, you can access the cached samples via custom requests:

### Start Sampling
```typescript
await session.customRequest('liveStartSampling', {
    intervalMs: 10
});
```

### Stop Sampling
```typescript
await session.customRequest('liveStopSampling', {});
```

### Get Cached Samples
```typescript
const result = await session.customRequest('liveGetCachedSamples', {});
// Returns: { samples: Array<{name, timestamp, value, type}>, isSampling: boolean }
```

### Set Variable While Running
```typescript
// Set a child variable (structure member, array element)
await session.customRequest('liveSetVariable', {
    variablesReference: parentVarRef,
    name: 'fieldName',
    value: '123'
});

// Set a root-level expression (global variable)
await session.customRequest('liveSetExpression', {
    expression: 'myGlobalVar',
    value: '0x1234'
});
```

## Performance Considerations

1. **Sampling Rate Impact**:
   - Lower intervals (1-5ms) may impact debugging performance
   - GDB must halt the target briefly to read variables
   - Recommended: Start with 10ms and adjust as needed

2. **Variable Count**:
   - More variables = longer sampling time
   - Keep Live Watch list focused on critical variables
   - Remove unused variables to improve performance

3. **GDB Connection**:
   - Uses a separate GDB connection (non-intrusive to main debug session)
   - Cached data prevents redundant queries

4. **Memory Usage**:
   - Cache stores latest sample for each variable
   - Minimal memory footprint (one sample per variable)

## Troubleshooting

### Sampling seems slow or inconsistent
- Reduce the number of variables in Live Watch
- Increase `intervalMs` value
- Check if your GDB server supports concurrent connections

### "Failed to start live-monitor-gdb session" error
- Ensure your GDB server supports multiple connections
- Check if `liveWatch.enabled` is set to `true`
- Verify your debugger is properly configured

### High CPU usage
- Increase `intervalMs` to reduce sampling frequency
- Reduce number of variables in Live Watch
- Check `showDevDebugOutput` for GDB communication issues

## Technical Details

### Architecture
```
Frontend (VS Code Extension)
    ↓ (200-5000ms UI refresh)
Live Watch Tree Provider
    ↓ (requests cached data)
Debug Adapter (gdb.ts)
    ↓
LiveWatchMonitor (live-watch-monitor.ts)
    ↓ (1-100ms sampling timer)
Separate GDB Connection
    ↓ (MI commands)
Target Device
```

### Cache Mechanism
- **Storage**: `Map<string, SampleData>` with variable name as key
- **Data**: `{ timestamp, value, type, variablesReference }`
- **Update**: Refreshed every sampling interval
- **Cleanup**: Cleared on debug session end

### Custom Requests
The following custom DAP requests are available:

**Sampling Control**:
- `liveStartSampling` - Start background sampling with configurable interval
- `liveStopSampling` - Stop background sampling
- `liveGetCachedSamples` - Retrieve cached samples with timestamps

**Variable Access**:
- `liveEvaluate` - Evaluate expression in global context
- `liveVariables` - Get variable children
- `liveCacheRefresh` - Refresh variable cache

**Variable Modification (New)**:
- `liveSetVariable` - Set child variable value while running
- `liveSetExpression` - Set root-level expression value while running

## Future Enhancements

Potential future improvements:
- [ ] Historical data buffering (store last N samples)
- [ ] Sample rate statistics and monitoring
- [ ] Trigger-based sampling (sample on condition)
- [ ] Export sampled data to CSV/JSON
- [ ] Integration with waveform display
- [ ] Adaptive sampling based on value change rate

## See Also

- [debug_attributes.md](debug_attributes.md) - Complete launch.json configuration reference
- [Live Watch Documentation](docs/livewatch.md) - General Live Watch usage guide
- [Waveform Display](docs/waveform.md) - Visualization of sampled data
