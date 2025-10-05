# RISC-V 支持计划

## 🎯 目标

为 CmBacktrace 添加 RISC-V 架构支持，实现跨架构的故障分析工具。

## ❌ 当前限制

### 1. ARM 专用硬件寄存器
```typescript
// 当前实现使用 ARM Cortex-M SCB 寄存器
const SCB_REGISTERS = {
    CFSR: 0xE000ED28,  // ARM 专用地址
    HFSR: 0xE000ED2C,
    // ...
};
```

### 2. ARM 特定故障类型
- Hard Fault
- Memory Management Fault (MPU)
- Bus Fault
- Usage Fault

### 3. ARM 工具链
- `arm-none-eabi-gdb`
- `arm-none-eabi-addr2line`

---

## 🔄 RISC-V 架构差异

### RISC-V 异常/中断系统

#### CSR (Control and Status Registers)
```
mcause   - Machine Cause Register (异常/中断原因)
mtval    - Machine Trap Value (故障地址)
mepc     - Machine Exception PC (故障 PC)
mstatus  - Machine Status Register
mtvec    - Machine Trap Vector
```

#### RISC-V 异常代码 (mcause)
```
0  - Instruction address misaligned
1  - Instruction access fault
2  - Illegal instruction
3  - Breakpoint
4  - Load address misaligned
5  - Load access fault
6  - Store/AMO address misaligned
7  - Store/AMO access fault
8  - Environment call from U-mode
9  - Environment call from S-mode
11 - Environment call from M-mode
12 - Instruction page fault
13 - Load page fault
15 - Store/AMO page fault
```

---

## 🏗️ 架构设计

### 1. 架构抽象层

```typescript
// 抽象接口
interface ArchitectureBacktrace {
    // 读取故障寄存器
    readFaultRegisters(): Promise<Map<string, number>>;

    // 判断故障类型
    determineFaultType(registers: Map<string, number>): FaultType;

    // 分析故障原因
    analyzeFaultCause(faultType: FaultType, registers: Map<string, number>): string[];

    // 获取故障地址
    getFaultAddress(faultType: FaultType, registers: Map<string, number>): number | undefined;

    // 获取工具链前缀
    getToolchainPrefix(): string;
}

// ARM Cortex-M 实现
class CortexMBacktrace implements ArchitectureBacktrace {
    // 当前实现
}

// RISC-V 实现
class RiscVBacktrace implements ArchitectureBacktrace {
    // 新增实现
}
```

### 2. 故障类型映射

```typescript
// 通用故障类型
enum FaultType {
    NONE = 'None',

    // ARM 专用
    HARD_FAULT = 'Hard Fault',
    MEM_MANAGE_FAULT = 'Memory Management Fault',
    BUS_FAULT = 'Bus Fault',
    USAGE_FAULT = 'Usage Fault',
    DEBUG_FAULT = 'Debug Fault',

    // RISC-V 专用
    INSTRUCTION_MISALIGNED = 'Instruction Address Misaligned',
    INSTRUCTION_FAULT = 'Instruction Access Fault',
    ILLEGAL_INSTRUCTION = 'Illegal Instruction',
    LOAD_MISALIGNED = 'Load Address Misaligned',
    LOAD_FAULT = 'Load Access Fault',
    STORE_MISALIGNED = 'Store Address Misaligned',
    STORE_FAULT = 'Store Access Fault',
    ECALL = 'Environment Call',
    PAGE_FAULT = 'Page Fault',

    // 通用
    BREAKPOINT = 'Breakpoint',
    UNKNOWN = 'Unknown Fault'
}
```

### 3. 寄存器定义

```typescript
// RISC-V CSR 地址
const RISCV_CSR = {
    // Machine-level CSRs
    MSTATUS: 0x300,
    MISA: 0x301,
    MIE: 0x304,
    MTVEC: 0x305,

    // Machine Trap Handling
    MSCRATCH: 0x340,
    MEPC: 0x341,
    MCAUSE: 0x342,
    MTVAL: 0x343,
    MIP: 0x344,

    // Supervisor-level CSRs (可选)
    SSTATUS: 0x100,
    SIE: 0x104,
    STVEC: 0x105,
    SEPC: 0x141,
    SCAUSE: 0x142,
    STVAL: 0x143,
};
```

---

## 🔨 实施步骤

### Phase 1: 架构检测 (P0)
```typescript
// 检测目标架构
enum Architecture {
    CORTEX_M,
    RISCV32,
    RISCV64,
    UNKNOWN
}

class BacktraceFactory {
    static create(session: vscode.DebugSession): ArchitectureBacktrace {
        const arch = this.detectArchitecture(session);

        switch (arch) {
            case Architecture.CORTEX_M:
                return new CortexMBacktrace(session);
            case Architecture.RISCV32:
            case Architecture.RISCV64:
                return new RiscVBacktrace(session);
            default:
                throw new Error('Unsupported architecture');
        }
    }

    private static detectArchitecture(session: vscode.DebugSession): Architecture {
        // 从配置或 ELF 文件检测
        const config = session.configuration;

        if (config.device?.includes('cortex-m')) {
            return Architecture.CORTEX_M;
        }

        if (config.toolchainPrefix?.includes('riscv')) {
            return config.toolchainPrefix.includes('riscv64')
                ? Architecture.RISCV64
                : Architecture.RISCV32;
        }

        return Architecture.UNKNOWN;
    }
}
```

### Phase 2: RISC-V 故障分析 (P0)
```typescript
class RiscVBacktrace implements ArchitectureBacktrace {
    async readFaultRegisters(): Promise<Map<string, number>> {
        const registers = new Map<string, number>();

        // 读取 RISC-V CSR
        registers.set('MCAUSE', await this.readCSR(RISCV_CSR.MCAUSE));
        registers.set('MEPC', await this.readCSR(RISCV_CSR.MEPC));
        registers.set('MTVAL', await this.readCSR(RISCV_CSR.MTVAL));
        registers.set('MSTATUS', await this.readCSR(RISCV_CSR.MSTATUS));

        return registers;
    }

    determineFaultType(registers: Map<string, number>): FaultType {
        const mcause = registers.get('MCAUSE') || 0;

        // RISC-V mcause 寄存器格式:
        // 最高位 = 1: 中断
        // 最高位 = 0: 异常
        const isInterrupt = (mcause >> 31) & 1;
        const code = mcause & 0x7FFFFFFF;

        if (isInterrupt) {
            return FaultType.NONE; // 中断不算故障
        }

        // 异常代码映射
        switch (code) {
            case 0: return FaultType.INSTRUCTION_MISALIGNED;
            case 1: return FaultType.INSTRUCTION_FAULT;
            case 2: return FaultType.ILLEGAL_INSTRUCTION;
            case 3: return FaultType.BREAKPOINT;
            case 4: return FaultType.LOAD_MISALIGNED;
            case 5: return FaultType.LOAD_FAULT;
            case 6: return FaultType.STORE_MISALIGNED;
            case 7: return FaultType.STORE_FAULT;
            case 8:
            case 9:
            case 11: return FaultType.ECALL;
            case 12:
            case 13:
            case 15: return FaultType.PAGE_FAULT;
            default: return FaultType.UNKNOWN;
        }
    }

    analyzeFaultCause(faultType: FaultType, registers: Map<string, number>): string[] {
        const causes: string[] = [];
        const mtval = registers.get('MTVAL') || 0;
        const mepc = registers.get('MEPC') || 0;

        switch (faultType) {
            case FaultType.INSTRUCTION_MISALIGNED:
                causes.push(`Instruction address misaligned: PC = 0x${mepc.toString(16)}`);
                causes.push('Check instruction alignment (must be 2-byte or 4-byte aligned)');
                break;

            case FaultType.INSTRUCTION_FAULT:
                causes.push(`Instruction access fault at: 0x${mtval.toString(16)}`);
                causes.push('Invalid instruction fetch address');
                break;

            case FaultType.ILLEGAL_INSTRUCTION:
                causes.push(`Illegal instruction at: PC = 0x${mepc.toString(16)}`);
                causes.push('Unsupported or invalid instruction encoding');
                break;

            case FaultType.LOAD_MISALIGNED:
                causes.push(`Load address misaligned: 0x${mtval.toString(16)}`);
                causes.push('Check data alignment for load operations');
                break;

            case FaultType.LOAD_FAULT:
                causes.push(`Load access fault at: 0x${mtval.toString(16)}`);
                causes.push('Invalid memory read address');
                break;

            case FaultType.STORE_MISALIGNED:
                causes.push(`Store address misaligned: 0x${mtval.toString(16)}`);
                causes.push('Check data alignment for store operations');
                break;

            case FaultType.STORE_FAULT:
                causes.push(`Store access fault at: 0x${mtval.toString(16)}`);
                causes.push('Invalid memory write address or read-only memory');
                break;

            case FaultType.ECALL:
                causes.push(`Environment call at: PC = 0x${mepc.toString(16)}`);
                break;

            case FaultType.PAGE_FAULT:
                causes.push(`Page fault at: 0x${mtval.toString(16)}`);
                causes.push('Virtual memory page not mapped');
                break;
        }

        return causes;
    }

    getFaultAddress(faultType: FaultType, registers: Map<string, number>): number | undefined {
        // RISC-V 使用 mtval 存储故障地址
        return registers.get('MTVAL');
    }

    getToolchainPrefix(): string {
        return 'riscv32-unknown-elf-'; // 或 riscv64-unknown-elf-
    }

    private async readCSR(address: number): Promise<number> {
        // CSR 读取需要特殊处理
        // 方法 1: 通过 GDB 读取寄存器
        // 方法 2: 通过自定义 GDB 命令
        // 例: monitor read_csr 0x342
    }
}
```

### Phase 3: UI 更新 (P1)
```typescript
// TreeView 图标映射
private getFaultIcon(faultType: FaultType): string {
    switch (faultType) {
        // ARM
        case FaultType.HARD_FAULT: return 'error';
        case FaultType.MEM_MANAGE_FAULT: return 'symbol-variable';
        case FaultType.BUS_FAULT: return 'debug-disconnect';
        case FaultType.USAGE_FAULT: return 'warning';

        // RISC-V
        case FaultType.INSTRUCTION_MISALIGNED:
        case FaultType.LOAD_MISALIGNED:
        case FaultType.STORE_MISALIGNED:
            return 'symbol-ruler';

        case FaultType.INSTRUCTION_FAULT:
        case FaultType.LOAD_FAULT:
        case FaultType.STORE_FAULT:
            return 'debug-disconnect';

        case FaultType.ILLEGAL_INSTRUCTION:
            return 'error';

        case FaultType.PAGE_FAULT:
            return 'file-code';

        default: return 'bug';
    }
}
```

### Phase 4: 工具链支持 (P1)
```typescript
// 支持多种工具链
interface ToolchainConfig {
    prefix: string;
    gdb: string;
    addr2line: string;
    objdump: string;
}

const TOOLCHAINS: { [key: string]: ToolchainConfig } = {
    'cortex-m': {
        prefix: 'arm-none-eabi-',
        gdb: 'arm-none-eabi-gdb',
        addr2line: 'arm-none-eabi-addr2line',
        objdump: 'arm-none-eabi-objdump'
    },
    'riscv32': {
        prefix: 'riscv32-unknown-elf-',
        gdb: 'riscv32-unknown-elf-gdb',
        addr2line: 'riscv32-unknown-elf-addr2line',
        objdump: 'riscv32-unknown-elf-objdump'
    },
    'riscv64': {
        prefix: 'riscv64-unknown-elf-',
        gdb: 'riscv64-unknown-elf-gdb',
        addr2line: 'riscv64-unknown-elf-addr2line',
        objdump: 'riscv64-unknown-elf-objdump'
    }
};
```

### Phase 5: 配置更新 (P2)
```json
{
    "cortex-debug.architecture": {
        "type": "string",
        "enum": ["cortex-m", "riscv32", "riscv64", "auto"],
        "default": "auto",
        "description": "Target architecture for fault analysis"
    },
    "cortex-debug.riscvToolchainPrefix": {
        "type": "string",
        "default": "riscv32-unknown-elf-",
        "description": "RISC-V toolchain prefix"
    }
}
```

---

## 🧪 测试场景

### RISC-V 测试用例

#### 1. 非对齐访问
```c
volatile uint32_t *ptr = (uint32_t*)0x20000001; // 非 4 字节对齐
uint32_t value = *ptr; // 触发 Load Address Misaligned
```

#### 2. 非法指令
```c
asm volatile(".word 0xFFFFFFFF"); // 非法指令
// 触发 Illegal Instruction
```

#### 3. 访问无效地址
```c
volatile uint32_t *ptr = (uint32_t*)0xFFFFFFFF;
uint32_t value = *ptr; // 触发 Load Access Fault
```

---

## 📊 工作量估算

| 任务 | 工作量 | 优先级 |
|------|--------|--------|
| 架构抽象层设计 | 2天 | P0 |
| RISC-V 故障分析实现 | 3天 | P0 |
| CSR 寄存器读取 | 1天 | P0 |
| UI 图标和文本更新 | 1天 | P1 |
| 工具链自动检测 | 1天 | P1 |
| 配置和文档 | 1天 | P1 |
| 测试和调试 | 2天 | P0 |
| **总计** | **11天** | - |

---

## 📋 待解决的技术问题

### 1. CSR 寄存器读取
**问题**: RISC-V CSR 不是普通内存映射

**解决方案**:
- 使用 GDB 的 `info registers` 命令
- 自定义 GDB monitor 命令
- 或使用调试器专用接口

### 2. 权限级别检测
**问题**: RISC-V 有 M/S/U 三级权限

**解决方案**:
- 从 `mstatus.MPP` 检测当前权限级别
- 根据权限级别读取对应的 CSR

### 3. 扩展支持
**问题**: RISC-V 有众多扩展（M, A, C, F, D 等）

**解决方案**:
- 从 `misa` CSR 读取支持的扩展
- 根据扩展调整故障分析逻辑

---

## 🎯 最小可行产品 (MVP)

### MVP 范围
1. ✅ 支持 RISC-V 基本异常检测
2. ✅ 读取 mcause, mepc, mtval
3. ✅ 分析 8 种常见异常
4. ✅ 调用栈回溯 (使用 addr2line)
5. ✅ TreeView 显示

### 不包含
- ❌ 虚拟内存支持
- ❌ 中断分析
- ❌ S/U 权限级别
- ❌ PMP (Physical Memory Protection)

---

## 📚 参考资料

- [RISC-V Privileged Spec](https://github.com/riscv/riscv-isa-manual)
- [RISC-V Exception Handling](https://five-embeddev.com/riscv-isa-manual/latest/machine.html)
- [RISC-V GDB](https://github.com/riscv/riscv-gdb)

---

**状态**: 📋 规划中
**预计完成**: 2-3 周（11 工作日）
**依赖**: RISC-V 工具链、测试硬件
