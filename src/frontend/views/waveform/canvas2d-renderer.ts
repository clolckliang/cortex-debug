/**
 * Canvas 2D Renderer
 *
 * Standard Canvas 2D-based waveform renderer
 */

/// <reference lib="dom" />

import { RendererBase } from './renderer-base';
import { WaveformVariable, ViewPort, RenderOptions } from './types';

export class Canvas2DRenderer extends RendererBase {
    private ctx: CanvasRenderingContext2D;

    constructor(canvas: HTMLCanvasElement) {
        super(canvas);

        const ctx = canvas.getContext('2d', {
            alpha: true,
            desynchronized: true // For better performance
        });

        if (!ctx) {
            throw new Error('Canvas 2D context is not available');
        }

        this.ctx = ctx;
    }

    public initialize(): void {
        // Set up context properties
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        console.log('[Canvas2DRenderer] Initialized');
    }

    public render(variables: WaveformVariable[], viewport: ViewPort, options: RenderOptions): void {
        const ctx = this.ctx;

        // Clear canvas
        ctx.clearRect(0, 0, this.context.width, this.context.height);

        // Reset draw call counter
        this.performanceMetrics.drawCalls = 0;
        this.performanceMetrics.vertexCount = 0;

        // Downsample data for efficient rendering
        const downsampledVariables = this.downsampleData(variables, viewport);

        // Draw grid
        if (options.showGrid) {
            this.renderGrid(viewport);
        }

        // Draw waveforms
        for (const variable of downsampledVariables) {
            if (!variable.enabled || !variable.data || variable.data.length === 0) {
                continue;
            }

            this.renderWaveform(variable, viewport, options);
        }

        // Update performance metrics
        this.updatePerformanceMetrics();
    }

    public clear(): void {
        this.ctx.clearRect(0, 0, this.context.width, this.context.height);
    }

    public dispose(): void {
        // Canvas 2D doesn't require explicit cleanup
        console.log('[Canvas2DRenderer] Disposed');
    }

    private renderWaveform(variable: WaveformVariable, viewport: ViewPort, options: RenderOptions): void {
        const ctx = this.ctx;

        if (variable.data.length === 0) return;

        // Set line style
        ctx.strokeStyle = this.getColorString(variable.color, variable.opacity || 1.0);
        ctx.lineWidth = (options.lineWidth || variable.lineWidth || 2) * this.context.devicePixelRatio;
        ctx.globalAlpha = variable.opacity || 1.0;

        // Set line dash pattern
        if (variable.lineStyle === 'dashed') {
            ctx.setLineDash([10, 5]);
        } else if (variable.lineStyle === 'dotted') {
            ctx.setLineDash([2, 3]);
        } else {
            ctx.setLineDash([]);
        }

        // Draw the line
        ctx.beginPath();

        let firstPoint = true;
        for (const point of variable.data) {
            const screen = this.dataToScreen(point.timestamp, point.value, viewport);

            if (firstPoint) {
                ctx.moveTo(screen.x, screen.y);
                firstPoint = false;
            } else {
                ctx.lineTo(screen.x, screen.y);
            }
        }

        ctx.stroke();

        // Reset line dash
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;

        // Update metrics
        this.performanceMetrics.drawCalls++;
        this.performanceMetrics.vertexCount += variable.data.length;
    }

    private renderGrid(viewport: ViewPort): void {
        const ctx = this.ctx;
        const numHorizontalLines = 5;
        const numVerticalLines = 10;

        ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)';
        ctx.lineWidth = 1;

        ctx.beginPath();

        // Horizontal lines
        for (let i = 0; i <= numHorizontalLines; i++) {
            const y = (i / numHorizontalLines) * this.context.height;
            ctx.moveTo(0, y);
            ctx.lineTo(this.context.width, y);
        }

        // Vertical lines
        for (let i = 0; i <= numVerticalLines; i++) {
            const x = (i / numVerticalLines) * this.context.width;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.context.height);
        }

        ctx.stroke();

        // Update metrics
        this.performanceMetrics.drawCalls++;
    }

    private getColorString(color: string, opacity: number = 1.0): string {
        // If already has opacity, return as-is
        if (color.startsWith('rgba')) {
            return color;
        }

        // Convert hex to rgba
        if (color.startsWith('#')) {
            const parsed = this.parseColor(color, opacity);
            return `rgba(${Math.round(parsed.r * 255)}, ${Math.round(parsed.g * 255)}, ${Math.round(parsed.b * 255)}, ${parsed.a})`;
        }

        // Convert rgb to rgba
        if (color.startsWith('rgb(')) {
            return color.replace('rgb(', 'rgba(').replace(')', `, ${opacity})`);
        }

        return color;
    }
}
