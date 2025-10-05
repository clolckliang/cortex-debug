/**
 * Architecture Abstraction Layer for Fault Analysis
 * Supports multiple architectures: ARM Cortex-M, RISC-V
 */

import * as vscode from 'vscode';

/**
 * Supported architectures
 */
export enum Architecture {
    CORTEX_M = 'cortex-m',
    RISCV32 = 'riscv32',
    RISCV64 = 'riscv64',
    UNKNOWN = 'unknown'
}

/**
 * Fault type enumeration - unified across architectures
 */
export enum FaultType {
    NONE = 'None',

    // ARM Cortex-M specific
    HARD_FAULT = 'Hard Fault',
    MEM_MANAGE_FAULT = 'Memory Management Fault',
    BUS_FAULT = 'Bus Fault',
    USAGE_FAULT = 'Usage Fault',
    DEBUG_FAULT = 'Debug Fault',

    // RISC-V specific
    INSTRUCTION_MISALIGNED = 'Instruction Address Misaligned',
    INSTRUCTION_FAULT = 'Instruction Access Fault',
    ILLEGAL_INSTRUCTION = 'Illegal Instruction',
    LOAD_MISALIGNED = 'Load Address Misaligned',
    LOAD_FAULT = 'Load Access Fault',
    STORE_MISALIGNED = 'Store Address Misaligned',
    STORE_FAULT = 'Store Access Fault',
    ECALL = 'Environment Call',
    PAGE_FAULT = 'Page Fault',

    // Common
    BREAKPOINT = 'Breakpoint',
    UNKNOWN = 'Unknown Fault'
}

/**
 * Fault analysis result
 */
export interface FaultAnalysis {
    faultType: FaultType;
    faultCause: string[];
    faultAddress?: number;
    registers: Map<string, number>;
    callStack: CallStackFrame[];
    recommendation: string;
    architecture: Architecture;
}

/**
 * Call stack frame
 */
export interface CallStackFrame {
    pc: number;
    lr: number;
    function?: string;
    file?: string;
    line?: number;
}

/**
 * Architecture-specific backtrace interface
 */
export interface IArchitectureBacktrace {
    /**
     * Get architecture type
     */
    getArchitecture(): Architecture;

    /**
     * Read fault-related registers
     */
    readFaultRegisters(): Promise<Map<string, number>>;

    /**
     * Determine fault type from registers
     */
    determineFaultType(registers: Map<string, number>): FaultType;

    /**
     * Analyze fault cause
     */
    analyzeFaultCause(faultType: FaultType, registers: Map<string, number>): string[];

    /**
     * Get fault address if available
     */
    getFaultAddress(faultType: FaultType, registers: Map<string, number>): number | undefined;

    /**
     * Get toolchain prefix (e.g., 'arm-none-eabi-', 'riscv32-unknown-elf-')
     */
    getToolchainPrefix(): string;

    /**
     * Generate recommendations based on fault
     */
    generateRecommendation(faultType: FaultType, causes: string[]): string;
}

/**
 * Architecture detection and factory
 */
export class ArchitectureFactory {
    /**
     * Detect architecture from debug session configuration
     */
    static detectArchitecture(session: vscode.DebugSession): Architecture {
        const config = session.configuration;

        // Check for manual architecture override in VS Code settings
        const manualArch = vscode.workspace.getConfiguration('cortex-debug').get<string>('architecture', 'auto');
        if (manualArch && manualArch !== 'auto') {
            switch (manualArch.toLowerCase()) {
                case 'cortex-m':
                    return Architecture.CORTEX_M;
                case 'riscv32':
                    return Architecture.RISCV32;
                case 'riscv64':
                    return Architecture.RISCV64;
            }
        }

        // Check toolchain prefix first
        if (config.toolchainPrefix) {
            const prefix = config.toolchainPrefix.toLowerCase();
            if (prefix.includes('riscv64')) {
                return Architecture.RISCV64;
            }
            if (prefix.includes('riscv') || prefix.includes('rv32')) {
                return Architecture.RISCV32;
            }
            if (prefix.includes('arm-none-eabi')) {
                return Architecture.CORTEX_M;
            }
        }

        // Check device name
        if (config.device) {
            const device = config.device.toLowerCase();
            if (device.includes('cortex-m') || device.includes('stm32') || device.includes('nrf')) {
                return Architecture.CORTEX_M;
            }
            if (device.includes('riscv') || device.includes('rv32') || device.includes('rv64')) {
                return device.includes('rv64') ? Architecture.RISCV64 : Architecture.RISCV32;
            }
        }

        // Check servertype
        if (config.servertype) {
            const servertype = config.servertype.toLowerCase();
            if (servertype.includes('jlink') || servertype.includes('openocd') || servertype.includes('stlink')) {
                // These typically target ARM
                return Architecture.CORTEX_M;
            }
        }

        // Default to Cortex-M (backward compatibility)
        return Architecture.CORTEX_M;
    }

    /**
     * Create appropriate backtrace implementation
     */
    static async create(
        session: vscode.DebugSession,
        architecture?: Architecture
    ): Promise<IArchitectureBacktrace> {
        const arch = architecture || this.detectArchitecture(session);

        const { CortexMBacktrace } = await import('./cortex-m-backtrace');
        const { RiscVBacktrace } = await import('./riscv-backtrace');

        switch (arch) {
            case Architecture.CORTEX_M:
                return new CortexMBacktrace(session);

            case Architecture.RISCV32:
            case Architecture.RISCV64:
                return new RiscVBacktrace(session, arch);

            default:
                throw new Error(`Unsupported architecture: ${arch}`);
        }
    }
}
