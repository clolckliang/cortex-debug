import { GraphPoint, GrapherDataMessage, GrapherProgramCounterMessage } from './types';

export { GraphPoint } from './types';

export interface WaveformVariable {
    id: string;
    name: string;
    color: string;
    enabled: boolean;
    lastValue?: number;
    unit?: string;
    lineStyle?: 'solid' | 'dashed' | 'dotted';
    lineWidth?: number;
    opacity?: number;
    visible?: boolean;
    expression?: string;
}

export interface DataSourceStats {
    count: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
    minValue: number | null;
    maxValue: number | null;
    avgValue: number | null;
}

export class GraphDataSource {
    private data: {
        [graphId: string]: GraphPoint[];
    } = {};

    private subscriptions: {
        // tslint:disable-next-line:ban-types
        [graphId: string]: ((p: GraphPoint) => void)[];
    } = {};

    private counterStats: {
        [fnName: string]: number;
    } = {};

    constructor() {
    }

    public receivedProgramCounterMessage(message: GrapherProgramCounterMessage) {
        if (!this.counterStats[message.function]) { this.counterStats[message.function] = 0; }
        this.counterStats[message.function] += 1;
    }

    public getProgramCounterStats() {
        return { ...this.counterStats };
    }

    public receiveDataMessage(message: GrapherDataMessage) {
        const gp: GraphPoint = {
            timestamp: message.timestamp,
            value: message.data
        };

        const graphId = message.id;
        if (!this.data[graphId]) { this.data[graphId] = []; }

        if (this.data[graphId]) {
            this.data[graphId].push(gp);
        }

        if (this.subscriptions[graphId]) {
            this.subscriptions[graphId].forEach((fn) => fn(gp));
        }
    }

    public getData(graphId: string, start: number, end: number, pad: boolean = true): GraphPoint[] {
        let data: GraphPoint[] = this.data[graphId];
        if (!data) { return []; }

        data = data.filter((gp) => gp.timestamp >= start && gp.timestamp <= end);
        if (pad && data.length >= 1) {
            const ep = data[data.length - 1];
            data.push({ timestamp: end, value: ep.value });
        }

        return data;
    }

    public sampleData(graphId: string, sampleSize: number, start: number = null, end: number = null): GraphPoint[] {
        let data: GraphPoint[] = this.data[graphId];
        if (!data) { return []; }

        if (start === null) { start = 0; }
        if (end == null) { end = new Date().getTime(); }

        data = data.filter((gp) => gp.timestamp >= start && gp.timestamp <= end);

        if (data.length > sampleSize * 1.5) {
            const sampleRate = Math.round(data.length / sampleSize);
            data = data.filter((gp, idx) => idx % sampleRate === 0);
        }

        return data;
    }

    public oldestPoint(graphId: string): GraphPoint {
        return this.data[graphId] ? this.data[graphId][0] : null;
    }

    public subscribe(graphId: string, callback: (point: GraphPoint) => void) {
        if (!this.subscriptions[graphId]) { this.subscriptions[graphId] = []; }
        this.subscriptions[graphId].push(callback);
    }

    // Waveform-specific methods
    public clearData(graphId?: string): void {
        if (graphId) {
            delete this.data[graphId];
            delete this.subscriptions[graphId];
        } else {
            // Clear all data
            this.data = {};
            this.subscriptions = {};
        }
    }

    public clearOldData(cutoffTime: number): void {
        for (const graphId in this.data) {
            const data = this.data[graphId];
            if (data) {
                this.data[graphId] = data.filter((point) => point.timestamp >= cutoffTime);
            }
        }
    }

    public getDataStats(graphId: string): DataSourceStats {
        const data = this.data[graphId];
        if (!data || data.length === 0) {
            return {
                count: 0,
                oldestTimestamp: null,
                newestTimestamp: null,
                minValue: null,
                maxValue: null,
                avgValue: null
            };
        }

        let sum = 0;
        let min = data[0].value;
        let max = data[0].value;
        let oldest = data[0].timestamp;
        let newest = data[0].timestamp;

        for (const point of data) {
            sum += point.value;
            min = Math.min(min, point.value);
            max = Math.max(max, point.value);
            oldest = Math.min(oldest, point.timestamp);
            newest = Math.max(newest, point.timestamp);
        }

        return {
            count: data.length,
            oldestTimestamp: oldest,
            newestTimestamp: newest,
            minValue: min,
            maxValue: max,
            avgValue: sum / data.length
        };
    }

    public getAllGraphIds(): string[] {
        return Object.keys(this.data);
    }

    public getLatestDataPoints(variableIds: string[]): Map<string, GraphPoint | null> {
        const result = new Map<string, GraphPoint | null>();

        for (const id of variableIds) {
            const data = this.data[id];
            if (data && data.length > 0) {
                result.set(id, data[data.length - 1]);
            } else {
                result.set(id, null);
            }
        }

        return result;
    }

    public getDataRange(variableIds: string[], startTime: number, endTime: number): Map<string, GraphPoint[]> {
        const result = new Map<string, GraphPoint[]>();

        for (const id of variableIds) {
            const data = this.getData(id, startTime, endTime, false);
            result.set(id, data);
        }

        return result;
    }

    public autoScaleY(variableIds: string[], startTime: number, endTime: number): { min: number; max: number } {
        let minY = Infinity;
        let maxY = -Infinity;

        for (const id of variableIds) {
            const data = this.getData(id, startTime, endTime, false);
            for (const point of data) {
                minY = Math.min(minY, point.value);
                maxY = Math.max(maxY, point.value);
            }
        }

        if (minY === Infinity || maxY === -Infinity) {
            // No data available, use default range
            minY = -1;
            maxY = 1;
        } else {
            // Add some padding
            const padding = (maxY - minY) * 0.1;
            minY -= padding;
            maxY += padding;
        }

        return { min: minY, max: maxY };
    }
}
