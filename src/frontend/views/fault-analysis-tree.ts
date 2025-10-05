/**
 * Fault Analysis TreeView Provider
 * Displays multi-architecture fault analysis in VS Code's native tree view
 * Supports: ARM Cortex-M and RISC-V (RV32/RV64)
 */

import { TreeItem, TreeDataProvider, EventEmitter, Event, TreeItemCollapsibleState } from 'vscode';
import * as vscode from 'vscode';
import { FaultAnalysis, FaultType, CallStackFrame, Architecture } from '../cmbacktrace';
import { BaseNode } from './nodes/basenode';

/**
 * Node types for different fault analysis elements
 */
enum FaultNodeType {
    ROOT = 'root',
    CAUSES = 'causes',
    CAUSE_ITEM = 'cause_item',
    ADDRESS = 'address',
    REGISTERS = 'registers',
    REGISTER_ITEM = 'register_item',
    CALLSTACK = 'callstack',
    STACK_FRAME = 'stack_frame',
    RECOMMENDATIONS = 'recommendations',
    RECOMMENDATION_ITEM = 'recommendation_item',
    NO_FAULT = 'no_fault'
}

/**
 * Fault Analysis Tree Node
 */
export class FaultAnalysisNode extends BaseNode {
    protected children: FaultAnalysisNode[] | undefined;

    constructor(
        parent: FaultAnalysisNode | undefined,
        private nodeType: FaultNodeType,
        private label: string,
        private value: string = '',
        private description: string = '',
        private collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
        private iconId: string = '',
        private tooltip?: string,
        private command?: vscode.Command,
        public contextValue?: string
    ) {
        super(parent);
    }

    public getTreeItem(): TreeItem {
        const item = new TreeItem(this.label, this.collapsibleState);

        item.description = this.description;
        item.tooltip = this.tooltip || this.label;
        item.contextValue = this.contextValue || this.nodeType;

        if (this.iconId) {
            item.iconPath = new vscode.ThemeIcon(this.iconId);
        }

        if (this.command) {
            item.command = this.command;
        }

        return item;
    }

    public getChildren(): FaultAnalysisNode[] {
        return this.children || [];
    }

    public getCopyValue(): string | undefined {
        return this.value || this.label;
    }

    public addChild(node: FaultAnalysisNode): void {
        if (!this.children) {
            this.children = [];
        }
        this.children.push(node);
    }

    public getNodeType(): FaultNodeType {
        return this.nodeType;
    }

    public getValue(): string {
        return this.value;
    }
}

/**
 * Fault Analysis Tree Data Provider
 */
export class FaultAnalysisTreeProvider implements TreeDataProvider<FaultAnalysisNode> {
    private _onDidChangeTreeData: EventEmitter<FaultAnalysisNode | undefined> = new EventEmitter<FaultAnalysisNode | undefined>();
    public readonly onDidChangeTreeData: Event<FaultAnalysisNode | undefined> = this._onDidChangeTreeData.event;

    private rootNode: FaultAnalysisNode;
    private currentAnalysis: FaultAnalysis | null = null;

    constructor(private context: vscode.ExtensionContext) {
        this.rootNode = this.createNoFaultNode();
    }

    /**
     * Update the tree with new fault analysis
     */
    public updateAnalysis(analysis: FaultAnalysis | null): void {
        this.currentAnalysis = analysis;

        if (!analysis) {
            this.rootNode = this.createNoFaultNode();
            vscode.commands.executeCommand('setContext', 'cortex-debug:hasFault', false);
        } else {
            this.rootNode = this.buildTreeFromAnalysis(analysis);
            vscode.commands.executeCommand('setContext', 'cortex-debug:hasFault', true);
        }

        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Clear the fault analysis
     */
    public clear(): void {
        this.updateAnalysis(null);
    }

    /**
     * Get current analysis
     */
    public getAnalysis(): FaultAnalysis | null {
        return this.currentAnalysis;
    }

    public getTreeItem(element: FaultAnalysisNode): TreeItem {
        return element.getTreeItem();
    }

    public getChildren(element?: FaultAnalysisNode): FaultAnalysisNode[] {
        if (!element) {
            return this.rootNode ? [this.rootNode] : [];
        }
        return element.getChildren();
    }

    /**
     * Create a "No Fault" placeholder node
     */
    private createNoFaultNode(): FaultAnalysisNode {
        return new FaultAnalysisNode(
            undefined,
            FaultNodeType.NO_FAULT,
            'No fault detected',
            '',
            '',
            TreeItemCollapsibleState.None,
            'info',
            'Run fault analysis when debugger stops on a fault'
        );
    }

    /**
     * Build tree structure from fault analysis
     */
    private buildTreeFromAnalysis(analysis: FaultAnalysis): FaultAnalysisNode {
        const rootIcon = this.getFaultIcon(analysis.faultType);
        const archLabel = analysis.architecture ? ` [${analysis.architecture.toUpperCase()}]` : '';
        const root = new FaultAnalysisNode(
            undefined,
            FaultNodeType.ROOT,
            analysis.faultType + archLabel,
            '',
            '',
            TreeItemCollapsibleState.Expanded,
            rootIcon,
            `Fault Type: ${analysis.faultType} (Architecture: ${analysis.architecture || 'Unknown'})`,
            undefined,
            'faultRoot'
        );

        // Add fault causes section
        if (analysis.faultCause && analysis.faultCause.length > 0) {
            const causesNode = new FaultAnalysisNode(
                root,
                FaultNodeType.CAUSES,
                'Fault Causes',
                '',
                `${analysis.faultCause.length} issue(s)`,
                TreeItemCollapsibleState.Expanded,
                'warning',
                'Detected fault causes'
            );
            root.addChild(causesNode);

            for (const cause of analysis.faultCause) {
                const causeItem = new FaultAnalysisNode(
                    causesNode,
                    FaultNodeType.CAUSE_ITEM,
                    cause,
                    '',
                    '',
                    TreeItemCollapsibleState.None,
                    'alert',
                    cause
                );
                causesNode.addChild(causeItem);
            }
        }

        // Add fault address
        if (analysis.faultAddress !== undefined) {
            const addressNode = new FaultAnalysisNode(
                root,
                FaultNodeType.ADDRESS,
                'Fault Address',
                `0x${analysis.faultAddress.toString(16).toUpperCase().padStart(8, '0')}`,
                `0x${analysis.faultAddress.toString(16).toUpperCase().padStart(8, '0')}`,
                TreeItemCollapsibleState.None,
                'location',
                `Memory address where fault occurred: 0x${analysis.faultAddress.toString(16).toUpperCase()}`
            );
            root.addChild(addressNode);
        }

        // Add registers section
        if (analysis.registers && analysis.registers.size > 0) {
            const registersNode = new FaultAnalysisNode(
                root,
                FaultNodeType.REGISTERS,
                'Fault Registers',
                '',
                `${analysis.registers.size} register(s)`,
                TreeItemCollapsibleState.Collapsed,
                'symbol-variable',
                'ARM Cortex-M fault status registers'
            );
            root.addChild(registersNode);

            const importantRegs = ['CFSR', 'HFSR', 'MMFSR', 'BFSR', 'UFSR', 'DFSR', 'MMFAR', 'BFAR', 'AFSR'];
            for (const regName of importantRegs) {
                const value = analysis.registers.get(regName);
                if (value !== undefined && value !== 0) {
                    const regItem = new FaultAnalysisNode(
                        registersNode,
                        FaultNodeType.REGISTER_ITEM,
                        regName,
                        `0x${value.toString(16).toUpperCase().padStart(8, '0')}`,
                        `0x${value.toString(16).toUpperCase().padStart(8, '0')}`,
                        TreeItemCollapsibleState.None,
                        'symbol-numeric',
                        `${regName} = 0x${value.toString(16).toUpperCase()}`
                    );
                    registersNode.addChild(regItem);
                }
            }
        }

        // Add call stack section
        if (analysis.callStack && analysis.callStack.length > 0) {
            const callstackNode = new FaultAnalysisNode(
                root,
                FaultNodeType.CALLSTACK,
                'Call Stack',
                '',
                `${analysis.callStack.length} frame(s)`,
                TreeItemCollapsibleState.Expanded,
                'debug-stackframe',
                'Function call stack at the time of fault'
            );
            root.addChild(callstackNode);

            for (let i = 0; i < analysis.callStack.length; i++) {
                const frame = analysis.callStack[i];
                const frameLabel = `#${i} ${frame.function || '??'}`;
                const frameDesc = `0x${frame.pc.toString(16).toUpperCase().padStart(8, '0')}`;

                let frameTooltip = `PC: 0x${frame.pc.toString(16).toUpperCase()}`;
                if (frame.file && frame.line) {
                    frameTooltip += `\n${frame.file}:${frame.line}`;
                }

                // Command to jump to source
                let frameCommand: vscode.Command | undefined;
                if (frame.file && frame.line) {
                    frameCommand = {
                        command: 'cortex-debug.faultAnalysis.jumpToSource',
                        title: 'Jump to Source',
                        arguments: [frame.file, frame.line]
                    };
                }

                const frameNode = new FaultAnalysisNode(
                    callstackNode,
                    FaultNodeType.STACK_FRAME,
                    frameLabel,
                    '',
                    frameDesc,
                    TreeItemCollapsibleState.None,
                    'debug-stackframe-dot',
                    frameTooltip,
                    frameCommand,
                    'stackFrame'
                );

                callstackNode.addChild(frameNode);
            }
        }

        // Add recommendations section
        if (analysis.recommendation) {
            const recommendationsNode = new FaultAnalysisNode(
                root,
                FaultNodeType.RECOMMENDATIONS,
                'Recommendations',
                '',
                '',
                TreeItemCollapsibleState.Expanded,
                'lightbulb',
                'Suggestions to fix the fault'
            );
            root.addChild(recommendationsNode);

            const recommendations = analysis.recommendation.split('\n').filter(r => r.trim());
            for (const rec of recommendations) {
                const recItem = new FaultAnalysisNode(
                    recommendationsNode,
                    FaultNodeType.RECOMMENDATION_ITEM,
                    rec.trim(),
                    '',
                    '',
                    TreeItemCollapsibleState.None,
                    'lightbulb-autofix',
                    rec
                );
                recommendationsNode.addChild(recItem);
            }
        }

        return root;
    }

    /**
     * Get appropriate icon for fault type
     */
    private getFaultIcon(faultType: FaultType): string {
        switch (faultType) {
            // ARM Cortex-M faults
            case FaultType.HARD_FAULT:
                return 'error';
            case FaultType.MEM_MANAGE_FAULT:
                return 'symbol-variable';
            case FaultType.BUS_FAULT:
                return 'debug-disconnect';
            case FaultType.USAGE_FAULT:
                return 'warning';
            case FaultType.DEBUG_FAULT:
                return 'debug';

            // RISC-V alignment faults
            case FaultType.INSTRUCTION_MISALIGNED:
            case FaultType.LOAD_MISALIGNED:
            case FaultType.STORE_MISALIGNED:
                return 'symbol-ruler';

            // RISC-V access faults
            case FaultType.INSTRUCTION_FAULT:
            case FaultType.LOAD_FAULT:
            case FaultType.STORE_FAULT:
                return 'debug-disconnect';

            // RISC-V illegal instruction
            case FaultType.ILLEGAL_INSTRUCTION:
                return 'error';

            // RISC-V page fault
            case FaultType.PAGE_FAULT:
                return 'file-code';

            // RISC-V environment call
            case FaultType.ECALL:
                return 'symbol-method';

            // Common faults
            case FaultType.BREAKPOINT:
                return 'debug-breakpoint';

            case FaultType.UNKNOWN:
                return 'question';

            default:
                return 'bug';
        }
    }
}
