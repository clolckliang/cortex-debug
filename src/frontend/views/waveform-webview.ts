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

                case 'configureVariable':
                    // Forward to extension command
                    if (message.variableId) {
                        const variable = this.dataProvider.getVariable(message.variableId);
                        if (variable) {
                            vscode.commands.executeCommand('cortex-debug.liveWatch.configureForWaveform', {
                                getExpr: () => variable.id,
                                getName: () => variable.name
                            });
                        }
                    }
                    break;

                case 'changeColor':
                    if (message.variableId) {
                        const variableId = message.variableId as string;
                        vscode.commands.executeCommand('cortex-debug.waveform.setStyleFromNode', {
                            getExpr: (): string => variableId,
                            getName: (): string => this.dataProvider.getVariable(variableId)?.name || ''
                        });
                    }
                    break;

                case 'changeDisplayType':
                    if (message.variableId) {
                        const variableId = message.variableId as string;
                        vscode.commands.executeCommand('cortex-debug.waveform.changeDisplayType', {
                            getExpr: (): string => variableId,
                            getName: (): string => this.dataProvider.getVariable(variableId)?.name || ''
                        });
                    }
                    break;

                case 'configureGroup':
                    if (message.variableId) {
                        const variableId = message.variableId as string;
                        vscode.commands.executeCommand('cortex-debug.waveform.configureGroup', {
                            getExpr: (): string => variableId,
                            getName: (): string => this.dataProvider.getVariable(variableId)?.name || ''
                        });
                    }
                    break;

                case 'configureTrigger':
                    if (message.variableId) {
                        const variableId = message.variableId as string;
                        vscode.commands.executeCommand('cortex-debug.waveform.configureTrigger', {
                            getExpr: (): string => variableId,
                            getName: (): string => this.dataProvider.getVariable(variableId)?.name || ''
                        });
                    }
                    break;

                case 'showStatistics':
                    if (message.variableId) {
                        const variableId = message.variableId as string;
                        vscode.commands.executeCommand('cortex-debug.waveform.showStatistics', {
                            getExpr: (): string => variableId,
                            getName: (): string => this.dataProvider.getVariable(variableId)?.name || ''
                        });
                    }
                    break;

                case 'removeVariable':
                    if (message.variableId) {
                        this.dataProvider.removeVariable(message.variableId);
                        this.sendDataUpdate();
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

        // Get waveform client script URI
        const scriptUri = this.webviewPanel?.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'waveform-client.js')
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

        /* Quick Filter Bar */
        .filter-container {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-sideBar-background);
        }

        .filter-input {
            width: 100%;
            padding: 4px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 12px;
            outline: none;
        }

        .filter-input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .filter-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .filter-chips {
            display: flex;
            gap: 4px;
            margin-top: 6px;
            flex-wrap: wrap;
        }

        .filter-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 6px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            font-size: 10px;
            cursor: pointer;
            user-select: none;
        }

        .filter-chip:hover {
            opacity: 0.8;
        }

        .filter-chip.active {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .filter-mode-btn {
            width: 28px;
            height: 28px;
            padding: 0;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-input-foreground);
            transition: background-color 0.1s, border-color 0.1s;
        }

        .filter-mode-btn:hover {
            background-color: var(--vscode-inputOption-hoverBackground) !important;
        }

        .filter-mode-btn.active {
            background-color: var(--vscode-inputOption-activeBackground) !important;
            color: var(--vscode-inputOption-activeForeground) !important;
            border-color: var(--vscode-inputOption-activeBorder) !important;
        }

        .filter-mode-btn .codicon {
            font-size: 14px;
        }

        .filter-input-row {
            display: flex;
            gap: 4px;
            align-items: center;
        }

        .filter-input {
            flex: 1;
        }

        .filter-error {
            color: var(--vscode-errorForeground);
            font-size: 10px;
            padding: 2px 8px;
            margin-top: 2px;
        }

        .filter-chip .codicon {
            font-size: 11px;
        }

        /* Signal Group Headers */
        .group-header {
            display: flex;
            align-items: center;
            padding: 0 12px;
            height: 24px;
            background-color: var(--vscode-sideBarSectionHeader-background);
            color: var(--vscode-sideBarSectionHeader-foreground);
            cursor: pointer;
            user-select: none;
            font-size: 12px;
            font-weight: 600;
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
        }

        .group-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .group-chevron {
            margin-right: 4px;
            transition: transform 0.2s ease;
            font-size: 14px;
        }

        .group-header.collapsed .group-chevron {
            transform: rotate(-90deg);
        }

        .group-count {
            margin-left: auto;
            opacity: 0.6;
            font-size: 10px;
            font-weight: normal;
        }

        .group-actions {
            display: none;
            gap: 2px;
            margin-left: 8px;
        }

        .group-header:hover .group-actions {
            display: flex;
        }

        .group-action-btn {
            width: 18px;
            height: 18px;
            padding: 0;
            background: transparent;
            border: none;
            border-radius: 3px;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background-color 0.1s;
        }

        .group-action-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .group-action-btn .codicon {
            font-size: 12px;
        }

        .group-items {
            overflow: hidden;
            transition: max-height 0.3s ease;
        }

        .group-items.collapsed {
            max-height: 0 !important;
        }

        .group-item {
            padding-left: 28px; /* Indent for group hierarchy */
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

        /* Drag-and-drop styles */
        .variable-item.dragging {
            opacity: 0.4;
            cursor: grabbing;
        }

        .variable-item.drop-before {
            border-top: 2px solid var(--vscode-focusBorder);
        }

        .variable-item.drop-after {
            border-bottom: 2px solid var(--vscode-focusBorder);
        }

        .variable-item[draggable="true"] {
            cursor: grab;
        }

        .variable-item[draggable="true"]:active {
            cursor: grabbing;
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

        /* Variable type icon and metadata */
        .variable-type-icon {
            margin-left: 6px;
            font-size: 12px;
            opacity: 0.6;
            flex-shrink: 0;
        }

        .variable-metadata {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 10px;
            opacity: 0.5;
            margin-top: 2px;
            padding-left: 20px;
        }

        .metadata-badge {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            padding: 1px 4px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 9px;
        }

        .trigger-indicator {
            color: var(--vscode-debugIcon-breakpointForeground);
        }

        .variable-item.has-trigger .variable-name {
            font-weight: 600;
        }

        .variable-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground) !important;
            color: var(--vscode-list-activeSelectionForeground) !important;
        }

        /* Context Menu */
        .variable-context-menu {
            position: fixed;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            padding: 4px 0;
            z-index: 10000;
            min-width: 200px;
            max-width: 300px;
        }

        .context-menu-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            user-select: none;
        }

        .context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }

        .context-menu-item .codicon {
            width: 16px;
            font-size: 14px;
            text-align: center;
        }

        .context-menu-separator {
            height: 1px;
            background-color: var(--vscode-menu-separatorBackground);
            margin: 4px 0;
        }

        .context-menu-item.disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .context-menu-item.disabled:hover {
            background-color: transparent;
            color: inherit;
        }

        /* Enhanced tooltip */
        .enhanced-tooltip {
            position: fixed;
            background-color: var(--vscode-editor-hoverHighlightBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 10px;
            font-size: 11px;
            pointer-events: none;
            z-index: 5000;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            max-width: 320px;
        }

        .tooltip-header {
            font-weight: 600;
            margin-bottom: 6px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .tooltip-row {
            display: flex;
            justify-content: space-between;
            padding: 2px 0;
            gap: 16px;
        }

        .tooltip-label {
            opacity: 0.7;
        }

        .tooltip-value {
            font-family: var(--vscode-editor-font-family);
            font-weight: 500;
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

                <!-- Quick Filter -->
                <div class="filter-container">
                    <div class="filter-input-row">
                        <input
                            type="text"
                            class="filter-input"
                            id="filterInput"
                            placeholder="🔍 Filter variables..."
                            aria-label="Filter variables"
                        />
                        <button
                            class="filter-mode-btn"
                            id="filterModeBtn"
                            title="Toggle search mode (text/regex)"
                            aria-label="Toggle search mode"
                        >
                            <i class="codicon codicon-regex"></i>
                        </button>
                        <button
                            class="filter-mode-btn"
                            id="caseSensitiveBtn"
                            title="Toggle case sensitive search"
                            aria-label="Toggle case sensitive"
                        >
                            <i class="codicon codicon-case-sensitive"></i>
                        </button>
                    </div>
                    <div class="filter-chips" id="filterChips">
                        <div class="filter-chip" data-filter="analog" title="Show analog signals">
                            <i class="codicon codicon-pulse"></i>
                            <span>Analog</span>
                        </div>
                        <div class="filter-chip" data-filter="bit" title="Show bit/digital signals">
                            <i class="codicon codicon-symbol-boolean"></i>
                            <span>Bit</span>
                        </div>
                        <div class="filter-chip" data-filter="state" title="Show state signals">
                            <i class="codicon codicon-symbol-enum"></i>
                            <span>State</span>
                        </div>
                        <div class="filter-chip" data-filter="trigger" title="Show signals with triggers">
                            <i class="codicon codicon-debug-breakpoint-conditional"></i>
                            <span>Trigger</span>
                        </div>
                    </div>
                </div>

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

    <script nonce="${nonce}" src="${String(scriptUri)}"></script>
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
