/**
 * Base Renderer Class
 *
 * Abstract base class for waveform renderers
 */

/// <reference lib="dom" />

import { IRenderer, RenderContext, ViewPort, RenderOptions, PerformanceMetrics, WaveformVariable } from './types';

export abstract class RendererBase implements IRenderer {
    protected canvas: HTMLCanvasElement;
    protected context: RenderContext;
    protected performanceMetrics: PerformanceMetrics;

    // Performance tracking
    private frameCount = 0;
    private lastFrameTime = 0;
    private frameTimeSum = 0;
    private lastMetricsUpdate = 0;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.context = {
            width: canvas.width,
            height: canvas.height,
            devicePixelRatio: window.devicePixelRatio || 1
        };

        this.performanceMetrics = {
            fps: 60,
            frameTime: 16.67,
            drawCalls: 0,
            vertexCount: 0
        };
    }

    abstract initialize(): void;
    abstract render(variables: WaveformVariable[], viewport: ViewPort, options: RenderOptions): void;
    abstract clear(): void;
    abstract dispose(): void;

    public resize(width: number, height: number): void {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = width * dpr;
        this.canvas.height = height * dpr;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;

        this.context.width = width * dpr;
        this.context.height = height * dpr;
        this.context.devicePixelRatio = dpr;
    }

    public getPerformanceMetrics(): PerformanceMetrics {
        return { ...this.performanceMetrics };
    }

    protected updatePerformanceMetrics(): void {
        const now = performance.now();

        // Calculate frame time
        if (this.lastFrameTime > 0) {
            const frameTime = now - this.lastFrameTime;
            this.frameTimeSum += frameTime;
            this.frameCount++;

            // Update metrics every second
            if (now - this.lastMetricsUpdate > 1000) {
                this.performanceMetrics.frameTime = this.frameTimeSum / this.frameCount;
                this.performanceMetrics.fps = 1000 / this.performanceMetrics.frameTime;

                // Reset counters
                this.frameTimeSum = 0;
                this.frameCount = 0;
                this.lastMetricsUpdate = now;
            }
        }

        this.lastFrameTime = now;
    }

    /**
     * Convert data coordinates to screen coordinates
     */
    protected dataToScreen(dataX: number, dataY: number, viewport: ViewPort): { x: number; y: number } {
        const xRange = viewport.xMax - viewport.xMin;
        const yRange = viewport.yMax - viewport.yMin;

        const x = ((dataX - viewport.xMin) / xRange) * this.context.width;
        const y = this.context.height - ((dataY - viewport.yMin) / yRange) * this.context.height;

        return { x, y };
    }

    /**
     * Convert screen coordinates to data coordinates
     */
    protected screenToData(screenX: number, screenY: number, viewport: ViewPort): { x: number; y: number } {
        const xRange = viewport.xMax - viewport.xMin;
        const yRange = viewport.yMax - viewport.yMin;

        const x = (screenX / this.context.width) * xRange + viewport.xMin;
        const y = (1 - screenY / this.context.height) * yRange + viewport.yMin;

        return { x, y };
    }

    /**
     * Parse color string to RGBA components
     */
    protected parseColor(color: string, opacity: number = 1.0): { r: number; g: number; b: number; a: number } {
        // Handle hex colors
        if (color.startsWith('#')) {
            const hex = color.substring(1);
            const r = parseInt(hex.substring(0, 2), 16) / 255;
            const g = parseInt(hex.substring(2, 4), 16) / 255;
            const b = parseInt(hex.substring(4, 6), 16) / 255;
            return { r, g, b, a: opacity };
        }

        // Handle rgb/rgba colors
        const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (rgbMatch) {
            return {
                r: parseInt(rgbMatch[1]) / 255,
                g: parseInt(rgbMatch[2]) / 255,
                b: parseInt(rgbMatch[3]) / 255,
                a: rgbMatch[4] ? parseFloat(rgbMatch[4]) : opacity
            };
        }

        // Default to white
        return { r: 1, g: 1, b: 1, a: opacity };
    }

    /**
     * Calculate auto-scale range for Y axis
     */
    protected calculateAutoScale(variables: WaveformVariable[]): { min: number; max: number } {
        let min = Infinity;
        let max = -Infinity;

        for (const variable of variables) {
            if (!variable.enabled || !variable.data) continue;

            for (const point of variable.data) {
                if (point.value < min) min = point.value;
                if (point.value > max) max = point.value;
            }
        }

        if (min === Infinity || max === -Infinity) {
            return { min: 0, max: 1 };
        }

        // Add 10% padding
        const range = max - min;
        const padding = range * 0.1;
        return { min: min - padding, max: max + padding };
    }

    /**
     * Downsample data for efficient rendering
     */
    protected downsampleData(data: WaveformVariable[], viewport: ViewPort, maxPoints: number = 2000): WaveformVariable[] {
        const result: WaveformVariable[] = [];

        for (const variable of data) {
            if (!variable.data || variable.data.length === 0) {
                result.push(variable);
                continue;
            }

            // Filter data within viewport
            const visibleData = variable.data.filter(
                (p) => p.timestamp >= viewport.xMin && p.timestamp <= viewport.xMax
            );

            if (visibleData.length <= maxPoints) {
                result.push({
                    ...variable,
                    data: visibleData
                });
                continue;
            }

            // Downsample using LTTB (Largest Triangle Three Buckets) algorithm
            const downsampled = this.lttbDownsample(visibleData, maxPoints);

            result.push({
                ...variable,
                data: downsampled
            });
        }

        return result;
    }

    /**
     * LTTB (Largest Triangle Three Buckets) downsampling algorithm
     */
    private lttbDownsample(data: { timestamp: number; value: number }[], threshold: number): { timestamp: number; value: number }[] {
        if (data.length <= threshold) {
            return data;
        }

        const sampled: { timestamp: number; value: number }[] = [];
        const bucketSize = (data.length - 2) / (threshold - 2);

        // Always include first point
        sampled.push(data[0]);

        let a = 0;
        for (let i = 0; i < threshold - 2; i++) {
            const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
            const avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
            const avgRangeLength = avgRangeEnd - avgRangeStart;

            let avgX = 0;
            let avgY = 0;

            for (let j = avgRangeStart; j < avgRangeEnd && j < data.length; j++) {
                avgX += data[j].timestamp;
                avgY += data[j].value;
            }
            avgX /= avgRangeLength;
            avgY /= avgRangeLength;

            const rangeStart = Math.floor(i * bucketSize) + 1;
            const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;

            const pointA = data[a];
            let maxArea = -1;
            let maxAreaPoint = 0;

            for (let j = rangeStart; j < rangeEnd && j < data.length; j++) {
                const area = Math.abs(
                    (pointA.timestamp - avgX) * (data[j].value - pointA.value)
                    - (pointA.timestamp - data[j].timestamp) * (avgY - pointA.value)
                ) * 0.5;

                if (area > maxArea) {
                    maxArea = area;
                    maxAreaPoint = j;
                }
            }

            sampled.push(data[maxAreaPoint]);
            a = maxAreaPoint;
        }

        // Always include last point
        sampled.push(data[data.length - 1]);

        return sampled;
    }
}
