export interface FFTConfig {
    windowSize: number;
    windowFunction: 'hanning' | 'hamming' | 'blackman' | 'rectangular';
    samplingRate: number;
}

export interface FFTResult {
    frequencies: number[];
    magnitudes: number[];
    phases: number[];
    peaks: Array<{
        frequency: number;
        magnitude: number;
        snr: number;
        phase: number;
    }>;
    noiseFloor: number;
    dominantFrequency: {
        frequency: number;
        magnitude: number;
        phase: number;
    };
    thd: number; // Total Harmonic Distortion
    windowSize: number;
    samplingRate: number;
}

export class FFTAnalyzer {
    private config: FFTConfig;

    constructor(config: Partial<FFTConfig> = {}) {
        this.config = {
            windowSize: 512,
            windowFunction: 'hanning',
            samplingRate: 1.0,
            ...config
        };
    }

    public updateConfig(config: Partial<FFTConfig>): void {
        this.config = { ...this.config, ...config };
    }

    public analyze(data: number[]): FFTResult | null {
        if (data.length < this.config.windowSize) {
            return null;
        }

        // Take the most recent windowSize samples
        const window = data.slice(-this.config.windowSize);

        // Apply window function
        const windowed = this.applyWindow(window);

        // Perform FFT
        const fftResult = this.performFFT(windowed);

        // Calculate magnitudes, phases and convert to dB
        const { magnitudes, phases } = this.calculateMagnitudesAndPhases(fftResult);

        // Find frequencies
        const frequencies = this.calculateFrequencies();

        // Find peaks with enhanced detection
        const peaks = this.findPeaks(frequencies, magnitudes, phases);

        // Calculate noise floor and signal metrics
        const { noiseFloor, thd } = this.calculateSignalMetrics(frequencies, magnitudes);

        // Find dominant frequency (peak with highest magnitude)
        const dominantFreq = peaks.length > 0
            ? peaks[0]
            : {
                    frequency: 0,
                    magnitude: 0,
                    snr: 0,
                    phase: 0
                };

        return {
            frequencies,
            magnitudes,
            phases,
            peaks,
            noiseFloor,
            dominantFrequency: {
                frequency: dominantFreq.frequency,
                magnitude: dominantFreq.magnitude,
                phase: dominantFreq.phase
            },
            thd,
            windowSize: this.config.windowSize,
            samplingRate: this.config.samplingRate
        };
    }

    private applyWindow(data: number[]): number[] {
        const N = data.length;
        const windowed: number[] = new Array(N);

        switch (this.config.windowFunction) {
            case 'hanning':
                for (let i = 0; i < N; i++) {
                    windowed[i] = data[i] * 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
                }
                break;
            case 'hamming':
                for (let i = 0; i < N; i++) {
                    windowed[i] = data[i] * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1)));
                }
                break;
            case 'blackman':
                for (let i = 0; i < N; i++) {
                    const a0 = 0.42;
                    const a1 = 0.5;
                    const a2 = 0.08;
                    windowed[i] = data[i] * (a0 - a1 * Math.cos(2 * Math.PI * i / (N - 1)) + a2 * Math.cos(4 * Math.PI * i / (N - 1)));
                }
                break;
            case 'rectangular':
            default:
                return data.slice();
        }

        return windowed;
    }

    private performFFT(data: number[]): Complex[] {
        const N = data.length;
        const result: Complex[] = new Array(N);

        // Optimized FFT implementation
        this.cooleyTukeyFFT(data, N, result);

        return result;
    }

    private cooleyTukeyFFT(input: number[], n: number, output: Complex[]): void {
        if (n <= 1) {
            output[0] = { real: input[0] || 0, imag: 0 };
            return;
        }

        // Pad input to power of 2
        const paddedSize = Math.pow(2, Math.ceil(Math.log2(n)));
        const padded = new Array(paddedSize).fill(0);
        for (let i = 0; i < n; i++) {
            padded[i] = input[i];
        }

        // Initialize output array
        for (let i = 0; i < paddedSize; i++) {
            output[i] = { real: 0, imag: 0 };
        }

        // Recursive FFT
        this.fftRecursive(padded, paddedSize, output, false);
    }

    private fftRecursive(x: number[], n: number, output: Complex[], inverse: boolean): void {
        if (n === 1) {
            output[0] = { real: x[0], imag: 0 };
            return;
        }

        const even = new Array(n / 2);
        const odd = new Array(n / 2);
        const evenOut = new Array(n / 2);
        const oddOut = new Array(n / 2);

        for (let i = 0; i < n / 2; i++) {
            even[i] = x[2 * i];
            odd[i] = x[2 * i + 1];
        }

        this.fftRecursive(even, n / 2, evenOut, inverse);
        this.fftRecursive(odd, n / 2, oddOut, inverse);

        const angle = (inverse ? 2 : -2) * Math.PI / n;
        for (let k = 0; k < n / 2; k++) {
            const cos = Math.cos(angle * k);
            const sin = Math.sin(angle * k);
            const t = {
                real: cos * oddOut[k].real - sin * oddOut[k].imag,
                imag: cos * oddOut[k].imag + sin * oddOut[k].real
            };

            output[k] = {
                real: evenOut[k].real + t.real,
                imag: evenOut[k].imag + t.imag
            };
            output[k + n / 2] = {
                real: evenOut[k].real - t.real,
                imag: evenOut[k].imag - t.imag
            };
        }
    }

    private calculateMagnitudesAndPhases(fftData: Complex[]): { magnitudes: number[]; phases: number[] } {
        const N = fftData.length;
        const magnitudes: number[] = new Array(N / 2);
        const phases: number[] = new Array(N / 2);

        for (let i = 0; i < N / 2; i++) {
            const real = fftData[i].real;
            const imag = fftData[i].imag;
            const magnitude = Math.sqrt(real * real + imag * imag);

            // Convert to dB scale
            magnitudes[i] = 20 * Math.log10(magnitude / (N / 2) + 1e-10);

            // Calculate phase in radians
            phases[i] = Math.atan2(imag, real);
        }

        return { magnitudes, phases };
    }

    private calculateFrequencies(): number[] {
        const N = this.config.windowSize;
        const frequencies: number[] = new Array(N / 2);

        for (let i = 0; i < N / 2; i++) {
            frequencies[i] = (i * this.config.samplingRate) / N;
        }

        return frequencies;
    }

    private calculateSignalMetrics(frequencies: number[], magnitudes: number[]): { noiseFloor: number; thd: number } {
        // Calculate noise floor (using median of lower 25% of values)
        const sortedMagnitudes = [...magnitudes].sort((a, b) => a - b);
        const noiseFloor = sortedMagnitudes[Math.floor(sortedMagnitudes.length * 0.25)];

        // Calculate Total Harmonic Distortion (THD)
        const thd = this.calculateTHD(frequencies, magnitudes);

        return { noiseFloor, thd };
    }

    private calculateTHD(frequencies: number[], magnitudes: number[]): number {
        if (magnitudes.length < 10) return 0;

        // Find fundamental frequency (highest magnitude excluding DC)
        let fundamentalMag = magnitudes[1]; // Skip DC component
        let fundamentalIdx = 1;

        for (let i = 2; i < magnitudes.length; i++) {
            if (magnitudes[i] > fundamentalMag) {
                fundamentalMag = magnitudes[i];
                fundamentalIdx = i;
            }
        }

        if (fundamentalMag <= -60) return 0; // No significant signal

        // Calculate harmonic power sum (2nd to 10th harmonics)
        let harmonicPower = 0;
        const fundamentalFreq = frequencies[fundamentalIdx];

        for (let harmonic = 2; harmonic <= 10; harmonic++) {
            const harmonicFreq = fundamentalFreq * harmonic;
            const harmonicIdx = Math.round(harmonicFreq * this.config.windowSize / this.config.samplingRate);

            if (harmonicIdx < magnitudes.length) {
                const harmonicMag = magnitudes[harmonicIdx];
                harmonicPower += Math.pow(10, harmonicMag / 10);
            }
        }

        const fundamentalPower = Math.pow(10, fundamentalMag / 10);
        const thd = harmonicPower > 0 ? Math.sqrt(harmonicPower / fundamentalPower) : 0;

        return Math.min(thd, 1.0); // Cap at 100%
    }

    private findPeaks(
        frequencies: number[],
        magnitudes: number[],
        phases: number[]
    ): Array<{ frequency: number; magnitude: number; snr: number; phase: number }> {
        const peaks: Array<{ frequency: number; magnitude: number; snr: number; phase: number }> = [];

        // Calculate noise floor
        const { noiseFloor } = this.calculateSignalMetrics(frequencies, magnitudes);
        const threshold = noiseFloor + 10; // 10dB above noise floor

        for (let i = 2; i < magnitudes.length - 2; i++) {
            // Check for local maximum with better peak detection
            const isPeak = magnitudes[i] > magnitudes[i - 1]
                           && magnitudes[i] > magnitudes[i - 2]
                           && magnitudes[i] > magnitudes[i + 1]
                           && magnitudes[i] > magnitudes[i + 2]
                           && magnitudes[i] > threshold;

            if (isPeak) {
                // Calculate signal-to-noise ratio
                const snr = magnitudes[i] - noiseFloor;

                // Parabolic interpolation for more accurate peak location
                const alpha = magnitudes[i - 1];
                const beta = magnitudes[i];
                const gamma = magnitudes[i + 1];

                let interpolatedIndex = i;
                if (beta !== 0) {
                    const delta = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);
                    interpolatedIndex = i + delta;
                }

                const interpolatedFrequency = frequencies[Math.floor(interpolatedIndex)]
                    + (interpolatedIndex - Math.floor(interpolatedIndex))
                    * (frequencies[Math.ceil(interpolatedIndex)] - frequencies[Math.floor(interpolatedIndex)]);

                peaks.push({
                    frequency: interpolatedFrequency,
                    magnitude: beta,
                    snr: snr,
                    phase: phases[i]
                });
            }
        }

        // Sort by SNR and return top peaks
        peaks.sort((a, b) => b.snr - a.snr);
        return peaks.slice(0, 8); // Return top 8 peaks
    }
}

interface Complex {
    real: number;
    imag: number;
}

// Utility function to get data points for FFT
export function getDataPointsForFFT(dataPoints: GraphPoint[], windowSize: number): number[] {
    if (dataPoints.length === 0) {
        return [];
    }

    // Extract just the values
    const values = dataPoints.map((point) => point.value);

    // If we have more data than needed, take the most recent samples
    if (values.length > windowSize) {
        return values.slice(-windowSize);
    }

    // If we have less data than needed, pad with zeros
    const padded: number[] = new Array(windowSize).fill(0);
    for (let i = 0; i < values.length; i++) {
        padded[i] = values[i];
    }

    return padded;
}

// Import GraphPoint from the types file
interface GraphPoint {
    timestamp: number;
    value: number;
}
