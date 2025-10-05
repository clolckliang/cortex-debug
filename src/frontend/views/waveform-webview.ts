import * as vscode from 'vscode';
import { WaveformDataProvider } from './waveform-data-provider';
import { LiveWatchTreeProvider } from './live-watch';
import { GraphPoint } from '../../grapher/datasource';

export class WaveformWebviewPanel {
    private webviewPanel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private updateTimer: NodeJS.Timeout | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private liveWatchProvider: LiveWatchTreeProvider,
        private dataProvider: WaveformDataProvider
    ) {
        this.setupUpdateTimer();
    }

    public show(): void {
        if (this.webviewPanel) {
            this.webviewPanel.reveal();
            return;
        }

        this.webviewPanel = vscode.window.createWebviewPanel(
            'waveformView',
            'Waveform Monitor',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.context.extensionUri],
                enableFindWidget: true
            }
        );

        // Restore webview state if available
        this.webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        this.webviewPanel.webview.html = this.getWebviewContent();

        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = undefined;
            this.cleanup();
        }, null, this.disposables);

        // Setup message handling with error handling
        this.webviewPanel.webview.onDidReceiveMessage(
            (message) => {
                try {
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error handling webview message:', error);
                    vscode.window.showErrorMessage(`Waveform view error: ${error}`);
                }
            },
            undefined,
            this.disposables
        );

        // Handle visibility changes
        this.webviewPanel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.visible) {
                    this.sendDataUpdate();
                }
            },
            undefined,
            this.disposables
        );

        // Send initial data
        this.sendDataUpdate();
    }

    public hide(): void {
        if (this.webviewPanel) {
            this.webviewPanel.dispose();
        }
    }

    private setupUpdateTimer(): void {
        this.updateTimer = setInterval(() => {
            if (this.webviewPanel) {
                this.sendDataUpdate();
            }
        }, 1000); // Update every second
    }

    private sendDataUpdate(): void {
        if (!this.webviewPanel) return;

        const variables = this.dataProvider.getVariables();
        const allData = new Map<string, GraphPoint[]>();

        for (const variable of variables) {
            if (variable.enabled) {
                const data = this.dataProvider.getData(variable.id);
                allData.set(variable.id, data);
            }
        }

        const latestPoints = this.dataProvider.getLatestDataPoints();

        this.webviewPanel.webview.postMessage({
            type: 'dataUpdate',
            variables: variables,
            data: Object.fromEntries(allData),
            latestPoints: Object.fromEntries(latestPoints),
            settings: this.dataProvider.getSettings()
        });
    }

    private handleMessage(message: any): void {
        if (!message || !message.command) {
            console.warn('Received invalid message:', message);
            return;
        }

        try {
            switch (message.command) {
                case 'requestInitialData':
                    this.sendDataUpdate();
                    break;

                case 'toggleVariable':
                    if (message.variableId !== undefined) {
                        this.dataProvider.updateVariableSettings(message.variableId, {
                            enabled: message.enabled
                        });
                        this.sendDataUpdate(); // Immediately reflect changes
                    } else {
                        console.warn('toggleVariable missing variableId:', message);
                    }
                    break;

                case 'updateSettings':
                    if (message.settings && typeof message.settings === 'object') {
                        this.dataProvider.updateSettings(message.settings);
                        this.sendDataUpdate();
                    } else {
                        console.warn('updateSettings invalid settings:', message.settings);
                    }
                    break;

                case 'exportData':
                    if (message.format && ['json', 'csv'].includes(message.format)) {
                        this.handleExportData(message.format);
                    } else {
                        vscode.window.showErrorMessage('Invalid export format. Use "json" or "csv".');
                    }
                    break;

                case 'performFFT':
                    if (message.variableId && message.windowSize && message.windowFunction) {
                        this.handleFFTAnalysis(message.variableId, message.windowSize, message.windowFunction);
                    } else {
                        vscode.window.showErrorMessage('Invalid FFT parameters. Provide variableId, windowSize, and windowFunction.');
                    }
                    break;

                case 'startRecording':
                    this.dataProvider.startRecording();
                    this.sendDataUpdate();
                    break;

                case 'stopRecording':
                    this.dataProvider.stopRecording();
                    this.sendDataUpdate();
                    break;

                case 'clearAllData':
                    this.dataProvider.clearAllData();
                    this.sendDataUpdate();
                    break;

                case 'getVariableData':
                    if (message.variableId) {
                        const data = this.dataProvider.getData(message.variableId);
                        this.sendMessage('variableDataResponse', {
                            variableId: message.variableId,
                            data: data
                        });
                    }
                    break;

                default:
                    console.warn('Unknown command:', message.command);
            }
        } catch (error) {
            console.error(`Error handling command ${message.command}:`, error);
            vscode.window.showErrorMessage(`Waveform operation failed: ${error}`);
        }
    }

    private sendMessage(type: string, data: any): void {
        if (this.webviewPanel) {
            this.webviewPanel.webview.postMessage({
                type: type,
                data: data,
                timestamp: Date.now()
            });
        }
    }

    public highlightVariable(expression: string): void {
        this.sendMessage('highlightVariable', { expression: expression });
    }

    public toggleVariable(expression: string, enabled: boolean): void {
        this.sendMessage('variableToggle', { expression: expression, enabled: enabled });
    }

    public updateVariableStyle(expression: string, style: any): void {
        this.sendMessage('variableStyleUpdate', { expression: expression, style: style });
    }

    public updateChartSettings(settings: any): void {
        this.sendMessage('chartSettingsUpdate', { settings: settings });
    }

    public showNotification(message: string, type: string = 'info'): void {
        this.sendMessage('notification', { message: message, type: type });
    }

    public refreshData(): void {
        this.sendDataUpdate();
    }

    private async handleExportData(format: string): Promise<void> {
        try {
            const data = this.dataProvider.exportData(format as any);

            const uri = await vscode.window.showSaveDialog({
                filters: format === 'json' ? { 'JSON Files': ['json'] } : { 'CSV Files': ['csv'] },
                defaultUri: vscode.Uri.file(`waveform_data.${format}`)
            });

            if (uri) {
                const fs = await import('fs');
                fs.writeFileSync(uri.fsPath, data);
                vscode.window.showInformationMessage(`Waveform data exported to ${uri.fsPath}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export data: ${error}`);
        }
    }

    private handleFFTAnalysis(variableId: string, windowSize: number, windowFunction: string): void {
        try {
            const result = this.dataProvider.getFFTAnalysis(variableId, windowSize, windowFunction);

            if (result && this.webviewPanel) {
                this.webviewPanel.webview.postMessage({
                    type: 'fftResult',
                    variableId: variableId,
                    result: result
                });
            } else if (!result) {
                vscode.window.showErrorMessage('Insufficient data for FFT analysis');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`FFT analysis failed: ${error}`);
        }
    }

    private getWebviewContent(): string {
        const nonce = this.getNonce();

        // Get Codicons URI for VSCode icons
        const codiconsUri = this.webviewPanel?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${this.webviewPanel?.webview.cspSource} 'unsafe-inline';
                   font-src ${this.webviewPanel?.webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>Waveform Monitor</title>
    ${codiconsUri ? '<link href="' + String(codiconsUri) + '" rel="stylesheet" />' : ''}
    <style nonce="${nonce}">
        /* Use VSCode CSS variables directly - no custom color definitions needed */

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            font-weight: var(--vscode-font-weight);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            overflow: hidden;
            line-height: 1.4;
        }

        /* Scrollbar styling - VSCode standard */
        ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }

        ::-webkit-scrollbar-corner {
            background-color: transparent;
        }

        ::-webkit-scrollbar-thumb {
            background-color: var(--vscode-scrollbarSlider-background);
        }

        ::-webkit-scrollbar-thumb:hover {
            background-color: var(--vscode-scrollbarSlider-hoverBackground);
        }

        ::-webkit-scrollbar-thumb:active {
            background-color: var(--vscode-scrollbarSlider-activeBackground);
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            width: 100%;
        }

        /* VSCode-style Toolbar */
        .toolbar {
            display: flex;
            align-items: center;
            height: 35px;
            padding: 0 8px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
            gap: 4px;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-right: 8px;
            padding-right: 8px;
            border-right: 1px solid var(--vscode-widget-border);
        }

        .toolbar-group:last-child {
            border-right: none;
        }

        /* VSCode Action Bar Button Style */
        .toolbar-button {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            padding: 0;
            background: transparent;
            border: none;
            border-radius: 5px;
            color: var(--vscode-foreground);
            cursor: pointer;
            outline: none;
            transition: background-color 0.1s ease-in-out;
        }

        .toolbar-button:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .toolbar-button:active {
            background-color: var(--vscode-toolbar-activeBackground);
        }

        .toolbar-button.active {
            background-color: var(--vscode-inputOption-activeBackground);
            color: var(--vscode-inputOption-activeForeground);
            border: 1px solid var(--vscode-inputOption-activeBorder);
        }

        .toolbar-button:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .toolbar-button:disabled:hover {
            background-color: transparent;
        }

        /* Codicon support */
        .toolbar-button .codicon {
            font-size: 16px;
        }

        .main-content {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        .sidebar {
            width: 240px;
            border-right: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            background-color: var(--vscode-sideBar-background);
        }

        .sidebar-header {
            padding: 0 20px;
            height: 35px;
            line-height: 35px;
            background-color: var(--vscode-sideBarSectionHeader-background);
            color: var(--vscode-sideBarSectionHeader-foreground);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .chart-container {
            flex: 1;
            position: relative;
            background-color: var(--vscode-editor-background);
        }

        #waveformCanvas {
            width: 100%;
            height: 100%;
            cursor: crosshair;
        }

        /* Status Bar - VSCode style */
        .status-bar {
            height: 22px;
            background-color: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            border-top: 1px solid var(--vscode-statusBar-border);
            display: flex;
            align-items: center;
            padding: 0 10px;
            font-size: 12px;
            flex-shrink: 0;
        }

        .status-item {
            margin-right: 16px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .status-label {
            opacity: 0.7;
        }

        .status-value {
            font-family: var(--vscode-editor-font-family);
            font-weight: 400;
        }

        /* Variable list items - VSCode tree item style */
        .variable-list {
            flex: 1;
            overflow-y: auto;
        }

        .variable-item {
            display: flex;
            align-items: center;
            padding: 0 20px;
            height: 22px;
            cursor: pointer;
            user-select: none;
            transition: background-color 0.1s ease;
        }

        .variable-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .variable-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .variable-item:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .variable-item.disabled {
            opacity: 0.5;
        }

        .color-indicator {
            width: 12px;
            height: 12px;
            border-radius: 2px;
            margin-right: 8px;
            flex-shrink: 0;
        }

        .variable-info {
            flex: 1;
            min-width: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .variable-name {
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .variable-value {
            font-size: 11px;
            font-family: var(--vscode-editor-font-family);
            opacity: 0.7;
            margin-left: 8px;
            flex-shrink: 0;
        }

        /* Floating Panels */
        .floating-panel {
            position: absolute;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            padding: 12px;
            min-width: 200px;
            z-index: 1000;
        }

        .panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            font-weight: bold;
            font-size: 12px;
        }

        .panel-close {
            width: 16px;
            height: 16px;
            background: none;
            border: none;
            cursor: pointer;
            color: var(--vscode-editor-foreground);
            font-size: 14px;
            line-height: 1;
        }

        /* Settings Panel */
        .settings-panel {
            top: 10px;
            left: 10px;
            width: 280px;
            display: none;
        }

        .settings-group {
            margin-bottom: 12px;
        }

        .settings-label {
            display: block;
            margin-bottom: 4px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .settings-input {
            width: 100%;
            padding: 4px 6px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 11px;
        }

        .settings-row {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }

        .settings-button {
            flex: 1;
            padding: 4px 8px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 2px;
            cursor: pointer;
            font-size: 11px;
        }

        /* FFT Panel */
        .fft-panel {
            top: 10px;
            right: 10px;
            width: 320px;
            max-height: 400px;
            overflow-y: auto;
            display: none;
        }

        .fft-results {
            font-size: 11px;
            line-height: 1.4;
        }

        .fft-result-item {
            margin-bottom: 8px;
            padding: 6px;
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            border-radius: 0 2px 2px 0;
        }

        .fft-label {
            font-weight: bold;
            margin-right: 4px;
        }

        /* Measurement Tools */
        .crosshair {
            position: absolute;
            pointer-events: none;
            z-index: 100;
        }

        .crosshair-h {
            position: absolute;
            left: 0;
            height: 1px;
            background-color: rgba(255, 255, 255, 0.8);
            border-top: 1px dashed rgba(0, 0, 0, 0.3);
            border-bottom: 1px dashed rgba(0, 0, 0, 0.3);
        }

        .crosshair-v {
            position: absolute;
            top: 0;
            width: 1px;
            background-color: rgba(255, 255, 255, 0.8);
            border-left: 1px dashed rgba(0, 0, 0, 0.3);
            border-right: 1px dashed rgba(0, 0, 0, 0.3);
        }

        .coordinate-display {
            position: absolute;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            padding: 4px 6px;
            font-size: 10px;
            font-family: monospace;
            pointer-events: none;
            z-index: 101;
            white-space: nowrap;
        }

        /* Legend */
        .legend {
            position: absolute;
            bottom: 10px;
            left: 10px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 6px 8px;
            font-size: 11px;
            z-index: 50;
        }

        .legend-item {
            display: flex;
            align-items: center;
            margin: 2px 0;
        }

        .legend-color {
            width: 12px;
            height: 12px;
            margin-right: 6px;
            border-radius: 2px;
            border: 1px solid var(--vscode-panel-border);
        }

        /* Context Menu */
        .context-menu {
            position: absolute;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            padding: 4px 0;
            z-index: 2000;
            min-width: 150px;
        }

        .context-menu-item {
            padding: 4px 12px;
            cursor: pointer;
            font-size: 11px;
            line-height: 1.4;
        }

        .context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
        }

        .context-menu-separator {
            height: 1px;
            background-color: var(--vscode-menu-border);
            margin: 4px 0;
        }

        /* Tooltips */
        .tooltip {
            position: absolute;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            padding: 6px 8px;
            font-size: 10px;
            font-family: monospace;
            pointer-events: none;
            z-index: 3000;
            white-space: nowrap;
            max-width: 300px;
        }

        /* Selection rectangle */
        .selection-rect {
            position: absolute;
            border: 1px dashed var(--vscode-focusBorder);
            background-color: var(--vscode-focusBorder);
            opacity: 0.2;
            pointer-events: none;
            z-index: 90;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- VSCode-style Toolbar -->
        <div class="toolbar" role="toolbar" aria-label="Waveform controls">
            <div class="toolbar-group">
                <button class="toolbar-button" id="btnStartStop" title="Start/Stop Recording" aria-label="Start recording">
                    <i class="codicon codicon-debug-start"></i>
                </button>
                <button class="toolbar-button" id="btnClear" title="Clear Data" aria-label="Clear all data" disabled>
                    <i class="codicon codicon-clear-all"></i>
                </button>
                <button class="toolbar-button" id="btnExport" title="Export Data" aria-label="Export data">
                    <i class="codicon codicon-save"></i>
                </button>
            </div>

            <div class="toolbar-group">
                <button class="toolbar-button" id="btnZoomIn" title="Zoom In" aria-label="Zoom in">
                    <i class="codicon codicon-zoom-in"></i>
                </button>
                <button class="toolbar-button" id="btnZoomOut" title="Zoom Out" aria-label="Zoom out">
                    <i class="codicon codicon-zoom-out"></i>
                </button>
                <button class="toolbar-button" id="btnZoomFit" title="Auto Fit" aria-label="Fit to window">
                    <i class="codicon codicon-screen-full"></i>
                </button>
            </div>

            <div class="toolbar-group">
                <button class="toolbar-button" id="btnGrid" title="Toggle Grid" aria-label="Toggle grid">
                    <i class="codicon codicon-layout"></i>
                </button>
                <button class="toolbar-button" id="btnLegend" title="Toggle Legend" aria-label="Toggle legend">
                    <i class="codicon codicon-symbol-color"></i>
                </button>
                <button class="toolbar-button" id="btnMeasure" title="Measurement Tools" aria-label="Measurement tools">
                    <i class="codicon codicon-ruler"></i>
                </button>
            </div>

            <div class="toolbar-group">
                <button class="toolbar-button" id="btnFFT" title="FFT Analysis" aria-label="FFT analysis">
                    <i class="codicon codicon-graph"></i>
                </button>
                <button class="toolbar-button" id="btnSettings" title="Settings" aria-label="Settings">
                    <i class="codicon codicon-settings-gear"></i>
                </button>
            </div>
        </div>

        <!-- Main Content Area -->
        <div class="main-content">
            <!-- Left Sidebar -->
            <div class="sidebar" role="complementary" aria-label="Variables">
                <div class="sidebar-header">Variables</div>
                <div class="variable-list" id="variableList" role="list" aria-label="Monitored variables"></div>
            </div>

            <!-- Chart Area -->
            <div class="chart-container" role="main" aria-label="Waveform chart">
                <canvas id="waveformCanvas" role="img" aria-label="Real-time waveform display"></canvas>

                <!-- Floating Panels -->
                <div class="floating-panel settings-panel" id="settingsPanel">
                    <div class="panel-header">
                        <span>Chart Settings</span>
                        <button class="panel-close" onclick="closeSettings()">×</button>
                    </div>
                    <div class="settings-group">
                        <label class="settings-label">Time Span (seconds):</label>
                        <input type="number" id="timeSpan" class="settings-input" min="1" max="300" step="1">
                    </div>
                    <div class="settings-group">
                        <label class="settings-label">Refresh Rate (Hz):</label>
                        <input type="number" id="refreshRate" class="settings-input" min="0.1" max="20" step="0.1">
                    </div>
                    <div class="settings-group">
                        <label class="settings-label">Max Data Points:</label>
                        <input type="number" id="maxDataPoints" class="settings-input" min="100" max="50000" step="100">
                    </div>
                    <div class="settings-group">
                        <div class="settings-row">
                            <button class="settings-button" onclick="applySettings()">Apply</button>
                            <button class="settings-button" onclick="closeSettings()">Cancel</button>
                        </div>
                    </div>
                </div>

                <div class="floating-panel fft-panel" id="fftPanel">
                    <div class="panel-header">
                        <span>FFT Analysis</span>
                        <button class="panel-close" onclick="closeFFT()">×</button>
                    </div>
                    <div class="fft-results" id="fftResults"></div>
                </div>

                <!-- Measurement Elements -->
                <div class="crosshair" id="crosshair">
                    <div class="crosshair-h"></div>
                    <div class="crosshair-v"></div>
                </div>
                <div class="coordinate-display" id="coordinateDisplay"></div>
                <div class="selection-rect" id="selectionRect"></div>

                <!-- Legend -->
                <div class="legend" id="legend"></div>
                <div class="tooltip" id="tooltip"></div>
            </div>
        </div>

        <!-- Status Bar -->
        <div class="status-bar">
            <div class="status-item">
                <span class="status-label">X:</span>
                <span class="status-value" id="statusX">--</span>
            </div>
            <div class="status-item">
                <span class="status-label">Y:</span>
                <span class="status-value" id="statusY">--</span>
            </div>
            <div class="status-item">
                <span class="status-label">ΔX:</span>
                <span class="status-value" id="statusDX">--</span>
            </div>
            <div class="status-item">
                <span class="status-label">ΔY:</span>
                <span class="status-value" id="statusDY">--</span>
            </div>
            <div class="status-item">
                <span class="status-label">Zoom:</span>
                <span class="status-value" id="statusZoom">1.0x</span>
            </div>
            <div class="status-item">
                <span class="status-label">Range:</span>
                <span class="status-value" id="statusRange">60s</span>
            </div>
            <div class="status-item">
                <span class="status-label">FPS:</span>
                <span class="status-value" id="statusFPS">--</span>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // Professional state management
        let appState = {
            isRecording: false,
            variables: [],
            data: {},
            settings: {
                timeSpan: 60,
                refreshRate: 1.0,
                maxDataPoints: 10000,
                yAxisMode: 'auto',
                yMin: -1,
                yMax: 1
            },
            lastUpdateTime: 0,
            connectionStatus: 'connected'
        };

        // Save/restore state using VSCode API
        function saveState() {
            const stateToSave = {
                settings: appState.settings,
                variables: appState.variables,
                lastUpdateTime: Date.now()
            };
            vscode.setState(stateToSave);
        }

        function restoreState() {
            const previousState = vscode.getState();
            if (previousState) {
                appState = { ...appState, ...previousState };
                console.log('State restored from previous session');
            }
        }
        let canvas, ctx;
        let variables = [];
        let data = {};
        let settings = {
            timeSpan: 60,
            refreshRate: 1.0,
            maxDataPoints: 10000,
            yAxisMode: 'auto',
            yMin: -1,
            yMax: 1
        };

        // Professional interaction state
        let interactionState = {
            isDragging: false,
            isSelecting: false,
            isMeasuring: false,
            measureMode: false,
            dragStart: { x: 0, y: 0 },
            dragEnd: { x: 0, y: 0 },
            selectionStart: { x: 0, y: 0 },
            selectionEnd: { x: 0, y: 0 },
            measureStart: { x: 0, y: 0 },
            measureEnd: { x: 0, y: 0 },
            zoomLevel: 1.0,
            panOffset: { x: 0, y: 0 },
            history: [],
            historyIndex: -1
        };

        // UI Elements
        let crosshair, coordinateDisplay, selectionRect, tooltip;

        // FPS tracking
        let fps = 0;
        let frameCount = 0;
        let lastFpsUpdate = Date.now();

        // Initialize application
        window.addEventListener('load', () => {
            try {
                // Restore previous state
                restoreState();

                // Initialize canvas and UI elements
                initializeUI();

                // Setup event listeners
                setupEventListeners();

                // Request initial data
                vscode.postMessage({ command: 'requestInitialData' });

                // Initialize status display
                updateStatusDisplay();

                console.log('Waveform view initialized successfully');
            } catch (error) {
                console.error('Error initializing waveform view:', error);
                showError('Failed to initialize waveform view: ' + error.message);
            }
        });

        function initializeUI() {
            canvas = document.getElementById('waveformCanvas');
            if (!canvas) {
                throw new Error('Canvas element not found');
            }

            ctx = canvas.getContext('2d');
            if (!ctx) {
                throw new Error('Failed to get canvas context');
            }

            // Get UI elements
            crosshair = document.getElementById('crosshair');
            coordinateDisplay = document.getElementById('coordinateDisplay');
            selectionRect = document.getElementById('selectionRect');
            tooltip = document.getElementById('tooltip');

            // Set initial canvas size
            resizeCanvas();

            // Handle window resize
            window.addEventListener('resize', () => {
                resizeCanvas();
            });

            // Apply saved settings
            if (appState.settings) {
                Object.assign(settings, appState.settings);
            }
        }

              function showError(message) {
            const errorDiv = document.createElement('div');
            const errorStyles = [
                'position: fixed',
                'top: 20px',
                'right: 20px',
                'background-color: var(--vscode-editor-errorBackground)',
                'color: var(--vscode-editor-errorForeground)',
                'border: 1px solid var(--vscode-editorError-border)',
                'border-radius: 4px',
                'padding: 12px',
                'max-width: 400px',
                'z-index: 10000',
                'font-family: var(--vscode-font-family)'
            ];
            errorDiv.style.cssText = errorStyles.join(';');
            errorDiv.textContent = message;
            document.body.appendChild(errorDiv);

            setTimeout(() => {
                if (errorDiv.parentNode) {
                    errorDiv.parentNode.removeChild(errorDiv);
                }
            }, 5000);
        }

        function resizeCanvas() {
            const container = canvas.parentElement;
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;
            drawWaveform();
        }

        function setupEventListeners() {
            // Toolbar buttons
            document.getElementById('btnStartStop')?.addEventListener('click', toggleRecording);
            document.getElementById('btnClear')?.addEventListener('click', clearAllData);
            document.getElementById('btnExport')?.addEventListener('click', () => exportData('json'));
            document.getElementById('btnSettings')?.addEventListener('click', toggleSettings);
            document.getElementById('btnFFT')?.addEventListener('click', () => toggleFFTPanel());
            document.getElementById('btnZoomIn')?.addEventListener('click', zoomIn);
            document.getElementById('btnZoomOut')?.addEventListener('click', zoomOut);
            document.getElementById('btnZoomFit')?.addEventListener('click', autoFit);
            document.getElementById('btnMeasure')?.addEventListener('click', toggleMeasureMode);
            document.getElementById('btnGrid')?.addEventListener('click', toggleGrid);
            document.getElementById('btnLegend')?.addEventListener('click', toggleLegend);

            // Canvas professional interactions
            canvas.addEventListener('mousedown', handleCanvasMouseDown);
            canvas.addEventListener('mousemove', handleCanvasMouseMove);
            canvas.addEventListener('mouseup', handleCanvasMouseUp);
            canvas.addEventListener('mouseleave', handleCanvasMouseLeave);
            canvas.addEventListener('contextmenu', handleCanvasRightClick);
            canvas.addEventListener('wheel', handleCanvasWheel);
            canvas.addEventListener('dblclick', handleCanvasDoubleClick);

            // Keyboard shortcuts
            document.addEventListener('keydown', handleKeyDown);
            document.addEventListener('keyup', handleKeyUp);
        }

        // Professional mouse interaction handlers
        function handleCanvasMouseDown(e) {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (e.button === 0) { // Left click
                if (interactionState.measureMode) {
                    interactionState.isMeasuring = true;
                    interactionState.measureStart = { x, y };
                    interactionState.measureEnd = { x, y };
                } else if (e.shiftKey) {
                    interactionState.isSelecting = true;
                    interactionState.selectionStart = { x, y };
                    interactionState.selectionEnd = { x, y };
                } else {
                    interactionState.isDragging = true;
                    interactionState.dragStart = { x, y };
                    canvas.style.cursor = 'grabbing';
                }
            }
        }

        function handleCanvasMouseMove(e) {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Update crosshair position
            updateCrosshair(x, y);

            // Update coordinate display
            updateCoordinateDisplay(x, y);

            if (interactionState.isDragging) {
                interactionState.dragEnd = { x, y };
                const dx = x - interactionState.dragStart.x;
                const dy = y - interactionState.dragStart.y;

                // Apply pan
                interactionState.panOffset.x += dx;
                interactionState.panOffset.y += dy;

                interactionState.dragStart = { x, y };
                drawWaveform();
            } else if (interactionState.isSelecting) {
                interactionState.selectionEnd = { x, y };
                updateSelectionRect();
            } else if (interactionState.isMeasuring) {
                interactionState.measureEnd = { x, y };
                updateMeasurementDisplay();
            }

            // Update tooltip if hovering over data points
            updateTooltip(x, y, e.clientX, e.clientY);
        }

        function handleCanvasMouseUp(e) {
            if (interactionState.isDragging) {
                interactionState.isDragging = false;
                canvas.style.cursor = 'crosshair';
                saveToHistory();
            } else if (interactionState.isSelecting) {
                interactionState.isSelecting = false;
                if (Math.abs(interactionState.selectionEnd.x - interactionState.selectionStart.x) > 10) {
                    zoomToSelection();
                }
                hideSelectionRect();
            } else if (interactionState.isMeasuring) {
                interactionState.isMeasuring = false;
                if (Math.abs(interactionState.measureEnd.x - interactionState.measureStart.x) > 5) {
                    showMeasurementResults();
                }
            }
        }

        function handleCanvasMouseLeave() {
            hideCrosshair();
            hideTooltip();

            if (interactionState.isDragging) {
                interactionState.isDragging = false;
                canvas.style.cursor = 'crosshair';
            }
            if (interactionState.isSelecting) {
                interactionState.isSelecting = false;
                hideSelectionRect();
            }
        }

        function handleCanvasRightClick(e) {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            showContextMenu(x, y, e.clientX, e.clientY);
        }

        function handleCanvasWheel(e) {
            e.preventDefault();

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = Math.max(0.1, Math.min(10, interactionState.zoomLevel * delta));

            if (newZoom !== interactionState.zoomLevel) {
                // Zoom towards mouse position
                const zoomRatio = newZoom / interactionState.zoomLevel;

                interactionState.panOffset.x = x - (x - interactionState.panOffset.x) * zoomRatio;
                interactionState.panOffset.y = y - (y - interactionState.panOffset.y) * zoomRatio;
                interactionState.zoomLevel = newZoom;

                updateStatusDisplay();
                drawWaveform();
            }
        }

        function handleCanvasDoubleClick(e) {
            // Reset view on double click
            resetView();
        }

        function handleKeyDown(e) {
            switch(e.key) {
                case ' ':
                    e.preventDefault();
                    toggleRecording();
                    break;
                case 'Escape':
                    if (interactionState.measureMode) {
                        toggleMeasureMode();
                    }
                    hideAllPanels();
                    break;
                case 'g':
                case 'G':
                    if (!e.ctrlKey && !e.metaKey) {
                        toggleGrid();
                    }
                    break;
                case 'l':
                case 'L':
                    if (!e.ctrlKey && !e.metaKey) {
                        toggleLegend();
                    }
                    break;
                case 'm':
                case 'M':
                    if (!e.ctrlKey && !e.metaKey) {
                        toggleMeasureMode();
                    }
                    break;
                case 'f':
                case 'F':
                    if (!e.ctrlKey && !e.metaKey) {
                        autoFit();
                    }
                    break;
                case '+':
                case '=':
                    if (!e.ctrlKey && !e.metaKey) {
                        zoomIn();
                    }
                    break;
                case '-':
                case '_':
                    if (!e.ctrlKey && !e.metaKey) {
                        zoomOut();
                    }
                    break;
                case '0':
                    if (!e.ctrlKey && !e.metaKey) {
                        resetView();
                    }
                    break;
                case 'z':
                case 'Z':
                    if (e.ctrlKey || e.metaKey) {
                        if (e.shiftKey) {
                            redo();
                        } else {
                            undo();
                        }
                    }
                    break;
            }
        }

        function handleKeyUp(e) {
            // Handle key release if needed
        }

        // Professional UI control functions
        function toggleRecording() {
            const btn = document.getElementById('btnStartStop');
            const icon = btn?.querySelector('.codicon');
            if (!btn || !icon) return;

            const isPlaying = icon.classList.contains('codicon-debug-start');

            if (isPlaying) {
                icon.classList.remove('codicon-debug-start');
                icon.classList.add('codicon-debug-pause');
                btn.title = 'Pause Recording';
                btn.setAttribute('aria-label', 'Pause recording');
                appState.isRecording = true;
                sendMessageToExtension('startRecording');
            } else {
                icon.classList.remove('codicon-debug-pause');
                icon.classList.add('codicon-debug-start');
                btn.title = 'Start Recording';
                btn.setAttribute('aria-label', 'Start recording');
                appState.isRecording = false;
                sendMessageToExtension('stopRecording');
            }
            saveState();
        }

        function zoomIn() {
            interactionState.zoomLevel = Math.min(10, interactionState.zoomLevel * 1.2);
            updateStatusDisplay();
            drawWaveform();
        }

        function zoomOut() {
            interactionState.zoomLevel = Math.max(0.1, interactionState.zoomLevel / 1.2);
            updateStatusDisplay();
            drawWaveform();
        }

        function autoFit() {
            // Auto-fit all visible data
            interactionState.zoomLevel = 1.0;
            interactionState.panOffset = { x: 0, y: 0 };
            updateStatusDisplay();
            drawWaveform();
        }

        function resetView() {
            interactionState.zoomLevel = 1.0;
            interactionState.panOffset = { x: 0, y: 0 };
            updateStatusDisplay();
            drawWaveform();
        }

        function toggleMeasureMode() {
            interactionState.measureMode = !interactionState.measureMode;
            const btn = document.getElementById('btnMeasure');
            btn.classList.toggle('active', interactionState.measureMode);

            if (!interactionState.measureMode) {
                interactionState.isMeasuring = false;
                hideMeasurementDisplay();
            }

            canvas.style.cursor = interactionState.measureMode ? 'crosshair' : 'default';
        }

        function toggleGrid() {
            const btn = document.getElementById('btnGrid');
            btn.classList.toggle('active');
            drawWaveform();
        }

        function toggleLegend() {
            const btn = document.getElementById('btnLegend');
            btn.classList.toggle('active');
            const legend = document.getElementById('legend');
            legend.style.display = legend.style.display === 'none' ? 'block' : 'none';
        }

        function toggleFFTPanel() {
            const panel = document.getElementById('fftPanel');
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';

            if (panel.style.display === 'block') {
                // Perform FFT on first enabled variable
                const enabledVar = variables.find(v => v.enabled);
                if (enabledVar) {
                    performFFT(enabledVar.id);
                }
            }
        }

        // Professional measurement and display functions
        function updateCrosshair(x, y) {
            if (!crosshair) return;

            const h = crosshair.querySelector('.crosshair-h');
            const v = crosshair.querySelector('.crosshair-v');

            h.style.top = y + 'px';
            h.style.width = canvas.width + 'px';

            v.style.left = x + 'px';
            v.style.height = canvas.height + 'px';

            crosshair.style.display = 'block';
        }

        function hideCrosshair() {
            if (crosshair) {
                crosshair.style.display = 'none';
            }
        }

        function updateCoordinateDisplay(x, y) {
            if (!coordinateDisplay) return;

            const coords = pixelToDataCoords(x, y);
            coordinateDisplay.innerHTML = 'X: ' + coords.x.toFixed(3) + 's<br>Y: ' + coords.y.toFixed(3);
            coordinateDisplay.style.left = (x + 10) + 'px';
            coordinateDisplay.style.top = (y - 30) + 'px';
            coordinateDisplay.style.display = 'block';

            // Update status bar
            document.getElementById('statusX').textContent = coords.x.toFixed(3);
            document.getElementById('statusY').textContent = coords.y.toFixed(3);
        }

        function updateSelectionRect() {
            if (!selectionRect || !interactionState.isSelecting) return;

            const left = Math.min(interactionState.selectionStart.x, interactionState.selectionEnd.x);
            const top = Math.min(interactionState.selectionStart.y, interactionState.selectionEnd.y);
            const width = Math.abs(interactionState.selectionEnd.x - interactionState.selectionStart.x);
            const height = Math.abs(interactionState.selectionEnd.y - interactionState.selectionStart.y);

            selectionRect.style.left = left + 'px';
            selectionRect.style.top = top + 'px';
            selectionRect.style.width = width + 'px';
            selectionRect.style.height = height + 'px';
            selectionRect.style.display = 'block';
        }

        function hideSelectionRect() {
            if (selectionRect) {
                selectionRect.style.display = 'none';
            }
        }

        function updateMeasurementDisplay() {
            if (!interactionState.isMeasuring) return;

            const startCoords = pixelToDataCoords(interactionState.measureStart.x, interactionState.measureStart.y);
            const endCoords = pixelToDataCoords(interactionState.measureEnd.x, interactionState.measureEnd.y);

            const deltaX = endCoords.x - startCoords.x;
            const deltaY = endCoords.y - startCoords.y;

            // Update status bar with measurements
            document.getElementById('statusDX').textContent = deltaX.toFixed(3);
            document.getElementById('statusDY').textContent = deltaY.toFixed(3);
        }

        function hideMeasurementDisplay() {
            document.getElementById('statusDX').textContent = '--';
            document.getElementById('statusDY').textContent = '--';
        }

        function showMeasurementResults() {
            const startCoords = pixelToDataCoords(interactionState.measureStart.x, interactionState.measureStart.y);
            const endCoords = pixelToDataCoords(interactionState.measureEnd.x, interactionState.measureEnd.y);

            const deltaX = endCoords.x - startCoords.x;
            const deltaY = endCoords.y - startCoords.y;
            const slope = deltaY / deltaX;

            const message = 'Measurement Results:\n' +
                'Time: ' + deltaX.toFixed(3) + 's\n' +
                'Amplitude: ' + deltaY.toFixed(3) + '\n' +
                'Slope: ' + slope.toFixed(3);

            alert(message);
        }

        function updateTooltip(x, y, clientX, clientY) {
            // Find nearest data point
            const coords = pixelToDataCoords(x, y);
            let nearestPoint = null;
            let minDistance = Infinity;

            variables.filter(v => v.enabled).forEach(variable => {
                const points = data[variable.id];
                if (points && points.length > 0) {
                    points.forEach(point => {
                        const pointCoords = dataToPixelCoords(point.timestamp, point.value);
                        const distance = Math.sqrt(Math.pow(x - pointCoords.x, 2) + Math.pow(y - pointCoords.y, 2));

                        if (distance < minDistance && distance < 10) {
                            minDistance = distance;
                            nearestPoint = { variable, point, coords: pointCoords };
                        }
                    });
                }
            });

            if (nearestPoint) {
                tooltip.innerHTML = nearestPoint.variable.name + '<br>' +
                'Time: ' + (nearestPoint.point.timestamp / 1000).toFixed(3) + 's<br>' +
                'Value: ' + nearestPoint.point.value.toFixed(3);
                tooltip.style.left = clientX + 10 + 'px';
                tooltip.style.top = clientY - 30 + 'px';
                tooltip.style.display = 'block';
            } else {
                hideTooltip();
            }
        }

        function hideTooltip() {
            tooltip.style.display = 'none';
        }

        function showContextMenu(x, y, clientX, clientY) {
            // Remove existing context menu
            const existingMenu = document.querySelector('.context-menu');
            if (existingMenu) {
                existingMenu.remove();
            }

            const menu = document.createElement('div');
            menu.className = 'context-menu';
            menu.style.left = clientX + 'px';
            menu.style.top = clientY + 'px';

            const coords = pixelToDataCoords(x, y);

            let menuHTML = '';
            menuHTML += '<div class="context-menu-item" onclick="zoomIn()">Zoom In</div>';
            menuHTML += '<div class="context-menu-item" onclick="zoomOut()">Zoom Out</div>';
            menuHTML += '<div class="context-menu-item" onclick="autoFit()">Auto Fit</div>';
            menuHTML += '<div class="context-menu-separator"></div>';
            menuHTML += '<div class="context-menu-item" onclick="exportData(' + "'json'" + ')">Export JSON</div>';
            menuHTML += '<div class="context-menu-item" onclick="exportData(' + "'csv'" + ')">Export CSV</div>';
            menuHTML += '<div class="context-menu-separator"></div>';
            menuHTML += '<div class="context-menu-item" onclick="toggleMeasureMode()">Measure Mode</div>';
            menuHTML += '<div class="context-menu-item" onclick="toggleGrid()">Toggle Grid</div>';

            // Add variable-specific options
            variables.filter(v => v.enabled).forEach(variable => {
                menuHTML += '<div class="context-menu-separator"></div>';
                menuHTML += \`<div class="context-menu-item" onclick="performFFT('\${variable.id}')">FFT: \${variable.name}</div>\`;
            });

            menu.innerHTML = menuHTML;
            document.body.appendChild(menu);

            // Close menu when clicking elsewhere
            const closeMenu = (e) => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 100);
        }

        // Professional data conversion functions
        function pixelToDataCoords(x, y) {
            const padding = 40;
            const chartWidth = canvas.width - 2 * padding;
            const chartHeight = canvas.height - 2 * padding;

            // Apply zoom and pan
            const adjustedX = (x - interactionState.panOffset.x) / interactionState.zoomLevel;
            const adjustedY = (y - interactionState.panOffset.y) / interactionState.zoomLevel;

            // Convert to data coordinates
            const now = Date.now();
            const startTime = now - (settings.timeSpan * 1000);

            const dataX = startTime + ((adjustedX - padding) / chartWidth) * (settings.timeSpan * 1000);
            const dataY = settings.yMax - ((adjustedY - padding) / chartHeight) * (settings.yMax - settings.yMin);

            return { x: dataX / 1000, y: dataY }; // Return time in seconds
        }

        function dataToPixelCoords(timestamp, value) {
            const padding = 40;
            const chartWidth = canvas.width - 2 * padding;
            const chartHeight = canvas.height - 2 * padding;

            const now = Date.now();
            const startTime = now - (settings.timeSpan * 1000);

            const x = padding + ((timestamp - startTime) / (settings.timeSpan * 1000)) * chartWidth;
            const y = padding + (1 - (value - settings.yMin) / (settings.yMax - settings.yMin)) * chartHeight;

            // Apply zoom and pan
            return {
                x: x * interactionState.zoomLevel + interactionState.panOffset.x,
                y: y * interactionState.zoomLevel + interactionState.panOffset.y
            };
        }

        // Professional navigation functions
        function zoomToSelection() {
            const left = Math.min(interactionState.selectionStart.x, interactionState.selectionEnd.x);
            const top = Math.min(interactionState.selectionStart.y, interactionState.selectionEnd.y);
            const width = Math.abs(interactionState.selectionEnd.x - interactionState.selectionStart.x);
            const height = Math.abs(interactionState.selectionEnd.y - interactionState.selectionStart.y);

            if (width < 10 || height < 10) return;

            // Calculate zoom to fit selection
            const zoomX = canvas.width / width;
            const zoomY = canvas.height / height;
            interactionState.zoomLevel = Math.min(zoomX, zoomY, 5); // Limit max zoom

            // Center on selection
            interactionState.panOffset.x = canvas.width / 2 - (left + width / 2) * interactionState.zoomLevel;
            interactionState.panOffset.y = canvas.height / 2 - (top + height / 2) * interactionState.zoomLevel;

            updateStatusDisplay();
            saveToHistory();
            drawWaveform();
        }

        function saveToHistory() {
            const state = {
                zoomLevel: interactionState.zoomLevel,
                panOffset: { ...interactionState.panOffset }
            };

            // Remove states after current index
            interactionState.history = interactionState.history.slice(0, interactionState.historyIndex + 1);

            // Add new state
            interactionState.history.push(state);
            interactionState.historyIndex++;

            // Limit history size
            if (interactionState.history.length > 50) {
                interactionState.history.shift();
                interactionState.historyIndex--;
            }
        }

        function undo() {
            if (interactionState.historyIndex > 0) {
                interactionState.historyIndex--;
                const state = interactionState.history[interactionState.historyIndex];
                interactionState.zoomLevel = state.zoomLevel;
                interactionState.panOffset = { ...state.panOffset };
                updateStatusDisplay();
                drawWaveform();
            }
        }

        function redo() {
            if (interactionState.historyIndex < interactionState.history.length - 1) {
                interactionState.historyIndex++;
                const state = interactionState.history[interactionState.historyIndex];
                interactionState.zoomLevel = state.zoomLevel;
                interactionState.panOffset = { ...state.panOffset };
                updateStatusDisplay();
                drawWaveform();
            }
        }

        function updateStatusDisplay() {
            document.getElementById('statusZoom').textContent = interactionState.zoomLevel.toFixed(1) + 'x';
            document.getElementById('statusRange').textContent = (settings.timeSpan / interactionState.zoomLevel).toFixed(1) + 's';
        }

        function hideAllPanels() {
            document.getElementById('settingsPanel').style.display = 'none';
            document.getElementById('fftPanel').style.display = 'none';
            const existingMenu = document.querySelector('.context-menu');
            if (existingMenu) {
                existingMenu.remove();
            }
        }

        // Bi-directional communication functions
        function highlightVariableInChart(expression) {
            // Find the variable and highlight it in the chart
            const variable = variables.find(v => v.expression === expression || v.id === expression);
            if (variable) {
                // Flash the legend item
                const legendItems = document.querySelectorAll('.legend-item');
                legendItems.forEach(item => {
                    if (item.textContent.includes(variable.name)) {
                        item.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
                        item.style.color = 'var(--vscode-list-activeSelectionForeground)';

                        setTimeout(() => {
                            item.style.backgroundColor = '';
                            item.style.color = '';
                        }, 2000);
                    }
                });

                // Show a tooltip notification
                showNotification('Highlighting: ' + variable.name, 'info');
            }
        }

        function toggleVariableInChart(expression, enabled) {
            const variable = variables.find(v => v.expression === expression || v.id === expression);
            if (variable) {
                variable.enabled = enabled;
                updateVariableList();
                updateLegend();
                drawWaveform();

                showNotification(variable.name + ' ' + (enabled ? 'enabled' : 'disabled'), 'info');
            }
        }

        function updateVariableStyleInChart(expression, style) {
            const variable = variables.find(v => v.expression === expression || v.id === expression);
            if (variable && style) {
                Object.assign(variable, style);
                updateLegend();
                drawWaveform();

                showNotification('Updated style for: ' + variable.name, 'info');
            }
        }

        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            const colors = {
                info: 'var(--vscode-notifications-background)',
                success: 'var(--vscode-testing-iconPassed)',
                warning: 'var(--vscode-testing-iconSkipped)',
                error: 'var(--vscode-testing-iconFailed)'
            };

            const styles = [
                'position: fixed',
                'top: 10px',
                'right: 10px',
                'background-color: var(--vscode-notifications-background)',
                'color: var(--vscode-notifications-foreground)',
                'border: 1px solid var(--vscode-notifications-border)',
                'border-radius: 4px',
                'padding: 8px 12px',
                'font-size: 12px',
                'font-family: var(--vscode-font-family)',
                'z-index: 10000',
                'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2)',
                'animation: slideIn 0.3s ease-out'
            ];

            notification.style.cssText = styles.join(';');
            notification.textContent = message;
            document.body.appendChild(notification);

            // Auto remove after 3 seconds
            setTimeout(() => {
                notification.style.animation = 'slideOut 0.3s ease-in';
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }, 3000);
        }

        // Add CSS animations for notifications
        const styleSheet = document.createElement('style');
        const keyframesSlideIn = '@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } ' +
                                 'to { transform: translateX(0); opacity: 1; } }';
        const keyframesSlideOut = '@keyframes slideOut { from { transform: translateX(0); opacity: 1; } ' +
                                   'to { transform: translateX(100%); opacity: 0; } }';
        styleSheet.textContent = keyframesSlideIn + ' ' + keyframesSlideOut;
        document.head.appendChild(styleSheet);

        // Memory management and cleanup
        let memoryCleanupInterval = setInterval(() => {
            performMemoryCleanup();
        }, 30000); // Cleanup every 30 seconds

        function performMemoryCleanup() {
            // Clean up old data points
            const now = Date.now();
            const maxAge = settings.timeSpan * 1000 * 2; // Keep 2x time span of data

            let totalPoints = 0;
            let removedPoints = 0;

            Object.keys(data).forEach(variableId => {
                const points = data[variableId];
                if (points && points.length > 0) {
                    const originalLength = points.length;

                    // Remove old points
                    const filteredPoints = points.filter(point =>
                        (now - point.timestamp) < maxAge
                    );

                    data[variableId] = filteredPoints;
                    removedPoints += originalLength - filteredPoints.length;
                    totalPoints += filteredPoints.length;
                }
            });

            // Force garbage collection hints
            if (removedPoints > 1000) {
                console.log('Memory cleanup: removed ' + removedPoints + ' old data points, kept ' + totalPoints);

                // Suggest garbage collection to browser
                if (window.gc) {
                    window.gc();
                }
            }

            // Clean up performance stats if too many entries
            if (performanceStats.frameCount > 10000) {
                performanceStats = {
                    frameCount: performanceStats.frameCount % 1000,
                    totalTime: performanceStats.totalTime % 1000,
                    maxFrameTime: performanceStats.maxFrameTime,
                    minFrameTime: performanceStats.minFrameTime,
                    lastStatsUpdate: performanceStats.lastStatsUpdate
                };
            }
        }

        // Performance monitoring for VSCode
        let vscodePerformanceReport = {
            lastReport: Date.now(),
            frameCount: 0,
            renderTime: 0
        };

        function reportVSCodePerformance() {
            const now = Date.now();
            const timeSinceLastReport = now - vscodePerformanceReport.lastReport;

            if (timeSinceLastReport >= 60000) { // Report every minute
                const avgFPS = vscodePerformanceReport.frameCount / (timeSinceLastReport / 1000);
                const avgRenderTime = vscodePerformanceReport.renderTime / vscodePerformanceReport.frameCount;

                // Send performance data to extension
                sendMessageToExtension('performanceReport', {
                    avgFPS: avgFPS.toFixed(1),
                    avgRenderTime: avgRenderTime.toFixed(2),
                    frameCount: vscodePerformanceReport.frameCount,
                    memoryUsage: getMemoryUsage()
                });

                // Reset counters
                vscodePerformanceReport = {
                    lastReport: now,
                    frameCount: 0,
                    renderTime: 0
                };
            }
        }

        function getMemoryUsage() {
            if (performance.memory) {
                return {
                    used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024), // MB
                    total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024), // MB
                    limit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) // MB
                };
            }
            return null;
        }

        // Enhanced resize handler with performance optimization
        let resizeTimeout;
        function handleResize() {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                const container = canvas.parentElement;
                canvas.width = container.clientWidth;
                canvas.height = container.clientHeight;

                // Trigger re-render after resize
                drawWaveform();

                // Report new dimensions to extension
                sendMessageToExtension('canvasResized', {
                    width: canvas.width,
                    height: canvas.height
                });
            }, 100); // Debounce resize events
        }

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            stopOptimizedRendering();
            clearInterval(memoryCleanupInterval);
            saveState();
        });

        // Handle messages from extension with improved error handling
        window.addEventListener('message', (event) => {
            try {
                const message = event.data;
                if (!message) return;

                switch (message.type) {
                    case 'dataUpdate':
                        handleDataUpdate(message);
                        break;
                    case 'fftResult':
                        handleFFTResult(message);
                        break;
                    case 'variableDataResponse':
                        handleVariableDataResponse(message);
                        break;
                    case 'highlightVariable':
                        handleHighlightVariable(message);
                        break;
                    case 'variableToggle':
                        handleVariableToggle(message);
                        break;
                    case 'variableStyleUpdate':
                        handleVariableStyleUpdate(message);
                        break;
                    case 'chartSettingsUpdate':
                        handleChartSettingsUpdate(message);
                        break;
                    case 'error':
                        handleError(message);
                        break;
                    default:
                        console.warn('Unknown message type:', message.type);
                }
            } catch (error) {
                console.error('Error handling message from extension:', error);
                showError('Communication error: ' + error.message);
            }
        });

        function handleDataUpdate(message) {
            if (!message.data) return;

            const now = Date.now();
            const timeSinceLastUpdate = now - appState.lastUpdateTime;

            // Update state
            appState.variables = message.variables || [];
            appState.data = message.data || {};
            appState.lastUpdateTime = now;

            // Update local variables for compatibility
            variables = appState.variables;
            data = appState.data;

            if (message.settings) {
                appState.settings = { ...appState.settings, ...message.settings };
                Object.assign(settings, appState.settings);
                saveState();
            }

            // Update UI
            updateVariableList();
            updateLegend();
            drawWaveform();

            // Update status
            appState.connectionStatus = 'connected';
            updateConnectionStatus();
        }

        function handleHighlightVariable(message) {
            if (message.data && message.data.expression) {
                highlightVariableInChart(message.data.expression);
            }
        }

        function handleVariableToggle(message) {
            if (message.data && message.data.expression) {
                toggleVariableInChart(message.data.expression, message.data.enabled);
            }
        }

        function handleVariableStyleUpdate(message) {
            if (message.data && message.data.expression) {
                updateVariableStyleInChart(message.data.expression, message.data.style);
            }
        }

        function handleChartSettingsUpdate(message) {
            if (message.data) {
                Object.assign(settings, message.data);
                appState.settings = { ...appState.settings, ...message.data };
                saveState();
                drawWaveform();
            }
        }

        function handleFFTResult(message) {
            if (message.result) {
                displayFFTResults(message.result);
            }
        }

        function handleVariableDataResponse(message) {
            if (message.data && message.data.variableId) {
                // Handle specific variable data response
                console.log('Received data for variable:', message.data.variableId);
            }
        }

        function handleError(message) {
            console.error('Extension error:', message.error);
            showError(message.error || 'An unknown error occurred');
            appState.connectionStatus = 'error';
            updateConnectionStatus();
        }

        function updateConnectionStatus() {
            const statusElement = document.getElementById('connectionStatus');
            if (statusElement) {
                statusElement.textContent = appState.connectionStatus;
                statusElement.className = 'status-value ' + appState.connectionStatus;
            }
        }

        function sendMessageToExtension(command, data = {}) {
            const message = {
                command: command,
                timestamp: Date.now(),
                ...data
            };

            try {
                vscode.postMessage(message);
            } catch (error) {
                console.error('Error sending message to extension:', error);
                showError('Communication error: ' + error.message);
            }
        }

        function updateVariableList() {
            const list = document.getElementById('variableList');
            if (!list) return;
            list.innerHTML = '';

            variables.forEach((variable, index) => {
                const item = document.createElement('div');
                item.className = 'variable-item ' + (variable.enabled ? '' : 'disabled');
                item.setAttribute('role', 'listitem');
                item.setAttribute('tabindex', '0');
                const ariaLabel = variable.name + ': ' +
                                  (variable.lastValue !== undefined ? variable.lastValue.toFixed(3) : 'No data') +
                                  '. ' + (variable.enabled ? 'Enabled' : 'Disabled');
                item.setAttribute('aria-label', ariaLabel);

                const colorIndicator = document.createElement('div');
                colorIndicator.className = 'color-indicator';
                colorIndicator.style.backgroundColor = variable.color;
                colorIndicator.setAttribute('aria-hidden', 'true');

                const info = document.createElement('div');
                info.className = 'variable-info';

                const name = document.createElement('div');
                name.className = 'variable-name';
                name.textContent = variable.name;

                const value = document.createElement('div');
                value.className = 'variable-value';
                value.textContent = variable.lastValue !== undefined ? variable.lastValue.toFixed(3) : 'No data';

                info.appendChild(name);
                info.appendChild(value);

                item.appendChild(colorIndicator);
                item.appendChild(info);

                const toggleVariable = () => {
                    variable.enabled = !variable.enabled;
                    vscode.postMessage({
                        command: 'toggleVariable',
                        variableId: variable.id,
                        enabled: variable.enabled
                    });
                    updateVariableList();
                    updateLegend();
                };

                item.addEventListener('click', toggleVariable);
                item.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleVariable();
                    }
                });

                list.appendChild(item);
            });
        }

        function updateLegend() {
            const legend = document.getElementById('legend');
            legend.innerHTML = '';

            const enabledVariables = variables.filter(v => v.enabled);
            if (enabledVariables.length === 0) {
                legend.style.display = 'none';
                return;
            }

            legend.style.display = 'block';
            enabledVariables.forEach(variable => {
                const item = document.createElement('div');
                item.className = 'legend-item';

                const color = document.createElement('div');
                color.className = 'legend-color';
                color.style.backgroundColor = variable.color;

                const name = document.createElement('span');
                name.textContent = variable.name;

                item.appendChild(color);
                item.appendChild(name);
                legend.appendChild(item);
            });
        }

        function drawWaveform() {
            if (!ctx) return;

            // Update FPS counter
            frameCount++;
            const now = Date.now();
            if (now - lastFpsUpdate >= 1000) {
                fps = frameCount;
                frameCount = 0;
                lastFpsUpdate = now;
                document.getElementById('statusFPS').textContent = fps;
            }

            // Save context state for performance
            ctx.save();

            // Clear canvas with optimization
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Apply transformations once
            ctx.translate(interactionState.panOffset.x, interactionState.panOffset.y);
            ctx.scale(interactionState.zoomLevel, interactionState.zoomLevel);

            // Draw grid first (background)
            drawGrid();

            // Batch draw all variables for better performance
            const enabledVariables = variables.filter(v => v.enabled);
            if (enabledVariables.length > 0) {
                // Pre-calculate common values
                const padding = 40;
                const chartWidth = canvas.width - 2 * padding;
                const chartHeight = canvas.height - 2 * padding;
                const timeSpanMs = settings.timeSpan * 1000;
                const now = Date.now();
                const startTime = now - timeSpanMs;

                // Draw all variables with minimal context switches
                enabledVariables.forEach(variable => {
                    const points = data[variable.id];
                    if (points && points.length > 1) {
                        drawVariableOptimized(variable, points, padding, chartWidth, chartHeight, startTime, timeSpanMs);
                    }
                });
            }

            // Restore context state
            ctx.restore();
        }

        function drawGrid() {
            const btn = document.getElementById('btnGrid');
            if (!btn || !btn.classList.contains('active')) return;

            ctx.save();

            ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-panel-border');
            ctx.lineWidth = 1;

            // Apply zoom and pan transformations
            ctx.translate(interactionState.panOffset.x, interactionState.panOffset.y);
            ctx.scale(interactionState.zoomLevel, interactionState.zoomLevel);

            const padding = 40;
            const chartWidth = canvas.width - 2 * padding;
            const chartHeight = canvas.height - 2 * padding;

            // Vertical grid lines
            for (let i = 0; i <= 10; i++) {
                const x = padding + (chartWidth / 10) * i;
                ctx.beginPath();
                ctx.moveTo(x, padding);
                ctx.lineTo(x, padding + chartHeight);
                ctx.stroke();
            }

            // Horizontal grid lines
            for (let i = 0; i <= 5; i++) {
                const y = padding + (chartHeight / 5) * i;
                ctx.beginPath();
                ctx.moveTo(padding, y);
                ctx.lineTo(padding + chartWidth, y);
                ctx.stroke();
            }

            ctx.restore();
        }

        function drawVariable(variable, points) {
            // Legacy function - use drawVariableOptimized instead
            const padding = 40;
            const chartWidth = canvas.width - 80;
            const chartHeight = canvas.height - 80;
            const timeStart = Date.now() - (settings.timeSpan * 1000);
            const timeRange = settings.timeSpan * 1000;
            drawVariableOptimized(variable, points, padding, chartWidth, chartHeight, timeStart, timeRange);
        }

        function drawVariableOptimized(variable, points, padding, chartWidth, chartHeight, startTime, timeSpanMs) {
            if (points.length === 0) return;

            // Set style once
            ctx.strokeStyle = variable.color;
            ctx.lineWidth = variable.lineWidth || 2;
            ctx.globalAlpha = variable.opacity || 1.0;

            // Apply line style
            if (variable.lineStyle === 'dashed') {
                ctx.setLineDash([5, 5]);
            } else if (variable.lineStyle === 'dotted') {
                ctx.setLineDash([2, 2]);
            } else {
                ctx.setLineDash([]);
            }

            ctx.beginPath();

            // Calculate value range once
            let yMin = settings.yMin;
            let yMax = settings.yMax;

            if (settings.yAxisMode === 'auto') {
                // Optimized min/max calculation
                let minVal = points[0].value;
                let maxVal = points[0].value;
                for (let i = 1; i < points.length; i++) {
                    const val = points[i].value;
                    if (val < minVal) minVal = val;
                    if (val > maxVal) maxVal = val;
                }
                yMin = minVal;
                yMax = maxVal;
                const rangePadding = (yMax - yMin) * 0.1;
                yMin -= rangePadding;
                yMax += rangePadding;
            }

            const yRange = yMax - yMin;
            const xScale = chartWidth / timeSpanMs;
            const yScale = chartHeight / yRange;

            // Optimized drawing loop
            let firstPoint = true;
            for (let i = 0; i < points.length; i++) {
                const point = points[i];
                const x = padding + ((point.timestamp - startTime) * xScale);
                const y = padding + (1 - (point.value - yMin) / yRange) * chartHeight;

                if (firstPoint) {
                    ctx.moveTo(x, y);
                    firstPoint = false;
                } else {
                    ctx.lineTo(x, y);
                }
            }

            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1.0;
        }

        function toggleSettings() {
            const panel = document.getElementById('settingsPanel');
            panel.classList.toggle('active');

            if (panel.classList.contains('active')) {
                document.getElementById('timeSpan').value = settings.timeSpan;
                document.getElementById('refreshRate').value = settings.refreshRate;
                document.getElementById('maxDataPoints').value = settings.maxDataPoints;
            }
        }

        function applySettings() {
            const newSettings = {
                timeSpan: parseFloat(document.getElementById('timeSpan').value),
                refreshRate: parseFloat(document.getElementById('refreshRate').value),
                maxDataPoints: parseInt(document.getElementById('maxDataPoints').value)
            };

            vscode.postMessage({
                command: 'updateSettings',
                settings: newSettings
            });

            toggleSettings();
        }

        function exportData(format) {
            sendMessageToExtension('exportData', { format: format });
        }

        function clearAllData() {
            if (confirm('Are you sure you want to clear all waveform data?')) {
                sendMessageToExtension('clearAllData');
            }
        }

        function performFFT(variableId) {
            const windowSize = prompt('Enter FFT window size (256-4096):', '512');
            const windowFunction = prompt('Enter window function (hanning/hamming/blackman/rectangular):', 'hanning');

            if (windowSize && windowFunction) {
                sendMessageToExtension('performFFT', {
                    variableId: variableId,
                    windowSize: parseInt(windowSize),
                    windowFunction: windowFunction
                });
            }
        }

        function displayFFTResults(result) {
            const panel = document.getElementById('fftPanel');
            const results = document.getElementById('fftResults');

            let html = '<h5>Analysis Results</h5>';
            html += '<p><strong>Dominant Frequency:</strong> ' + result.dominantFrequency.frequency.toFixed(2) + ' Hz</p>';
            html += '<p><strong>Dominant Magnitude:</strong> ' + result.dominantFrequency.magnitude.toFixed(2) + ' dB</p>';
            html += '<p><strong>Noise Floor:</strong> ' + result.noiseFloor.toFixed(2) + ' dB</p>';
            html += '<p><strong>THD:</strong> ' + (result.thd * 100).toFixed(3) + '%</p>';

            html += '<h6>Top Peaks:</h6>';
            result.peaks.slice(0, 5).forEach((peak, i) => {
                html += '<p>' + (i+1) + '. ' + peak.frequency.toFixed(2) + ' Hz, ' + peak.magnitude.toFixed(2) + ' dB</p>';
            });

            results.innerHTML = html;
            panel.classList.add('active');
        }

        function closeFFT() {
            document.getElementById('fftPanel').classList.remove('active');
        }

        // Performance-optimized rendering with requestAnimationFrame
        let animationFrameId: number | null = null;
        let lastRenderTime = 0;
        const targetFPS = 30; // Target 30 FPS for smooth animation
        const frameInterval = 1000 / targetFPS;

        function scheduleRender() {
            const now = performance.now();
            const deltaTime = now - lastRenderTime;

            if (deltaTime >= frameInterval) {
                drawWaveform();
                lastRenderTime = now - (deltaTime % frameInterval);
            }

            if (appState.isRecording || interactionState.isDragging || interactionState.isMeasuring) {
                animationFrameId = requestAnimationFrame(scheduleRender);
            }
        }

        // Performance monitoring
        let performanceStats = {
            frameCount: 0,
            totalTime: 0,
            maxFrameTime: 0,
            minFrameTime: Infinity,
            lastStatsUpdate: Date.now()
        };

        function measurePerformance() {
            const start = performance.now();
            drawWaveform();
            const end = performance.now();
            const frameTime = end - start;

            performanceStats.frameCount++;
            performanceStats.totalTime += frameTime;
            performanceStats.maxFrameTime = Math.max(performanceStats.maxFrameTime, frameTime);
            performanceStats.minFrameTime = Math.min(performanceStats.minFrameTime, frameTime);

            // Update stats every 5 seconds
            const now = Date.now();
            if (now - performanceStats.lastStatsUpdate > 5000) {
                const avgFrameTime = performanceStats.totalTime / performanceStats.frameCount;
                const avgFPS = 1000 / avgFrameTime;
                const logMsg = 'Waveform Performance: Avg FPS: ' + avgFPS.toFixed(1) +
                               ', Frame Time: ' + avgFrameTime.toFixed(2) + 'ms (min: ' +
                               performanceStats.minFrameTime.toFixed(2) + 'ms, max: ' +
                               performanceStats.maxFrameTime.toFixed(2) + 'ms)';
                console.log(logMsg);

                // Reset stats
                performanceStats = {
                    frameCount: 0,
                    totalTime: 0,
                    maxFrameTime: 0,
                    minFrameTime: Infinity,
                    lastStatsUpdate: now
                };
            }
        }

        // Optimized update loop
        function startOptimizedRendering() {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
            scheduleRender();
        }

        function stopOptimizedRendering() {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
        }

        // Update timer with performance optimization
        setInterval(() => {
            if (appState.isRecording) {
                startOptimizedRendering();
            } else {
                measurePerformance(); // Measure performance even when not recording
            }
        }, 1000 / settings.refreshRate);
    </script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private cleanup(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = undefined;
        }

        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    public dispose(): void {
        this.hide();
        this.cleanup();
    }
}
