import { GraphPoint, GrapherDataMessage, GrapherProgramCounterMessage } from './types';

export { GraphPoint } from './types';

/**
 * Display type for Logic Analyzer signal visualization
 * - analog: Continuous waveform (default)
 * - bit: Digital 0/1 display
 * - state: Multi-state digital bus display
 * - hex: Hexadecimal value display
 * - binary: Binary value display
 */
export type SignalDisplayType = 'analog' | 'bit' | 'state' | 'hex' | 'binary';

/**
 * Trigger condition for signal capture
 */
export interface TriggerCondition {
    enabled: boolean;
    type: 'rising' | 'falling' | 'level' | 'change';
    value?: number; // For level trigger
    operator?: '==' | '!=' | '>' | '<' | '>=' | '<=';
}

/**
 * Structure member for tree display
 */
export interface StructMember {
    name: string;
    path: string;
    value: string;
    type: string;
    numericValue?: number;
    selected?: boolean;
}

/**
 * Signal statistics for data analysis
 */
export interface SignalStatistics {
    min: number;
    max: number;
    avg: number;
    rms: number;  // Root Mean Square
    duty: number; // Duty cycle (for digital signals)
    frequency?: number; // Estimated frequency
    period?: number;    // Estimated period
}

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
    samplingRate?: number;
    lastUpdate?: number;

    // Logic Analyzer enhancements
    displayType?: SignalDisplayType;  // Display mode (analog/bit/state/hex/binary)
    bitWidth?: number;                // For multi-bit signals (default: 1)
    bitMask?: number;                 // Bit mask for extracting specific bits
    bitOffset?: number;               // Bit offset for multi-bit signals
    threshold?: number;               // Threshold for bit display (default: 0.5)
    trigger?: TriggerCondition;       // Trigger condition
    group?: string;                   // Signal grouping
    yOffset?: number;                 // Y-axis offset for stacked display
    height?: number;                  // Height for signal in stacked view
    statistics?: SignalStatistics;    // Calculated statistics

    // Structure support
    isStruct?: boolean;               // Whether this is a struct/union variable
    structMembers?: StructMember[];   // Struct members for tree display
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

    /**
     * Calculate signal statistics for Logic Analyzer
     */
    public calculateSignalStatistics(graphId: string, startTime?: number, endTime?: number): SignalStatistics | null {
        const start = startTime || 0;
        const end = endTime || Date.now();
        const data = this.getData(graphId, start, end, false);

        if (!data || data.length === 0) {
            return null;
        }

        let min = data[0].value;
        let max = data[0].value;
        let sum = 0;
        let sumSquares = 0;
        let highCount = 0;
        let transitionCount = 0;
        let prevValue: number | null = null;

        // Calculate basic statistics
        for (const point of data) {
            const value = point.value;
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
            sumSquares += value * value;

            // Count high samples (for duty cycle)
            if (value > 0.5) {
                highCount++;
            }

            // Count transitions (for frequency estimation)
            if (prevValue !== null && Math.abs(value - prevValue) > 0.1) {
                transitionCount++;
            }
            prevValue = value;
        }

        const avg = sum / data.length;
        const rms = Math.sqrt(sumSquares / data.length);
        const duty = (highCount / data.length) * 100;

        // Estimate frequency from transitions
        let frequency: number | undefined;
        let period: number | undefined;

        if (transitionCount > 2 && data.length > 1) {
            const timeSpan = (data[data.length - 1].timestamp - data[0].timestamp) / 1000; // Convert to seconds
            frequency = (transitionCount / 2) / timeSpan; // Divide by 2 for full cycles
            period = 1 / frequency;
        }

        return {
            min,
            max,
            avg,
            rms,
            duty,
            frequency,
            period
        };
    }

    /**
     * Detect trigger condition on signal
     */
    public checkTrigger(graphId: string, trigger: TriggerCondition, latestPoint: GraphPoint, previousPoint?: GraphPoint): boolean {
        if (!trigger.enabled) {
            return false;
        }

        const value = latestPoint.value;

        switch (trigger.type) {
            case 'rising':
                return previousPoint && previousPoint.value < 0.5 && value >= 0.5;

            case 'falling':
                return previousPoint && previousPoint.value >= 0.5 && value < 0.5;

            case 'change':
                return previousPoint && Math.abs(value - previousPoint.value) > 0.1;

            case 'level':
                if (trigger.value !== undefined && trigger.operator) {
                    switch (trigger.operator) {
                        case '==': return Math.abs(value - trigger.value) < 0.01;
                        case '!=': return Math.abs(value - trigger.value) >= 0.01;
                        case '>': return value > trigger.value;
                        case '<': return value < trigger.value;
                        case '>=': return value >= trigger.value;
                        case '<=': return value <= trigger.value;
                    }
                }
                return false;

            default:
                return false;
        }
    }

    /**
     * Apply bit mask and offset to extract specific bits from value
     */
    public extractBits(value: number, bitMask?: number, bitOffset?: number): number {
        let result = value;

        if (bitOffset) {
            result = result >> bitOffset;
        }

        if (bitMask) {
            result = result & bitMask;
        }

        return result;
    }

    /**
     * Convert value to digital (0/1) based on threshold
     */
    public toDigital(value: number, threshold: number = 0.5): number {
        return value >= threshold ? 1 : 0;
    }

    /**
     * Format value based on display type
     */
    public formatValue(value: number, displayType: SignalDisplayType = 'analog', bitWidth: number = 1): string {
        switch (displayType) {
            case 'analog':
                return value.toFixed(3);

            case 'bit':
                return value >= 0.5 ? '1' : '0';

            case 'hex': {
                const intValue = Math.floor(value);
                const hexStr = intValue.toString(16).toUpperCase();
                const padLength = Math.ceil(bitWidth / 4);
                return '0x' + hexStr.padStart(padLength, '0');
            }

            case 'binary': {
                const binValue = Math.floor(value);
                const binStr = binValue.toString(2);
                return '0b' + binStr.padStart(bitWidth, '0');
            }

            case 'state':
                return Math.floor(value).toString();

            default:
                return value.toString();
        }
    }
}
