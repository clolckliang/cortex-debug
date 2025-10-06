# 波形图调试指南

## 问题诊断

### 1. 波形图面板按钮图标显示不全

**问题原因**: 波形图被定义为 `viewsWebview` 而不是普通视图，webview 不支持传统的 title 栏按钮。

**解决方案**:
- 按钮图标需要在 webview 内部的 HTML 中实现
- 当前配置在 `package.json` 中的 `view/title` 部分对 webview 不会生效
- 需要在 webview 的 HTML 内容中添加自定义工具栏

### 2. myStruct 添加到波形图没有反应

**可能原因**:
1. **调试会话问题**: 波形数据收集需要活动的 Cortex-Debug 调试会话
2. **Live Watch 配置**: 需要在 launch.json 中启用 liveWatch
3. **数据解析问题**: 结构体值的解析可能失败
4. **webview 通信问题**: 扩展和 webview 之间的消息传递可能失败

## 调试步骤

### 步骤 1: 检查基础配置

1. **确保 launch.json 中启用了 liveWatch**:
```json
{
    "liveWatch": {
        "enabled": true,
        "samplesPerSecond": 4
    }
}
```

2. **启动调试会话**: 必须有活动的 Cortex-Debug 调试会话

### 步骤 2: 检查调试控制台

打开 VS Code 开发者工具 (Help → Toggle Developer Tools)，查看控制台输出：

**应该看到的日志**:
```
[Waveform] Adding variable to waveform: myStruct (myStruct)
[Waveform] Variable added, current count: 1
[Waveform] Starting recording...
[Waveform] Recording started at: [timestamp]
[Waveform] startDataCollection called:
[Waveform] - Variables count: 1
[Waveform] - Is recording: true
[Waveform] Starting data collection with interval: 1000ms
[Waveform] Evaluating expression: myStruct
```

**如果没有看到这些日志**:
- 检查 addToWaveform 命令是否被正确触发
- 检查 Live Watch 中的变量是否正确显示

### 步骤 3: 检查 webview 通信

在开发者工具控制台中查看 webview 相关日志：

**应该看到的日志**:
```
[Waveform Client] Received data update: {variables: 1, dataKeys: ["myStruct"], settings: {...}}
[Waveform Webview] Sending data update: 1 variables
[Waveform Webview] Variable myStruct: 0 data points, last value: undefined
```

### 步骤 4: 检查结构体值解析

**常见的结构体格式和支持情况**:

1. **简单结构体** `{a: 1, b: 2}`:
   - 解析为数值总和 (3)
   - 在波形中显示为数值

2. **复杂结构体**:
   - 生成哈希值用于显示
   - 哈希值会在结构体内容变化时改变

3. **枚举或命名常量**:
   - 生成哈希值
   - 可以跟踪状态变化

## 常见问题和解决方案

### 问题 1: "Variable added but no data appears"

**检查项目**:
- 调试会话是否正在运行?
- 变量在 Live Watch 中是否显示正确值?
- 控制台是否有错误信息?

**解决方案**:
- 确保调试目标正在运行
- 检查变量表达式是否正确
- 尝试简单的数值变量而不是复杂结构体

### 问题 2: "Waveform view is empty"

**检查项目**:
- 波形图 webview 是否正确加载?
- 是否有 JavaScript 错误?
- 数据是否正确发送到 webview?

**解决方案**:
- 重新打开波形图视图
- 检查开发者工具中的错误信息
- 尝试手动刷新 webview

### 问题 3: "Icons not showing in toolbar"

**问题原因**: Webview 不支持传统的 VS Code 工具栏按钮

**当前状态**: 需要在 webview HTML 中实现自定义工具栏

## 代码修改摘要

### 已实施的修复:

1. **增强调试日志**:
   - 在数据提供程序中添加详细的调试信息
   - 在 webview 中添加消息接收日志

2. **改进结构体值解析**:
   - 支持 `{a: 1, b: 2}` 格式的结构体
   - 为复杂结构体生成哈希值
   - 处理枚举和命名常量

3. **修复 TypeScript 错误**:
   - 移除对受保护属性的直接访问
   - 使用公共 API 获取节点值

4. **改进数据收集启动**:
   - 确保手动添加变量时启动记录
   - 改进数据收集条件的检查

### 测试建议:

1. **测试简单变量**: 先尝试数值变量确认基本功能
2. **测试结构体**: 逐步测试复杂的结构体变量
3. **检查日志**: 使用详细的调试日志追踪问题
4. **验证 webview**: 确认波形图正确加载和显示

## 下一步改进计划

1. **实现 webview 工具栏**: 在 HTML 中添加自定义按钮
2. **优化结构体显示**: 提供更好的结构体可视化选项
3. **错误处理**: 改进错误消息和用户反馈
4. **性能优化**: 优化大量数据的处理和显示