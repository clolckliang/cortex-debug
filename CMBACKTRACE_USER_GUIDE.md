# CmBacktrace - ARM Cortex-M 故障分析工具

## 快速开始

CmBacktrace 是集成在 Cortex-Debug 中的 ARM Cortex-M 故障分析工具，能自动检测和分析各种硬件故障。

### 1. 自动故障检测

调试时遇到故障会自动检测并提示：

```
⚠️ Fault Detected: Hard Fault
[Show Details] [Dismiss]
```

点击 **Show Details**，在 Debug 侧边栏查看完整分析。

### 2. 查看故障分析

在 Debug 侧边栏的 **Fault Analysis** 面板中：

```
⛔ Hard Fault
├── ⚠ Fault Causes
│   ├── Vector table read error
│   └── Forced Hard Fault - Escalated from configurable fault (check CFSR)
├── 📍 Fault Address: 0xE000ED28
├── 🔧 Fault Registers (展开查看)
│   ├── CFSR: 0x00000100
│   ├── HFSR: 0x40000000
│   └── ...
├── 📞 Call Stack
│   ├── #0 HardFault_Handler @ 0x08001234 (点击跳转)
│   ├── #1 main @ 0x08001100
│   └── ...
└── 💡 Recommendations
    └── Check for code corruption, invalid function pointers...
```

### 3. 手动触发分析

**命令面板** (`Ctrl+Shift+P`):
- `Cortex-Debug: Analyze Cortex-M Fault` - 分析当前故障
- `Cortex-Debug: Show Call Stack (CmBacktrace)` - 显示调用栈

### 4. 交互操作

- **点击调用栈** → 自动跳转到源代码位置
- **右键菜单** → 更多选项（Clear、Copy等）
- **折叠/展开** → 控制显示详细程度

## 支持的故障类型

| 故障类型 | 说明 | 图标 |
|---------|------|------|
| Hard Fault | 硬件故障 - 最严重的错误 | ⛔ |
| Memory Management Fault | 内存管理故障 - MPU违规 | 🔒 |
| Bus Fault | 总线故障 - 无效内存访问 | 🚫 |
| Usage Fault | 使用故障 - 未定义指令、除零等 | ⚠️ |
| Debug Fault | 调试故障 - 断点、watchpoint | 🐛 |

## 常见故障原因

### Hard Fault
- ❌ **向量表读取错误** → 检查中断向量表是否损坏
- ❌ **强制故障** → 从其他故障升级而来，检查 CFSR 寄存器

### Memory Management Fault
- ❌ **指令访问违规** → 尝试从受保护区域执行代码
- ❌ **数据访问违规** → 读写受保护内存
- ❌ **栈溢出** → 增加栈大小或减少局部变量

### Bus Fault
- ❌ **指令总线错误** → 错误的函数指针
- ❌ **精确数据总线错误** → 访问无效地址
- ❌ **栈指针损坏** → 检查栈操作

### Usage Fault
- ❌ **未定义指令** → 代码损坏或错误函数指针
- ❌ **无效状态** → Thumb 位未设置
- ❌ **除零错误** → 添加除零检查
- ❌ **未对齐访问** → 检查数据结构对齐

## 配置选项

### settings.json

```json
{
    // 启用/禁用自动故障检测
    "cortex-debug.autoFaultDetection": true
}
```

### launch.json

```json
{
    "type": "cortex-debug",
    "name": "Debug",
    "executable": "${workspaceFolder}/build/firmware.elf",
    "toolchainPrefix": "arm-none-eabi-",  // 工具链前缀
    ...
}
```

## 故障排查流程

### 步骤 1: 查看故障类型
确认是哪种类型的故障（Hard Fault / Bus Fault 等）

### 步骤 2: 分析故障原因
查看 **Fault Causes** 列表，了解具体原因

### 步骤 3: 检查故障地址
如果有 **Fault Address**，这是出错的内存地址

### 步骤 4: 分析调用栈
在 **Call Stack** 中：
1. 点击栈帧跳转到源码
2. 从 #0 开始逐层检查
3. 找到最后一个有效函数

### 步骤 5: 查看寄存器
展开 **Fault Registers** 了解硬件状态

### 步骤 6: 应用建议
根据 **Recommendations** 修复问题

## 实用技巧

### 📌 技巧 1: 保存故障信息
- 右键根节点 → 暂不支持导出，可截图或复制

### 📌 技巧 2: 对比多次故障
- 使用 "Clear Fault Analysis" 清除旧信息
- 重新触发故障进行对比

### 📌 技巧 3: 结合其他工具
- 配合 **Variables** 面板查看变量值
- 配合 **Registers** 面板查看所有寄存器
- 配合 **Memory** 面板检查内存内容

### 📌 技巧 4: 快速定位问题
1. 看 **Fault Causes** - 了解"是什么"
2. 看 **Call Stack** - 了解"在哪里"
3. 看 **Recommendations** - 了解"怎么修"

## 常见问题

### Q: 为什么没有显示故障分析？
A: 检查以下几点：
- 是否启用了 `cortex-debug.autoFaultDetection`
- 是否真的发生了硬件故障（而非断点停止）
- 调试会话是否正常运行

### Q: Call Stack 中的文件路径错误？
A: 确保：
- ELF 文件包含调试符号（编译时使用 `-g`）
- `arm-none-eabi-addr2line` 在 PATH 中
- 源文件路径与 ELF 中的路径一致

### Q: 如何禁用自动检测？
A: 在 settings.json 中设置：
```json
"cortex-debug.autoFaultDetection": false
```

### Q: 可以在非故障状态下查看调用栈吗？
A: 可以！使用命令：
```
Cortex-Debug: Show Call Stack (CmBacktrace)
```

## 示例：调试除零错误

### 1. 代码触发故障
```c
int divide(int a, int b) {
    return a / b;  // 如果 b == 0 会触发 Usage Fault
}

void main() {
    int result = divide(10, 0);  // 除零
}
```

### 2. 故障分析显示
```
⚠️ Usage Fault
├── Divide by zero
└── Call Stack
    ├── #0 divide @ 0x08001234 (math.c:2)
    └── #1 main @ 0x08001100 (main.c:5)
```

### 3. 修复建议
```
💡 Add division by zero checks before arithmetic operations
```

### 4. 修复代码
```c
int divide(int a, int b) {
    if (b == 0) {
        return 0;  // 或者返回错误码
    }
    return a / b;
}
```

## 高级用法

### 与 RTOS 配合使用
- 查看调用栈时注意任务切换
- 检查是否在中断上下文中发生故障
- 确认栈大小配置（任务栈 vs 主栈）

### 自定义工具链
如果使用非标准工具链（如 LLVM）：
```json
"toolchainPrefix": "llvm-"
```

### 符号服务器
配置 addr2line 使用符号服务器（高级用户）

## UI 特性

### ✨ 主题自适应
- 自动跟随 VS Code 亮色/暗色主题
- 无需手动配置颜色

### ✨ 原生体验
- 与 Call Stack、Variables 等面板操作一致
- 支持键盘导航
- 支持折叠/展开

### ✨ 高性能
- 原生 UI 组件，无浏览器开销
- 大量数据也能流畅显示

## 了解更多

- 📖 [完整实现文档](./CMBACKTRACE_IMPLEMENTATION.md)
- 🐛 [报告问题](https://github.com/Marus/cortex-debug/issues)
- 💬 [社区讨论](https://github.com/Marus/cortex-debug/discussions)

---

**提示**: 首次使用建议先阅读"故障排查流程"部分，了解如何系统地分析故障。
