/**
 * Waveform Data Provider
 *
 * Manages waveform data collection and provides a clean interface for the webview
 */

import * as vscode from 'vscode';
import { WaveformVariable, WaveformSettings, WaveformDataPoint } from './types';

export interface IWaveformDataProvider {
    // Variable management
    addVariable(expression: string, name: string): boolean;
    removeVariable(variableId: string): boolean;
    getVariables(): WaveformVariable[];
    getVariable(variableId: string): WaveformVariable | undefined;
    updateVariableSettings(variableId: string, settings: Partial<WaveformVariable>): void;

    // Data access
    getVariableData(variableId: string): WaveformDataPoint[];
    getAllData(): Map<string, WaveformDataPoint[]>;
    clearAllData(): void;

    // Recording control
    startRecording(): void;
    stopRecording(): void;
    isRecordingActive(): boolean;

    // Settings
    getSettings(): WaveformSettings;
    updateSettings(settings: Partial<WaveformSettings>): void;

    // Export
    exportData(format: 'json' | 'csv'): string;

    // Live Watch integration
    setLiveWatchProvider(liveWatchProvider: any): void;
    useLiveWatchData(useLiveWatch: boolean): void;
    getLiveWatchHistoricalData(variableId: string): WaveformDataPoint[];

    // Cleanup
    dispose(): void;
}

export class WaveformDataProvider implements IWaveformDataProvider {
    private variables: Map<string, WaveformVariable> = new Map();
    private dataStore: Map<string, WaveformDataPoint[]> = new Map();
    private settings: WaveformSettings;
    private isRecording = false;
    private startTime = 0;
    private collectionTimer: NodeJS.Timeout | null = null;

    // Live Watch integration
    private liveWatchProvider: any = null;
    private useLiveWatchDataFlag = false;
    private colorIndex = 0;

    private readonly colorSchemes: Record<string, string[]> = {
        professional: [
            '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
            '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
        ],
        vibrant: [
            '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
            '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'
        ]
    };

    constructor(defaultSettings?: Partial<WaveformSettings>) {
        this.settings = {
            timeSpan: 60,
            refreshRate: 1.0,
            maxDataPoints: 10000,
            yAxisMode: 'auto',
            yMin: null,
            yMax: null,
            showGrid: true,
            showLegend: false,
            colorScheme: 'professional',
            renderer: 'webgl',
            ...defaultSettings
        };

        this.setupDebugEventListeners();
    }

    private setupDebugEventListeners(): void {
        vscode.debug.onDidStartDebugSession(() => {
            console.log('[WaveformDataProvider] Debug session started');
            this.startRecording();
        });

        vscode.debug.onDidTerminateDebugSession(() => {
            console.log('[WaveformDataProvider] Debug session terminated');
            this.stopRecording();
        });
    }

    public addVariable(expression: string, name: string): boolean {
        if (this.variables.has(expression)) {
            vscode.window.showWarningMessage(`Variable '${name}' is already monitored`);
            return false;
        }

        const variable: WaveformVariable = {
            id: expression,
            name: name,
            color: this.getNextColor(),
            enabled: true,
            visible: true,
            data: []
        };

        this.variables.set(expression, variable);
        this.dataStore.set(expression, []);

        console.log(`[WaveformDataProvider] Added variable: ${name} (${expression})`);

        // Start data collection if recording
        if (this.isRecording && this.collectionTimer === null) {
            this.startDataCollection();
        }

        return true;
    }

    public removeVariable(variableId: string): boolean {
        const removed = this.variables.delete(variableId);
        this.dataStore.delete(variableId);

        if (removed && this.variables.size === 0) {
            this.stopDataCollection();
        }

        return removed;
    }

    public getVariables(): WaveformVariable[] {
        return Array.from(this.variables.values()).map((v) => ({
            ...v,
            data: this.dataStore.get(v.id) || []
        }));
    }

    public getVariable(variableId: string): WaveformVariable | undefined {
        const variable = this.variables.get(variableId);
        if (!variable) return undefined;

        return {
            ...variable,
            data: this.dataStore.get(variableId) || []
        };
    }

    public updateVariableSettings(variableId: string, settings: Partial<WaveformVariable>): void {
        const variable = this.variables.get(variableId);
        if (variable) {
            Object.assign(variable, settings);
        }
    }

    public getVariableData(variableId: string): WaveformDataPoint[] {
        return this.dataStore.get(variableId) || [];
    }

    public getAllData(): Map<string, WaveformDataPoint[]> {
        return new Map(this.dataStore);
    }

    public clearAllData(): void {
        for (const key of this.dataStore.keys()) {
            this.dataStore.set(key, []);
        }
        console.log('[WaveformDataProvider] All data cleared');
    }

    public startRecording(): void {
        if (this.isRecording) {
            console.log('[WaveformDataProvider] Already recording');
            return;
        }

        this.isRecording = true;
        this.startTime = Date.now();
        console.log('[WaveformDataProvider] Recording started');

        if (this.variables.size > 0) {
            this.startDataCollection();
        }
    }

    public stopRecording(): void {
        this.isRecording = false;
        this.stopDataCollection();
        console.log('[WaveformDataProvider] Recording stopped');
    }

    public isRecordingActive(): boolean {
        return this.isRecording;
    }

    public getSettings(): WaveformSettings {
        return { ...this.settings };
    }

    public updateSettings(newSettings: Partial<WaveformSettings>): void {
        this.settings = { ...this.settings, ...newSettings };

        // Restart collection if refresh rate changed
        if (newSettings.refreshRate && this.collectionTimer) {
            this.stopDataCollection();
            this.startDataCollection();
        }

        console.log('[WaveformDataProvider] Settings updated:', newSettings);
    }

    public exportData(format: 'json' | 'csv'): string {
        if (format === 'json') {
            return this.exportAsJSON();
        } else {
            return this.exportAsCSV();
        }
    }

    public dispose(): void {
        this.stopDataCollection();
        this.variables.clear();
        this.dataStore.clear();
        console.log('[WaveformDataProvider] Disposed');
    }

    // Private methods
    private startDataCollection(): void {
        if (this.collectionTimer) return;

        const intervalMs = 1000 / this.settings.refreshRate;
        console.log(`[WaveformDataProvider] Starting data collection (${intervalMs}ms interval)`);

        this.collectionTimer = setInterval(() => {
            this.collectData();
        }, intervalMs);

        // Collect immediately
        this.collectData();
    }

    private stopDataCollection(): void {
        if (this.collectionTimer) {
            clearInterval(this.collectionTimer);
            this.collectionTimer = null;
            console.log('[WaveformDataProvider] Data collection stopped');
        }
    }

    private async collectData(): Promise<void> {
        if (this.useLiveWatchDataFlag) {
            this.collectDataFromLiveWatch();
            return;
        }

        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== 'cortex-debug') {
            return;
        }

        const currentTime = Date.now() - this.startTime;

        for (const [expression, variable] of this.variables) {
            if (!variable.enabled) continue;

            try {
                const result = await session.customRequest('evaluate', {
                    expression: expression,
                    context: 'watch'
                });

                if (result && result.result !== undefined) {
                    const value = this.parseValue(result.result);

                    if (value !== null) {
                        const dataPoint: WaveformDataPoint = {
                            timestamp: currentTime,
                            value: value
                        };

                        const data = this.dataStore.get(expression) || [];
                        data.push(dataPoint);

                        // Trim old data
                        const cutoffTime = currentTime - (this.settings.timeSpan * 1000);
                        const trimmedData = data.filter((p) => p.timestamp >= cutoffTime);

                        // Limit total points
                        if (trimmedData.length > this.settings.maxDataPoints) {
                            trimmedData.splice(0, trimmedData.length - this.settings.maxDataPoints);
                        }

                        this.dataStore.set(expression, trimmedData);
                    }
                }
            } catch (error) {
                console.error(`[WaveformDataProvider] Error evaluating ${expression}:`, error);
            }
        }
    }

    private parseValue(value: string): number | null {
        if (!value || value === 'not available') {
            return null;
        }

        // Try direct number parse
        const num = parseFloat(value);
        if (!isNaN(num)) {
            return num;
        }

        // Try hex
        if (value.startsWith('0x') || value.startsWith('0X')) {
            return parseInt(value, 16);
        }

        // Try binary
        if (value.startsWith('0b') || value.startsWith('0B')) {
            return parseInt(value.substring(2), 2);
        }

        // Extract first number from string
        const match = value.match(/-?\d+\.?\d*/);
        if (match) {
            return parseFloat(match[0]);
        }

        return null;
    }

    private getNextColor(): string {
        const colors = this.colorSchemes[this.settings.colorScheme] || this.colorSchemes.professional;
        const color = colors[this.colorIndex % colors.length];
        this.colorIndex++;
        return color;
    }

    private exportAsJSON(): string {
        const data = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            settings: this.settings,
            variables: this.getVariables()
        };

        return JSON.stringify(data, null, 2);
    }

    private exportAsCSV(): string {
        const lines: string[] = [];
        const variables = this.getVariables();

        // Header
        const headers = ['timestamp', ...variables.map((v) => v.name)];
        lines.push(headers.join(','));

        // Find max length
        const maxLength = Math.max(...variables.map((v) => v.data.length));

        // Data rows
        for (let i = 0; i < maxLength; i++) {
            const row: string[] = [];

            // Timestamp from first variable
            const firstData = variables[0]?.data[i];
            row.push(firstData ? String(firstData.timestamp) : '');

            // Values
            for (const variable of variables) {
                if (i < variable.data.length) {
                    row.push(String(variable.data[i].value));
                } else {
                    row.push('');
                }
            }

            lines.push(row.join(','));
        }

        return lines.join('\n');
    }

    // Live Watch integration methods
    public setLiveWatchProvider(liveWatchProvider: any): void {
        this.liveWatchProvider = liveWatchProvider;
        console.log('[WaveformDataProvider] Live Watch provider set');
    }

    public useLiveWatchData(useLiveWatch: boolean): void {
        this.useLiveWatchDataFlag = useLiveWatch;
        console.log(`[WaveformDataProvider] Using Live Watch data: ${useLiveWatch}`);

        if (useLiveWatch && this.liveWatchProvider) {
            // Sync existing variables with Live Watch
            this.syncWithLiveWatchInternal();
        }
    }

    public getLiveWatchHistoricalData(variableId: string): WaveformDataPoint[] {
        if (!this.useLiveWatchDataFlag || !this.liveWatchProvider) {
            return [];
        }

        const variable = this.variables.get(variableId);
        if (!variable) {
            return [];
        }

        try {
            // Get historical data from Live Watch using variable name
            const historicalData = this.liveWatchProvider.getHistoricalData(variable.name);
            return historicalData.map((sample: any): WaveformDataPoint => ({
                timestamp: sample.timestamp - this.startTime,
                value: this.parseValue(sample.value) || 0
            })) as WaveformDataPoint[];
        } catch (error) {
            console.error(`[WaveformDataProvider] Error getting Live Watch data for ${variableId}:`, error);
            return [];
        }
    }

    private syncWithLiveWatchInternal(): void {
        if (!this.liveWatchProvider) {
            return;
        }

        try {
            // Get all Live Watch variables
            const liveWatchVariables = this.liveWatchProvider.getVariables();

            // Add Live Watch variables to waveform if they don't exist
            for (const liveVar of liveWatchVariables) {
                const exists = Array.from(this.variables.values()).some((v) => v.name === liveVar.getName());
                if (!exists) {
                    this.addVariable(liveVar.getExpr(), liveVar.getName());
                }
            }
        } catch (error) {
            console.error('[WaveformDataProvider] Error syncing with Live Watch:', error);
        }
    }

    public syncWithLiveWatch(): void {
        this.syncWithLiveWatchInternal();
    }

    private collectDataFromLiveWatch(): void {
        if (!this.useLiveWatchDataFlag || !this.liveWatchProvider) {
            return;
        }

        const currentTime = Date.now() - this.startTime;

        for (const [expression, variable] of this.variables) {
            if (!variable.enabled) continue;

            try {
                // Get cached sample from Live Watch
                const cachedSample = this.liveWatchProvider.getCachedSample(expression);
                if (cachedSample) {
                    const value = this.parseValue(cachedSample.value);
                    if (value !== null) {
                        const dataPoint: WaveformDataPoint = {
                            timestamp: currentTime,
                            value: value
                        };

                        const data = this.dataStore.get(expression) || [];
                        data.push(dataPoint);

                        // Trim old data
                        const cutoffTime = currentTime - (this.settings.timeSpan * 1000);
                        const trimmedData = data.filter((p) => p.timestamp >= cutoffTime);

                        // Limit total points
                        if (trimmedData.length > this.settings.maxDataPoints) {
                            trimmedData.splice(0, trimmedData.length - this.settings.maxDataPoints);
                        }

                        this.dataStore.set(expression, trimmedData);
                    }
                }
            } catch (error) {
                console.error(`[WaveformDataProvider] Error getting Live Watch data for ${expression}:`, error);
            }
        }
    }
}
