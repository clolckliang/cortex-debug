/**
 * Waveform WebView Manager
 *
 * Manages the waveform viewer webview panel
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IWaveformDataProvider } from './data-provider';

export class WaveformWebViewManager {
    private panel: vscode.WebviewPanel | undefined;
    private readonly context: vscode.ExtensionContext;
    private readonly dataProvider: IWaveformDataProvider;
    private disposables: vscode.Disposable[] = [];
    private updateTimer: NodeJS.Timeout | null = null;

    constructor(
        context: vscode.ExtensionContext,
        dataProvider: IWaveformDataProvider
    ) {
        this.context = context;
        this.dataProvider = dataProvider;
    }

    public show(): void {
        const column = vscode.ViewColumn.One;

        if (this.panel) {
            this.panel.reveal(column);
            return;
        }

        // Get renderer preference
        const config = vscode.workspace.getConfiguration('cortex-debug');
        const rendererType = config.get('waveformRenderer', 'webgl') as string;

        this.panel = vscode.window.createWebviewPanel(
            'cortexDebugWaveform',
            `Waveform Monitor (${rendererType === 'webgl' ? 'WebGL' : 'Canvas 2D'})`,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                    vscode.Uri.joinPath(this.context.extensionUri, 'src', 'frontend', 'views', 'waveform')
                ]
            }
        );

        // Set panel icon
        this.panel.iconPath = {
            light: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon.png'),
            dark: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'icon.png')
        };

        // Set HTML content
        this.panel.webview.html = this.getHtmlContent();

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            null,
            this.disposables
        );

        // Handle panel disposal
        this.panel.onDidDispose(
            () => {
                this.stopAutoUpdate();
                this.panel = undefined;
                this.disposables.forEach((d) => {
                    d.dispose();
                });
                this.disposables = [];
            },
            null,
            this.disposables
        );

        // Send initial data
        this.sendInitialData();

        // Start auto-update
        this.startAutoUpdate();
    }

    public dispose(): void {
        this.stopAutoUpdate();

        if (this.panel) {
            this.panel.dispose();
        }

        this.disposables.forEach((d) => {
            d.dispose();
        });
        this.disposables = [];
    }

    private getHtmlContent(): string {
        if (!this.panel) return '';

        try {
            // Read HTML template
            const htmlPath = vscode.Uri.joinPath(
                this.context.extensionUri,
                'src',
                'frontend',
                'views',
                'waveform',
                'waveform.html'
            );

            let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

            // Get codicons URI
            const codiconsUri = this.getCodiconsUri();

            // Get script URI (bundled client)
            const scriptUri = this.panel.webview.asWebviewUri(
                vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'waveform-client.js')
            );

            // Generate nonce for CSP
            const nonce = this.getNonce();

            // Replace placeholders
            htmlContent = htmlContent
                .replace(/\${webview\.cspSource}/g, this.panel.webview.cspSource)
                .replace(/\${nonce}/g, nonce)
                .replace(
                    /\${codiconsUri.*?}/g,
                    codiconsUri ? `<link href="${codiconsUri}" rel="stylesheet" />` : ''
                )
                .replace(/\${scriptUri}/g, scriptUri.toString());

            return htmlContent;
        } catch (error) {
            console.error('[WaveformWebViewManager] Error loading HTML:', error);
            vscode.window.showErrorMessage('Failed to load waveform view');
            return '<html><body>Error loading waveform view</body></html>';
        }
    }

    private getCodiconsUri(): string | undefined {
        if (!this.panel) return undefined;

        try {
            const codiconsExtension = vscode.extensions.getExtension('@vscode/codicons')
                || vscode.extensions.getExtension('vscode.codicons');

            if (codiconsExtension) {
                return this.panel.webview.asWebviewUri(
                    vscode.Uri.joinPath(codiconsExtension.extensionUri, 'dist', 'codicon.css')
                ).toString();
            }
        } catch (error) {
            console.warn('[WaveformWebViewManager] Could not load codicons:', error);
        }

        return undefined;
    }

    private getNonce(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let text = '';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private handleMessage(message: any): void {
        switch (message.command) {
            case 'requestInitialData':
                this.sendInitialData();
                break;

            case 'startRecording':
                this.dataProvider.startRecording();
                break;

            case 'stopRecording':
                this.dataProvider.stopRecording();
                break;

            case 'clearAllData':
                this.dataProvider.clearAllData();
                this.sendVariableData();
                break;

            case 'toggleVariable':
                // Variable enable/disable is handled by the data provider
                break;

            case 'exportData':
                this.handleExportData(message.format);
                break;

            case 'updateSettings':
                this.dataProvider.updateSettings(message.settings);
                break;

            case 'performFFT':
                // TODO: Implement FFT analysis
                break;

            case 'toggleLiveWatchIntegration':
                this.dataProvider.useLiveWatchData(message.enabled);
                this.sendInitialData(); // Refresh data
                break;

            case 'syncWithLiveWatch':
                this.syncWithLiveWatch();
                break;

            default:
                console.log('[WaveformWebViewManager] Unknown message:', message);
        }
    }

    private sendInitialData(): void {
        if (!this.panel) return;

        const variables = this.dataProvider.getVariables();
        const settings = this.dataProvider.getSettings();

        this.panel.webview.postMessage({
            command: 'dataUpdate',
            variables: variables,
            settings: settings
        });

        // Send initial data
        this.sendVariableData();
    }

    private sendVariableData(): void {
        if (!this.panel) return;

        const allData = this.dataProvider.getAllData();
        const dataObject: { [key: string]: any[] } = {};

        for (const [variableId, dataPoints] of allData) {
            dataObject[variableId] = dataPoints;
        }

        this.panel.webview.postMessage({
            command: 'variableDataUpdate',
            data: dataObject
        });
    }

    private handleExportData(format: 'json' | 'csv'): void {
        try {
            const data = this.dataProvider.exportData(format);
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const defaultUri = vscode.Uri.file(`waveform_data_${timestamp}.${format}`);

            vscode.window.showSaveDialog({
                defaultUri: defaultUri,
                filters: format === 'json'
                    ? { 'JSON Files': ['json'] }
                    : { 'CSV Files': ['csv'] }
            }).then((uri) => {
                if (uri) {
                    vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf8'));
                    vscode.window.showInformationMessage(`Waveform data exported to ${uri.fsPath}`);
                }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to export data: ${errorMessage}`);
        }
    }

    private startAutoUpdate(): void {
        if (this.updateTimer) return;

        // Update at 10 Hz
        this.updateTimer = setInterval(() => {
            this.sendVariableData();
        }, 100);
    }

    private stopAutoUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }

    public refreshData(): void {
        this.sendVariableData();
    }

    public addVariable(expression: string, name: string): boolean {
        const added = this.dataProvider.addVariable(expression, name);

        if (added) {
            this.sendInitialData();
        }

        return added;
    }

    public toggleVariable(expression: string, enabled: boolean): void {
        this.dataProvider.updateVariableSettings(expression, { enabled });

        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'toggleVariable',
                expression,
                enabled
            });
        }
    }

    public highlightVariable(expression: string): void {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'highlightVariable',
                expression
            });
        }
    }

    private syncWithLiveWatch(): void {
        if (!this.dataProvider) {
            return;
        }

        try {
            // Sync variables with Live Watch
            (this.dataProvider as any).syncWithLiveWatch();

            // Send updated data to webview
            this.sendInitialData();

            console.log('[WaveformWebViewManager] Synced with Live Watch');
        } catch (error) {
            console.error('[WaveformWebViewManager] Error syncing with Live Watch:', error);
        }
    }
}
