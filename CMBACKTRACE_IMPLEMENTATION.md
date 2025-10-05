# CmBacktrace Implementation - ARM Cortex-M Fault Analysis

## 概述

CmBacktrace 是一个用于 ARM Cortex-M 微控制器的错误分析和调用栈回溯工具，已成功集成到 Cortex-Debug 扩展中。

## 支持的功能

### 1. 错误类型检测

自动检测和分析以下 ARM Cortex-M 错误类型：

- **断言（Assert）** - 通过调用栈分析
- **硬件故障（Hard Fault）** - 向量表错误、强制故障等
- **内存管理故障（Memory Management Fault）** - 指令/数据访问违规、栈溢出等
- **总线故障（Bus Fault）** - 指令/数据总线错误、精确/非精确错误
- **使用故障（Usage Fault）** - 未定义指令、无效状态、除零错误、未对齐访问等
- **调试故障（Debug Fault）** - 断点、硬件监视点等

### 2. 故障原因自动诊断

系统会自动分析 ARM Cortex-M 故障寄存器并提供详细的故障原因：

#### Memory Management Fault (MMFSR)
- 指令访问违规 - 尝试从受保护区域执行代码
- 数据访问违规 - 尝试读写受保护内存
- 栈溢出/栈指针损坏
- 浮点延迟状态保存错误
- MMFAR 有效地址显示

#### Bus Fault (BFSR)
- 指令总线错误 - 获取指令失败（函数指针错误？）
- 精确数据总线错误 - 访问无效内存地址
- 非精确数据总线错误
- 栈指针损坏
- BFAR 有效地址显示

#### Usage Fault (UFSR)
- 未定义指令执行 - 代码损坏或错误的函数指针
- 无效状态 - 尝试切换到 ARM 状态（未设置 Thumb 位）
- 无效 PC 加载 - 异常返回时 PC 值错误
- 无协处理器
- 未对齐访问 - 启用严格对齐检查时的未对齐内存访问
- 除零错误

#### Hard Fault (HFSR)
- 向量表读取错误 - 损坏的向量表
- 强制硬件故障 - 从可配置故障升级（检查 CFSR）
- 调试被禁用时发生调试事件

### 3. 调用栈回溯

- **自动提取函数调用栈** - 还原错误发生时的现场信息
- **符号解析** - 使用 addr2line 工具精确定位代码位置
- **源文件定位** - 显示文件名和行号
- **可视化展示** - 在 WebView 中以树形结构展示调用栈
- **源码导航** - 点击调用栈帧可跳转到对应源代码位置

### 4. 错误寄存器分析

读取并显示所有相关的 Cortex-M 系统控制寄存器：

- **CFSR** (Configurable Fault Status Register) - 0xE000ED28
  - MMFSR (MemManage Fault Status Register)
  - BFSR (Bus Fault Status Register)
  - UFSR (Usage Fault Status Register)
- **HFSR** (Hard Fault Status Register) - 0xE000ED2C
- **DFSR** (Debug Fault Status Register) - 0xE000ED30
- **MMFAR** (MemManage Fault Address Register) - 0xE000ED34
- **BFAR** (Bus Fault Address Register) - 0xE000ED38
- **AFSR** (Auxiliary Fault Status Register) - 0xE000ED3C

### 5. 智能推荐

基于故障类型和原因，自动生成修复建议：

- 栈溢出 → 增加栈大小或减少局部变量使用
- 指针错误 → 验证指针初始化和边界检查
- 除零错误 → 在算术运算前添加除零检查
- 未对齐访问 → 确保数据结构正确对齐或禁用严格对齐检查
- 未定义指令 → 检查代码损坏、无效函数指针或编译器优化问题

## 文件结构

```
src/frontend/
├── cmbacktrace.ts                      # CmBacktrace 核心分析引擎
│   ├── CmBacktraceAnalyzer 类
│   ├── 故障寄存器读取
│   ├── 故障类型判断
│   ├── 故障原因分析
│   ├── 调用栈提取
│   └── addr2line 符号解析
│
└── views/
    └── fault-analysis-tree.ts          # 故障分析原生 TreeView
        ├── FaultAnalysisNode 类 (树节点)
        ├── FaultAnalysisTreeProvider 类
        ├── 自动主题适配
        └── VS Code 原生 UI 集成
```

## 使用方法

### 1. 自动故障检测（默认启用）

当调试器因故障停止时，系统会自动检测并提示：

```
⚠️ Fault Detected: Hard Fault
[Show Details] [Dismiss]
```

点击 "Show Details" 会在 Debug 侧边栏显示 "Fault Analysis" 面板。

### 2. 手动触发故障分析

在命令面板（Ctrl+Shift+P / Cmd+Shift+P）中执行：

```
Cortex-Debug: Analyze Cortex-M Fault
```

### 3. 查看当前调用栈

在调试过程中的任何时候，可以执行：

```
Cortex-Debug: Show Call Stack (CmBacktrace)
```

这将显示当前的函数调用栈，并可以点击跳转到源代码。

### 4. 配置选项

在 VS Code 设置中：

```json
{
    // 启用/禁用自动故障检测
    "cortex-debug.autoFaultDetection": true  // 默认: true
}
```

在 launch.json 中配置工具链前缀（如果使用非标准工具链）：

```json
{
    "type": "cortex-debug",
    "name": "Debug",
    "toolchainPrefix": "arm-none-eabi-",  // 默认值
    ...
}
```

## 故障分析面板（TreeView）

在 Debug 侧边栏的原生 TreeView 面板，包含以下节点：

### 树形结构
```
⛔ Hard Fault (根节点)
├── ⚠ Fault Causes (故障原因)
│   ├── 🔴 Vector table read error
│   └── 🔴 Forced Hard Fault
├── 📍 Fault Address: 0xE000ED28
├── 🔧 Fault Registers (可折叠)
│   ├── CFSR: 0x00000100
│   ├── HFSR: 0x40000000
│   └── ...
├── 📞 Call Stack (调用栈)
│   ├── #0 HardFault_Handler @ 0x08001234
│   ├── #1 main @ 0x08001100
│   └── ...（点击跳转到源码）
└── 💡 Recommendations (推荐)
    └── Check for code corruption...
```

### UI 特性
- ✅ **自动主题适配** - 完美跟随 VS Code 主题（亮色/暗色）
- ✅ **原生交互** - 与 Call Stack、Variables 面板一致的操作体验
- ✅ **可折叠节点** - 寄存器等详细信息默认折叠
- ✅ **右键菜单** - 调用栈支持"Jump to Source"
- ✅ **图标标识** - 使用 VS Code Codicons
- ✅ **性能优异** - 无浏览器开销

### 右键菜单
- **调用栈节点** - "Jump to Source" 跳转到源代码
- **根节点** - "Clear Fault Analysis" 清除故障信息

## 技术实现

### 核心算法

1. **寄存器读取**
   - 使用 Debug Adapter Protocol (DAP) 的 `readMemory` 请求
   - 读取 SCB 寄存器组的内存映射地址
   - 解析 base64 编码的寄存器值

2. **故障类型判断**
   ```
   优先级：
   1. 检查 DFSR - Debug Fault
   2. 检查 HFSR.FORCED - 从配置故障升级
   3. 检查 HFSR.VECTTBL - 向量表错误
   4. 检查 MMFSR/BFSR/UFSR - 具体故障类型
   ```

3. **调用栈提取**
   - 使用 DAP 的 `stackTrace` 请求获取栈帧
   - 提取 PC、函数名、文件位置
   - 通过 addr2line 解析缺失的符号信息

4. **addr2line 集成**
   ```bash
   arm-none-eabi-addr2line -e <elf_file> -f -C <address>
   ```
   - `-e`: ELF 可执行文件
   - `-f`: 显示函数名
   - `-C`: C++ 名称解码
   - 输出格式：函数名 + 文件:行号

### DAP 集成

```typescript
// 读取内存
await session.customRequest('readMemory', {
    memoryReference: '0xE000ED28',  // CFSR 地址
    count: 4
});

// 获取调用栈
await session.customRequest('stackTrace', {
    threadId: 1,
    startFrame: 0,
    levels: 20
});
```

### TreeView 集成

```typescript
// 创建 TreeView
this.faultAnalysisTreeView = vscode.window.createTreeView('cortex-debug.faultAnalysis', {
    treeDataProvider: this.faultAnalysisProvider,
    showCollapseAll: true
});

// 更新分析结果
this.faultAnalysisProvider.updateAnalysis(analysis);

// 显示面板
this.faultAnalysisTreeView.reveal(null, { select: false, focus: true });

// TreeNode 命令
const frameCommand: vscode.Command = {
    command: 'cortex-debug.faultAnalysis.jumpToSource',
    title: 'Jump to Source',
    arguments: [frame.file, frame.line]
};
```

## VS Code 命令

### 已注册命令

1. **cortex-debug.analyzeFault**
   - 标题: "Analyze Cortex-M Fault"
   - 图标: $(bug)
   - 触发: 手动分析当前故障

2. **cortex-debug.showCallStack**
   - 标题: "Show Call Stack (CmBacktrace)"
   - 图标: $(call-outgoing)
   - 触发: 显示当前调用栈（Quick Pick）

3. **cortex-debug.faultAnalysis.jumpToSource**
   - 标题: "Jump to Source"
   - 触发: 从调用栈跳转到源代码

4. **cortex-debug.faultAnalysis.clearFault**
   - 标题: "Clear Fault Analysis"
   - 图标: $(clear-all)
   - 触发: 清除故障分析面板

### 命令可用性

命令仅在 cortex-debug 调试会话活动时可用：

```json
"when": "debugType === cortex-debug"
```

TreeView 仅在检测到故障时显示：

```json
"when": "debugType == cortex-debug && cortex-debug:hasFault"
```

## 配置项

### package.json 配置

```json
{
    "cortex-debug.autoFaultDetection": {
        "type": "boolean",
        "default": true,
        "description": "Automatically detect and analyze ARM Cortex-M faults when debugger stops"
    }
}
```

## 事件处理流程

### 自动检测流程

```
调试停止事件 (onDidReceiveDebugSessionCustomEvent)
    ↓
receivedStopEvent()
    ↓
checkForFault()
    ↓
检查 autoFaultDetection 配置
    ↓
analyzeFault()
    ↓
读取故障寄存器 → 判断故障类型 → 分析原因 → 提取调用栈
    ↓
显示通知或 WebView
```

### 手动触发流程

```
用户执行命令
    ↓
analyzeFault() 或 showCallStack()
    ↓
获取当前调试会话
    ↓
设置工具链前缀
    ↓
执行分析
    ↓
显示结果
```

## 错误处理

- 无活动调试会话 → 显示错误提示
- 寄存器读取失败 → 抛出异常并提示用户
- addr2line 失败 → 记录日志，继续使用 DAP 提供的信息
- 文件导航失败 → 显示错误消息

## 依赖项

### 外部工具
- **arm-none-eabi-addr2line** - 符号解析（需要在 PATH 中）
- **arm-none-eabi-gdb** - 调试器（已有依赖）

### VS Code API
- Debug Adapter Protocol (DAP)
- Webview API
- Command API
- Configuration API

### TypeScript 模块
- vscode
- @vscode/debugprotocol
- child_process (用于 addr2line)
- path, Buffer (Node.js 内置)

## 测试建议

### 单元测试场景

1. **寄存器解析测试**
   - 测试各种 CFSR 值的解析
   - 验证故障类型判断逻辑

2. **调用栈提取测试**
   - 模拟 DAP stackTrace 响应
   - 验证帧信息提取

3. **addr2line 集成测试**
   - 测试符号解析
   - 处理解析失败情况

### 集成测试场景

1. **触发 Hard Fault**
   ```c
   void (*bad_func)(void) = (void*)0xFFFFFFFF;
   bad_func();  // 应触发 Hard Fault
   ```

2. **触发 Bus Fault**
   ```c
   volatile uint32_t *bad_addr = (uint32_t*)0x20000000; // 无效地址
   uint32_t val = *bad_addr;
   ```

3. **触发 Usage Fault - 除零**
   ```c
   int a = 10;
   int b = 0;
   int c = a / b;  // 除零错误（需启用 DIV_0_TRP）
   ```

## 已知限制

1. **需要有效的 ELF 文件** - addr2line 依赖调试符号
2. **工具链要求** - 必须安装 ARM GCC 工具链
3. **仅支持 Cortex-M** - 不支持其他 ARM 架构
4. **内存访问** - 依赖 DAP 的 readMemory 支持

## UI 设计优势

### 为什么使用原生 TreeView 而非 WebView？

#### ✅ TreeView 优势
1. **完美集成** - 直接嵌入 Debug 侧边栏，与 Call Stack 等面板并列
2. **自动主题** - 完全跟随 VS Code 主题，无需手动 CSS
3. **高性能** - 原生 UI 组件，无浏览器开销
4. **一致体验** - 与 VS Code 调试工具一致的交互方式
5. **丰富交互** - Context menu、inline actions、状态持久化
6. **响应式** - VS Code 自动处理布局和缩放

#### ❌ WebView 劣势
1. 集成度低 - 独立面板，与调试工具分离
2. 主题适配复杂 - 需手动管理大量 CSS 变量
3. 性能开销 - 嵌入式浏览器消耗资源
4. 交互限制 - 需要消息传递机制
5. 维护成本高 - HTML/CSS/JS 三套代码

## 未来增强

1. **栈回溯算法** - 实现手动栈帧分析（当 DAP 失败时）
2. **故障历史** - 记录多次故障信息
3. **导出报告** - 支持导出 JSON/HTML 格式报告
4. **寄存器快照** - 保存所有 CPU 寄存器状态
5. **RTOS 支持** - 显示任务/线程信息
6. **断言支持** - 集成嵌入式 assert 宏
7. **离线分析** - 支持从日志文件分析

## 开发者说明

### 添加新的故障分析

1. 在 `analyzeFaultCause()` 中添加新的 case
2. 实现具体的分析函数（如 `analyzeNewFault()`）
3. 在 `generateRecommendation()` 中添加推荐逻辑
4. 更新 WebView HTML 模板（如需要）

### 扩展 addr2line 功能

修改 `addr2line()` 方法以支持：
- 其他工具链（LLVM, IAR 等）
- 额外的输出格式
- 批量地址解析

### 自定义 WebView

编辑 `fault-analysis-webview.ts` 中的 `getHtmlContent()` 方法：
- 修改 CSS 样式
- 添加新的节（section）
- 集成图表库

## 参考资料

### ARM 文档
- [ARMv7-M Architecture Reference Manual](https://developer.arm.com/documentation/ddi0403/latest/)
- [Cortex-M4 Technical Reference Manual](https://developer.arm.com/documentation/100166/0001)
- [Fault Handling in Cortex-M](https://interrupt.memfault.com/blog/cortex-m-fault-debug)

### 相关工具
- [CmBacktrace 原始项目](https://github.com/armink/CmBacktrace)
- [GNU Binutils addr2line](https://sourceware.org/binutils/docs/binutils/addr2line.html)
- [VS Code Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)

## 版本历史

### v1.0.0 (初始实现)
- ✅ 基本故障检测和分析
- ✅ 调用栈提取和符号解析
- ✅ 原生 TreeView 故障报告
- ✅ 自动/手动触发模式
- ✅ VS Code 命令集成
- ✅ 配置选项支持
- ✅ Debug 侧边栏集成
- ✅ 右键菜单支持

---

**作者**: AI Assistant
**日期**: 2025-10-05
**状态**: 已完成 ✅
