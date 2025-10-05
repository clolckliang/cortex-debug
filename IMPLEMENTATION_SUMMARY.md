# Live Watch 增强功能实现总结

## 完成的功能

### 1. 高速采样缓存机制 ✅

实现了后台高速采样，可以以1-100ms的间隔采样变量，独立于UI刷新频率。

**修改的文件**:
- `src/live-watch-monitor.ts` - 添加了采样定时器和缓存机制
- `src/common.ts` - 扩展了`LiveWatchConfig`接口
- `src/gdb.ts` - 添加了采样控制的自定义请求处理

**新增方法**:
- `startSampling(intervalMs)` - 启动后台采样
- `stopSampling()` - 停止采样
- `performSampling()` - 执行一次采样周期
- `getCachedSample(varName)` - 获取缓存的样本
- `getAllCachedSamples()` - 获取所有缓存样本
- `isSampling()` - 检查采样状态

**新增自定义请求**:
- `liveStartSampling` - 启动采样，可指定间隔
- `liveStopSampling` - 停止采样
- `liveGetCachedSamples` - 获取所有缓存的样本数据

**配置示例**:
```json
{
    "liveWatch": {
        "enabled": true,
        "samplesPerSecond": 4,
        "highSpeedSampling": {
            "enabled": true,
            "intervalMs": 10
        }
    }
}
```

### 2. 运行时变量修改（类似Keil）✅

实现了在程序运行时修改变量值的功能，无需暂停目标设备。

**修改的文件**:
- `src/live-watch-monitor.ts` - 添加了`setVariable`和`setExpression`方法
- `src/gdb.ts` - 添加了变量设置的自定义请求处理
- `src/frontend/views/live-watch.ts` - 修改了`setValue`方法使用Live GDB连接

**技术实现**:
- 使用独立的Live GDB连接
- 通过GDB的`var-assign`命令修改变量
- 支持全局变量和结构体成员
- 实时更新缓存值

**新增方法**:
```typescript
// LiveWatchMonitor类
public async setVariable(
    variablesReference: number,
    name: string,
    value: string
): Promise<SetVariableResponse['body']>

public async setExpression(
    expression: string,
    value: string
): Promise<SetExpressionResponse['body']>
```

**新增自定义请求**:
- `liveSetVariable` - 设置子变量（结构体成员、数组元素）
- `liveSetExpression` - 设置根级表达式（全局变量）

**使用方法**:
1. 在Live Watch树视图中点击变量值
2. 输入新值并按Enter
3. 变量立即在运行的目标设备上更新

**支持的值格式**:
- 十进制: `123`, `-456`, `3.14`
- 十六进制: `0x1A2B`, `0xFF00`
- 二进制: `0b10101010`
- 字符串: `"Hello"`, `'World'`
- 字符: `'A'`
- 布尔值: `true`, `false`

## 架构设计

### 高速采样架构
```
Frontend (VS Code Extension)
    ↓ (200-5000ms UI refresh)
Live Watch Tree Provider
    ↓ (requests cached data)
Debug Adapter (gdb.ts)
    ↓ (custom requests)
LiveWatchMonitor (live-watch-monitor.ts)
    ↓ (1-100ms sampling timer)
Separate GDB Connection (MI2)
    ↓ (var-update commands)
Target Device
```

### 变量修改架构
```
Live Watch UI (Click to Edit)
    ↓ (setValue call)
LiveVariableNode
    ↓ (customRequest: liveSetVariable/liveSetExpression)
GDB Debug Adapter
    ↓ (route to Live GDB)
LiveWatchMonitor
    ↓ (var-assign command)
Separate GDB Connection
    ↓ (modify memory)
Target Device (Running)
```

## 关键特性

### 解耦的采样和显示
- **后端采样**: 1-100ms高速采样
- **前端显示**: 200-5000ms UI刷新
- **独立运行**: 不会阻塞UI或主调试会话

### 运行时修改能力
- ✅ 无需暂停目标设备
- ✅ 不影响主调试会话
- ✅ 支持全局变量和结构体成员
- ✅ 实时看到修改后的效果
- ✅ 自动更新缓存值

### 安全性
- 值格式验证
- 指针修改确认（可选）
- 错误处理和用户反馈
- GDB命令失败时的优雅降级

## 实际应用场景

### 1. PID参数调优
```c
float kp = 1.0;
float ki = 0.1;
float kd = 0.01;
```
在程序运行时实时调整PID参数，立即看到控制效果，无需重启。

### 2. 传感器阈值调整
```c
uint16_t adc_threshold = 2048;
float temperature_limit = 85.0;
```
在实际运行环境中动态调整阈值，找到最优值。

### 3. 测试信号注入
```c
int test_signal = 0;
bool enable_test_mode = false;
```
运行时切换测试模式，注入不同的测试信号。

### 4. 高速数据采集
```c
uint16_t adc_value;  // ADC读数
float sensor_data;   // 传感器数据
```
以10ms间隔采样快速变化的信号，用于波形显示或数据分析。

## 性能考虑

### 采样率影响
- **1-5ms**: 可能影响调试性能，适用于高速信号
- **10ms**: 平衡的选择，适合大多数场景
- **50-100ms**: 低开销，适合慢速变化的变量

### 变量数量
- 变量越多，采样时间越长
- 建议只监控关键变量
- 移除不使用的变量以提高性能

### 内存使用
- 每个变量只缓存最新的一个样本
- 内存占用最小
- 未来可扩展为历史缓冲

## 编译和测试

代码已成功编译，没有错误：
```bash
npm run compile
# ✅ webpack compiled successfully
```

## 文档

创建了详细的用户文档：
- `LIVEWATCH_HIGHSPEED_SAMPLING.md` - 完整的功能说明和配置指南

## 未来增强

潜在的改进方向：
- [ ] 历史数据缓冲（存储最近N个样本）
- [ ] 采样率统计和监控
- [ ] 基于条件的触发采样
- [ ] 导出采样数据到CSV/JSON
- [ ] 与波形显示集成
- [ ] 基于值变化率的自适应采样

## 总结

成功实现了两个主要功能：

1. **高速采样**: 独立的后台采样机制，支持1-100ms间隔
2. **运行时修改**: 类似Keil的实时变量修改功能

这些功能通过独立的Live GDB连接实现，不影响主调试会话，使得Cortex-Debug的Live Watch功能更加强大和实用。
