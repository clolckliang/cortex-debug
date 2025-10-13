import { DebugProtocol } from '@vscode/debugprotocol';
import { Handles } from '@vscode/debugadapter';
import { MI2 } from './backend/mi2/mi2';
import { decodeReference, ExtendedVariable, GDBDebugSession, RequestQueue } from './gdb';
import { MIError, VariableObject } from './backend/backend';
import * as crypto from 'crypto';
import { MINode } from './backend/mi_parse';
import { expandValue } from './backend/gdb_expansion';

interface SampleData {
    timestamp: number;
    value: string;
    type?: string;
    variablesReference?: number;
}

interface HistoricalSampleData {
    timestamp: number;
    value: string;
    type?: string;
    variablesReference?: number;
    changeRate?: number; // Rate of change from previous sample
}

interface SamplingStats {
    totalSamples: number;
    averageIntervalMs: number;
    lastSampleTime: number;
    samplingErrors: number;
    variablesCount: number;
}

interface ConditionalTrigger {
    variable: string;
    condition: 'change' | 'equals' | 'greater' | 'less' | 'range';
    value?: any;
    minValue?: any;
    maxValue?: any;
    debounceMs?: number;
    lastTriggerTime?: number;
}

interface ConditionalSamplingConfig {
    enabled: boolean;
    triggers: ConditionalTrigger[];
    action: 'sample' | 'pause' | 'resume';
}

interface AdaptiveSamplingConfig {
    enabled: boolean;
    minIntervalMs: number;
    maxIntervalMs: number;
    changeThreshold: number;
    stabilityPeriodMs: number;
    adjustmentFactor: number;
}

interface PerformanceOptimizationConfig {
    enabled: boolean;
    batchSize: number;
    memoryLimitMB: number;
    compressionEnabled: boolean;
    cacheTimeoutMs: number;
    maxConcurrentRequests: number;
}

export type VariableType = string | VariableObject | ExtendedVariable;
export interface NameToVarChangeInfo {
    [name: string]: any;
}
export class VariablesHandler {
    public variableHandles = new Handles<VariableType>(256);
    public variableHandlesReverse = new Map<string, number>();
    public cachedChangeList: NameToVarChangeInfo | undefined;

    constructor(
        public isBusy: () => boolean,
        public busyError: (r: DebugProtocol.Response, a: any) => void
    ) { }

    public async clearCachedVars(miDebugger: MI2) {
        if (this.cachedChangeList) {
            const poromises = [];
            for (const name of Object.keys(this.cachedChangeList)) {
                poromises.push(miDebugger.sendCommand(`var-delete ${name}`));
            }
            this.cachedChangeList = {};
            const results = await Promise.allSettled(poromises);
            results
                .filter((r) => r.status === 'rejected')
                .forEach((r) => console.error('clearCachedValues', r.reason));
        }
    }

    public refreshCachedChangeList(miDebugger: MI2, resolve) {
        this.cachedChangeList = {};
        miDebugger.varUpdate('*', -1, -1).then((changes: MINode) => {
            const changelist = changes.result('changelist');
            for (const change of changelist || []) {
                const name = MINode.valueOf(change, 'name');
                this.cachedChangeList[name] = change;
                const inScope = MINode.valueOf(change, 'in_scope');
                const typeChanged = MINode.valueOf(change, 'type_changed');
                if ((inScope === 'false') || (typeChanged === 'true')) {
                    // If one of these conditions happened, abandon the entire cache. TODO: Optimize later
                    this.cachedChangeList = undefined;
                    break;
                }
                const vId = this.variableHandlesReverse.get(name);
                const v = this.variableHandles.get(vId) as any;
                v.applyChanges(change);
            }
        }).finally (() => {
            resolve();
        });
    }

    public createVariable(arg: VariableType, options?: any) {
        if (options) {
            return this.variableHandles.create(new ExtendedVariable(arg, options));
        } else {
            return this.variableHandles.create(arg);
        }
    }

    public findOrCreateVariable(varObj: VariableObject): number {
        let id = this.variableHandlesReverse.get(varObj.name);
        if (id === undefined) {
            id = this.createVariable(varObj);
            this.variableHandlesReverse.set(varObj.name, id);
        }
        const isCompound = varObj.isCompound();
        const result = isCompound ? id : 0;

        // Debug logging for variable reference creation
        console.log(
            `[LiveWatch] findOrCreateVariable ${varObj.name}: `
            + `numchild=${varObj.numchild}, type=${varObj.type}, `
            + `isCompound=${isCompound}, result=${result}`
        );

        return result;
    }

    private evaluateQ = new RequestQueue<DebugProtocol.EvaluateResponse, DebugProtocol.EvaluateArguments>();
    public evaluateRequest(
        r: DebugProtocol.EvaluateResponse, a: DebugProtocol.EvaluateArguments,
        miDebugger: MI2, session: GDBDebugSession, forceNoFrameId = false): Promise<void> {
        a.context = a.context || 'hover';
        if (a.context !== 'repl') {
            if (this.isBusy()) {
                this.busyError(r, a);
                return Promise.resolve();
            }
        }

        const doit = (
            response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments,
            _pendContinue: any, miDebugger: MI2, session: GDBDebugSession) => {
            return new Promise<void>(async (resolve) => {
                if (this.isBusy() && (a.context !== 'repl')) {
                    this.busyError(response, args);
                    resolve();
                    return;
                }

                // Spec says if 'frameId' is specified, evaluate in the scope specified or in the global scope. Well,
                // we don't have a way to specify global scope ... use floating variable.
                let threadId = session.stoppedThreadId || 1;
                let frameId = 0;
                if (forceNoFrameId) {
                    threadId = frameId = -1;
                    args.frameId = undefined;
                } else if (args.frameId !== undefined) {
                    [threadId, frameId] = decodeReference(args.frameId);
                }

                if (args.context !== 'repl') {
                    try {
                        const exp = args.expression;
                        const hasher = crypto.createHash('sha256');
                        hasher.update(exp);
                        if (!forceNoFrameId && (args.frameId !== undefined)) {
                            hasher.update(args.frameId.toString(16));
                        }
                        const exprName = hasher.digest('hex');
                        const varObjName = `${args.context}_${exprName}`;
                        let varObj: VariableObject;
                        let varId = this.variableHandlesReverse.get(varObjName);
                        let forceCreate = varId === undefined;
                        let updateError;
                        if (!forceCreate) {
                            try {
                                const cachedChange = this.cachedChangeList && this.cachedChangeList[varObjName];
                                let changelist;
                                if (cachedChange) {
                                    changelist = [];
                                } else if (this.cachedChangeList && (varId !== undefined)) {
                                    changelist = [];
                                } else {
                                    const changes = await miDebugger.varUpdate(varObjName, threadId, frameId);
                                    changelist = changes.result('changelist') ?? [];
                                }
                                for (const change of changelist) {
                                    const inScope = MINode.valueOf(change, 'in_scope');
                                    if (inScope === 'true') {
                                        const name = MINode.valueOf(change, 'name');
                                        const vId = this.variableHandlesReverse.get(name);
                                        const v = this.variableHandles.get(vId) as any;
                                        v.applyChanges(change);
                                        if (this.cachedChangeList) {
                                            this.cachedChangeList[name] = change;
                                        }
                                    } else {
                                        const msg = `${exp} currently not in scope`;
                                        await miDebugger.sendCommand(`var-delete ${varObjName}`);
                                        if (session.args.showDevDebugOutput) {
                                            session.handleMsg('log', `Expression ${msg}. Will try to create again\n`);
                                        }
                                        forceCreate = true;
                                        throw new Error(msg);
                                    }
                                }
                                varObj = this.variableHandles.get(varId) as any;
                            } catch (err) {
                                updateError = err;
                            }
                        }
                        if (!this.isBusy() && (forceCreate || ((updateError instanceof MIError && updateError.message === 'Variable object not found')))) {
                            if (this.cachedChangeList) {
                                delete this.cachedChangeList[varObjName];
                            }
                            if (forceNoFrameId || (args.frameId === undefined)) {
                                varObj = await miDebugger.varCreate(0, exp, varObjName, '@');  // Create floating variable
                            } else {
                                varObj = await miDebugger.varCreate(0, exp, varObjName, '@', threadId, frameId);
                            }
                            varId = this.findOrCreateVariable(varObj);
                            varObj.exp = exp;
                            varObj.id = varId;
                        } else if (!varObj) {
                            throw updateError || new Error('live watch unknown error');
                        }

                        response.body = varObj.toProtocolEvaluateResponseBody();
                        response.success = true;
                        session.sendResponse(response);
                    } catch (err) {
                        if (this.isBusy()) {
                            this.busyError(response, args);
                        } else {
                            response.body = {
                                result: (args.context === 'hover') ? null : `<${err.toString()}>`,
                                variablesReference: 0
                            };
                            session.sendResponse(response);
                            if (session.args.showDevDebugOutput) {
                                session.handleMsg('stderr', args.context + ' ' + err.toString());
                            }
                        }
                        // this.sendErrorResponse(response, 7, err.toString());
                    } finally {
                        resolve();
                    }
                } else {        // This is an 'repl'
                    try {
                        miDebugger.sendUserInput(args.expression).then((output) => {
                            if (typeof output === 'undefined') {
                                response.body = {
                                    result: '',
                                    variablesReference: 0
                                };
                            } else {
                                response.body = {
                                    result: JSON.stringify(output),
                                    variablesReference: 0
                                };
                            }
                            session.sendResponse(response);
                            resolve();
                        }, (msg) => {
                            session.sendErrorResponsePub(response, 8, msg.toString());
                            resolve();
                        });
                    } catch (e) {
                        session.sendErrorResponsePub(response, 8, e.toString());
                        resolve();
                    }
                }
            });
        };

        return this.evaluateQ.add(doit, r, a, miDebugger, session);
    }

    public getCachedChilren(pVar: VariableObject): VariableObject[] | undefined {
        if (!this.cachedChangeList) { return undefined; }
        const keys = Object.keys(pVar.children);
        if (keys.length === 0) { return undefined; }        // We don't have previous children, force a refresh
        const ret: VariableObject[] = [];
        for (const key of keys) {
            const gdbVaName = pVar.children[key];
            const childId = this.variableHandlesReverse.get(gdbVaName);
            if (childId === undefined) {
                return undefined;
            }
            const childObj = this.variableHandles.get(childId) as VariableObject;
            ret.push(childObj);
        }
        return ret;
    }

    public async variablesChildrenRequest(
        response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments,
        miDebugger: MI2, session: GDBDebugSession): Promise<void> {
        response.body = { variables: [] };
        if (!args.variablesReference) {
            // This should only be called to expand additional variable for a valid parent
            session.sendResponse(response);
            return;
        }
        const id = this.variableHandles.get(args.variablesReference);
        if (typeof id === 'object') {
            if (id instanceof VariableObject) {
                const pVar = id;

                // Variable members
                let children: VariableObject[];
                const childMap: { [name: string]: number } = {};
                try {
                    let vars = [];
                    children = this.getCachedChilren(pVar);
                    if (children) {
                        for (const child of children) {
                            vars.push(child.toProtocolVariable());
                        }
                    } else {
                        children = await miDebugger.varListChildren(args.variablesReference, id.name);
                        pVar.children = {};     // Clear in case type changed, dynamic variable, etc.
                        vars = children.map((child) => {
                            const varId = this.findOrCreateVariable(child);
                            child.id = varId;
                            if (/^\d+$/.test(child.exp)) {
                                child.fullExp = `${pVar.fullExp || pVar.exp}[${child.exp}]`;
                            } else {
                                let suffix = '.' + child.exp;                   // A normal suffix
                                if (child.exp.startsWith('<anonymous')) {       // We can have duplicates!!
                                    const prev = childMap[child.exp];
                                    if (prev) {
                                        childMap[child.exp] = prev + 1;
                                        child.exp += '#' + prev.toString(10);
                                    }
                                    childMap[child.exp] = 1;
                                    suffix = '';    // Anonymous ones don't have a suffix. Have to use parent name
                                } else {
                                    // The full-name is not always derivable from the parent and child info. Esp. children
                                    // of anonymous stuff. Might as well store all of them or set-value will not work.
                                    pVar.children[child.exp] = child.name;
                                }
                                child.fullExp = `${pVar.fullExp || pVar.exp}${suffix}`;
                            }
                            return child.toProtocolVariable();
                        });
                    }

                    response.body = {
                        variables: vars
                    };
                    session.sendResponse(response);
                } catch (err) {
                    session.sendErrorResponsePub(response, 1, `Could not expand variable: ${err}`);
                }
            } else if (id instanceof ExtendedVariable) {
                const variables: DebugProtocol.Variable[] = [];

                const varReq = id;
                if (varReq.options.arg) {
                    const strArr = [];
                    let argsPart = true;
                    let arrIndex = 0;
                    const submit = () => {
                        response.body = {
                            variables: strArr
                        };
                        session.sendResponse(response);
                    };
                    const addOne = async () => {
                        const variable = await miDebugger.evalExpression(JSON.stringify(`${varReq.name}+${arrIndex})`), -1, -1);
                        try {
                            const expanded = expandValue(this.createVariable.bind(this), variable.result('value'), varReq.name, variable);
                            if (!expanded) {
                                session.sendErrorResponsePub(response, 15, 'Could not expand variable');
                            } else {
                                if (typeof expanded === 'string') {
                                    if (expanded === '<nullptr>') {
                                        if (argsPart) {
                                            argsPart = false;
                                        } else {
                                            return submit();
                                        }
                                    } else if (expanded[0] !== '"') {
                                        strArr.push({
                                            name: '[err]',
                                            value: expanded,
                                            variablesReference: 0
                                        });
                                        return submit();
                                    }
                                    strArr.push({
                                        name: `[${(arrIndex++)}]`,
                                        value: expanded,
                                        variablesReference: 0
                                    });
                                    addOne();
                                } else {
                                    strArr.push({
                                        name: '[err]',
                                        value: expanded,
                                        variablesReference: 0
                                    });
                                    submit();
                                }
                            }
                        } catch (e) {
                            session.sendErrorResponsePub(response, 14, `Could not expand variable: ${e}`);
                        }
                    };
                    addOne();
                } else {
                    session.sendErrorResponsePub(response, 13, `Unimplemented variable request options: ${JSON.stringify(varReq.options)}`);
                }
            } else {
                response.body = {
                    variables: id
                };
                session.sendResponse(response);
            }
        } else {
            response.body = {
                variables: []
            };
            session.sendResponse(response);
        }
    }
}

export class LiveWatchMonitor {
    public miDebugger: MI2 | undefined;
    protected varHandler: VariablesHandler;
    private samplingTimer: NodeJS.Timeout | undefined;
    private samplingIntervalMs: number = 10; // Default 10ms high-speed sampling
    private samplingEnabled: boolean = false;
    private cachedSamples: Map<string, SampleData> = new Map();

    // Historical data buffering
    private historicalData: Map<string, HistoricalSampleData[]> = new Map();
    private maxHistorySize: number = 1000; // Maximum samples per variable
    private samplingStats: SamplingStats = {
        totalSamples: 0,
        averageIntervalMs: 0,
        lastSampleTime: 0,
        samplingErrors: 0,
        variablesCount: 0
    };

    // Conditional sampling
    private conditionalSampling: ConditionalSamplingConfig | null = null;
    private previousValues: Map<string, string> = new Map(); // Track previous values for change detection

    // Adaptive sampling
    private adaptiveSampling: AdaptiveSamplingConfig | null = null;
    private variableChangeRates: Map<string, number> = new Map();
    private lastAdaptiveAdjustment: number = 0;

    // Performance optimization
    private performanceOptimization: PerformanceOptimizationConfig | null = null;
    private requestQueue: RequestQueue<any, any> = new RequestQueue<any, any>();
    private memoryUsage: number = 0;
    private compressionCache: Map<string, string> = new Map();

    constructor(private mainSession: GDBDebugSession) {
        this.varHandler = new VariablesHandler(
            (): boolean => false,
            (r: DebugProtocol.Response, a: any) => { }
        );

        // Initialize historical data settings from configuration
        const liveWatchConfig = mainSession.args.liveWatch;
        if (liveWatchConfig?.historicalData?.enabled) {
            this.maxHistorySize = liveWatchConfig.historicalData.maxSamples || 1000;
        }

        // Initialize conditional sampling from configuration
        if (liveWatchConfig?.conditionalSampling?.enabled) {
            this.conditionalSampling = {
                enabled: true,
                triggers: liveWatchConfig.conditionalSampling.triggers || [],
                action: liveWatchConfig.conditionalSampling.action || 'sample'
            };
        }

        // Initialize adaptive sampling from configuration
        if (liveWatchConfig?.adaptiveSampling?.enabled) {
            this.adaptiveSampling = {
                enabled: true,
                minIntervalMs: liveWatchConfig.adaptiveSampling.minIntervalMs || 1,
                maxIntervalMs: liveWatchConfig.adaptiveSampling.maxIntervalMs || 1000,
                changeThreshold: liveWatchConfig.adaptiveSampling.changeThreshold || 0.1,
                stabilityPeriodMs: liveWatchConfig.adaptiveSampling.stabilityPeriodMs || 5000,
                adjustmentFactor: liveWatchConfig.adaptiveSampling.adjustmentFactor || 0.5
            };
        }

        // Initialize performance optimization from configuration
        if (liveWatchConfig?.performanceOptimization?.enabled) {
            this.performanceOptimization = {
                enabled: true,
                batchSize: liveWatchConfig.performanceOptimization.batchSize || 10,
                memoryLimitMB: liveWatchConfig.performanceOptimization.memoryLimitMB || 100,
                compressionEnabled: liveWatchConfig.performanceOptimization.compressionEnabled || true,
                cacheTimeoutMs: liveWatchConfig.performanceOptimization.cacheTimeoutMs || 5000,
                maxConcurrentRequests: liveWatchConfig.performanceOptimization.maxConcurrentRequests || 5
            };
        }
    }

    public setupEvents(mi2: MI2) {
        this.miDebugger = mi2;
        this.miDebugger.on('quit', this.quitEvent.bind(this));
        this.miDebugger.on('exited-normally', this.quitEvent.bind(this));
        this.miDebugger.on('msg', (type: string, msg: string) => {
            this.mainSession.handleMsg(type, 'LiveGDB: ' + msg);
        });

        /*
        Yes, we get all of these events and they seem to be harlmess
        const otherEvents = [
            'stopped',
            'watchpoint',
            'watchpoint-scope',
            'step-end',
            'step-out-end',
            'signal-stop',
            'running',
            'continue-failed',
            'thread-created',
            'thread-exited',
            'thread-selected',
            'thread-group-exited'
        ];
        for (const ev of otherEvents) {
            this.miDebugger.on(ev, (arg) => {
                this.mainSession.handleMsg(
                    'stderr', `Internal Error: Live watch GDB session received an unexpected event '${ev}' with arg ${arg?.toString() ?? '<empty>'}\n`);
            });
        }
        */
    }

    protected quitEvent() {
        this.stopSampling();
        // this.miDebugger = undefined;
    }

    /**
     * Start high-speed background sampling
     * @param intervalMs Sampling interval in milliseconds (1-100ms recommended)
     */
    public startSampling(intervalMs: number = 10) {
        this.samplingIntervalMs = Math.max(1, Math.min(100, intervalMs)); // Clamp to 1-100ms
        this.samplingEnabled = true;

        if (this.samplingTimer) {
            clearInterval(this.samplingTimer);
        }

        this.samplingTimer = setInterval(() => {
            this.performSampling();
        }, this.samplingIntervalMs);

        if (this.mainSession.args.showDevDebugOutput) {
            this.mainSession.handleMsg('log', `LiveWatch: Started high-speed sampling at ${this.samplingIntervalMs}ms interval\n`);
        }
    }

    /**
     * Stop high-speed background sampling
     */
    public stopSampling() {
        this.samplingEnabled = false;
        if (this.samplingTimer) {
            clearInterval(this.samplingTimer);
            this.samplingTimer = undefined;
        }
        this.cachedSamples.clear();
    }

    /**
     * Perform one sampling cycle - updates cache for all tracked variables
     */
    private performSampling() {
        if (!this.miDebugger || !this.samplingEnabled) {
            return;
        }

        const samplingStartTime = Date.now();

        try {
            // Refresh the cache using existing mechanism
            this.varHandler.refreshCachedChangeList(this.miDebugger, () => {
                // Cache is now updated, store samples with timestamp
                const timestamp = Date.now();

                // Update sampling statistics
                this.samplingStats.totalSamples++;
                if (this.samplingStats.lastSampleTime > 0) {
                    const interval = timestamp - this.samplingStats.lastSampleTime;
                    this.samplingStats.averageIntervalMs
                        = (this.samplingStats.averageIntervalMs * (this.samplingStats.totalSamples - 1) + interval)
                        / this.samplingStats.totalSamples;
                }
                this.samplingStats.lastSampleTime = timestamp;

                // Iterate through all cached variables and store their current values
                if (this.varHandler.cachedChangeList) {
                    this.samplingStats.variablesCount = Object.keys(this.varHandler.cachedChangeList).length;

                    for (const [varName, change] of Object.entries(this.varHandler.cachedChangeList)) {
                        const varId = this.varHandler.variableHandlesReverse.get(varName);
                        if (varId !== undefined) {
                            const varObj = this.varHandler.variableHandles.get(varId) as VariableObject;
                            if (varObj) {
                                const currentValue = varObj.value || '';
                                const currentType = varObj.type;
                                const currentVarRef = varObj.isCompound() ? varId : 0;

                                // Store in cache
                                this.cachedSamples.set(varName, {
                                    timestamp,
                                    value: currentValue,
                                    type: currentType,
                                    variablesReference: currentVarRef
                                });

                                // Store in historical data
                                this.storeHistoricalSample(varName, {
                                    timestamp,
                                    value: currentValue,
                                    type: currentType,
                                    variablesReference: currentVarRef
                                });

                                // Check conditional triggers
                                this.checkConditionalTriggers(varName, currentValue, timestamp);

                                // Update adaptive sampling
                                this.updateAdaptiveSampling(varName, currentValue, timestamp);

                                // Apply performance optimizations
                                this.optimizeMemoryUsage();
                            }
                        }
                    }
                }
            });
        } catch (error) {
            this.samplingStats.samplingErrors++;
            if (this.mainSession.args.showDevDebugOutput) {
                this.mainSession.handleMsg('stderr', `LiveWatch sampling error: ${error}\n`);
            }
        }
    }

    /**
     * Get cached sample data for a variable
     * @param varName GDB variable name
     */
    public getCachedSample(varName: string): SampleData | undefined {
        return this.cachedSamples.get(varName);
    }

    /**
     * Store historical sample data for a variable
     * @param varName Variable name
     * @param sample Sample data
     */
    private storeHistoricalSample(varName: string, sample: HistoricalSampleData) {
        if (!this.historicalData.has(varName)) {
            this.historicalData.set(varName, []);
        }

        const history = this.historicalData.get(varName);
        const previousSample = history && history.length > 0 ? history[history.length - 1] : null;

        // Calculate change rate if enabled in configuration and we have a previous sample
        const liveWatchConfig = this.mainSession.args.liveWatch;
        if (liveWatchConfig?.historicalData?.enableChangeRate && previousSample) {
            try {
                const prevValue = parseFloat(previousSample.value);
                const currValue = parseFloat(sample.value);
                if (!isNaN(prevValue) && !isNaN(currValue)) {
                    const timeDiff = sample.timestamp - previousSample.timestamp;
                    if (timeDiff > 0) {
                        sample.changeRate = (currValue - prevValue) / timeDiff;
                    }
                }
            } catch (e) {
                // Ignore parsing errors for non-numeric values
            }
        }

        history.push(sample);

        // Maintain maximum history size
        if (history.length > this.maxHistorySize) {
            history.shift(); // Remove oldest sample
        }
    }

    /**
     * Get historical data for a variable
     * @param varName Variable name
     * @param maxSamples Maximum number of samples to return (default: all)
     */
    public getHistoricalData(varName: string, maxSamples?: number): HistoricalSampleData[] {
        const history = this.historicalData.get(varName) || [];
        if (maxSamples && maxSamples > 0) {
            return history.slice(-maxSamples);
        }
        return [...history];
    }

    /**
     * Get historical data for all variables
     * @param maxSamples Maximum number of samples per variable
     */
    public getAllHistoricalData(maxSamples?: number): Map<string, HistoricalSampleData[]> {
        const result = new Map<string, HistoricalSampleData[]>();
        for (const [varName, history] of this.historicalData) {
            result.set(varName, this.getHistoricalData(varName, maxSamples));
        }
        return result;
    }

    /**
     * Get sampling statistics
     */
    public getSamplingStats(): SamplingStats {
        return { ...this.samplingStats };
    }

    /**
     * Clear historical data for a specific variable
     * @param varName Variable name
     */
    public clearHistoricalData(varName: string): void {
        this.historicalData.delete(varName);
    }

    /**
     * Clear all historical data
     */
    public clearAllHistoricalData(): void {
        this.historicalData.clear();
    }

    /**
     * Set maximum history size per variable
     * @param size Maximum number of samples to keep per variable
     */
    public setMaxHistorySize(size: number): void {
        this.maxHistorySize = Math.max(1, size);

        // Trim existing histories if needed
        for (const [varName, history] of this.historicalData) {
            if (history.length > this.maxHistorySize) {
                this.historicalData.set(varName, history.slice(-this.maxHistorySize));
            }
        }
    }

    /**
     * Check conditional triggers for a variable
     * @param varName Variable name
     * @param currentValue Current value
     * @param timestamp Current timestamp
     */
    private checkConditionalTriggers(varName: string, currentValue: string, timestamp: number): void {
        if (!this.conditionalSampling || !this.conditionalSampling.enabled) {
            return;
        }

        for (const trigger of this.conditionalSampling.triggers) {
            if (trigger.variable !== varName) {
                continue;
            }

            // Check debounce
            const debounceMs = trigger.debounceMs || 100;
            if (trigger.lastTriggerTime && (timestamp - trigger.lastTriggerTime) < debounceMs) {
                continue;
            }

            // Check trigger condition
            if (this.evaluateTriggerCondition(trigger, currentValue)) {
                trigger.lastTriggerTime = timestamp;
                this.executeTriggerAction(trigger, varName, currentValue);
            }
        }

        // Update previous value for change detection
        this.previousValues.set(varName, currentValue);
    }

    /**
     * Evaluate a trigger condition
     * @param trigger Trigger configuration
     * @param currentValue Current variable value
     */
    private evaluateTriggerCondition(trigger: ConditionalTrigger, currentValue: string): boolean {
        try {
            switch (trigger.condition) {
                case 'change': {
                    const previousValue = this.previousValues.get(trigger.variable);
                    return previousValue !== undefined && previousValue !== currentValue;
                }

                case 'equals':
                    return currentValue === trigger.value?.toString();

                case 'greater': {
                    const currentNum = parseFloat(currentValue);
                    const targetNum = parseFloat(trigger.value?.toString() || '0');
                    return !isNaN(currentNum) && !isNaN(targetNum) && currentNum > targetNum;
                }

                case 'less': {
                    const currentNumLess = parseFloat(currentValue);
                    const targetNumLess = parseFloat(trigger.value?.toString() || '0');
                    return !isNaN(currentNumLess) && !isNaN(targetNumLess) && currentNumLess < targetNumLess;
                }

                case 'range': {
                    const currentNumRange = parseFloat(currentValue);
                    const minNum = parseFloat(trigger.minValue?.toString() || '0');
                    const maxNum = parseFloat(trigger.maxValue?.toString() || '0');
                    return !isNaN(currentNumRange) && !isNaN(minNum) && !isNaN(maxNum)
                        && currentNumRange >= minNum && currentNumRange <= maxNum;
                }

                default:
                    return false;
            }
        } catch (error) {
            if (this.mainSession.args.showDevDebugOutput) {
                this.mainSession.handleMsg('stderr', `Conditional trigger evaluation error: ${error}\n`);
            }
            return false;
        }
    }

    /**
     * Execute trigger action
     * @param trigger Trigger configuration
     * @param varName Variable name
     * @param currentValue Current value
     */
    private executeTriggerAction(trigger: ConditionalTrigger, varName: string, currentValue: string): void {
        if (!this.conditionalSampling) {
            return;
        }

        const message = `Conditional trigger activated: ${varName} ${trigger.condition} ${trigger.value || ''} (value: ${currentValue})`;

        if (this.mainSession.args.showDevDebugOutput) {
            this.mainSession.handleMsg('log', `${message}\n`);
        }

        switch (this.conditionalSampling.action) {
            case 'sample':
                // Force an immediate sampling cycle
                this.performSampling();
                break;
            case 'pause':
                // Pause sampling
                this.stopSampling();
                break;
            case 'resume':
                // Resume sampling if paused
                if (!this.samplingEnabled) {
                    this.startSampling(this.samplingIntervalMs);
                }
                break;
        }
    }

    /**
     * Get all cached samples
     */
    public getAllCachedSamples(): Map<string, SampleData> {
        return new Map(this.cachedSamples);
    }

    /**
     * Get conditional triggers configuration
     */
    public getConditionalTriggers(): ConditionalTrigger[] {
        return this.conditionalSampling?.triggers || [];
    }

    /**
     * Set conditional triggers configuration
     * @param triggers Array of trigger configurations
     * @param action Action to take when triggered
     */
    public setConditionalTriggers(triggers: ConditionalTrigger[], action: 'sample' | 'pause' | 'resume'): void {
        this.conditionalSampling = {
            enabled: triggers.length > 0,
            triggers: triggers,
            action: action
        };
    }

    /**
     * Export historical data to CSV format
     * @param varName Optional variable name to export specific variable, or undefined for all
     * @param maxSamples Maximum number of samples to export
     */
    public exportToCSV(varName?: string, maxSamples?: number): string {
        if (varName) {
            // Export single variable
            const data = this.getHistoricalData(varName, maxSamples);
            const csvLines = ['timestamp,value,type,changeRate'];
            for (const sample of data) {
                const timestamp = new Date(sample.timestamp).toISOString();
                const value = sample.value.replace(/"/g, '""'); // Escape quotes
                const type = sample.type || '';
                const changeRate = sample.changeRate || '';
                csvLines.push(`"${timestamp}","${value}","${type}","${changeRate}"`);
            }
            return csvLines.join('\n');
        } else {
            // Export all variables
            const data = this.getAllHistoricalData(maxSamples);
            const csvLines = ['timestamp,variable,value,type,changeRate'];
            for (const [varName, samples] of data) {
                for (const sample of samples) {
                    const timestamp = new Date(sample.timestamp).toISOString();
                    const value = sample.value.replace(/"/g, '""'); // Escape quotes
                    const type = sample.type || '';
                    const changeRate = sample.changeRate || '';
                    csvLines.push(`"${timestamp}","${varName}","${value}","${type}","${changeRate}"`);
                }
            }
            return csvLines.join('\n');
        }
    }

    /**
     * Export historical data to JSON format
     * @param varName Optional variable name to export specific variable, or undefined for all
     * @param maxSamples Maximum number of samples to export
     */
    public exportToJSON(varName?: string, maxSamples?: number): string {
        if (varName) {
            // Export single variable
            const data = this.getHistoricalData(varName, maxSamples);
            return JSON.stringify({
                variable: varName,
                samples: data.map((sample) => ({
                    timestamp: sample.timestamp,
                    value: sample.value,
                    type: sample.type,
                    changeRate: sample.changeRate
                })),
                metadata: {
                    totalSamples: data.length,
                    exportTime: new Date().toISOString(),
                    maxSamples: maxSamples
                }
            }, null, 2);
        } else {
            // Export all variables
            const data = this.getAllHistoricalData(maxSamples);
            const exportData: any = {
                variables: {},
                metadata: {
                    totalVariables: data.size,
                    exportTime: new Date().toISOString(),
                    maxSamples: maxSamples
                }
            };

            for (const [varName, samples] of data) {
                exportData.variables[varName] = {
                    samples: samples.map((sample) => ({
                        timestamp: sample.timestamp,
                        value: sample.value,
                        type: sample.type,
                        changeRate: sample.changeRate
                    })),
                    totalSamples: samples.length
                };
            }

            return JSON.stringify(exportData, null, 2);
        }
    }

    /**
     * Check if sampling is currently active
     */
    public isSampling(): boolean {
        return this.samplingEnabled && this.samplingTimer !== undefined;
    }

    /**
     * Set a variable value while running (using Live GDB connection)
     * This allows modifying variables without stopping the target
     */
    public async setVariable(
        variablesReference: number,
        name: string,
        value: string
    ): Promise<DebugProtocol.SetVariableResponse['body']> {
        if (!this.miDebugger) {
            throw new Error('Live GDB not available');
        }

        try {
            const varObj = this.varHandler.variableHandles.get(variablesReference) as VariableObject;
            if (!varObj || !(varObj instanceof VariableObject)) {
                throw new Error(`Invalid variable reference: ${variablesReference}`);
            }

            // Find the child variable
            const childGdbName = varObj.children[name];
            if (!childGdbName) {
                // List available children for debugging
                const availableChildren = Object.keys(varObj.children).join(', ');
                throw new Error(`Child variable '${name}' not found. Available children: ${availableChildren || 'none'}`);
            }

            // Use GDB's var-assign command to set the value
            const result = await this.miDebugger.sendCommand(`var-assign ${childGdbName} ${value}`);
            const newValue = result.result('value');

            if (this.mainSession.args.showDevDebugOutput) {
                this.mainSession.handleMsg('log', `LiveGDB: Set ${childGdbName} (${name}) = ${newValue}\n`);
            }

            // Update the cached value
            const varId = this.varHandler.variableHandlesReverse.get(childGdbName);
            if (varId !== undefined) {
                const childObj = this.varHandler.variableHandles.get(varId) as VariableObject;
                if (childObj) {
                    childObj.value = newValue;
                }
            }

            return {
                value: newValue,
                type: undefined,
                variablesReference: 0,
                namedVariables: 0,
                indexedVariables: 0
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (this.mainSession.args.showDevDebugOutput) {
                this.mainSession.handleMsg('stderr', `LiveGDB: Failed to set variable ${name}: ${errorMsg}\n`);
            }
            throw new Error(`Failed to set variable: ${errorMsg}`);
        }
    }

    /**
     * Set an expression value while running (for root-level variables)
     */
    public async setExpression(
        expression: string,
        value: string
    ): Promise<DebugProtocol.SetExpressionResponse['body']> {
        if (!this.miDebugger) {
            throw new Error('Live GDB not available');
        }

        try {
            // First, evaluate to get the variable object name
            const evalArg: DebugProtocol.EvaluateArguments = {
                expression: expression,
                context: 'watch'
            };

            const evalResponse: DebugProtocol.EvaluateResponse = {
                seq: 0,
                type: 'response',
                request_seq: 0,
                command: 'evaluate',
                success: true,
                body: {
                    result: undefined,
                    variablesReference: undefined
                }
            };

            await this.evaluateRequest(evalResponse, evalArg);

            if (!evalResponse.success || !evalResponse.body) {
                throw new Error(`Could not evaluate expression: ${expression}`);
            }

            // Now get the GDB variable name from the cache
            const hasher = crypto.createHash('sha256');
            hasher.update(expression);
            const exprName = hasher.digest('hex');
            const varObjName = `watch_${exprName}`;

            // Use var-assign to set the value
            const result = await this.miDebugger.sendCommand(`var-assign ${varObjName} ${value}`);
            const newValue = result.result('value');

            if (this.mainSession.args.showDevDebugOutput) {
                this.mainSession.handleMsg('log', `LiveGDB: Set ${expression} = ${newValue}\n`);
            }

            // Update the cached value
            const varId = this.varHandler.variableHandlesReverse.get(varObjName);
            if (varId !== undefined) {
                const varObj = this.varHandler.variableHandles.get(varId) as VariableObject;
                if (varObj) {
                    varObj.value = newValue;
                }
            }

            return {
                value: newValue,
                type: undefined,
                variablesReference: 0,
                namedVariables: 0,
                indexedVariables: 0
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to set expression: ${errorMsg}`);
        }
    }

    public evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        return new Promise<void>((resolve) => {
            args.frameId = undefined;       // We don't have threads or frames here. We always evaluate in global context
            this.varHandler.evaluateRequest(response, args, this.miDebugger, this.mainSession, true).finally(() => {
                if (this.mainSession.args.showDevDebugOutput) {
                    this.mainSession.handleMsg('log',
                        `LiveGDB: Evaluated ${args.expression}, `
                        + `result=${response.body?.result}, `
                        + `varRef=${response.body?.variablesReference}, `
                        + `type=${response.body?.type}\n`
                    );
                }
                resolve();
            });
        });
    }

    public async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, session?: GDBDebugSession): Promise<void> {
        const useSession = session || this.mainSession;
        if (this.mainSession.args.showDevDebugOutput) {
            this.mainSession.handleMsg('log', `LiveGDB: variablesRequest for varRef=${args.variablesReference}\n`);
        }
        const ret = await this.varHandler.variablesChildrenRequest(response, args, this.miDebugger, useSession);
        if (this.mainSession.args.showDevDebugOutput) {
            this.mainSession.handleMsg('log',
                `LiveGDB: variablesRequest returned ${response.body?.variables?.length || 0} variables\n`
            );
        }
        return ret;
    }

    // Calling this will also enable caching for the future of the session
    public async refreshLiveCache(args: RefreshAllArguments): Promise<void> {
        if (args.deleteAll) {
            await this.varHandler.clearCachedVars(this.miDebugger);
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.varHandler.refreshCachedChangeList(this.miDebugger, resolve);
        });
    }

    // Adaptive sampling methods
    private updateAdaptiveSampling(varName: string, currentValue: string, timestamp: number): void {
        if (!this.adaptiveSampling?.enabled) {
            return;
        }

        const previousValue = this.previousValues.get(varName);
        if (previousValue !== undefined) {
            // Calculate change rate
            const changeRate = this.calculateChangeRate(previousValue, currentValue);
            this.variableChangeRates.set(varName, changeRate);
        }

        this.previousValues.set(varName, currentValue);

        // Check if we should adjust sampling interval
        const now = Date.now();
        if (now - this.lastAdaptiveAdjustment > this.adaptiveSampling.stabilityPeriodMs) {
            this.adjustSamplingInterval();
            this.lastAdaptiveAdjustment = now;
        }
    }

    private calculateChangeRate(oldValue: string, newValue: string): number {
        try {
            const oldNum = parseFloat(oldValue);
            const newNum = parseFloat(newValue);

            if (isNaN(oldNum) || isNaN(newNum)) {
                // For non-numeric values, use string comparison
                return oldValue === newValue ? 0 : 1;
            }

            if (oldNum === 0) {
                return newNum === 0 ? 0 : 1;
            }

            return Math.abs((newNum - oldNum) / oldNum);
        } catch (error) {
            return oldValue === newValue ? 0 : 1;
        }
    }

    private adjustSamplingInterval(): void {
        if (!this.adaptiveSampling) {
            return;
        }

        const changeRates = Array.from(this.variableChangeRates.values());
        if (changeRates.length === 0) {
            return;
        }

        const averageChangeRate = changeRates.reduce((sum, rate) => sum + rate, 0) / changeRates.length;
        const maxChangeRate = Math.max(...changeRates);

        let newInterval = this.samplingIntervalMs;

        if (maxChangeRate > this.adaptiveSampling.changeThreshold) {
            // High change rate - decrease interval (sample more frequently)
            newInterval = Math.max(
                this.samplingIntervalMs * (1 - this.adaptiveSampling.adjustmentFactor),
                this.adaptiveSampling.minIntervalMs
            );
        } else if (averageChangeRate < this.adaptiveSampling.changeThreshold * 0.1) {
            // Low change rate - increase interval (sample less frequently)
            newInterval = Math.min(
                this.samplingIntervalMs * (1 + this.adaptiveSampling.adjustmentFactor),
                this.adaptiveSampling.maxIntervalMs
            );
        }

        if (Math.abs(newInterval - this.samplingIntervalMs) > 1) {
            this.samplingIntervalMs = newInterval;

            // Restart sampling with new interval
            if (this.samplingEnabled) {
                this.stopSampling();
                this.startSampling();
            }

            if (this.mainSession.args.showDevDebugOutput) {
                this.mainSession.handleMsg('stderr',
                    `LiveWatch adaptive sampling: interval adjusted to ${this.samplingIntervalMs}ms (avg change rate: ${averageChangeRate.toFixed(3)})\n`);
            }
        }
    }

    public getAdaptiveSamplingConfig(): AdaptiveSamplingConfig | null {
        return this.adaptiveSampling;
    }

    public setAdaptiveSamplingConfig(config: AdaptiveSamplingConfig): void {
        this.adaptiveSampling = config;

        // Reset change rates when config changes
        this.variableChangeRates.clear();
        this.lastAdaptiveAdjustment = 0;
    }

    public getVariableChangeRates(): Map<string, number> {
        return new Map(this.variableChangeRates);
    }

    // Performance optimization methods
    public getPerformanceOptimizationConfig(): PerformanceOptimizationConfig | null {
        return this.performanceOptimization;
    }

    public setPerformanceOptimizationConfig(config: PerformanceOptimizationConfig): void {
        this.performanceOptimization = config;
    }

    public getMemoryUsage(): number {
        return this.memoryUsage;
    }

    public optimizeMemoryUsage(): void {
        if (!this.performanceOptimization?.enabled) {
            return;
        }

        const memoryLimitBytes = this.performanceOptimization.memoryLimitMB * 1024 * 1024;

        if (this.memoryUsage > memoryLimitBytes) {
            // Clear old historical data
            const maxSamples = Math.floor(this.maxHistorySize * 0.5);
            for (const [varName, data] of this.historicalData) {
                if (data.length > maxSamples) {
                    this.historicalData.set(varName, data.slice(-maxSamples));
                }
            }

            // Clear compression cache
            this.compressionCache.clear();

            // Update memory usage estimate
            this.updateMemoryUsage();

            if (this.mainSession.args.showDevDebugOutput) {
                this.mainSession.handleMsg('stderr',
                    `LiveWatch memory optimization: cleared old data, current usage: ${(this.memoryUsage / 1024 / 1024).toFixed(2)}MB\n`);
            }
        }
    }

    private updateMemoryUsage(): void {
        let totalSize = 0;

        // Estimate memory usage from historical data
        for (const [varName, data] of this.historicalData) {
            totalSize += varName.length * 2; // UTF-16 string
            totalSize += data.length * 50; // Estimate 50 bytes per sample
        }

        // Estimate memory usage from cached samples
        for (const [varName, sample] of this.cachedSamples) {
            totalSize += varName.length * 2;
            totalSize += (sample.value?.length || 0) * 2;
            totalSize += (sample.type?.length || 0) * 2;
        }

        // Estimate memory usage from compression cache
        for (const [key, value] of this.compressionCache) {
            totalSize += key.length * 2;
            totalSize += value.length * 2;
        }

        this.memoryUsage = totalSize;
    }

    private compressValue(value: string): string {
        if (!this.performanceOptimization?.compressionEnabled) {
            return value;
        }

        // Simple compression: remove common patterns
        const compressed = value
            .replace(/\s+/g, ' ') // Replace multiple spaces with single space
            .replace(/0x0+/g, '0x0') // Compress hex zeros
            .replace(/\.0+/g, '.0'); // Compress decimal zeros

        // Cache compressed value
        this.compressionCache.set(value, compressed);

        return compressed;
    }

    private decompressValue(compressed: string): string {
        if (!this.performanceOptimization?.compressionEnabled) {
            return compressed;
        }

        // Find original value in cache
        for (const [original, comp] of this.compressionCache) {
            if (comp === compressed) {
                return original;
            }
        }

        return compressed;
    }

    public getPerformanceStats(): {
        memoryUsageMB: number;
        historicalDataSize: number;
        cachedSamplesSize: number;
        compressionCacheSize: number;
    } {
        this.updateMemoryUsage();

        return {
            memoryUsageMB: this.memoryUsage / 1024 / 1024,
            historicalDataSize: this.historicalData.size,
            cachedSamplesSize: this.cachedSamples.size,
            compressionCacheSize: this.compressionCache.size
        };
    }

    private quitting = false;
    public quit() {
        try {
            if (!this.quitting) {
                this.quitting = true;
                this.stopSampling();
                this.miDebugger.detach();
            }
        } catch (e) {
            console.error('LiveWatchMonitor.quit', e);
        }
    }
}

interface RefreshAllArguments {
    // Delete all gdb variables and the cache. This should be done when a live expression is deleted,
    // but otherwise, it is not needed
    deleteAll: boolean;
}
