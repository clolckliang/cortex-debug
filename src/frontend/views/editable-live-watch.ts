/**
 * Editable Live Watch Webview Panel
 * Provides an Excel-like editable table view for Live Watch variables
 * with support for structure/union expand/collapse
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { LiveWatchTreeProvider, LiveVariableNode } from './live-watch';

export class EditableLiveWatchPanel {
    private static currentPanel: EditableLiveWatchPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private liveWatchProvider: LiveWatchTreeProvider;
    private updateInterval: NodeJS.Timeout | undefined;
    private samplingInterval: NodeJS.Timeout | undefined; // High-speed sampling
    private previousValues: Map<string, string> = new Map(); // Track value changes
    private cachedData: any[] = []; // Cache for sampled data
    private samplingRate: number = 10; // Backend sampling rate in ms
    private displayRate: number = 250; // Frontend display rate in ms

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        liveWatchProvider: LiveWatchTreeProvider
    ) {
        this.panel = panel;
        this.liveWatchProvider = liveWatchProvider;

        // Set the webview's initial html content
        this.panel.webview.html = this.getWebviewContent();

        // Listen for when the panel is disposed
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'setValue':
                        await this.handleSetValue(message.path, message.value);
                        break;
                    case 'toggleExpand':
                        this.handleToggleExpand(message.path);
                        break;
                    case 'ready':
                        this.startAutoUpdate();
                        break;
                    case 'startEdit':
                        // Pause updates during editing
                        this.pauseUpdates();
                        break;
                    case 'finishEdit':
                        // Resume updates after editing
                        this.resumeUpdates();
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        liveWatchProvider: LiveWatchTreeProvider
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (EditableLiveWatchPanel.currentPanel) {
            EditableLiveWatchPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'editableLiveWatch',
            'Editable Live Watch',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        EditableLiveWatchPanel.currentPanel = new EditableLiveWatchPanel(
            panel,
            extensionUri,
            liveWatchProvider
        );
    }

    private async handleSetValue(path: string[], value: string) {
        // Find the node by path
        const node = this.findNodeByPath(path);
        if (node && node.setValue) {
            try {
                await node.setValue(value);
                // Refresh data after successful update
                this.sendUpdate();
            } catch (error) {
                this.panel.webview.postMessage({
                    command: 'error',
                    message: `Failed to set value: ${error}`
                });
            }
        }
    }

    private handleToggleExpand(path: string[]) {
        const node = this.findNodeByPath(path);
        if (node) {
            node.expanded = !node.expanded;
            this.liveWatchProvider.saveState();
            this.sendUpdate();
        }
    }

    private findNodeByPath(path: string[]): LiveVariableNode | undefined {
        if (path.length === 0) {
            return undefined;
        }

        // Get root variables from live watch provider
        const roots = this.liveWatchProvider['variables']?.getChildren() || [];

        let current: LiveVariableNode | undefined;

        // Find root node
        for (const root of roots) {
            if (root.getName && root.getName() === path[0]) {
                current = root;
                break;
            }
        }

        if (!current) {
            return undefined;
        }

        // Traverse path
        for (let i = 1; i < path.length; i++) {
            const children = current.getChildren ? current.getChildren() : [];
            let found = false;

            for (const child of children) {
                if (child.getName && child.getName() === path[i]) {
                    current = child;
                    found = true;
                    break;
                }
            }

            if (!found) {
                return undefined;
            }
        }

        return current;
    }

    private startAutoUpdate() {
        // Update every 250ms (same as live watch default)
        this.updateInterval = setInterval(() => {
            this.sendUpdate();
        }, 250);
    }

    private pauseUpdates() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = undefined;
        }
    }

    private resumeUpdates() {
        if (!this.updateInterval) {
            this.startAutoUpdate();
        }
    }

    private async sendUpdate() {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            return;
        }

        // Get data from live watch provider
        const data = await this.collectLiveWatchData();

        this.panel.webview.postMessage({
            command: 'update',
            data: data
        });
    }

    private async collectLiveWatchData(): Promise<any[]> {
        const roots = this.liveWatchProvider['variables']?.getChildren() || [];
        const result: any[] = [];

        for (const root of roots) {
            const item = await this.nodeToDataItem(root);
            if (item) {
                result.push(item);
            }
        }

        return result;
    }

    private async nodeToDataItem(node: LiveVariableNode, pathPrefix: string = ''): Promise<any> {
        const name = node.getName ? node.getName() : '';
        const value = node.getCopyValue ? node.getCopyValue() : '';
        const type = node['type'] || '';
        const children = node.getChildren ? node.getChildren() : [];
        const expanded = node['expanded'] || false;

        // Build full path for value tracking
        const fullPath = pathPrefix ? `${pathPrefix}.${name}` : name;
        const previousValue = this.previousValues.get(fullPath);
        const changed = previousValue !== undefined && previousValue !== value;

        // Update previous value
        this.previousValues.set(fullPath, value);

        const item: any = {
            name,
            value,
            type,
            expanded,
            changed,
            children: []
        };

        // Only include actual children, not message nodes
        const realChildren = children.filter((c) => c.getName && c.getName() !== '');

        if (realChildren.length > 0) {
            for (const child of realChildren) {
                const childItem = await this.nodeToDataItem(child, fullPath);
                if (childItem) {
                    item.children.push(childItem);
                }
            }
        }

        return item;
    }

    private getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Editable Live Watch</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
        }

        .tree-table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }

        .tree-table th {
            background-color: var(--vscode-editorGroupHeader-tabsBackground);
            padding: 8px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            z-index: 10;
        }

        .tree-table td {
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .tree-row {
            transition: background-color 0.15s;
        }

        .tree-row:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .tree-row.changed {
            background-color: var(--vscode-diffEditor-insertedTextBackground);
        }

        .indent {
            display: inline-block;
            width: 20px;
        }

        .expand-icon {
            display: inline-block;
            width: 16px;
            height: 16px;
            cursor: pointer;
            user-select: none;
            text-align: center;
            line-height: 16px;
        }

        .expand-icon:before {
            content: '▶';
            font-size: 10px;
            transition: transform 0.15s;
            display: inline-block;
        }

        .expand-icon.expanded:before {
            transform: rotate(90deg);
        }

        .expand-icon.leaf {
            visibility: hidden;
        }

        .value-cell {
            cursor: text;
            min-height: 20px;
        }

        .value-cell:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .value-input {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 2px 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }

        .value-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .type-column {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        .error-message {
            color: var(--vscode-errorForeground);
            padding: 10px;
            margin: 10px 0;
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <table class="tree-table">
        <thead>
            <tr>
                <th style="width: 50%">Name</th>
                <th style="width: 30%">Value</th>
                <th style="width: 20%">Type</th>
            </tr>
        </thead>
        <tbody id="data-body">
        </tbody>
    </table>

    <script>
        const vscode = acquireVsCodeApi();
        let currentData = [];
        let editingCell = null;

        // Notify ready
        vscode.postMessage({ command: 'ready' });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'update':
                    updateData(message.data);
                    break;
                case 'error':
                    showError(message.message);
                    break;
            }
        });

        function updateData(data) {
            currentData = data;
            renderTable();
        }

        function renderTable() {
            const tbody = document.getElementById('data-body');
            tbody.innerHTML = '';

            currentData.forEach(item => {
                renderRow(item, tbody, 0, []);
            });
        }

        function renderRow(item, container, level, path) {
            const tr = document.createElement('tr');
            tr.className = 'tree-row';
            if (item.changed) {
                tr.classList.add('changed');
            }

            // Name cell
            const nameTd = document.createElement('td');
            const indent = ''.padStart(level * 20, ' ');
            const expandIcon = document.createElement('span');
            expandIcon.className = 'expand-icon';

            if (item.children && item.children.length > 0) {
                if (item.expanded) {
                    expandIcon.classList.add('expanded');
                }
                expandIcon.onclick = () => toggleExpand(path);
            } else {
                expandIcon.classList.add('leaf');
            }

            const nameSpan = document.createElement('span');
            nameSpan.textContent = item.name;

            nameTd.innerHTML = indent;
            nameTd.appendChild(expandIcon);
            nameTd.appendChild(nameSpan);

            // Value cell
            const valueTd = document.createElement('td');
            valueTd.className = 'value-cell';
            valueTd.textContent = item.value || '';
            valueTd.onclick = () => startEdit(valueTd, item, path);

            // Type cell
            const typeTd = document.createElement('td');
            typeTd.className = 'type-column';
            typeTd.textContent = item.type || '';

            tr.appendChild(nameTd);
            tr.appendChild(valueTd);
            tr.appendChild(typeTd);
            container.appendChild(tr);

            // Render children if expanded
            if (item.expanded && item.children) {
                item.children.forEach(child => {
                    renderRow(child, container, level + 1, [...path, item.name]);
                });
            }
        }

        function toggleExpand(path) {
            vscode.postMessage({
                command: 'toggleExpand',
                path: path
            });
        }

        function startEdit(cell, item, path) {
            if (editingCell) {
                finishEdit(false);
            }

            // Notify extension to pause updates
            vscode.postMessage({ command: 'startEdit' });

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'value-input';
            input.value = item.value || '';

            input.onblur = () => finishEdit(true);
            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    finishEdit(true);
                } else if (e.key === 'Escape') {
                    finishEdit(false);
                }
            };

            cell.textContent = '';
            cell.appendChild(input);
            input.focus();
            input.select();

            editingCell = { cell, input, item, path, originalValue: item.value };
        }

        function finishEdit(save) {
            if (!editingCell) return;

            const { cell, input, item, path, originalValue } = editingCell;
            const newValue = input.value;

            if (save && newValue !== originalValue) {
                vscode.postMessage({
                    command: 'setValue',
                    path: [...path, item.name],
                    value: newValue
                });
            }

            cell.textContent = save ? newValue : originalValue;
            editingCell = null;

            // Notify extension to resume updates
            vscode.postMessage({ command: 'finishEdit' });
        }

        function showError(message) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.textContent = message;
            document.body.insertBefore(errorDiv, document.body.firstChild);
            setTimeout(() => errorDiv.remove(), 5000);
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        EditableLiveWatchPanel.currentPanel = undefined;

        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
