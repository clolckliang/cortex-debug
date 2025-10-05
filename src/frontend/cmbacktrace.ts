/**
 * CmBacktrace - Multi-Architecture Backtrace Analyzer
 *
 * Automatically analyzes and diagnoses faults for multiple architectures:
 *
 * ARM Cortex-M:
 * - Hard Fault, Memory Management Fault, Bus Fault, Usage Fault, Debug Fault
 *
 * RISC-V (RV32/RV64):
 * - Instruction/Load/Store Misaligned, Access Faults, Illegal Instruction
 * - Environment Call, Page Fault, Breakpoint
 *
 * Features:
 * - Automatic fault cause diagnosis
 * - Function call stack extraction
 * - Precise code location with addr2line
 * - Fault register analysis
 * - Multi-architecture support with automatic detection
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import {
    Architecture,
    FaultType,
    FaultAnalysis,
    CallStackFrame,
    IArchitectureBacktrace,
    ArchitectureFactory
} from './architecture-backtrace';

// Re-export types for backward compatibility
export { FaultType, FaultAnalysis, CallStackFrame, Architecture };

export class CmBacktraceAnalyzer {
    private session: vscode.DebugSession | undefined;
    private elfPath: string | undefined;
    private backtrace: IArchitectureBacktrace | undefined;

    public async setSession(session: vscode.DebugSession | undefined): Promise<void> {
        this.session = session;
        if (session?.configuration?.executable) {
            this.elfPath = session.configuration.executable;
        }

        // Create architecture-specific backtrace implementation
        if (session) {
            try {
                this.backtrace = await ArchitectureFactory.create(session);
            } catch (error) {
                console.error('Failed to create backtrace implementation:', error);
                this.backtrace = undefined;
            }
        } else {
            this.backtrace = undefined;
        }
    }

    /**
     * Main entry point for fault analysis
     */
    public async analyzeFault(): Promise<FaultAnalysis | null> {
        if (!this.session) {
            vscode.window.showErrorMessage('No active debug session');
            return null;
        }

        if (!this.backtrace) {
            vscode.window.showErrorMessage('Architecture not supported or not detected');
            return null;
        }

        try {
            // Read fault registers (architecture-specific)
            const registers = await this.backtrace.readFaultRegisters();

            // Determine fault type
            const faultType = this.backtrace.determineFaultType(registers);

            if (faultType === FaultType.NONE) {
                vscode.window.showInformationMessage('No fault detected');
                return null;
            }

            // Analyze fault cause
            const faultCause = this.backtrace.analyzeFaultCause(faultType, registers);

            // Get fault address if available
            const faultAddress = this.backtrace.getFaultAddress(faultType, registers);

            // Extract call stack
            const callStack = await this.extractCallStack();

            // Resolve symbols using architecture-specific toolchain
            await this.resolveSymbols(callStack, this.backtrace.getToolchainPrefix());

            // Generate recommendation
            const recommendation = this.backtrace.generateRecommendation(faultType, faultCause);

            return {
                faultType,
                faultCause,
                faultAddress,
                registers,
                callStack,
                recommendation,
                architecture: this.backtrace.getArchitecture()
            };
        } catch (error) {
            vscode.window.showErrorMessage(`Fault analysis failed: ${error}`);
            return null;
        }
    }

    /**
     * Extract call stack from current context
     */
    private async extractCallStack(): Promise<CallStackFrame[]> {
        if (!this.session) {
            return [];
        }

        try {
            // Get current stack trace from debug adapter
            const stackTraceResponse = await this.session.customRequest('stackTrace', {
                threadId: 1,
                startFrame: 0,
                levels: 20
            });

            if (!stackTraceResponse || !stackTraceResponse.stackFrames) {
                return [];
            }

            const frames: CallStackFrame[] = [];
            for (const frame of stackTraceResponse.stackFrames) {
                frames.push({
                    pc: frame.instructionPointerReference ?
                        parseInt(frame.instructionPointerReference, 16) : 0,
                    lr: 0,  // Will be filled by register reading if needed
                    function: frame.name,
                    file: frame.source?.path,
                    line: frame.line
                });
            }

            return frames;
        } catch (error) {
            console.error('Failed to extract call stack:', error);
            return [];
        }
    }

    /**
     * Resolve symbols using addr2line
     */
    private async resolveSymbols(callStack: CallStackFrame[], toolchainPrefix: string): Promise<void> {
        if (!this.elfPath) {
            return;
        }

        for (const frame of callStack) {
            if (!frame.file || !frame.line) {
                try {
                    const result = await this.addr2line(frame.pc, toolchainPrefix);
                    if (result) {
                        frame.file = result.file;
                        frame.line = result.line;
                        frame.function = result.function || frame.function;
                    }
                } catch (error) {
                    console.error(`addr2line failed for PC 0x${frame.pc.toString(16)}:`, error);
                }
            }
        }
    }

    /**
     * Use addr2line to resolve address to file/line
     */
    private addr2line(address: number, toolchainPrefix: string): Promise<{file: string; line: number; function?: string} | null> {
        return new Promise((resolve, reject) => {
            if (!this.elfPath) {
                resolve(null);
                return;
            }

            const addr2lineCmd = toolchainPrefix + 'addr2line';
            const args = ['-e', this.elfPath, '-f', '-C', '0x' + address.toString(16)];

            const proc = spawn(addr2lineCmd, args);
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`addr2line failed: ${stderr}`));
                    return;
                }

                const lines = stdout.trim().split('\n');
                if (lines.length >= 2) {
                    const functionName = lines[0].trim();
                    const location = lines[1].trim();
                    const match = location.match(/(.+):(\d+)/);

                    if (match) {
                        resolve({
                            function: functionName !== '??' ? functionName : undefined,
                            file: match[1],
                            line: parseInt(match[2], 10)
                        });
                        return;
                    }
                }

                resolve(null);
            });
        });
    }

    /**
     * Analyze fault on demand (can be called anytime, not just on fault)
     */
    public async getCurrentCallStack(): Promise<CallStackFrame[]> {
        if (!this.backtrace) {
            return [];
        }

        const callStack = await this.extractCallStack();
        await this.resolveSymbols(callStack, this.backtrace.getToolchainPrefix());
        return callStack;
    }
}
