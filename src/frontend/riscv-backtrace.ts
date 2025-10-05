/**
 * RISC-V Backtrace Implementation
 * Supports RV32 and RV64 architectures
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import {
    Architecture,
    FaultType,
    IArchitectureBacktrace,
    CallStackFrame
} from './architecture-backtrace';

/**
 * RISC-V Control and Status Registers (CSR)
 */
const RISCV_CSR = {
    // Machine Trap Setup
    MSTATUS: 0x300,
    MISA: 0x301,
    MEDELEG: 0x302,
    MIDELEG: 0x303,
    MIE: 0x304,
    MTVEC: 0x305,
    MCOUNTEREN: 0x306,

    // Machine Trap Handling
    MSCRATCH: 0x340,
    MEPC: 0x341,       // Machine Exception PC
    MCAUSE: 0x342,     // Machine Cause Register
    MTVAL: 0x343,      // Machine Trap Value
    MIP: 0x344,

    // Supervisor Trap Handling (optional)
    SSTATUS: 0x100,
    SIE: 0x104,
    STVEC: 0x105,
    SEPC: 0x141,
    SCAUSE: 0x142,
    STVAL: 0x143,
    SIP: 0x144
};

/**
 * RISC-V Exception Codes (from mcause register)
 */
enum RiscVExceptionCode {
    INSTRUCTION_MISALIGNED = 0,
    INSTRUCTION_FAULT = 1,
    ILLEGAL_INSTRUCTION = 2,
    BREAKPOINT = 3,
    LOAD_MISALIGNED = 4,
    LOAD_FAULT = 5,
    STORE_MISALIGNED = 6,
    STORE_FAULT = 7,
    ECALL_U = 8,
    ECALL_S = 9,
    ECALL_M = 11,
    INSTRUCTION_PAGE_FAULT = 12,
    LOAD_PAGE_FAULT = 13,
    STORE_PAGE_FAULT = 15
}

/**
 * RISC-V Backtrace Analyzer
 */
export class RiscVBacktrace implements IArchitectureBacktrace {
    private architecture: Architecture;
    private session: vscode.DebugSession;
    private toolchainPrefix: string;

    constructor(session: vscode.DebugSession, architecture: Architecture) {
        this.session = session;
        this.architecture = architecture;

        // Determine toolchain prefix (priority: session config > VS Code setting > default)
        if (session.configuration.toolchainPrefix) {
            this.toolchainPrefix = session.configuration.toolchainPrefix;
        } else {
            const manualPrefix = vscode.workspace.getConfiguration('cortex-debug').get<string>('riscvToolchainPrefix', '');
            if (manualPrefix) {
                this.toolchainPrefix = manualPrefix;
            } else {
                this.toolchainPrefix = architecture === Architecture.RISCV64
                    ? 'riscv64-unknown-elf-'
                    : 'riscv32-unknown-elf-';
            }
        }
    }

    getArchitecture(): Architecture {
        return this.architecture;
    }

    /**
     * Read RISC-V fault registers (CSRs)
     */
    async readFaultRegisters(): Promise<Map<string, number>> {
        const registers = new Map<string, number>();

        try {
            // Try to read CSRs using GDB's info registers
            // Method 1: Direct register read via DAP
            const mcause = await this.readRegister('mcause');
            const mepc = await this.readRegister('mepc');
            const mtval = await this.readRegister('mtval');
            const mstatus = await this.readRegister('mstatus');

            registers.set('MCAUSE', mcause);
            registers.set('MEPC', mepc);
            registers.set('MTVAL', mtval);
            registers.set('MSTATUS', mstatus);

            // Try to read optional registers
            try {
                const mtvec = await this.readRegister('mtvec');
                registers.set('MTVEC', mtvec);
            } catch {
                // Optional register not available
            }
        } catch (error) {
            console.error('Failed to read RISC-V CSRs:', error);
        }

        return registers;
    }

    /**
     * Determine fault type from RISC-V mcause register
     */
    determineFaultType(registers: Map<string, number>): FaultType {
        const mcause = registers.get('MCAUSE') || 0;

        // RISC-V mcause format:
        // Bit [XLEN-1]: Interrupt flag (1 = interrupt, 0 = exception)
        // Bits [XLEN-2:0]: Exception/Interrupt code
        const xlen = this.architecture === Architecture.RISCV64 ? 64 : 32;
        const isInterrupt = (mcause >> (xlen - 1)) & 1;
        const code = mcause & ((1 << (xlen - 1)) - 1);

        if (isInterrupt) {
            return FaultType.NONE; // Interrupts are not faults
        }

        // Map exception code to fault type
        switch (code as RiscVExceptionCode) {
            case RiscVExceptionCode.INSTRUCTION_MISALIGNED:
                return FaultType.INSTRUCTION_MISALIGNED;
            case RiscVExceptionCode.INSTRUCTION_FAULT:
            case RiscVExceptionCode.INSTRUCTION_PAGE_FAULT:
                return FaultType.INSTRUCTION_FAULT;
            case RiscVExceptionCode.ILLEGAL_INSTRUCTION:
                return FaultType.ILLEGAL_INSTRUCTION;
            case RiscVExceptionCode.BREAKPOINT:
                return FaultType.BREAKPOINT;
            case RiscVExceptionCode.LOAD_MISALIGNED:
                return FaultType.LOAD_MISALIGNED;
            case RiscVExceptionCode.LOAD_FAULT:
            case RiscVExceptionCode.LOAD_PAGE_FAULT:
                return FaultType.LOAD_FAULT;
            case RiscVExceptionCode.STORE_MISALIGNED:
                return FaultType.STORE_MISALIGNED;
            case RiscVExceptionCode.STORE_FAULT:
            case RiscVExceptionCode.STORE_PAGE_FAULT:
                return FaultType.STORE_FAULT;
            case RiscVExceptionCode.ECALL_U:
            case RiscVExceptionCode.ECALL_S:
            case RiscVExceptionCode.ECALL_M:
                return FaultType.ECALL;
            default:
                return FaultType.UNKNOWN;
        }
    }

    /**
     * Analyze fault cause for RISC-V
     */
    analyzeFaultCause(faultType: FaultType, registers: Map<string, number>): string[] {
        const causes: string[] = [];
        const mtval = registers.get('MTVAL') || 0;
        const mepc = registers.get('MEPC') || 0;
        const mcause = registers.get('MCAUSE') || 0;

        const xlen = this.architecture === Architecture.RISCV64 ? 64 : 32;
        const code = mcause & ((1 << (xlen - 1)) - 1);

        switch (faultType) {
            case FaultType.INSTRUCTION_MISALIGNED:
                causes.push(`Instruction address misaligned at PC = 0x${mepc.toString(16).toUpperCase()}`);
                causes.push('RISC-V requires instructions to be 2-byte or 4-byte aligned');
                causes.push('Check for corrupted function pointers or incorrect jumps');
                break;

            case FaultType.INSTRUCTION_FAULT:
                if ((code as RiscVExceptionCode) === RiscVExceptionCode.INSTRUCTION_PAGE_FAULT) {
                    causes.push(`Instruction page fault at address: 0x${mtval.toString(16).toUpperCase()}`);
                    causes.push('Virtual memory page not mapped or invalid PTE');
                } else {
                    causes.push(`Instruction access fault at address: 0x${mtval.toString(16).toUpperCase()}`);
                    causes.push('Invalid instruction fetch address or protected memory region');
                }
                break;

            case FaultType.ILLEGAL_INSTRUCTION:
                causes.push(`Illegal instruction at PC = 0x${mepc.toString(16).toUpperCase()}`);
                causes.push(`Bad instruction encoding: 0x${mtval.toString(16).toUpperCase()}`);
                causes.push('Possible causes: unsupported extension, corrupted code, or invalid opcode');
                break;

            case FaultType.LOAD_MISALIGNED:
                causes.push(`Load address misaligned: 0x${mtval.toString(16).toUpperCase()}`);
                causes.push('Check data structure alignment (must match access width)');
                causes.push('For word access (4-byte), address must be 4-byte aligned');
                break;

            case FaultType.LOAD_FAULT:
                if ((code as RiscVExceptionCode) === RiscVExceptionCode.LOAD_PAGE_FAULT) {
                    causes.push(`Load page fault at address: 0x${mtval.toString(16).toUpperCase()}`);
                    causes.push('Virtual memory page not mapped');
                } else {
                    causes.push(`Load access fault at address: 0x${mtval.toString(16).toUpperCase()}`);
                    causes.push('Invalid memory read address or protected region');
                }
                causes.push('Check for NULL pointer dereference or out-of-bounds array access');
                break;

            case FaultType.STORE_MISALIGNED:
                causes.push(`Store address misaligned: 0x${mtval.toString(16).toUpperCase()}`);
                causes.push('Check data structure alignment for write operations');
                break;

            case FaultType.STORE_FAULT:
                if ((code as RiscVExceptionCode) === RiscVExceptionCode.STORE_PAGE_FAULT) {
                    causes.push(`Store page fault at address: 0x${mtval.toString(16).toUpperCase()}`);
                    causes.push('Virtual memory page not mapped or read-only');
                } else {
                    causes.push(`Store access fault at address: 0x${mtval.toString(16).toUpperCase()}`);
                    causes.push('Invalid memory write address or write-protected region');
                }
                causes.push('Check for writes to ROM or read-only memory');
                break;

            case FaultType.ECALL: {
                const privilege = this.getPrivilegeLevel(mcause);
                causes.push(`Environment call from ${privilege} mode at PC = 0x${mepc.toString(16).toUpperCase()}`);
                causes.push('This is usually intentional (system call), not an error');
                break;
            }

            case FaultType.BREAKPOINT:
                causes.push(`Breakpoint exception at PC = 0x${mepc.toString(16).toUpperCase()}`);
                causes.push('EBREAK instruction encountered or hardware breakpoint triggered');
                break;

            default:
                causes.push(`Unknown exception code: ${code}`);
                causes.push(`MCAUSE = 0x${mcause.toString(16).toUpperCase()}`);
                break;
        }

        return causes;
    }

    /**
     * Get fault address from RISC-V mtval register
     */
    getFaultAddress(faultType: FaultType, registers: Map<string, number>): number | undefined {
        // RISC-V uses mtval (Machine Trap Value) to store fault address
        const mtval = registers.get('MTVAL');

        // mtval contains meaningful address for most faults
        if (mtval !== undefined && mtval !== 0) {
            return mtval;
        }

        return undefined;
    }

    /**
     * Get toolchain prefix
     */
    getToolchainPrefix(): string {
        return this.toolchainPrefix;
    }

    /**
     * Generate recommendations for RISC-V faults
     */
    generateRecommendation(faultType: FaultType, causes: string[]): string {
        const recommendations: string[] = [];

        switch (faultType) {
            case FaultType.INSTRUCTION_MISALIGNED:
            case FaultType.LOAD_MISALIGNED:
            case FaultType.STORE_MISALIGNED:
                recommendations.push('Ensure data structures are properly aligned using __attribute__((aligned(N)))');
                recommendations.push('Check for pointer arithmetic errors that might cause misalignment');
                break;

            case FaultType.INSTRUCTION_FAULT:
            case FaultType.LOAD_FAULT:
            case FaultType.STORE_FAULT:
                recommendations.push('Verify pointer initialization - check for NULL or uninitialized pointers');
                recommendations.push('Review array bounds - ensure indexes are within valid range');
                recommendations.push('Check memory map configuration - ensure address is valid for your system');
                break;

            case FaultType.ILLEGAL_INSTRUCTION:
                recommendations.push('Verify RISC-V extensions match your target (check MISA CSR)');
                recommendations.push('Check for code corruption - verify flash programming was successful');
                recommendations.push('Review compiler flags - ensure correct -march and -mabi settings');
                break;

            case FaultType.PAGE_FAULT:
                recommendations.push('Check virtual memory configuration and page table entries');
                recommendations.push('Ensure memory region is mapped with correct permissions');
                break;

            default:
                recommendations.push('Review the fault cause details and check the call stack');
                recommendations.push('Consult RISC-V Privileged Specification for exception details');
                break;
        }

        return recommendations.join('\n');
    }

    /**
     * Read a RISC-V register/CSR
     */
    private async readRegister(name: string): Promise<number> {
        try {
            // Method 1: Try DAP evaluate request (works with some debuggers)
            const result = await this.session.customRequest('evaluate', {
                expression: `$${name}`,
                context: 'watch'
            });

            if (result && result.result) {
                return this.parseNumber(result.result);
            }
        } catch (error) {
            // Fall through to method 2
        }

        // Method 2: Try custom GDB command
        try {
            const result = await this.session.customRequest('evaluate', {
                expression: `-exec info registers ${name}`,
                context: 'repl'
            });

            if (result && result.result) {
                // Parse GDB output: "mcause  0x2  2"
                const match = result.result.match(/0x([0-9a-fA-F]+)/);
                if (match) {
                    return parseInt(match[1], 16);
                }
            }
        } catch (error) {
            // Fall through
        }

        // Method 3: Return 0 if unavailable (non-critical)
        return 0;
    }

    /**
     * Parse number from string (hex or decimal)
     */
    private parseNumber(str: string): number {
        str = str.trim();
        if (str.startsWith('0x') || str.startsWith('0X')) {
            return parseInt(str.substring(2), 16);
        }
        return parseInt(str, 10);
    }

    /**
     * Get privilege level from exception code
     */
    private getPrivilegeLevel(mcause: number): string {
        const xlen = this.architecture === Architecture.RISCV64 ? 64 : 32;
        const code = mcause & ((1 << (xlen - 1)) - 1);

        switch (code as RiscVExceptionCode) {
            case RiscVExceptionCode.ECALL_U:
                return 'User';
            case RiscVExceptionCode.ECALL_S:
                return 'Supervisor';
            case RiscVExceptionCode.ECALL_M:
                return 'Machine';
            default:
                return 'Unknown';
        }
    }
}
