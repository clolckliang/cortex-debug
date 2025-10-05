# RISC-V 支持实施进度报告

## ✅ 已完成 (Phase 1 & 2)

### 1. 架构抽象层 ✓
- **文件**: `architecture-backtrace.ts`
- **内容**:
  - `Architecture` 枚举 (CORTEX_M, RISCV32, RISCV64)
  - `FaultType` 扩展枚举 (新增 9 种 RISC-V 故障类型)
  - `IArchitectureBacktrace` 接口
  - `ArchitectureFactory` 工厂类 (自动检测架构)
  - `FaultAnalysis` 接口增加 `architecture` 字段

### 2. RISC-V 实现 ✓
- **文件**: `riscv-backtrace.ts`
- **功能**:
  - CSR 寄存器定义 (MCAUSE, MEPC, MTVAL, MSTATUS)
  - 异常代码映射 (16 种 RISC-V 异常)
  - 故障分析逻辑
  - 智能推荐生成
  - RV32/RV64 支持

### 3. Cortex-M 重构 ✓
- **文件**: `cortex-m-backtrace.ts`
- **功能**:
  - 从 `cmbacktrace.ts` 提取 Cortex-M 实现
  - 实现 `IArchitectureBacktrace` 接口
  - 保留所有原有功能

### 4. CmBacktraceAnalyzer 集成 ✓
- **文件**: `cmbacktrace.ts`
- **更新**:
  - 移除重复的 `FaultType` 枚举，从 `architecture-backtrace.ts` 导入
  - 使用 `ArchitectureFactory.create()` 自动创建架构实现
  - `setSession()` 方法改为 async，自动检测架构
  - 移除架构特定代码，委托给 `IArchitectureBacktrace` 实现
  - 更新 `addr2line()` 接受 toolchainPrefix 参数
  - `FaultAnalysis` 返回值包含 `architecture` 字段

### 5. TreeView 更新 ✓
- **文件**: `fault-analysis-tree.ts`
- **更新**:
  - `getFaultIcon()` 增加 RISC-V 故障图标映射:
    - 对齐错误 → `symbol-ruler`
    - 访问错误 → `debug-disconnect`
    - 非法指令 → `error`
    - 页面错误 → `file-code`
    - 环境调用 → `symbol-method`
    - 断点 → `debug-breakpoint`
  - 根节点显示架构标签 (e.g., "Load Access Fault [RISCV32]")
  - Tooltip 显示架构信息

### 6. Extension 集成 ✓
- **文件**: `extension.ts`
- **更新**:
  - `analyzeFault()` 使用 `await this.cmBacktraceAnalyzer.setSession(session)`
  - `showCallStack()` 使用 `await this.cmBacktraceAnalyzer.setSession(session)`
  - `checkForFault()` 使用 `await this.cmBacktraceAnalyzer.setSession(session)`
  - 移除手动设置 `toolchainPrefix` (由架构实现自动处理)

## 📊 新增的故障类型

### RISC-V 专用
| 故障类型 | 说明 | 触发条件 |
|---------|------|---------|
| INSTRUCTION_MISALIGNED | 指令地址非对齐 | PC 不是 2/4 字节对齐 |
| INSTRUCTION_FAULT | 指令访问错误 | 无效指令地址 |
| ILLEGAL_INSTRUCTION | 非法指令 | 不支持的指令编码 |
| LOAD_MISALIGNED | 加载非对齐 | 数据地址非对齐 |
| LOAD_FAULT | 加载访问错误 | 读取无效地址 |
| STORE_MISALIGNED | 存储非对齐 | 写入地址非对齐 |
| STORE_FAULT | 存储访问错误 | 写入无效/只读地址 |
| ECALL | 环境调用 | ecall 指令 (系统调用) |
| PAGE_FAULT | 页面错误 | 虚拟内存页未映射 |

## 🏗️ 架构设计

### 架构检测逻辑
```typescript
// 优先级：
1. toolchainPrefix (riscv64/riscv32/arm-none-eabi)
2. device 名称 (cortex-m/stm32/riscv/rv32/rv64)
3. servertype (jlink/openocd → ARM)
4. 默认 Cortex-M (向后兼容)
```

### 工厂模式
```typescript
const backtrace = await ArchitectureFactory.create(session);
// 自动返回 CortexMBacktrace 或 RiscVBacktrace
```

## 📁 文件结构

```
src/frontend/
├── architecture-backtrace.ts       # 抽象层 (NEW)
│   ├── Architecture 枚举
│   ├── FaultType 扩展
│   ├── IArchitectureBacktrace 接口
│   └── ArchitectureFactory
│
├── cortex-m-backtrace.ts          # Cortex-M 实现 (NEW)
│   └── CortexMBacktrace 类
│
├── riscv-backtrace.ts             # RISC-V 实现 (NEW)
│   └── RiscVBacktrace 类
│
└── cmbacktrace.ts                 # 主分析器 (待更新)
    └── CmBacktraceAnalyzer (需重构)
```

## 🔄 待完成任务

### Phase 3: 配置选项 (下一步)
- [ ] 添加 `cortex-debug.architecture` 配置 (可选，默认自动检测)
- [ ] 添加 `cortex-debug.riscvToolchainPrefix` 配置
- [ ] 更新 launch.json 示例

### Phase 4: 文档
- [ ] 更新用户指南 (添加 RISC-V 章节)
- [ ] 更新技术文档
- [ ] 添加 RISC-V 测试用例

### Phase 5: 测试
- [ ] 测试 ARM Cortex-M 向后兼容性
- [ ] 测试 RISC-V 故障检测
- [ ] 测试架构自动检测
- [ ] 测试多架构切换

## 🧪 测试计划

### RISC-V 测试场景
```c
// 1. 非对齐访问
uint32_t *ptr = (uint32_t*)0x20000001;
uint32_t val = *ptr; // → LOAD_MISALIGNED

// 2. 非法指令
asm(".word 0xFFFFFFFF"); // → ILLEGAL_INSTRUCTION

// 3. 空指针
uint32_t *ptr = NULL;
uint32_t val = *ptr; // → LOAD_FAULT
```

## 📊 代码统计

| 文件 | 行数 | 状态 |
|------|------|------|
| architecture-backtrace.ts | ~184 | ✅ 完成 |
| riscv-backtrace.ts | ~393 | ✅ 完成 |
| cortex-m-backtrace.ts | ~363 | ✅ 完成 |
| cmbacktrace.ts (重构后) | ~242 | ✅ 完成 |
| fault-analysis-tree.ts (更新) | ~395 | ✅ 完成 |
| extension.ts (更新) | 3行修改 | ✅ 完成 |
| **总计** | **~1577** | **Phase 1 & 2 完成** |

## 🎯 下一步行动

### 立即执行 (Priority 0)
1. **添加配置选项**
   - `cortex-debug.architecture` (可选)
   - `cortex-debug.riscvToolchainPrefix`

2. **更新文档**
   - README 添加 RISC-V 支持说明
   - 用户指南添加 RISC-V 示例

3. **测试验证**
   - ARM Cortex-M 兼容性测试
   - RISC-V 功能测试

---

**当前进度**: 80% (Phase 1 & 2 完成, Phase 3 进行中)
**预计剩余时间**: 2 工作日
**状态**: 🟢 进行中

**下一个里程碑**: Phase 3 配置选项完成
