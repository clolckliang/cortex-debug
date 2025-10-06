# Waveform 结构体成员选择功能测试指南

## 功能概述
现在波形界面支持结构体成员的树形展开和选择功能。

## 如何测试功能

### 1. 准备工作
- 确保调试会话正在运行
- 确保有一个结构体变量（如 `myStruct`）

### 2. 添加结构体到波形
1. 在 Live Watch 中找到结构体变量（如 `myStruct`）
2. 右键点击 → "Add to Waveform"
3. 或者使用命令面板：`Cortex-Debug: Add Variable to Waveform`

### 3. 查看结构体展开功能
1. 在波形界面的 Variables 侧边栏中找到添加的结构体
2. 结构体应该以 **粗体** 显示
3. 点击结构体前的展开图标（▶️）来展开成员

### 4. 选择结构体成员
1. 展开结构体后，应该看到所有成员的列表
2. 每个数值成员前应该有复选框
3. 勾选想要监控的成员
4. 选中的成员会作为独立的波形线显示

## 预期结果

### 结构体解析日志
应该看到类似这样的日志：
```
[Waveform] Parsing structure with advanced parser: myStruct
[StructParser] Detected simplified structure representation for myStruct - expansion required
[Waveform] Successfully expanded structure: {myVariable = 1855, myFloatVariable = 1855, myCharVariable = 65 'A', myDoubleVariable = 0}
[Waveform] Structure parsed successfully: {type: 'struct', membersCount: 4, totalValue: 3775}
[Waveform] Found 4 numeric members: myVariable, myFloatVariable, myCharVariable, myDoubleVariable
```

### 界面元素检查
- [ ] 工具栏按钮有图标（不再全黑）
- [ ] 结构体在变量列表中以粗体显示
- [ ] 结构体有展开/折叠图标（chevron）
- [ ] 展开后显示成员列表
- [ ] 成员有复选框
- [ ] 成员显示名称、值、类型信息

### 功能测试
- [ ] 可以展开/折叠结构体
- [ ] 可以勾选/取消勾选成员
- [ ] 选中的成员在波形中显示为独立线条
- [ ] 成员值实时更新

## 故障排除

### 如果按钮仍然没有图标
1. 重启 VS Code
2. 重新加载插件：`Ctrl+Shift+P` → `Developer: Reload Window`
3. 检查开发者控制台是否有错误

### 如果结构体没有展开功能
1. 检查日志中是否有结构体解析成功的信息
2. 确认结构体确实包含数值成员
3. 尝试重新添加结构体到波形

### 如果看不到成员选择
1. 确认结构体已经成功解析（查看日志）
2. 尝试刷新波形界面
3. 检查结构体是否在 Variables 列表中显示为粗体