/**
 * Waveform Viewer Type Definitions
 *
 * Core types and interfaces for the waveform visualization system
 */

// ==================== Data Types ====================

export interface WaveformDataPoint {
    timestamp: number;
    value: number;
}

export interface WaveformVariable {
    id: string;
    name: string;
    color: string;
    enabled: boolean;
    visible?: boolean;
    displayType?: 'analog' | 'bit' | 'state' | 'hex' | 'binary';
    lineWidth?: number;
    lineStyle?: 'solid' | 'dashed' | 'dotted';
    opacity?: number;
    data: WaveformDataPoint[];
}

export interface WaveformSettings {
    timeSpan: number;          // seconds
    refreshRate: number;        // Hz
    maxDataPoints: number;
    yAxisMode: 'auto' | 'manual';
    yMin: number | null;
    yMax: number | null;
    showGrid: boolean;
    showLegend: boolean;
    colorScheme: string;
    renderer: 'webgl' | 'canvas2d';
}

// ==================== Renderer Interface ====================

export interface RenderContext {
    width: number;
    height: number;
    devicePixelRatio: number;
}

export interface ViewPort {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
}

export interface RenderOptions {
    showGrid?: boolean;
    showLegend?: boolean;
    showCrosshair?: boolean;
    antiAlias?: boolean;
    lineWidth?: number;
}

export interface IRenderer {
    /**
     * Initialize the renderer
     */
    initialize(): void;

    /**
     * Render the waveform
     */
    render(variables: WaveformVariable[], viewport: ViewPort, options: RenderOptions): void;

    /**
     * Clear the canvas
     */
    clear(): void;

    /**
     * Resize the canvas
     */
    resize(width: number, height: number): void;

    /**
     * Dispose resources
     */
    dispose(): void;

    /**
     * Get performance metrics
     */
    getPerformanceMetrics(): PerformanceMetrics;
}

export interface PerformanceMetrics {
    fps: number;
    frameTime: number;
    drawCalls: number;
    vertexCount: number;
    memoryUsage?: number;
}

// ==================== Event Types ====================

export interface WaveformMessage {
    command: string;
    [key: string]: any;
}

export interface VariableDataUpdateMessage extends WaveformMessage {
    command: 'variableDataUpdate';
    data: { [variableId: string]: WaveformDataPoint[] };
}

export interface SettingsUpdateMessage extends WaveformMessage {
    command: 'settingsUpdate';
    settings: Partial<WaveformSettings>;
}

export interface VariableToggleMessage extends WaveformMessage {
    command: 'toggleVariable';
    variableId: string;
    enabled: boolean;
}

// ==================== UI State ====================

export interface UIState {
    selectedVariables: Set<string>;
    hoveredVariable: string | null;
    measurementActive: boolean;
    zoomLevel: number;
    panOffset: { x: number; y: number };
    filterText: string;
    filterMode: 'text' | 'regex';
    caseSensitive: boolean;
    activeFilters: Set<string>;
}

// ==================== Export/Import ====================

export interface ExportData {
    version: string;
    timestamp: string;
    settings: WaveformSettings;
    variables: WaveformVariable[];
}

// ==================== Utility Types ====================

export type ColorScheme = {
    [key: string]: string[];
};

export interface Bounds {
    min: number;
    max: number;
}

export interface Point2D {
    x: number;
    y: number;
}

export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}
