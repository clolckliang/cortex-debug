/**
 * ARM Cortex-M Backtrace Implementation
 * Extracted from original cmbacktrace.ts for architecture abstraction
 */

import * as vscode from 'vscode';
import {
    Architecture,
    FaultType,
    IArchitectureBacktrace
} from './architecture-backtrace';

/**
 * Cortex-M System Control Block (SCB) Registers
 */
const SCB_REGISTERS = {
    // Configurable Fault Status Register
    CFSR: 0xE000ED28,
    CFSR_MMFSR: 0xE000ED28,  // MemManage Fault Status Register (byte 0)
    CFSR_BFSR: 0xE000ED29,   // Bus Fault Status Register (byte 1)
    CFSR_UFSR: 0xE000ED2A,   // Usage Fault Status Register (bytes 2-3)

    // Hard Fault Status Register
    HFSR: 0xE000ED2C,

    // Debug Fault Status Register
    DFSR: 0xE000ED30,

    // MemManage Fault Address Register
    MMFAR: 0xE000ED34,

    // Bus Fault Address Register
    BFAR: 0xE000ED38,

    // Auxiliary Fault Status Register
    AFSR: 0xE000ED3C
};

/**
 * ARM Cortex-M Backtrace Analyzer
 */
export class CortexMBacktrace implements IArchitectureBacktrace {
    private session: vscode.DebugSession;
    private toolchainPrefix: string;

    constructor(session: vscode.DebugSession) {
        this.session = session;
        this.toolchainPrefix = session.configuration.toolchainPrefix || 'arm-none-eabi-';
    }

    getArchitecture(): Architecture {
        return Architecture.CORTEX_M;
    }

    /**
     * Read Cortex-M fault status registers
     */
    async readFaultRegisters(): Promise<Map<string, number>> {
        const registers = new Map<string, number>();

        try {
            // Read CFSR (Configurable Fault Status Register)
            const cfsr = await this.readMemory32(SCB_REGISTERS.CFSR);
            registers.set('CFSR', cfsr);
            registers.set('MMFSR', cfsr & 0xFF);
            registers.set('BFSR', (cfsr >> 8) & 0xFF);
            registers.set('UFSR', (cfsr >> 16) & 0xFFFF);

            // Read HFSR (Hard Fault Status Register)
            const hfsr = await this.readMemory32(SCB_REGISTERS.HFSR);
            registers.set('HFSR', hfsr);

            // Read DFSR (Debug Fault Status Register)
            const dfsr = await this.readMemory32(SCB_REGISTERS.DFSR);
            registers.set('DFSR', dfsr);

            // Read MMFAR (MemManage Fault Address Register)
            const mmfar = await this.readMemory32(SCB_REGISTERS.MMFAR);
            registers.set('MMFAR', mmfar);

            // Read BFAR (Bus Fault Address Register)
            const bfar = await this.readMemory32(SCB_REGISTERS.BFAR);
            registers.set('BFAR', bfar);

            // Read AFSR (Auxiliary Fault Status Register)
            const afsr = await this.readMemory32(SCB_REGISTERS.AFSR);
            registers.set('AFSR', afsr);
        } catch (error) {
            throw new Error(`Failed to read fault registers: ${error}`);
        }

        return registers;
    }

    /**
     * Determine fault type from register values
     */
    determineFaultType(registers: Map<string, number>): FaultType {
        const hfsr = registers.get('HFSR') || 0;
        const mmfsr = registers.get('MMFSR') || 0;
        const bfsr = registers.get('BFSR') || 0;
        const ufsr = registers.get('UFSR') || 0;
        const dfsr = registers.get('DFSR') || 0;

        // Check Debug Fault
        if (dfsr !== 0) {
            return FaultType.DEBUG_FAULT;
        }

        // Check Hard Fault
        if (hfsr & (1 << 30)) {  // FORCED bit
            // Hard fault caused by escalation from configurable fault
            if (mmfsr !== 0) {
                return FaultType.MEM_MANAGE_FAULT;
            }
            if (bfsr !== 0) {
                return FaultType.BUS_FAULT;
            }
            if (ufsr !== 0) {
                return FaultType.USAGE_FAULT;
            }
        }

        if (hfsr & (1 << 1)) {  // VECTTBL bit
            return FaultType.HARD_FAULT;
        }

        // Check configurable faults
        if (mmfsr !== 0) {
            return FaultType.MEM_MANAGE_FAULT;
        }
        if (bfsr !== 0) {
            return FaultType.BUS_FAULT;
        }
        if (ufsr !== 0) {
            return FaultType.USAGE_FAULT;
        }

        return FaultType.NONE;
    }

    /**
     * Analyze fault cause based on fault type and register values
     */
    analyzeFaultCause(faultType: FaultType, registers: Map<string, number>): string[] {
        const causes: string[] = [];

        switch (faultType) {
            case FaultType.MEM_MANAGE_FAULT:
                causes.push(...this.analyzeMemManageFault(registers));
                break;
            case FaultType.BUS_FAULT:
                causes.push(...this.analyzeBusFault(registers));
                break;
            case FaultType.USAGE_FAULT:
                causes.push(...this.analyzeUsageFault(registers));
                break;
            case FaultType.HARD_FAULT:
                causes.push(...this.analyzeHardFault(registers));
                break;
            case FaultType.DEBUG_FAULT:
                causes.push(...this.analyzeDebugFault(registers));
                break;
        }

        return causes;
    }

    /**
     * Get fault address if available
     */
    getFaultAddress(faultType: FaultType, registers: Map<string, number>): number | undefined {
        const mmfsr = registers.get('MMFSR') || 0;
        const bfsr = registers.get('BFSR') || 0;

        if (faultType === FaultType.MEM_MANAGE_FAULT && (mmfsr & (1 << 7))) {
            return registers.get('MMFAR');
        }

        if (faultType === FaultType.BUS_FAULT && (bfsr & (1 << 7))) {
            return registers.get('BFAR');
        }

        return undefined;
    }

    getToolchainPrefix(): string {
        return this.toolchainPrefix;
    }

    /**
     * Generate recommendation based on fault analysis
     */
    generateRecommendation(faultType: FaultType, causes: string[]): string {
        const recommendations: string[] = [];

        if (causes.some(c => c.includes('Stack') || c.includes('stacking'))) {
            recommendations.push('Check for stack overflow - increase stack size or reduce local variable usage');
        }

        if (causes.some(c => c.includes('pointer') || c.includes('address'))) {
            recommendations.push('Verify pointer initialization and bounds checking');
        }

        if (causes.some(c => c.includes('Divide by zero'))) {
            recommendations.push('Add division by zero checks before arithmetic operations');
        }

        if (causes.some(c => c.includes('Unaligned'))) {
            recommendations.push('Ensure data structures are properly aligned or disable strict alignment checking');
        }

        if (causes.some(c => c.includes('Undefined instruction'))) {
            recommendations.push('Check for code corruption, invalid function pointers, or compiler optimization issues');
        }

        if (recommendations.length === 0) {
            recommendations.push('Review the fault cause details and check the function call stack for the error location');
        }

        return recommendations.join('\n');
    }

    // Private helper methods (same as original implementation)

    private async readMemory32(address: number): Promise<number> {
        const result = await this.session.customRequest('readMemory', {
            memoryReference: '0x' + address.toString(16),
            count: 4
        });

        if (result && result.data) {
            const buffer = Buffer.from(result.data, 'base64');
            return buffer.readUInt32LE(0);
        }

        return 0;
    }

    private analyzeMemManageFault(registers: Map<string, number>): string[] {
        const mmfsr = registers.get('MMFSR') || 0;
        const causes: string[] = [];

        if (mmfsr & (1 << 0)) {
            causes.push('Instruction access violation - Attempted to execute code from a protected region');
        }
        if (mmfsr & (1 << 1)) {
            causes.push('Data access violation - Attempted to read/write protected memory');
        }
        if (mmfsr & (1 << 3)) {
            causes.push('MemManage fault during exception stacking - Stack overflow or stack pointer corruption');
        }
        if (mmfsr & (1 << 4)) {
            causes.push('MemManage fault during exception unstacking - Stack corruption');
        }
        if (mmfsr & (1 << 5)) {
            causes.push('MemManage fault during FP lazy state preservation');
        }
        if (mmfsr & (1 << 7)) {
            const mmfar = registers.get('MMFAR') || 0;
            causes.push(`MMFAR valid: Fault address = 0x${mmfar.toString(16).toUpperCase()}`);
        }

        return causes;
    }

    private analyzeBusFault(registers: Map<string, number>): string[] {
        const bfsr = registers.get('BFSR') || 0;
        const causes: string[] = [];

        if (bfsr & (1 << 0)) {
            causes.push('Instruction bus error - Failed to fetch instruction (bad function pointer?)');
        }
        if (bfsr & (1 << 1)) {
            causes.push('Precise data bus error - Invalid memory address accessed');
        }
        if (bfsr & (1 << 2)) {
            causes.push('Imprecise data bus error - Check recent memory operations');
        }
        if (bfsr & (1 << 3)) {
            causes.push('BusFault during exception stacking - Stack pointer corruption');
        }
        if (bfsr & (1 << 4)) {
            causes.push('BusFault during exception unstacking - Stack corruption');
        }
        if (bfsr & (1 << 5)) {
            causes.push('BusFault during FP lazy state preservation');
        }
        if (bfsr & (1 << 7)) {
            const bfar = registers.get('BFAR') || 0;
            causes.push(`BFAR valid: Fault address = 0x${bfar.toString(16).toUpperCase()}`);
        }

        return causes;
    }

    private analyzeUsageFault(registers: Map<string, number>): string[] {
        const ufsr = registers.get('UFSR') || 0;
        const causes: string[] = [];

        if (ufsr & (1 << 0)) {
            causes.push('Undefined instruction executed - Corrupted code or bad function pointer');
        }
        if (ufsr & (1 << 1)) {
            causes.push('Invalid state - Attempted to switch to ARM state (Thumb bit not set)');
        }
        if (ufsr & (1 << 2)) {
            causes.push('Invalid PC load - Exception return with bad PC value');
        }
        if (ufsr & (1 << 3)) {
            causes.push('No coprocessor - Attempted to execute coprocessor instruction');
        }
        if (ufsr & (1 << 8)) {
            causes.push('Unaligned access - Unaligned memory access with strict alignment checking enabled');
        }
        if (ufsr & (1 << 9)) {
            causes.push('Divide by zero');
        }

        return causes;
    }

    private analyzeHardFault(registers: Map<string, number>): string[] {
        const hfsr = registers.get('HFSR') || 0;
        const causes: string[] = [];

        if (hfsr & (1 << 1)) {
            causes.push('Vector table read error - Corrupted vector table');
        }
        if (hfsr & (1 << 30)) {
            causes.push('Forced Hard Fault - Escalated from configurable fault (check CFSR)');
        }
        if (hfsr & (1 << 31)) {
            causes.push('Debug event occurred while debug is disabled');
        }

        return causes;
    }

    private analyzeDebugFault(registers: Map<string, number>): string[] {
        const dfsr = registers.get('DFSR') || 0;
        const causes: string[] = [];

        if (dfsr & (1 << 0)) {
            causes.push('Halt request debug event');
        }
        if (dfsr & (1 << 1)) {
            causes.push('BKPT instruction debug event');
        }
        if (dfsr & (1 << 2)) {
            causes.push('DWT debug event');
        }
        if (dfsr & (1 << 3)) {
            causes.push('Vector catch debug event');
        }
        if (dfsr & (1 << 4)) {
            causes.push('External debug request');
        }

        return causes;
    }
}
