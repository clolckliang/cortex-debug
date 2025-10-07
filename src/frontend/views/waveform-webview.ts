import * as vscode from 'vscode';
import * as fs from 'fs';
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
                localResourceRoots: [
                    this.context.extensionUri,
                    vscode.Uri.joinPath(this.context.extensionUri, 'node_modules'),
                    vscode.Uri.joinPath(this.context.extensionUri, 'dist')
                ]
            }
        );

        this.webviewPanel.webview.html = this.getWebviewContent();
        this.setupWebviewListeners();

        // Send initial data after a short delay to ensure webview is ready
        setTimeout(() => {
            this.sendInitialData();
        }, 100);
    }

    public hide(): void {
        if (this.webviewPanel) {
            this.webviewPanel.dispose();
        }
    }

    private setupUpdateTimer(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        this.updateTimer = setInterval(() => {
            this.sendDataUpdate();
        }, 1000); // Update every second
    }

    public dispose(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        for (const d of this.disposables) {
            if (d) {
                d.dispose();
            }
        }
        this.webviewPanel?.dispose();
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

        // Read HTML template
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'frontend', 'views', 'waveform.html');
        const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

        // Replace template variables
        return htmlContent
            .replace(/\${nonce}/g, nonce)
            .replace(/\${webview\.cspSource}/g, this.webviewPanel?.webview.cspSource || '')
            .replace(/\${codiconsUri}/g, String(codiconsUri || ''))
            .replace(/\${scriptUri}/g, String(scriptUri));
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private setupWebviewListeners(): void {
        if (!this.webviewPanel) {
            return;
        }

        // Handle messages from webview
        this.webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                try {
                    console.log('[Waveform Extension] Received message:', message);

                    switch (message.command) {
                        case 'requestInitialData':
                            this.handleRequestInitialData();
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

                        case 'exportData':
                            if (message.format) {
                                await this.handleExportData(message.format);
                            }
                            break;

                        case 'toggleVariable':
                            if (message.variableId) {
                                this.dataProvider.updateVariableSettings(message.variableId, {
                                    enabled: message.enabled
                                });
                                this.sendDataUpdate();
                            }
                            break;

                        case 'removeVariable':
                            if (message.variableId) {
                                this.dataProvider.removeVariable(message.variableId);
                                this.sendDataUpdate();
                            }
                            break;

                        case 'updateSettings':
                            if (message.settings) {
                                this.dataProvider.updateSettings(message.settings);
                                this.sendDataUpdate();
                            }
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

                        case 'getStructMembers':
                            if (message.variableId) {
                                const variable = this.dataProvider.getVariable(message.variableId);
                                if (variable) {
                                    const parsed = this.dataProvider.getParsedStructure(variable.expression || '');
                                    if (parsed) {
                                        this.sendMessage('structMembersUpdate', {
                                            variableId: message.variableId,
                                            structMembers: parsed.members.map((member) => ({
                                                name: member.name,
                                                path: member.path,
                                                value: member.value,
                                                type: member.type,
                                                numericValue: member.numericValue,
                                                selected: false
                                            }))
                                        });
                                    }
                                }
                            }
                            break;

                        case 'toggleStructMember':
                            if (message.parentVariableId && message.memberPath !== undefined) {
                                const variable = this.dataProvider.getVariable(message.parentVariableId);
                                if (variable) {
                                    const success = this.dataProvider.toggleStructMemberSelection(
                                        variable.expression || '',
                                        message.memberPath,
                                        message.selected
                                    );

                                    if (success) {
                                        const selectedMembers = this.dataProvider.getSelectedMembers(variable.expression || '');
                                        this.sendMessage('structMemberSelectionUpdate', {
                                            variableId: message.parentVariableId,
                                            selectedMembers: selectedMembers
                                        });
                                    }
                                }
                            }
                            break;

                        case 'performFFT':
                            if (message.variableId && message.windowSize && message.windowFunction) {
                                this.handleFFTAnalysis(message.variableId, message.windowSize, message.windowFunction);
                            }
                            break;

                        default:
                            console.warn('[Waveform Extension] Unknown command:', message.command);
                    }
                } catch (error) {
                    console.error('[Waveform Extension] Error handling message:', error);
                    this.sendMessage('error', { message: `Error: ${error}` });
                }
            },
            undefined,
            this.disposables
        );

        // Handle webview disposal
        this.webviewPanel.onDidDispose(
            () => {
                this.webviewPanel = undefined;
            },
            undefined,
            this.disposables
        );
    }

    private handleRequestInitialData(): void {
        try {
            console.log('[Waveform Extension] Handling request for initial data');

            // Send connection status first
            this.sendMessage('connectionStatus', { connected: true });

            // Get actual data
            const variables = this.dataProvider.getVariables();
            const data = this.dataProvider.getAllData();
            const settings = this.dataProvider.getSettings();

            console.log('[Waveform Extension] Data summary:', {
                variablesCount: variables.length,
                dataKeysCount: Object.keys(data).length,
                hasSettings: !!settings
            });

            // Send initial data
            this.sendMessage('dataUpdate', {
                variables: variables,
                data: data,
                settings: settings,
                timestamp: Date.now()
            });

            console.log('[Waveform Extension] Initial data sent successfully');
        } catch (error) {
            console.error('[Waveform Extension] Error sending initial data:', error);
            this.sendMessage('error', { message: `Failed to load initial data: ${error}` });
        }
    }

    private sendInitialData(): void {
        this.handleRequestInitialData();
    }

    private sendDataUpdate(): void {
        if (!this.webviewPanel) {
            return;
        }

        try {
            const variables = this.dataProvider.getVariables();
            const data = this.dataProvider.getAllData();
            const settings = this.dataProvider.getSettings();

            this.sendMessage('dataUpdate', {
                variables: variables,
                data: data,
                settings: settings,
                timestamp: Date.now()
            });

            // Also send connection status to ensure it's always up to date
            this.sendMessage('connectionStatus', { connected: true });
        } catch (error) {
            console.error('[Waveform Extension] Error sending data update:', error);
        }
    }

    public highlightVariable(expression: string): void {
        this.sendMessage('highlightVariable', {
            expression: expression
        });
    }

    public toggleVariable(expression: string, enabled: boolean): void {
        this.sendMessage('toggleVariable', {
            expression: expression,
            enabled: enabled
        });
    }

    public refreshData(): void {
        this.sendDataUpdate();
    }

    private sendMessage(command: string, data?: any): void {
        if (this.webviewPanel) {
            const message = {
                command: command,
                data: data
            };

            console.log('[Waveform Extension] Sending message:', command, data ? JSON.stringify(data).substring(0, 100) + '...' : '');

            this.webviewPanel.webview.postMessage(message);
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
                const fsModule = await import('fs');
                fsModule.writeFileSync(uri.fsPath, data);
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
                    command: 'fftResult',
                    result: result
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`FFT analysis failed: ${error}`);
        }
    }
}
