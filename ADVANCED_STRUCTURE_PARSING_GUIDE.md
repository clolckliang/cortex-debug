# 高级结构体解析指南

## 概述

本功能为Cortex-Debug波形图提供了高级的结构体和联合体解析能力，支持：
- 嵌套结构体解析
- 联合体成员可视化
- 选择性成员监控
- 自动数值提取和哈希计算

## 新增功能

### 1. 高级结构体解析器 (StructParser)

**位置**: `src/frontend/views/struct-parser.ts`

**功能**:
- 解析复杂的C/C++结构体表示
- 支持嵌套结构、联合体、数组
- 自动提取数值成员
- 生成结构体哈希用于变化检测

**支持的格式**:
```c
// 简单结构体
{a = 10, b = 20.5, c = 'x'}

// 嵌套结构体
{outer = {inner = {value = 100}}, count = 5}

// 联合体
union_name { active_member = 42 }

// 数组
{[0] = 1, [1] = 2, [2] = 3}

// 混合类型
{num = 42, flags = 0xFF, ptr = 0x20000000}
```

### 2. 结构体成员选择界面

**新增命令**:
- `cortex-debug.liveWatch.selectStructMembers` - 选择结构体成员
- `cortex-debug.waveform.configureStructMembers` - 配置结构体成员

**工作流程**:
1. 右键点击Live Watch中的结构体变量
2. 选择"Add to Waveform"
3. 系统检测到复杂结构体，提示是否选择成员
4. 在弹出的快速选择界面中选择要监控的成员
5. 生成成员表达式用于独立监控

### 3. 增强的调试日志

现在提供详细的调试信息：
```
[Waveform] Parsing structure with advanced parser: myStruct
[StructParser] Parsing structure: myStruct, value: {...}
[Waveform] Structure parsed successfully: {type: 'struct', membersCount: 2, totalValue: 52.5, hash: 'abc123'}
[Waveform] Found 2 numeric members: ["a", "b.value"]
```

## 使用方法

### 基本使用

1. **添加结构体到波形图**:
   - 在Live Watch中右键点击结构体变量
   - 选择"Add to Waveform"
   - 如果检测到复杂结构体，会提示选择成员

2. **选择特定成员**:
   - 在添加提示中选择"Select Members"
   - 在快速选择界面中勾选要监控的成员
   - 系统为每个选中的成员创建独立的监控

3. **查看结构体信息**:
   - 右键点击已添加的结构体变量
   - 选择"Configure Structure Members"
   - 查看详细的成员信息和当前值

### 高级配置

**示例C代码**:
```c
typedef struct {
    int temperature;
    float humidity;
    struct {
        int hour;
        int minute;
    } time;
    union {
        int digital;
        float analog;
    } sensor;
} SensorData;

SensorData mySensor = {
    .temperature = 25,
    .humidity = 60.5,
    .time = {.hour = 14, .minute = 30},
    .sensor = {.digital = 42}
};
```

**监控选择**:
- 整个结构体：`mySensor` (哈希值)
- 温度：`mySensor.temperature`
- 湿度：`mySensor.humidity`
- 时间：`mySensor.time.hour`
- 传感器：`mySensor.sensor.digital`

## 当前状态分析

根据您提供的日志，我可以看到：

1. **解析器工作正常**: 系统成功识别了`myStruct`为结构体类型
2. **简化表示问题**: Live Watch返回的是`{...}`而不是详细内容
3. **需要改进**: 当GDB返回简化表示时，需要展开结构体

## 问题诊断

### 当前问题
```
[Waveform] Node.getCopyValue(): {...}
[StructParser] Parsing structure: myStruct, value: {...}
[Waveform] Structure parsed successfully: {type: 'struct', membersCount: 0, totalValue: 0, hash: '0'}
```

**原因**: Live Watch返回了简化的结构体表示`{...}`，而不是实际的成员内容。

### 解决方案

1. **强制展开结构体**:
   - 检测到`{...}`表示时，自动展开结构体
   - 请求GDB提供详细的成员信息

2. **使用GDB命令获取详细信息**:
   - 使用`ptype`命令获取结构体定义
   - 使用`print`命令获取每个成员的值

3. **改进解析逻辑**:
   - 处理简化的结构体表示
   - 递归展开嵌套结构

## 下一步改进计划

### 1. 自动结构体展开
```typescript
private async expandStructure(node: any, expression: string): Promise<string> {
    // 当检测到{...}时，自动请求详细内容
    // 使用GDB命令获取完整结构体信息
}
```

### 2. GDB集成改进
```typescript
private async getStructureDetails(expression: string): Promise<string> {
    // 使用p/x *(type*)address 获取内存内容
    // 使用p *(expression) 获取详细值
}
```

### 3. 智能成员检测
```typescript
private detectStructType(expression: string): Promise<StructInfo> {
    // 分析变量类型
    // 预测可能的数值成员
}
```

## 临时解决方案

对于当前的`{...}`问题，您可以：

1. **手动展开成员**:
   - 在Live Watch中点击结构体的展开箭头
   - 然后右键点击具体成员选择"Add to Waveform"

2. **使用具体成员路径**:
   - 手动输入`myStruct.memberName`到波形图
   - 直接监控感兴趣的成员

3. **使用GDB命令**:
   ```bash
   p myStruct
   p myStruct.member1
   p myStruct.member2
   ```

## 技术细节

### 解析算法
1. **类型检测**: 自动识别struct、union、class、array
2. **成员提取**: 递归解析嵌套结构
3. **数值计算**: 自动计算总和或哈希值
4. **路径生成**: 生成点号分隔的成员路径

### 性能优化
- 缓存解析结果
- 增量更新检测
- 异步解析处理

### 错误处理
- 优雅降级到简单解析
- 详细的错误日志
- 用户友好的错误消息

## 测试用例

### 测试数据结构
```c
// 测试1: 简单结构体
struct Simple {
    int a;
    float b;
};

// 测试2: 嵌套结构体
struct Nested {
    struct {
        int x, y;
    } point;
    int count;
};

// 测试3: 联合体
union Data {
    int i;
    float f;
    char bytes[4];
};

// 测试4: 数组结构体
struct ArrayStruct {
    int values[10];
    char name[20];
};
```

### 预期行为
- 正确识别结构体类型
- 提取所有数值成员
- 生成正确的成员路径
- 计算准确的总值/哈希

这个功能正在积极开发中，当前版本提供了基础的结构体解析能力，后续版本将改进简化表示的处理。