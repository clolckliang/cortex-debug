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
                retainContextWhenHidden: true
            }
        );

        this.webviewPanel.webview.html = this.getWebviewContent();

        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = undefined;
            this.cleanup();
        }, null, this.disposables);

        // Setup message handling
        this.webviewPanel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
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
        switch (message.command) {
            case 'requestInitialData':
                this.sendDataUpdate();
                break;
            case 'toggleVariable':
                this.dataProvider.updateVariableSettings(message.variableId, {
                    enabled: message.enabled
                });
                break;
            case 'updateSettings':
                this.dataProvider.updateSettings(message.settings);
                break;
            case 'exportData':
                this.handleExportData(message.format);
                break;
            case 'performFFT':
                this.handleFFTAnalysis(message.variableId, message.windowSize, message.windowFunction);
                break;
        }
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
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Waveform Monitor</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            margin: 0;
            padding: 10px;
            overflow: hidden;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .controls {
            display: flex;
            gap: 10px;
        }

        .controls button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 10px;
            cursor: pointer;
            border-radius: 3px;
        }

        .controls button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .main-content {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        .sidebar {
            width: 200px;
            border-right: 1px solid var(--vscode-panel-border);
            padding: 10px;
            overflow-y: auto;
        }

        .chart-container {
            flex: 1;
            position: relative;
        }

        #waveformCanvas {
            width: 100%;
            height: 100%;
            cursor: crosshair;
        }

        .variable-item {
            display: flex;
            align-items: center;
            padding: 5px;
            margin: 2px 0;
            border-radius: 3px;
            cursor: pointer;
        }

        .variable-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .variable-item.disabled {
            opacity: 0.5;
        }

        .color-indicator {
            width: 12px;
            height: 12px;
            border-radius: 2px;
            margin-right: 8px;
        }

        .variable-info {
            flex: 1;
            font-size: 12px;
        }

        .variable-name {
            font-weight: bold;
        }

        .variable-value {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }

        .fft-panel {
            position: absolute;
            top: 10px;
            right: 10px;
            width: 300px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 10px;
            display: none;
            max-height: 400px;
            overflow-y: auto;
        }

        .fft-panel.active {
            display: block;
        }

        .settings-panel {
            position: absolute;
            top: 10px;
            left: 10px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 10px;
            display: none;
        }

        .settings-panel.active {
            display: block;
        }

        .settings-group {
            margin-bottom: 10px;
        }

        .settings-group label {
            display: block;
            margin-bottom: 3px;
            font-size: 12px;
        }

        .settings-group input, .settings-group select {
            width: 100%;
            padding: 3px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
        }

        .legend {
            position: absolute;
            bottom: 10px;
            left: 10px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 5px;
            font-size: 11px;
        }

        .legend-item {
            display: flex;
            align-items: center;
            margin: 2px 0;
        }

        .legend-color {
            width: 10px;
            height: 10px;
            margin-right: 5px;
            border-radius: 1px;
        }

        .tooltip {
            position: absolute;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            padding: 5px;
            font-size: 11px;
            pointer-events: none;
            display: none;
            z-index: 1000;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>Waveform Monitor</h2>
            <div class="controls">
                <button onclick="toggleSettings()">Settings</button>
                <button onclick="exportData('json')">Export JSON</button>
                <button onclick="exportData('csv')">Export CSV</button>
                <button onclick="clearAllData()">Clear All</button>
            </div>
        </div>

        <div class="main-content">
            <div class="sidebar">
                <h3>Variables</h3>
                <div id="variableList"></div>
            </div>

            <div class="chart-container">
                <canvas id="waveformCanvas"></canvas>

                <div class="settings-panel" id="settingsPanel">
                    <h4>Chart Settings</h4>
                    <div class="settings-group">
                        <label>Time Span (seconds):</label>
                        <input type="number" id="timeSpan" min="1" max="300" step="1">
                    </div>
                    <div class="settings-group">
                        <label>Refresh Rate (Hz):</label>
                        <input type="number" id="refreshRate" min="0.1" max="20" step="0.1">
                    </div>
                    <div class="settings-group">
                        <label>Max Data Points:</label>
                        <input type="number" id="maxDataPoints" min="100" max="50000" step="100">
                    </div>
                    <div class="settings-group">
                        <button onclick="applySettings()">Apply</button>
                        <button onclick="toggleSettings()">Cancel</button>
                    </div>
                </div>

                <div class="fft-panel" id="fftPanel">
                    <h4>FFT Analysis</h4>
                    <div id="fftResults"></div>
                    <button onclick="closeFFT()">Close</button>
                </div>

                <div class="legend" id="legend"></div>
                <div class="tooltip" id="tooltip"></div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
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

        // Initialize canvas
        window.addEventListener('load', () => {
            canvas = document.getElementById('waveformCanvas');
            ctx = canvas.getContext('2d');
            resizeCanvas();
            window.addEventListener('resize', resizeCanvas);

            // Request initial data
            vscode.postMessage({ command: 'requestInitialData' });
        });

        function resizeCanvas() {
            const container = canvas.parentElement;
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;
            drawWaveform();
        }

        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.type) {
                case 'dataUpdate':
                    variables = message.variables;
                    data = message.data;
                    settings = message.settings;
                    updateVariableList();
                    updateLegend();
                    drawWaveform();
                    break;
                case 'fftResult':
                    displayFFTResults(message.result);
                    break;
            }
        });

        function updateVariableList() {
            const list = document.getElementById('variableList');
            list.innerHTML = '';

            variables.forEach(variable => {
                const item = document.createElement('div');
                item.className = \`variable-item \${variable.enabled ? '' : 'disabled'}\`;

                const colorIndicator = document.createElement('div');
                colorIndicator.className = 'color-indicator';
                colorIndicator.style.backgroundColor = variable.color;

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

                item.addEventListener('click', () => {
                    variable.enabled = !variable.enabled;
                    vscode.postMessage({
                        command: 'toggleVariable',
                        variableId: variable.id,
                        enabled: variable.enabled
                    });
                    updateVariableList();
                    updateLegend();
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

            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw grid
            drawGrid();

            // Draw each variable
            variables.filter(v => v.enabled).forEach(variable => {
                const points = data[variable.id];
                if (points && points.length > 1) {
                    drawVariable(variable, points);
                }
            });
        }

        function drawGrid() {
            ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-panel-border');
            ctx.lineWidth = 1;

            // Vertical grid lines
            for (let i = 0; i <= 10; i++) {
                const x = (canvas.width / 10) * i;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, canvas.height);
                ctx.stroke();
            }

            // Horizontal grid lines
            for (let i = 0; i <= 5; i++) {
                const y = (canvas.height / 5) * i;
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(canvas.width, y);
                ctx.stroke();
            }
        }

        function drawVariable(variable, points) {
            if (points.length === 0) return;

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

            const padding = 40;
            const chartWidth = canvas.width - 2 * padding;
            const chartHeight = canvas.height - 2 * padding;

            // Calculate time range
            const now = Date.now();
            const startTime = now - (settings.timeSpan * 1000);

            // Calculate value range
            let yMin = settings.yMin;
            let yMax = settings.yMax;

            if (settings.yAxisMode === 'auto') {
                const allValues = points.map(p => p.value);
                yMin = Math.min(...allValues);
                yMax = Math.max(...allValues);
                const padding = (yMax - yMin) * 0.1;
                yMin -= padding;
                yMax += padding;
            }

            // Draw the line
            points.forEach((point, index) => {
                const x = padding + ((point.timestamp - startTime) / (settings.timeSpan * 1000)) * chartWidth;
                const y = padding + (1 - (point.value - yMin) / (yMax - yMin)) * chartHeight;

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });

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
            vscode.postMessage({
                command: 'exportData',
                format: format
            });
        }

        function clearAllData() {
            if (confirm('Are you sure you want to clear all waveform data?')) {
                // This would need to be implemented in the extension
                vscode.postMessage({ command: 'clearAll' });
            }
        }

        function performFFT(variableId) {
            const windowSize = prompt('Enter FFT window size (256-4096):', '512');
            const windowFunction = prompt('Enter window function (hanning/hamming/blackman/rectangular):', 'hanning');

            if (windowSize && windowFunction) {
                vscode.postMessage({
                    command: 'performFFT',
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
            html += \`<p><strong>Dominant Frequency:</strong> \${result.dominantFrequency.frequency.toFixed(2)} Hz</p>\`;
            html += \`<p><strong>Dominant Magnitude:</strong> \${result.dominantFrequency.magnitude.toFixed(2)} dB</p>\`;
            html += \`<p><strong>Noise Floor:</strong> \${result.noiseFloor.toFixed(2)} dB</p>\`;
            html += \`<p><strong>THD:</strong> \${(result.thd * 100).toFixed(3)}%</p>\`;

            html += '<h6>Top Peaks:</h6>';
            result.peaks.slice(0, 5).forEach((peak, i) => {
                html += \`<p>\${i+1}. \${peak.frequency.toFixed(2)} Hz, \${peak.magnitude.toFixed(2)} dB</p>\`;
            });

            results.innerHTML = html;
            panel.classList.add('active');
        }

        function closeFFT() {
            document.getElementById('fftPanel').classList.remove('active');
        }

        // Update timer for auto-refresh
        setInterval(() => {
            drawWaveform();
        }, 1000);
    </script>
</body>
</html>`;
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
