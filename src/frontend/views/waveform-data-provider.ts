import * as vscode from 'vscode';
import { LiveWatchTreeProvider, LiveVariableNode } from './live-watch';
import {
    GraphPoint, GraphDataSource, WaveformVariable, DataSourceStats,
    SignalDisplayType, TriggerCondition, SignalStatistics
} from '../../grapher/datasource';
import { FFTAnalyzer, FFTResult, getDataPointsForFFT } from './fft-analyzer';
import { StructParser, ParsedStructure, MemberSelection } from './struct-parser';

export interface WaveformSettings {
    timeSpan: number; // seconds
    refreshRate: number; // Hz
    maxDataPoints: number;
    yAxisMode: 'auto' | 'manual';
    yMin: number | null;
    yMax: number | null;
    showGrid: boolean;
    showLegend: boolean;
    colorScheme: string;
}

export class WaveformDataProvider {
    private variables: Map<string, WaveformVariable> = new Map();
    private dataSource: GraphDataSource;
    private refreshTimer: NodeJS.Timeout | undefined;
    private isRecording = false;
    private startTime = 0;
    private fftAnalyzer: FFTAnalyzer;
    private structParser: StructParser;
    private parsedStructures: Map<string, ParsedStructure> = new Map();
    private memberSelections: Map<string, MemberSelection[]> = new Map();

    // Configuration
    private settings: WaveformSettings = {
        timeSpan: 60,
        refreshRate: 1.0,
        maxDataPoints: 10000,
        yAxisMode: 'auto',
        yMin: null,
        yMax: null,
        showGrid: true,
        showLegend: true,
        colorScheme: 'professional'
    };

    // Color schemes
    private readonly colorSchemes: Record<string, string[]> = {
        professional: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
        colorblind: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
        highContrast: ['#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#8800ff', '#00ff88'],
        soft: ['#5cb3cc', '#f4a582', '#92c5de', '#b4d2b1', '#e6ab02', '#e7298a', '#7570b3', '#66a61e', '#e6ab02', '#a6761d']
    };

    private colorIndex = 0;

    constructor(private liveWatchProvider: LiveWatchTreeProvider) {
        this.dataSource = new GraphDataSource();
        this.fftAnalyzer = new FFTAnalyzer();
        this.structParser = new StructParser();
        this.loadSettings();
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        // Listen for debug session events
        vscode.debug.onDidStartDebugSession(() => {
            this.startRecording();
        });

        vscode.debug.onDidTerminateDebugSession(() => {
            this.stopRecording();
        });

        vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
            if (event.session.type === 'cortex-debug') {
                this.handleDebugEvent(event);
            }
        });

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('cortex-debug.waveform')) {
                this.loadSettings();
            }
        });
    }

    private loadSettings(): void {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        this.settings.timeSpan = config.get('waveformTimeSpan', 60);
        this.settings.refreshRate = config.get('waveformRefreshRate', 1.0);
        this.settings.maxDataPoints = config.get('waveformMaxDataPoints', 10000);
        this.settings.yAxisMode = config.get('waveformYAxisMode', 'auto');
        this.settings.yMin = config.get('waveformYMin', null);
        this.settings.yMax = config.get('waveformYMax', null);
        this.settings.showGrid = config.get('waveformShowGrid', true);
        this.settings.showLegend = config.get('waveformShowLegend', true);
        this.settings.colorScheme = config.get('waveformColorScheme', 'professional');
    }

    private handleDebugEvent(event: vscode.DebugSessionCustomEvent): void {
        // Handle debug-specific events if needed
        console.log('Waveform data provider received debug event:', event.event);
    }

    public addVariable(variable: LiveVariableNode, displayType: SignalDisplayType = 'analog'): boolean {
        const expression = variable.getExpr();
        const name = variable.getName();

        console.log(`[Waveform] Adding variable to waveform: ${name} (${expression})`);

        if (this.variables.has(expression)) {
            vscode.window.showWarningMessage(`Variable '${name}' is already in the waveform`);
            return false;
        }

        const waveformVar: WaveformVariable = {
            id: expression,
            name: name,
            color: this.getNextColor(),
            enabled: true,
            lastValue: undefined,
            unit: '',
            displayType: displayType,
            bitWidth: displayType === 'bit' ? 1 : 8,
            threshold: 0.5,
            trigger: {
                enabled: false,
                type: 'rising'
            }
        };

        this.variables.set(expression, waveformVar);
        console.log(`[Waveform] Variable added, current count: ${this.variables.size}`);
        console.log(`[Waveform] Is recording: ${this.isRecording}`);

        // Start recording if not already started
        if (!this.isRecording) {
            console.log(`[Waveform] Starting recording...`);
            this.startRecording();
        } else {
            this.startDataCollection();
        }

        return true;
    }

    public removeVariable(variableId: string): boolean {
        const removed = this.variables.delete(variableId);
        if (removed && this.variables.size === 0) {
            this.stopDataCollection();
        }
        return removed;
    }

    public getVariables(): WaveformVariable[] {
        return Array.from(this.variables.values());
    }

    public getVariable(variableId: string): WaveformVariable | undefined {
        return this.variables.get(variableId);
    }

    public updateVariableSettings(variableId: string, settings: Partial<WaveformVariable>): void {
        const variable = this.variables.get(variableId);
        if (variable) {
            Object.assign(variable, settings);
        }
    }

    public getSettings(): WaveformSettings {
        return { ...this.settings };
    }

    public updateSettings(newSettings: Partial<WaveformSettings>): void {
        Object.assign(this.settings, newSettings);
        this.restartDataCollection();
    }

    public getColorScheme(): string {
        return this.settings.colorScheme;
    }

    public setColorScheme(scheme: keyof typeof this.colorSchemes): void {
        if (this.colorSchemes[scheme]) {
            this.settings.colorScheme = scheme;
            this.colorIndex = 0;
            // Reassign colors to existing variables
            this.variables.forEach((variable) => {
                variable.color = this.getNextColor();
            });
        }
    }

    private getNextColor(): string {
        const colors = this.colorSchemes[this.settings.colorScheme];
        const color = colors[this.colorIndex % colors.length];
        this.colorIndex++;
        return color;
    }

    public startRecording(): void {
        if (this.isRecording) {
            console.log('[Waveform] Recording already active');
            return;
        }

        console.log('[Waveform] Starting recording...');

        // For manual addition (from addToWaveform), we ignore the auto-start setting
        // and always start recording when variables are added

        this.isRecording = true;
        this.startTime = Date.now();
        console.log(`[Waveform] Recording started at: ${this.startTime}`);

        this.startDataCollection();
    }

    public stopRecording(): void {
        this.isRecording = false;
        this.stopDataCollection();
    }

    private startDataCollection(): void {
        console.log(`[Waveform] startDataCollection called:`);
        console.log(`[Waveform] - Timer exists: ${!!this.refreshTimer}`);
        console.log(`[Waveform] - Variables count: ${this.variables.size}`);
        console.log(`[Waveform] - Is recording: ${this.isRecording}`);
        console.log(`[Waveform] - Refresh rate: ${this.settings.refreshRate} Hz`);

        if (this.refreshTimer) {
            console.log('[Waveform] Data collection already running');
            return;
        }

        if (this.variables.size === 0) {
            console.log('[Waveform] No variables to collect');
            return;
        }

        if (!this.isRecording) {
            console.log('[Waveform] Not recording, starting collection anyway (manual override)');
            // Allow collection even if not officially "recording" when manually added
        }

        const intervalMs = 1000 / this.settings.refreshRate;
        console.log(`[Waveform] Starting data collection with interval: ${intervalMs}ms`);

        this.refreshTimer = setInterval(() => {
            this.collectData();
        }, intervalMs);

        // Also collect data immediately
        this.collectData();
    }

    private stopDataCollection(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private restartDataCollection(): void {
        this.stopDataCollection();
        if (this.isRecording && this.variables.size > 0) {
            this.startDataCollection();
        }
    }

    private async collectData(): Promise<void> {
        if (!this.isRecording || this.variables.size === 0) {
            console.log(`[Waveform] collectData skipped: recording=${this.isRecording}, variables=${this.variables.size}`);
            return;
        }

        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'cortex-debug') {
            console.log(`[Waveform] collectData skipped: no active debug session or wrong type`);
            return;
        }

        const currentTime = Date.now() - this.startTime;

        // Batch evaluate all variables for better performance
        const evaluationPromises: Promise<void>[] = [];

        for (const [expression, variable] of this.variables) {
            if (!variable.enabled) {
                continue;
            }

            evaluationPromises.push(this.evaluateVariable(expression, variable, currentTime));
        }

        try {
            await Promise.allSettled(evaluationPromises);
        } catch (error) {
            console.error('Error during batch variable evaluation:', error);
        }

        // Clean old data points
        this.cleanAllOldData();
    }

    private async evaluateVariable(expression: string, variable: WaveformVariable, currentTime: number): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            console.log(`[Waveform] No active debug session for expression: ${expression}`);
            return;
        }

        try {
            console.log(`[Waveform] Evaluating expression: ${expression}`);

            // Try to get value from Live Watch first
            const liveWatchValue = await this.getLiveWatchValue(expression);
            let value: number | null = null;

            if (liveWatchValue !== null) {
                value = liveWatchValue;
                console.log(`[Waveform] Got value from Live Watch for ${expression}: ${value}`);
            } else {
                // Fallback to direct evaluation
                console.log(`[Waveform] Using direct evaluation for: ${expression}`);
                const result = await session.customRequest('evaluate', {
                    expression: expression,
                    context: 'watch'
                });

                if (result && result.result !== undefined) {
                    value = this.parseValue(result.result);
                    console.log(`[Waveform] Direct evaluation result for ${expression}: ${result.result} -> ${value}`);
                } else {
                    console.log(`[Waveform] No result from direct evaluation for: ${expression}`);
                }
            }

            if (value !== null) {
                variable.lastValue = value;
                console.log(`[Waveform] Adding data point for ${expression}: ${value} at ${currentTime}`);

                // Create a graph point and add to data source
                this.dataSource.receiveDataMessage({
                    id: this.getGraphId(expression),
                    timestamp: currentTime,
                    type: 'data',
                    data: value
                });
            } else {
                console.log(`[Waveform] Could not parse value for expression: ${expression}`);
            }
        } catch (error) {
            console.error(`[Waveform] Failed to evaluate expression '${expression}':`, error instanceof Error ? error.message : String(error));
        }
    }

    private async getLiveWatchValue(expression: string): Promise<number | null> {
        // Try to get value from Live Watch tree provider
        try {
            console.log(`[Waveform] Searching for expression in Live Watch: ${expression}`);
            const rootVariables = this.liveWatchProvider.getRootVariables();
            console.log(`[Waveform] Found ${rootVariables.length} variables in Live Watch`);

            for (const node of rootVariables) {
                console.log(`[Waveform] Checking node: ${node.getName()} (${node.getExpr()})`);
                if (node.getExpr() === expression) {
                    console.log(`[Waveform] Found matching node for: ${expression}`);
                    const value = this.extractNodeValue(node, expression);
                    if (value !== null) {
                        console.log(`[Waveform] Extracted value from node: ${value}`);
                        return value;
                    }

                    // Try to get more detailed value from the node
                    let nodeValue = null;
                    if (node.getCopyValue) {
                        nodeValue = node.getCopyValue();
                    }
                    console.log(`[Waveform] Node raw value: ${nodeValue}`);

                    // Check if we have a simplified representation that needs expansion
                    if (nodeValue === '{...}' || (nodeValue && nodeValue.includes('{...}'))) {
                        console.log(`[Waveform] Detected simplified structure, attempting expansion`);
                        const expandedValue = await this.expandStructure(node, expression);
                        if (expandedValue && expandedValue !== '{...}') {
                            console.log(`[Waveform] Successfully expanded structure: ${expandedValue}`);
                            const parsed = this.parseStructValue(expandedValue, expression);
                            if (parsed !== null) {
                                console.log(`[Waveform] Parsed expanded struct value: ${parsed}`);
                                return parsed;
                            }
                        }
                    }

                    // Regular parsing if not a simplified representation
                    if (nodeValue && nodeValue !== '{...}') {
                        const parsed = this.parseStructValue(nodeValue, expression);
                        if (parsed !== null) {
                            console.log(`[Waveform] Parsed struct value: ${parsed}`);
                            return parsed;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error getting value from Live Watch:', error);
        }

        console.log(`[Waveform] Expression not found in Live Watch, using direct evaluation: ${expression}`);
        // Fallback to direct evaluation
        return this.evaluateDirectly(expression);
    }

    private async expandStructure(node: any, expression: string): Promise<string | null> {
        try {
            console.log(`[Waveform] Expanding structure for: ${expression}`);

            // Try to get children from the node
            if (node.getChildren && typeof node.getChildren === 'function') {
                // Force expand the node to get children
                const session = vscode.debug.activeDebugSession;
                if (session && node.getVariablesReference && node.getVariablesReference() > 0) {
                    console.log(`[Waveform] Requesting children for expansion, varRef: ${node.getVariablesReference()}`);

                    try {
                        const result = await session.customRequest('liveVariables', {
                            variablesReference: node.getVariablesReference()
                        });

                        if (result && result.variables && result.variables.length > 0) {
                            console.log(`[Waveform] Got ${result.variables.length} children for expansion`);

                            // Build expanded structure representation
                            const members = result.variables.map((variable: any) => {
                                const value = variable.result || variable.value || 'undefined';
                                return `${variable.name} = ${value}`;
                            });

                            const expandedStructure = `{${members.join(', ')}}`;
                            console.log(`[Waveform] Built expanded structure: ${expandedStructure}`);

                            return expandedStructure;
                        }
                    } catch (error) {
                        console.error(`[Waveform] Error requesting children:`, error);
                    }
                }
            }

            // Alternative: Try direct evaluation with member access
            const session = vscode.debug.activeDebugSession;
            if (session) {
                console.log(`[Waveform] Trying direct evaluation for structure expansion`);
                try {
                    const result = await session.customRequest('evaluate', {
                        expression: expression,
                        context: 'watch'
                    });

                    if (result && result.result && result.result !== '{...}') {
                        console.log(`[Waveform] Direct evaluation successful: ${result.result}`);
                        return result.result;
                    }
                } catch (error) {
                    console.error(`[Waveform] Direct evaluation failed:`, error);
                }
            }

        } catch (error) {
            console.error(`[Waveform] Error expanding structure:`, error);
        }

        return null;
    }

    private extractNodeValue(node: any, expression: string): number | null {
        try {
            console.log(`[Waveform] Extracting value from node: ${node.getName()}`);

            // Try different methods to extract the value
            if (node.getValue) {
                const rawValue = node.getValue();
                console.log(`[Waveform] Node getValue(): ${rawValue}`);
                const parsed = this.parseValue(rawValue.toString());
                if (parsed !== null) {
                    return parsed;
                }
            }

            // Use public getter method to access the value
            if (node.getCopyValue && node.getCopyValue()) {
                const copyValue = node.getCopyValue();
                console.log(`[Waveform] Node.getCopyValue(): ${copyValue}`);
                // Try struct parsing first for complex values
                if (typeof copyValue === 'string' && copyValue.includes('{')) {
                    const structParsed = this.parseStructValue(copyValue, expression);
                    if (structParsed !== null) {
                        return structParsed;
                    }
                }
                const parsed = this.parseValue(copyValue);
                if (parsed !== null) {
                    return parsed;
                }
            }

            // For protected properties, we need to rely on public methods only
            // The getCopyValue method should provide the current value
            // If that doesn't work, we'll need to refresh the node data

            console.log(`[Waveform] Could not extract numeric value from node: ${node.getName()}`);
        } catch (error) {
            console.error('Error extracting node value:', error);
        }
        return null;
    }

    private async evaluateDirectly(expression: string): Promise<number | null> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            return null;
        }

        try {
            const result = await session.customRequest('evaluate', {
                expression: expression,
                context: 'watch'
            });

            if (result && result.result !== undefined) {
                return this.parseValue(result.result);
            }
        } catch (error) {
            console.error(`Failed to evaluate expression '${expression}':`, error);
        }

        return null;
    }

    private cleanAllOldData(): void {
        const cutoffTime = Date.now() - this.startTime - (this.settings.timeSpan * 1000);
        this.dataSource.clearOldData(cutoffTime);
    }

    private parseValue(value: string): number | null {
        if (!value || value === 'not available') {
            return null;
        }

        // Try to parse as a floating point number
        const parsed = parseFloat(value.replace(/[^0-9.-]/g, ''));
        if (!isNaN(parsed)) {
            return parsed;
        }

        // Try to parse as hexadecimal
        if (value.startsWith('0x') || value.startsWith('0X')) {
            const hexParsed = parseInt(value, 16);
            if (!isNaN(hexParsed)) {
                return hexParsed;
            }
        }

        // Try to parse as binary
        if (value.startsWith('0b') || value.startsWith('0B')) {
            const binParsed = parseInt(value.substring(2), 2);
            if (!isNaN(binParsed)) {
                return binParsed;
            }
        }

        return null;
    }

    private parseStructValue(structValue: string, expression: string): number | null {
        if (!structValue || structValue === 'not available') {
            return null;
        }

        console.log(`[Waveform] Parsing structure with advanced parser: ${expression}`);

        try {
            // Use the new advanced structure parser
            const parsed = this.structParser.parseStructure(structValue, expression);

            if (parsed) {
                console.log(`[Waveform] Structure parsed successfully:`, {
                    type: parsed.type,
                    membersCount: parsed.members.length,
                    totalValue: parsed.totalValue,
                    hash: parsed.hash
                });

                // Store the parsed structure for later use
                this.parsedStructures.set(expression, parsed);

                // Get available numeric members
                const numericMembers = this.structParser.getNumericMembers(parsed);
                this.memberSelections.set(expression, numericMembers);

                console.log(`[Waveform] Found ${numericMembers.length} numeric members:`,
                    numericMembers.map(m => m.path));

                // Return the total value for now
                // Later we can use member selection to return specific values
                return parsed.totalValue;
            }
        } catch (error) {
            console.error(`[Waveform] Error in advanced structure parsing:`, error);
        }

        // Fallback to simple parsing if advanced parsing fails
        console.log(`[Waveform] Falling back to simple parsing for: ${expression}`);
        return this.parseSimpleStructValue(structValue);
    }

    private parseSimpleStructValue(structValue: string): number | null {
        // Handle struct values like "{a: 1, b: 2}"
        if (structValue.startsWith('{') && structValue.endsWith('}')) {
            // Try to extract numeric values from struct representation
            const numbers = structValue.match(/\d+\.?\d*/g);
            if (numbers && numbers.length > 0) {
                // For structs, we can calculate a hash or sum of values
                const sum = numbers.reduce((acc, num) => acc + parseFloat(num), 0);
                return sum;
            }
        }

        // Handle enum or named constant values
        if (structValue.includes('{') || structValue.includes('...')) {
            // For complex struct representations, create a hash
            let hash = 0;
            for (let i = 0; i < structValue.length; i++) {
                const char = structValue.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit integer
            }
            return Math.abs(hash) % 1000000; // Keep it reasonable
        }

        // Fallback to regular parsing
        return this.parseValue(structValue);
    }

    private getGraphId(expression: string): number {
        // Generate a consistent hash from the expression
        let hash = 0;
        for (let i = 0; i < expression.length; i++) {
            const char = expression.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    public getData(variableId: string, startTime?: number, endTime?: number): GraphPoint[] {
        const graphId = this.getGraphId(variableId);
        const now = Date.now() - this.startTime;
        const start = startTime || (now - this.settings.timeSpan * 1000);
        const end = endTime || now;

        return this.dataSource.getData(graphId.toString(), start, end);
    }

    public getAllData(): Map<string, GraphPoint[]> {
        const allData = new Map<string, GraphPoint[]>();

        for (const [expression, variable] of this.variables) {
            if (variable.enabled) {
                const data = this.getData(expression);
                allData.set(expression, data);
            }
        }

        return allData;
    }

    public getDataStats(variableId: string): DataSourceStats {
        const graphId = this.getGraphId(variableId);
        return this.dataSource.getDataStats(graphId.toString());
    }

    public getLatestDataPoints(): Map<string, GraphPoint | null> {
        const variableIds = Array.from(this.variables.keys()).map((id) => this.getGraphId(id).toString());
        const dataPoints = this.dataSource.getLatestDataPoints(variableIds);

        // Convert back to expression keys
        const result = new Map<string, GraphPoint | null>();
        this.variables.forEach((variable, expression) => {
            const graphId = this.getGraphId(expression).toString();
            result.set(expression, dataPoints.get(graphId) || null);
        });

        return result;
    }

    public getAutoScaleRange(): { min: number; max: number } {
        const variableIds = Array.from(this.variables.keys()).map((id) => this.getGraphId(id).toString());
        const now = Date.now() - this.startTime;
        const startTime = now - this.settings.timeSpan * 1000;

        return this.dataSource.autoScaleY(variableIds, startTime, now);
    }

    public exportData(format: 'json' | 'csv'): string {
        const allData = this.getAllData();

        if (format === 'json') {
            const exportData = {
                settings: this.settings,
                variables: Array.from(this.variables.values()),
                data: Object.fromEntries(allData),
                timestamp: new Date().toISOString()
            };
            return JSON.stringify(exportData, null, 2);
        } else if (format === 'csv') {
            // Generate CSV data
            const lines: string[] = [];
            const headers = ['timestamp', ...Array.from(this.variables.keys())];
            lines.push(headers.join(','));

            // Find the longest data set
            const maxLength = Math.max(...Array.from(allData.values()).map((data) => data.length));

            for (let i = 0; i < maxLength; i++) {
                const row: string[] = [];

                // Use timestamp from first variable as reference
                const firstVarData = Array.from(allData.values())[0];
                if (i < firstVarData.length) {
                    row.push(firstVarData[i].timestamp.toString());
                } else {
                    row.push('');
                }

                // Add values for each variable
                for (const expression of this.variables.keys()) {
                    const data = allData.get(expression);
                    if (data && i < data.length) {
                        row.push(data[i].value.toString());
                    } else {
                        row.push('');
                    }
                }

                lines.push(row.join(','));
            }

            return lines.join('\n');
        }

        return '';
    }

    public clearAllData(): void {
        this.dataSource.clearData();
    }

    public isRecordingActive(): boolean {
        return this.isRecording;
    }

    // Enhanced variable style management
    public getVariableColor(expression: string): string {
        const variable = this.variables.get(expression);
        return variable?.color || this.getNextColor();
    }

    public getVariableLineWidth(expression: string): number {
        const variable = this.variables.get(expression);
        return variable?.lineWidth || 2;
    }

    public getVariableLineStyle(expression: string): string {
        const variable = this.variables.get(expression);
        return variable?.lineStyle || 'solid';
    }

    public getVariableOpacity(expression: string): number {
        const variable = this.variables.get(expression);
        return variable?.opacity || 1.0;
    }

    public getVariableSamplingRate(expression: string): number | undefined {
        const variable = this.variables.get(expression);
        return variable?.samplingRate;
    }

    // Configuration management

    public getFFTAnalysis(variableId: string, windowSize: number = 512, windowFunction: string = 'hanning'): FFTResult | null {
        const data = this.getData(variableId);

        if (data.length < windowSize) {
            return null;
        }

        // Update FFT configuration
        this.fftAnalyzer.updateConfig({
            windowSize: windowSize,
            windowFunction: windowFunction as any,
            samplingRate: this.settings.refreshRate
        });

        // Extract data values for FFT
        const dataValues = getDataPointsForFFT(data, windowSize);

        // Perform FFT analysis
        return this.fftAnalyzer.analyze(dataValues);
    }

    public getAvailableFFTWindowSizes(): number[] {
        return [256, 512, 1024, 2048, 4096];
    }

    public getAvailableFFTWindowFunctions(): string[] {
        return ['hanning', 'hamming', 'blackman', 'rectangular'];
    }

    public getDefaultFFTWindowSize(): number {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        return config.get('waveformFFTWindowSize', 512);
    }

    public getDefaultFFTWindowFunction(): string {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        return config.get('waveformFFTWindowFunction', 'hanning');
    }

    public getDefaultDataExportFormat(): string {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        return config.get('waveformDataExportFormat', 'json');
    }

    public getDefaultLineWidth(): number {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        return config.get('waveformDefaultLineWidth', 2);
    }

    public getVariableStyle(variableId: string): any {
        const variable = this.variables.get(variableId);
        if (variable) {
            return {
                color: variable.color,
                lineStyle: variable.lineStyle || 'solid',
                lineWidth: variable.lineWidth || 2,
                opacity: variable.opacity || 1.0,
                visible: variable.visible !== false
            };
        }
        return null;
    }

    public setVariableStyle(variableId: string, style: any): void {
        const variable = this.variables.get(variableId);
        if (variable) {
            if (style.color) variable.color = style.color;
            if (style.lineStyle) variable.lineStyle = style.lineStyle;
            if (style.lineWidth) variable.lineWidth = style.lineWidth;
            if (style.opacity) variable.opacity = style.opacity;
            if (style.visible !== undefined) variable.visible = style.visible;
        }
    }

    public exportConfiguration(): string {
        const config = {
            settings: this.settings,
            variables: Array.from(this.variables.entries()).map(([id, variable]) => ({
                id: id,
                name: variable.name,
                expression: variable.expression,
                style: this.getVariableStyle(id)
            }))
        };
        return JSON.stringify(config, null, 2);
    }

    public importConfiguration(configJson: string): boolean {
        try {
            const config = JSON.parse(configJson);

            if (config.settings) {
                this.settings = { ...this.settings, ...config.settings };
            }

            if (config.variables && Array.isArray(config.variables)) {
                // Clear existing variables
                this.variables.clear();
                this.dataSource.clearData();

                // Import variables
                config.variables.forEach((varConfig: any) => {
                    const variable: WaveformVariable = {
                        id: varConfig.id,
                        name: varConfig.name,
                        expression: varConfig.expression,
                        color: varConfig.style?.color || this.getNextColor(),
                        lineStyle: varConfig.style?.lineStyle || 'solid',
                        lineWidth: varConfig.style?.lineWidth || 2,
                        opacity: varConfig.style?.opacity || 1.0,
                        visible: varConfig.style?.visible !== false,
                        lastValue: undefined,
                        enabled: true
                    };
                    this.variables.set(varConfig.id, variable);
                });
            }

            return true;
        } catch (error) {
            console.error('Failed to import configuration:', error);
            return false;
        }
    }

    // Display type management methods for Logic Analyzer functionality

    /**
     * Get the display type for a variable
     */
    public getVariableDisplayType(variableId: string): SignalDisplayType {
        const variable = this.variables.get(variableId);
        return variable?.displayType || 'analog';
    }

    /**
     * Set the display type for a variable (analog, bit, state, hex, binary)
     */
    public setVariableDisplayType(variableId: string, displayType: SignalDisplayType): boolean {
        const variable = this.variables.get(variableId);
        if (variable) {
            variable.displayType = displayType;

            // Adjust default bit width based on display type
            if (displayType === 'bit' && !variable.bitWidth) {
                variable.bitWidth = 1;
            } else if ((displayType === 'hex' || displayType === 'binary' || displayType === 'state') && !variable.bitWidth) {
                variable.bitWidth = 8; // Default to 8-bit for multi-bit displays
            }

            return true;
        }
        return false;
    }

    /**
     * Get bit configuration for a variable
     */
    public getVariableBitConfig(variableId: string): { bitWidth: number; bitMask?: number; bitOffset?: number; threshold: number } {
        const variable = this.variables.get(variableId);
        return {
            bitWidth: variable?.bitWidth || 1,
            bitMask: variable?.bitMask,
            bitOffset: variable?.bitOffset,
            threshold: variable?.threshold || 0.5
        };
    }

    /**
     * Set bit configuration for a variable
     */
    public setVariableBitConfig(variableId: string, config: { bitWidth?: number; bitMask?: number; bitOffset?: number; threshold?: number }): boolean {
        const variable = this.variables.get(variableId);
        if (variable) {
            if (config.bitWidth !== undefined) variable.bitWidth = config.bitWidth;
            if (config.bitMask !== undefined) variable.bitMask = config.bitMask;
            if (config.bitOffset !== undefined) variable.bitOffset = config.bitOffset;
            if (config.threshold !== undefined) variable.threshold = config.threshold;
            return true;
        }
        return false;
    }

    /**
     * Get trigger configuration for a variable
     */
    public getVariableTrigger(variableId: string): TriggerCondition | undefined {
        const variable = this.variables.get(variableId);
        return variable?.trigger;
    }

    /**
     * Set trigger configuration for a variable
     */
    public setVariableTrigger(variableId: string, trigger: TriggerCondition): boolean {
        const variable = this.variables.get(variableId);
        if (variable) {
            variable.trigger = trigger;
            return true;
        }
        return false;
    }

    /**
     * Get signal statistics for a variable
     */
    public getVariableStatistics(variableId: string): SignalStatistics | null {
        return this.dataSource.calculateSignalStatistics(variableId);
    }

    /**
     * Get variable group
     */
    public getVariableGroup(variableId: string): string | undefined {
        const variable = this.variables.get(variableId);
        return variable?.group;
    }

    /**
     * Set variable group for hierarchical display
     */
    public setVariableGroup(variableId: string, group: string): boolean {
        const variable = this.variables.get(variableId);
        if (variable) {
            variable.group = group;
            return true;
        }
        return false;
    }

    /**
     * Get all signal groups
     */
    public getSignalGroups(): string[] {
        const groups = new Set<string>();
        this.variables.forEach((variable) => {
            if (variable.group) {
                groups.add(variable.group);
            }
        });
        return Array.from(groups).sort();
    }

    /**
     * Get variables in a group
     */
    public getVariablesInGroup(group: string): WaveformVariable[] {
        return Array.from(this.variables.values()).filter((v) => v.group === group);
    }

    /**
     * Format value based on display type
     */
    public formatVariableValue(variableId: string, value: number): string {
        const variable = this.variables.get(variableId);
        if (!variable) {
            return value.toString();
        }

        const displayType = variable.displayType || 'analog';
        const bitWidth = variable.bitWidth || 1;

        return this.dataSource.formatValue(value, displayType, bitWidth);
    }

    /**
     * Get available display types
     */
    public getAvailableDisplayTypes(): Array<{ label: string; value: SignalDisplayType; description: string }> {
        return [
            { label: 'Analog', value: 'analog', description: 'Continuous waveform display' },
            { label: 'Bit/Digital', value: 'bit', description: 'Digital 0/1 signal' },
            { label: 'State', value: 'state', description: 'Multi-state bus display' },
            { label: 'Hexadecimal', value: 'hex', description: 'Hex value display' },
            { label: 'Binary', value: 'binary', description: 'Binary value display' }
        ];
    }

    // Enhanced structure member selection methods

    public getParsedStructure(expression: string): ParsedStructure | null {
        return this.parsedStructures.get(expression) || null;
    }

    public getNumericMembers(expression: string): MemberSelection[] {
        return this.memberSelections.get(expression) || [];
    }

    public selectStructureMembers(expression: string, selectedPaths: string[]): boolean {
        const selections = this.memberSelections.get(expression);
        if (!selections) {
            return false;
        }

        // Update selection state
        selections.forEach(selection => {
            selection.selected = selectedPaths.includes(selection.path);
        });

        console.log(`[Waveform] Updated member selection for ${expression}:`,
            selections.filter(s => s.selected).map(s => s.path));

        return true;
    }

    public getSelectedMemberValue(expression: string, memberPath: string): number | null {
        const parsed = this.parsedStructures.get(expression);
        if (!parsed) {
            return null;
        }

        return this.structParser.extractMemberValue(parsed, memberPath);
    }

    public generateMemberExpressions(expression: string): string[] {
        const selections = this.memberSelections.get(expression);
        if (!selections) {
            return [];
        }

        return this.structParser.generateMemberExpressions(expression, selections);
    }

    public dispose(): void {
        this.stopDataCollection();
        this.variables.clear();
        this.dataSource.clearData();
        this.parsedStructures.clear();
        this.memberSelections.clear();
    }
}
