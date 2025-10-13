/**
 * Waveform Client
 *
 * Main client-side logic for the waveform viewer
 */

/// <reference lib="dom" />

import { WebGLRenderer } from './webgl-renderer';
import { Canvas2DRenderer } from './canvas2d-renderer';
import {
    IRenderer,
    WaveformVariable,
    WaveformSettings,
    ViewPort,
    UIState,
    WaveformMessage,
    VariableDataUpdateMessage
} from './types';

// VS Code API
declare function acquireVsCodeApi(): any;

class WaveformClient {
    private vscode: any;
    private renderer: IRenderer | null = null;
    private canvas: HTMLCanvasElement;

    // Data
    private variables: Map<string, WaveformVariable> = new Map();
    private settings: WaveformSettings;
    private viewport: ViewPort;

    // UI State
    private uiState: UIState;

    // Animation
    private animationFrameId: number | null = null;
    private isRecording = false;

    // UI Elements
    private elements: {
        variableList: HTMLElement;
        filterInput: HTMLInputElement;
        legend: HTMLElement;
        tooltip: HTMLElement;
        statusFPS: HTMLElement;
        statusVariables: HTMLElement;
        statusDataPoints: HTMLElement;
        statusZoom: HTMLElement;
        statusRenderer: HTMLElement;
        performanceIndicator: HTMLElement;
        fpsDisplay: HTMLElement;
    };

    constructor() {
        this.vscode = acquireVsCodeApi();

        // Get canvas element
        this.canvas = document.getElementById('waveformCanvas') as HTMLCanvasElement;
        if (!this.canvas) {
            throw new Error('Canvas element not found');
        }

        // Default settings
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
            renderer: 'webgl'
        };

        // Default viewport
        this.viewport = {
            xMin: 0,
            xMax: this.settings.timeSpan * 1000,
            yMin: 0,
            yMax: 1
        };

        // UI State
        this.uiState = {
            selectedVariables: new Set(),
            hoveredVariable: null,
            measurementActive: false,
            zoomLevel: 1.0,
            panOffset: { x: 0, y: 0 },
            filterText: '',
            filterMode: 'text',
            caseSensitive: false,
            activeFilters: new Set()
        };

        // Get UI elements
        this.elements = {
            variableList: document.getElementById('variableList'),
            filterInput: document.getElementById('filterInput') as HTMLInputElement,
            legend: document.getElementById('legend'),
            tooltip: document.getElementById('tooltip'),
            statusFPS: document.getElementById('statusFPS'),
            statusVariables: document.getElementById('statusVariables'),
            statusDataPoints: document.getElementById('statusDataPoints'),
            statusZoom: document.getElementById('statusZoom'),
            statusRenderer: document.getElementById('statusRenderer'),
            performanceIndicator: document.getElementById('performanceIndicator'),
            fpsDisplay: document.getElementById('fpsDisplay')
        };

        this.initialize();
    }

    private initialize(): void {
        // Initialize renderer
        this.initializeRenderer();

        // Setup event listeners
        this.setupEventListeners();

        // Setup message handler
        this.setupMessageHandler();

        // Start render loop
        this.startRenderLoop();

        // Request initial data
        this.sendMessage({ command: 'requestInitialData' });

        console.log('[WaveformClient] Initialized');
    }

    private initializeRenderer(): void {
        try {
            if (this.settings.renderer === 'webgl') {
                this.renderer = new WebGLRenderer(this.canvas);
                this.elements.statusRenderer.textContent = 'WebGL';
            } else {
                this.renderer = new Canvas2DRenderer(this.canvas);
                this.elements.statusRenderer.textContent = 'Canvas 2D';
            }

            this.renderer.initialize();
            this.resizeRenderer();
        } catch (error) {
            console.error('[WaveformClient] Renderer initialization failed:', error);

            // Fallback to Canvas 2D
            if (this.settings.renderer === 'webgl') {
                console.log('[WaveformClient] Falling back to Canvas 2D');
                this.settings.renderer = 'canvas2d';
                this.renderer = new Canvas2DRenderer(this.canvas);
                this.renderer.initialize();
                this.elements.statusRenderer.textContent = 'Canvas 2D (Fallback)';
            }
        }
    }

    private setupEventListeners(): void {
        // Window resize
        window.addEventListener('resize', () => this.resizeRenderer());

        // Toolbar buttons
        document.getElementById('btnRecord')?.addEventListener('click', () => this.toggleRecording());
        document.getElementById('btnClear')?.addEventListener('click', () => this.clearData());
        document.getElementById('btnExport')?.addEventListener('click', () => this.exportData());
        document.getElementById('btnZoomIn')?.addEventListener('click', () => this.zoom(1.2));
        document.getElementById('btnZoomOut')?.addEventListener('click', () => this.zoom(0.8));
        document.getElementById('btnZoomFit')?.addEventListener('click', () => this.zoomFit());
        document.getElementById('btnGrid')?.addEventListener('click', () => this.toggleGrid());
        document.getElementById('btnLegend')?.addEventListener('click', () => this.toggleLegend());
        document.getElementById('btnMeasure')?.addEventListener('click', () => this.toggleMeasurement());
        document.getElementById('btnFFT')?.addEventListener('click', () => this.showFFT());
        document.getElementById('btnSettings')?.addEventListener('click', () => this.showSettings());

        // Filter input
        this.elements.filterInput.addEventListener('input', () => this.applyFilter());

        // Canvas interactions
        this.canvas.addEventListener('wheel', (e) => this.handleWheel(e));
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.canvas.addEventListener('mouseleave', () => this.hideTooltip());
    }

    private setupMessageHandler(): void {
        window.addEventListener('message', (event) => {
            const message: WaveformMessage = event.data;

            switch (message.command) {
                case 'dataUpdate':
                    this.handleDataUpdate(message);
                    break;
                case 'variableDataUpdate':
                    this.handleVariableDataUpdate(message as VariableDataUpdateMessage);
                    break;
                case 'settingsUpdate':
                    this.handleSettingsUpdate(message);
                    break;
                case 'toggleVariable':
                    this.handleToggleVariable(message);
                    break;
                default:
                    console.log('[WaveformClient] Unknown message:', message);
            }
        });
    }

    private startRenderLoop(): void {
        const render = () => {
            if (this.renderer) {
                const variables = Array.from(this.variables.values());

                this.renderer.render(variables, this.viewport, {
                    showGrid: this.settings.showGrid,
                    showLegend: this.settings.showLegend,
                    antiAlias: true
                });

                // Update performance display
                const metrics = this.renderer.getPerformanceMetrics();
                this.updatePerformanceDisplay(metrics.fps);
            }

            this.animationFrameId = requestAnimationFrame(render);
        };

        render();
    }

    private resizeRenderer(): void {
        if (!this.renderer) return;

        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.renderer.resize(rect.width, rect.height);
    }

    // Event Handlers
    private handleDataUpdate(message: any): void {
        if (message.variables) {
            this.variables.clear();

            for (const variable of message.variables) {
                this.variables.set(variable.id, {
                    ...variable,
                    data: []
                });
            }

            this.updateVariableList();
        }

        if (message.settings) {
            this.settings = { ...this.settings, ...message.settings };
        }
    }

    private handleVariableDataUpdate(message: VariableDataUpdateMessage): void {
        for (const [variableId, dataPoints] of Object.entries(message.data)) {
            const variable = this.variables.get(variableId);
            if (variable) {
                variable.data = dataPoints;

                // Update viewport if auto-scaling
                if (this.settings.yAxisMode === 'auto') {
                    this.updateAutoScale();
                }
            }
        }

        this.updateStatusBar();
    }

    private handleSettingsUpdate(message: any): void {
        this.settings = { ...this.settings, ...message.settings };

        // Update viewport if time span changed
        if (message.settings.timeSpan) {
            this.viewport.xMax = message.settings.timeSpan * 1000;
        }
    }

    private handleToggleVariable(message: any): void {
        const variable = this.variables.get(message.variableId);
        if (variable) {
            variable.enabled = message.enabled;
            this.updateVariableList();
        }
    }

    // Actions
    private toggleRecording(): void {
        this.isRecording = !this.isRecording;

        const btn = document.getElementById('btnRecord');
        if (btn) {
            btn.classList.toggle('active', this.isRecording);
        }

        this.sendMessage({
            command: this.isRecording ? 'startRecording' : 'stopRecording'
        });
    }

    private clearData(): void {
        if (confirm('Clear all waveform data?')) {
            this.sendMessage({ command: 'clearAllData' });

            // Clear local data
            for (const variable of this.variables.values()) {
                variable.data = [];
            }
        }
    }

    private exportData(): void {
        this.sendMessage({ command: 'exportData', format: 'json' });
    }

    private zoom(factor: number): void {
        this.uiState.zoomLevel *= factor;

        const range = this.viewport.xMax - this.viewport.xMin;
        const newRange = range / factor;
        const center = (this.viewport.xMin + this.viewport.xMax) / 2;

        this.viewport.xMin = center - newRange / 2;
        this.viewport.xMax = center + newRange / 2;

        this.updateStatusBar();
    }

    private zoomFit(): void {
        this.uiState.zoomLevel = 1.0;
        this.viewport.xMin = 0;
        this.viewport.xMax = this.settings.timeSpan * 1000;
        this.updateAutoScale();
        this.updateStatusBar();
    }

    private toggleGrid(): void {
        this.settings.showGrid = !this.settings.showGrid;
        const btn = document.getElementById('btnGrid');
        if (btn) {
            btn.classList.toggle('active', this.settings.showGrid);
        }
    }

    private toggleLegend(): void {
        this.settings.showLegend = !this.settings.showLegend;
        this.elements.legend.style.display = this.settings.showLegend ? 'block' : 'none';

        const btn = document.getElementById('btnLegend');
        if (btn) {
            btn.classList.toggle('active', this.settings.showLegend);
        }

        if (this.settings.showLegend) {
            this.updateLegend();
        }
    }

    private toggleMeasurement(): void {
        this.uiState.measurementActive = !this.uiState.measurementActive;

        const btn = document.getElementById('btnMeasure');
        if (btn) {
            btn.classList.toggle('active', this.uiState.measurementActive);
        }
    }

    private showFFT(): void {
        // TODO: Implement FFT dialog
        console.log('[WaveformClient] FFT analysis');
    }

    private showSettings(): void {
        // TODO: Implement settings dialog
        console.log('[WaveformClient] Settings dialog');
    }

    private applyFilter(): void {
        this.uiState.filterText = this.elements.filterInput.value.toLowerCase();
        this.updateVariableList();
    }

    // Mouse handlers
    private handleWheel(event: WheelEvent): void {
        event.preventDefault();
        const factor = event.deltaY > 0 ? 0.9 : 1.1;
        this.zoom(factor);
    }

    private handleMouseDown(event: MouseEvent): void {
        // TODO: Implement pan/zoom interactions
    }

    private handleMouseMove(event: MouseEvent): void {
        // TODO: Show tooltip with values
    }

    private handleMouseUp(event: MouseEvent): void {
        // TODO: Complete pan/zoom interaction
    }

    private hideTooltip(): void {
        this.elements.tooltip.style.display = 'none';
    }

    // UI Updates
    private updateVariableList(): void {
        const listHtml: string[] = [];

        for (const variable of this.variables.values()) {
            // Apply filter
            if (this.uiState.filterText
                && !variable.name.toLowerCase().includes(this.uiState.filterText)) {
                continue;
            }

            const selected = this.uiState.selectedVariables.has(variable.id);
            const lastValue = variable.data.length > 0
                ? variable.data[variable.data.length - 1].value.toFixed(3)
                : '-';

            listHtml.push(`
                <div class="variable-item ${selected ? 'selected' : ''}"
                     data-id="${variable.id}">
                    <div class="color-indicator" style="background-color: ${variable.color}"></div>
                    <span class="variable-name">${variable.name}</span>
                    <span class="variable-value">${lastValue}</span>
                </div>
            `);
        }

        this.elements.variableList.innerHTML = listHtml.join('');

        // Add click handlers
        this.elements.variableList.querySelectorAll('.variable-item').forEach((item) => {
            item.addEventListener('click', () => {
                const id = (item as HTMLElement).dataset.id;
                const variable = this.variables.get(id);
                if (variable) {
                    variable.enabled = !variable.enabled;
                    this.sendMessage({
                        command: 'toggleVariable',
                        variableId: id,
                        enabled: variable.enabled
                    });
                    this.updateVariableList();
                }
            });
        });
    }

    private updateLegend(): void {
        const legendHtml: string[] = [];

        for (const variable of this.variables.values()) {
            if (!variable.enabled) continue;

            legendHtml.push(`
                <div class="legend-item">
                    <div class="legend-color" style="background-color: ${variable.color}"></div>
                    <span>${variable.name}</span>
                </div>
            `);
        }

        this.elements.legend.innerHTML = legendHtml.join('');
    }

    private updateStatusBar(): void {
        this.elements.statusVariables.textContent = String(this.variables.size);

        let totalPoints = 0;
        for (const variable of this.variables.values()) {
            totalPoints += variable.data.length;
        }
        this.elements.statusDataPoints.textContent = String(totalPoints);

        this.elements.statusZoom.textContent = `${this.uiState.zoomLevel.toFixed(1)}x`;
    }

    private updatePerformanceDisplay(fps: number): void {
        this.elements.statusFPS.textContent = String(Math.round(fps));
        this.elements.fpsDisplay.textContent = `${Math.round(fps)} FPS`;

        // Update indicator color
        const indicator = this.elements.performanceIndicator;
        indicator.className = 'performance-indicator';
        if (fps >= 50) {
            indicator.classList.add('good');
        } else if (fps >= 30) {
            indicator.classList.add('warning');
        } else {
            indicator.classList.add('bad');
        }
    }

    private updateAutoScale(): void {
        if (this.settings.yAxisMode !== 'auto') return;

        let min = Infinity;
        let max = -Infinity;

        for (const variable of this.variables.values()) {
            if (!variable.enabled) continue;

            for (const point of variable.data) {
                if (point.timestamp < this.viewport.xMin || point.timestamp > this.viewport.xMax) {
                    continue;
                }
                if (point.value < min) min = point.value;
                if (point.value > max) max = point.value;
            }
        }

        if (min !== Infinity && max !== -Infinity) {
            const range = max - min;
            const padding = range * 0.1;
            this.viewport.yMin = min - padding;
            this.viewport.yMax = max + padding;
        }
    }

    private sendMessage(message: WaveformMessage): void {
        this.vscode.postMessage(message);
    }
}

// Initialize client when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new WaveformClient();
    });
} else {
    new WaveformClient();
}
