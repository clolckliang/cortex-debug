# 启动速度测试指南

## 🧪 测试步骤

### 1. 使用"Ultra Fast"配置
将以下配置复制到你的 `.vscode/launch.json` 中：

```json
{
    "name": "Ultra Fast Test",
    "cwd": "E:\\program_project\\test_by_vscode_stm32\\demo1",
    "executable": "E:/program_project/test_by_vscode_stm32/demo1/build/Debug/demo1.elf",
    "request": "launch",
    "type": "cortex-debug",
    "servertype": "openocd",
    "serverpath": "D:\\Dev_env\\OpenOCD\\bin\\openocd.exe",
    "searchDir": ["C:/OpenOCD-x86_64-0.12.0/share/openocd/scripts"],
    "configFiles": [
        "interface/cmsis-dap.cfg",
        "target/stm32f4x.cfg"
    ],
    "runToEntryPoint": "main",
    "showDevDebugOutput": "none",
    "preLaunchCommands": [],
    "postLaunchCommands": [],
    "toolchainPath": "D:\\Dev_env\\arm_gcc\\arm-gnu-toolchain-13.3.rel1-mingw-w64-i686-arm-none-eabi\\bin",
    "toolchainPrefix": "arm-none-eabi",
    "swoConfig": {"enabled": false},
    "rttConfig": {"enabled": false},
    "liveWatch": {"enabled": false},
    "svdFile": "",
    "gdbPort": 3333,
    "tclPort": 6666,
    "telnetPort": 4444
}
```

### 2. 测试不同配置的速度

| 配置名称 | 预计启动时间 | 功能完整性 |
|---------|-------------|-----------|
| Ultra Fast | 5-15秒 | 基本调试功能 |
| Fast Launch | 10-20秒 | 包含SVD加载 |
| Medium Speed | 15-30秒 | 包含Live Watch |
| Full Features | 20-45秒 | 完整功能 |

### 3. 逐步启用功能

如果"Ultra Fast"配置工作正常，你可以逐步添加功能：

1. **添加SVD支持**
```json
"svdFile": "${workspaceFolder}/STM32F407.svd"
```

2. **启用Live Watch**
```json
"liveWatch": {
    "enabled": true,
    "samplesPerSecond": 1
}
```

3. **添加预启动命令**
```json
"preLaunchCommands": [
    "monitor reset halt",
    "monitor sleep 100"
]
```

## 🚀 进一步优化建议

### 1. 使用更快的OpenOCD版本
```bash
# 考虑使用最新的OpenOCD构建版本
# https://github.com/openocd-org/openocd/releases
```

### 2. 优化符号文件
- 减少调试符号 (`strip --strip-unneeded`)
- 使用 `-g1` 编译选项而不是 `-g`

### 3. 系统优化
- 关闭不必要的杀毒软件实时扫描
- 使用SSD硬盘
- 增加系统内存

## 📊 性能监控

启用时间戳来监控启动过程：
```json
"showDevDebugOutput": "raw",
"showDevDebugTimestamps": true
```

这会显示每个步骤的具体耗时。