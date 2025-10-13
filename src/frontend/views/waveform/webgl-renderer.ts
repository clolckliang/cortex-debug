/**
 * WebGL Renderer
 *
 * High-performance WebGL-based waveform renderer
 */

/// <reference lib="dom" />

import { RendererBase } from './renderer-base';
import { WaveformVariable, ViewPort, RenderOptions } from './types';

interface ShaderProgram {
    program: WebGLProgram;
    attributes: { [key: string]: number };
    uniforms: { [key: string]: WebGLUniformLocation | null };
}

export class WebGLRenderer extends RendererBase {
    private gl: WebGL2RenderingContext;
    private programs: Map<string, ShaderProgram> = new Map();
    private buffers: Map<string, WebGLBuffer> = new Map();
    private vaos: Map<string, WebGLVertexArrayObject> = new Map();

    constructor(canvas: HTMLCanvasElement) {
        super(canvas);

        const gl = canvas.getContext('webgl2', {
            alpha: true,
            antialias: true,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false
        });

        if (!gl) {
            throw new Error('WebGL2 is not supported');
        }

        this.gl = gl;
    }

    public initialize(): void {
        const gl = this.gl;

        // Enable blending for transparency
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Initialize shaders
        this.initializeShaders();

        // Initialize buffers
        this.initializeBuffers();

        console.log('[WebGLRenderer] Initialized');
    }

    public render(variables: WaveformVariable[], viewport: ViewPort, options: RenderOptions): void {
        const gl = this.gl;

        // Clear canvas
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

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
        const gl = this.gl;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    public dispose(): void {
        // Cleanup WebGL resources
        for (const buffer of this.buffers.values()) {
            this.gl.deleteBuffer(buffer);
        }

        for (const vao of this.vaos.values()) {
            this.gl.deleteVertexArray(vao);
        }

        for (const program of this.programs.values()) {
            this.gl.deleteProgram(program.program);
        }

        this.buffers.clear();
        this.vaos.clear();
        this.programs.clear();
    }

    private initializeShaders(): void {
        // Line shader
        const lineVertexShader = `#version 300 es
            in vec2 a_position;
            in vec4 a_color;

            uniform mat3 u_matrix;

            out vec4 v_color;

            void main() {
                vec3 pos = u_matrix * vec3(a_position, 1.0);
                gl_Position = vec4(pos.xy, 0.0, 1.0);
                v_color = a_color;
            }
        `;

        const lineFragmentShader = `#version 300 es
            precision highp float;

            in vec4 v_color;
            out vec4 outColor;

            void main() {
                outColor = v_color;
            }
        `;

        this.programs.set('line', this.createShaderProgram(lineVertexShader, lineFragmentShader));

        // Grid shader
        const gridVertexShader = `#version 300 es
            in vec2 a_position;

            uniform mat3 u_matrix;
            uniform vec4 u_color;

            void main() {
                vec3 pos = u_matrix * vec3(a_position, 1.0);
                gl_Position = vec4(pos.xy, 0.0, 1.0);
            }
        `;

        const gridFragmentShader = `#version 300 es
            precision highp float;

            uniform vec4 u_color;
            out vec4 outColor;

            void main() {
                outColor = u_color;
            }
        `;

        this.programs.set('grid', this.createShaderProgram(gridVertexShader, gridFragmentShader));
    }

    private createShaderProgram(vertexSource: string, fragmentSource: string): ShaderProgram {
        const gl = this.gl;

        const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);

        const program = gl.createProgram();
        if (!program) {
            throw new Error('Failed to create shader program');
        }

        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            throw new Error(`Shader program linking failed: ${info}`);
        }

        // Get attribute and uniform locations
        const attributes: { [key: string]: number } = {};
        const uniforms: { [key: string]: WebGLUniformLocation | null } = {};

        const numAttributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < numAttributes; i++) {
            const info = gl.getActiveAttrib(program, i);
            if (info) {
                attributes[info.name] = gl.getAttribLocation(program, info.name);
            }
        }

        const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < numUniforms; i++) {
            const info = gl.getActiveUniform(program, i);
            if (info) {
                uniforms[info.name] = gl.getUniformLocation(program, info.name);
            }
        }

        return { program, attributes, uniforms };
    }

    private compileShader(type: number, source: string): WebGLShader {
        const gl = this.gl;
        const shader = gl.createShader(type);

        if (!shader) {
            throw new Error('Failed to create shader');
        }

        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`Shader compilation failed: ${info}`);
        }

        return shader;
    }

    private initializeBuffers(): void {
        const gl = this.gl;

        // Create dynamic vertex buffer for waveforms
        const waveformBuffer = gl.createBuffer();
        if (waveformBuffer) {
            this.buffers.set('waveform', waveformBuffer);
        }

        // Create grid buffer
        const gridBuffer = gl.createBuffer();
        if (gridBuffer) {
            this.buffers.set('grid', gridBuffer);
        }
    }

    private renderWaveform(variable: WaveformVariable, viewport: ViewPort, options: RenderOptions): void {
        const gl = this.gl;
        const program = this.programs.get('line');
        if (!program) return;

        gl.useProgram(program.program);

        // Prepare vertex data
        const vertices: number[] = [];
        const color = this.parseColor(variable.color, variable.opacity || 1.0);

        for (const point of variable.data) {
            const screen = this.dataToScreen(point.timestamp, point.value, viewport);

            // Normalize to clip space (-1 to 1)
            const x = (screen.x / this.context.width) * 2 - 1;
            const y = (screen.y / this.context.height) * 2 - 1;

            vertices.push(x, y, color.r, color.g, color.b, color.a);
        }

        if (vertices.length === 0) return;

        // Update vertex buffer
        const buffer = this.buffers.get('waveform');
        if (!buffer) return;

        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);

        // Set up attributes
        const stride = 6 * 4; // 6 floats per vertex, 4 bytes per float

        gl.enableVertexAttribArray(program.attributes['a_position']);
        gl.vertexAttribPointer(program.attributes['a_position'], 2, gl.FLOAT, false, stride, 0);

        gl.enableVertexAttribArray(program.attributes['a_color']);
        gl.vertexAttribPointer(program.attributes['a_color'], 4, gl.FLOAT, false, stride, 8);

        // Set uniform matrix (identity matrix for now)
        const matrix = [
            1, 0, 0,
            0, 1, 0,
            0, 0, 1
        ];
        gl.uniformMatrix3fv(program.uniforms['u_matrix'], false, matrix);

        // Set line width (note: WebGL2 may not support this)
        const lineWidth = (options.lineWidth || variable.lineWidth || 2) * this.context.devicePixelRatio;
        gl.lineWidth(Math.min(lineWidth, gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)[1]));

        // Draw
        gl.drawArrays(gl.LINE_STRIP, 0, vertices.length / 6);

        // Update metrics
        this.performanceMetrics.drawCalls++;
        this.performanceMetrics.vertexCount += vertices.length / 6;
    }

    private renderGrid(viewport: ViewPort): void {
        const gl = this.gl;
        const program = this.programs.get('grid');
        if (!program) return;

        gl.useProgram(program.program);

        // Grid color (low opacity)
        const gridColor = [0.3, 0.3, 0.3, 0.2];
        gl.uniform4fv(program.uniforms['u_color'], gridColor);

        // Calculate grid lines
        const gridLines: number[] = [];
        const numHorizontalLines = 5;
        const numVerticalLines = 10;

        // Horizontal lines
        for (let i = 0; i <= numHorizontalLines; i++) {
            const y = (i / numHorizontalLines) * 2 - 1;
            gridLines.push(-1, y, 1, y);
        }

        // Vertical lines
        for (let i = 0; i <= numVerticalLines; i++) {
            const x = (i / numVerticalLines) * 2 - 1;
            gridLines.push(x, -1, x, 1);
        }

        // Update grid buffer
        const buffer = this.buffers.get('grid');
        if (!buffer) return;

        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridLines), gl.STATIC_DRAW);

        // Set up attributes
        gl.enableVertexAttribArray(program.attributes['a_position']);
        gl.vertexAttribPointer(program.attributes['a_position'], 2, gl.FLOAT, false, 0, 0);

        // Set uniform matrix (identity matrix)
        const matrix = [
            1, 0, 0,
            0, 1, 0,
            0, 0, 1
        ];
        gl.uniformMatrix3fv(program.uniforms['u_matrix'], false, matrix);

        // Draw grid
        gl.drawArrays(gl.LINES, 0, gridLines.length / 2);

        // Update metrics
        this.performanceMetrics.drawCalls++;
    }
}
