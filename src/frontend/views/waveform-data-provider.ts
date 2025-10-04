import * as vscode from 'vscode';
import { LiveWatchTreeProvider, LiveVariableNode } from './live-watch';
import { GraphPoint, GraphDataSource, WaveformVariable, DataSourceStats } from '../../grapher/datasource';
import { FFTAnalyzer, FFTResult, getDataPointsForFFT } from './fft-analyzer';

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

    public addVariable(variable: LiveVariableNode): boolean {
        const expression = variable.getExpr();
        const name = variable.getName();

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
            unit: ''
        };

        this.variables.set(expression, waveformVar);
        this.startDataCollection();
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

    private startRecording(): void {
        if (this.isRecording) {
            return;
        }

        // Check if auto-start is enabled in settings
        const config = vscode.workspace.getConfiguration('cortex-debug');
        const autoStart = config.get('waveformAutoStart', true);

        if (!autoStart) {
            console.log('Waveform auto-start is disabled in settings');
            return;
        }

        this.isRecording = true;
        this.startTime = Date.now();
        this.startDataCollection();
    }

    private stopRecording(): void {
        this.isRecording = false;
        this.stopDataCollection();
    }

    private startDataCollection(): void {
        if (this.refreshTimer || this.variables.size === 0 || !this.isRecording) {
            return;
        }

        const intervalMs = 1000 / this.settings.refreshRate;
        this.refreshTimer = setInterval(() => {
            this.collectData();
        }, intervalMs);
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
            return;
        }

        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'cortex-debug') {
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
            return;
        }

        try {
            // Try to get value from Live Watch first
            const liveWatchValue = await this.getLiveWatchValue(expression);
            let value: number | null = null;

            if (liveWatchValue !== null) {
                value = liveWatchValue;
            } else {
                // Fallback to direct evaluation
                const result = await session.customRequest('evaluate', {
                    expression: expression,
                    context: 'watch'
                });

                if (result && result.result !== undefined) {
                    value = this.parseValue(result.result);
                }
            }

            if (value !== null) {
                variable.lastValue = value;

                // Create a graph point and add to data source
                this.dataSource.receiveDataMessage({
                    id: this.getGraphId(expression),
                    timestamp: currentTime,
                    type: 'data',
                    data: value
                });
            }
        } catch (error) {
            console.error(`Failed to evaluate expression '${expression}':`, error instanceof Error ? error.message : String(error));
        }
    }

    private getLiveWatchValue(expression: string): Promise<number | null> {
        // For now, simplify this by using direct evaluation
        // Live Watch integration would require more complex async handling
        // that's better implemented with proper VSCode TreeDataProvider integration
        return this.evaluateDirectly(expression);
    }

    private extractNodeValue(node: any): number | null {
        try {
            // Try different methods to extract the value
            if (node.getValue) {
                const rawValue = node.getValue();
                return this.parseValue(rawValue.toString());
            } else if (node.value !== undefined) {
                return this.parseValue(node.value.toString());
            } else if (node.lastValue !== undefined) {
                return this.parseValue(node.lastValue.toString());
            }
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

    public dispose(): void {
        this.stopDataCollection();
        this.variables.clear();
        this.dataSource.clearData();
    }
}
