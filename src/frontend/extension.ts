import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { CortexDebugChannel } from '../dbgmsgs';
import { LiveWatchTreeProvider, LiveVariableNode } from './views/live-watch';
import { WaveformDataProvider } from './views/waveform-data-provider';
import { WaveformWebviewPanel } from './views/waveform-webview';

import { RTTCore, SWOCore } from './swo/core';
import {
    ConfigurationArguments, RTTCommonDecoderOpts, RTTConsoleDecoderOpts,
    CortexDebugKeys, ChainedEvents, ADAPTER_DEBUG_MODE, ChainedConfig } from '../common';
import { MemoryContentProvider } from './memory_content_provider';
import Reporting from '../reporting';

import { CortexDebugConfigurationProvider } from './configprovider';
import { JLinkSocketRTTSource, SocketRTTSource, SocketSWOSource, PeMicroSocketSource } from './swo/sources/socket';
import { FifoSWOSource } from './swo/sources/fifo';
import { FileSWOSource } from './swo/sources/file';
import { SerialSWOSource } from './swo/sources/serial';
import { UsbSWOSource } from './swo/sources/usb';
import { SymbolInformation, SymbolScope } from '../symbols';
import { RTTTerminal } from './rtt_terminal';
import { GDBServerConsole } from './server_console';
import { CDebugSession, CDebugChainedSessionItem } from './cortex_debug_session';
import { ServerConsoleLog } from '../backend/server';

interface SVDInfo {
    expression: RegExp;
    path: string;
}
class ServerStartedPromise {
    constructor(
        public readonly name: string,
        public readonly promise: Promise<vscode.DebugSessionCustomEvent>,
        public readonly resolve: any,
        public readonly reject: any) {
    }
}

export class CortexDebugExtension {
    private rttTerminals: RTTTerminal[] = [];

    private gdbServerConsole: GDBServerConsole = null;

    private memoryProvider: MemoryContentProvider;
    private liveWatchProvider: LiveWatchTreeProvider;
    private liveWatchTreeView: vscode.TreeView<LiveVariableNode>;
    private waveformDataProvider: WaveformDataProvider;
    private waveformWebview: WaveformWebviewPanel;

    private SVDDirectory: SVDInfo[] = [];
    private functionSymbols: SymbolInformation[] = null;
    private serverStartedEvent: ServerStartedPromise;

    constructor(private context: vscode.ExtensionContext) {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        this.startServerConsole(context, config.get(CortexDebugKeys.SERVER_LOG_FILE_NAME, '')); // Make this the first thing we do to be ready for the session
        this.memoryProvider = new MemoryContentProvider();

        Reporting.activate(context);

        this.liveWatchProvider = new LiveWatchTreeProvider(this.context);
        this.liveWatchTreeView = vscode.window.createTreeView('cortex-debug.liveWatch', {
            treeDataProvider: this.liveWatchProvider,
            showCollapseAll: true
        });

        // Setup Live Watch tree view context menus
        vscode.window.registerTreeDataProvider('cortex-debug.liveWatch', this.liveWatchProvider);

        this.waveformDataProvider = new WaveformDataProvider(this.liveWatchProvider);
        this.waveformWebview = new WaveformWebviewPanel(this.context, this.liveWatchProvider, this.waveformDataProvider);

        vscode.commands.executeCommand('setContext', `cortex-debug:${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`,
            config.get(CortexDebugKeys.VARIABLE_DISPLAY_MODE, true));

        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider('examinememory', this.memoryProvider),

            vscode.commands.registerCommand('cortex-debug.varHexModeTurnOn', this.variablesNaturalMode.bind(this, false)),
            vscode.commands.registerCommand('cortex-debug.varHexModeTurnOff', this.variablesNaturalMode.bind(this, true)),
            vscode.commands.registerCommand('cortex-debug.toggleVariableHexFormat', this.toggleVariablesHexMode.bind(this)),

            vscode.commands.registerCommand('cortex-debug.examineMemory', this.examineMemory.bind(this)),
            vscode.commands.registerCommand('cortex-debug.examineMemoryLegacy', this.examineMemoryLegacy.bind(this)),

            vscode.commands.registerCommand('cortex-debug.resetDevice', this.resetDevice.bind(this)),
            vscode.commands.registerCommand('cortex-debug.pvtEnableDebug', this.pvtCycleDebugMode.bind(this)),

            vscode.commands.registerCommand('cortex-debug.liveWatch.addExpr', this.addLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.removeExpr', this.removeLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.editExpr', this.editLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.addToLiveWatch', this.addToLiveWatch.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.moveUp', this.moveUpLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.moveDown', this.moveDownLiveWatchExpr.bind(this)),

            vscode.commands.registerCommand('cortex-debug.liveWatch.addToWaveform', this.addToWaveform.bind(this)),

            vscode.commands.registerCommand('cortex-debug.waveform.show', this.showWaveform.bind(this)),

            // Waveform-related commands
            vscode.commands.registerCommand('cortex-debug.waveform.addVariable', this.addWaveformVariable.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.removeVariable', this.removeWaveformVariable.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.clearAll', this.clearWaveformData.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.toggleVariable', this.toggleWaveformVariable.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.setStyle', this.setWaveformVariableStyle.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.setStyleFromNode', this.setWaveformVariableStyleFromNode.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.exportData', this.exportWaveformData.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.importConfig', this.importWaveformConfig.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.exportConfig', this.exportWaveformConfig.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.fftAnalysis', this.performWaveformFFT.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.fftAnalysisFromNode', this.performWaveformFFTFromNode.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.updateSettings', this.updateWaveformSettings.bind(this)),

            vscode.workspace.onDidChangeConfiguration(this.settingsChanged.bind(this)),
            vscode.debug.onDidReceiveDebugSessionCustomEvent(this.receivedCustomEvent.bind(this)),
            vscode.debug.onDidStartDebugSession(this.debugSessionStarted.bind(this)),
            vscode.debug.onDidTerminateDebugSession(this.debugSessionTerminated.bind(this)),
            vscode.window.onDidChangeActiveTextEditor(this.activeEditorChanged.bind(this)),
            vscode.window.onDidCloseTerminal(this.terminalClosed.bind(this)),
            vscode.workspace.onDidCloseTextDocument(this.textDocsClosed.bind(this)),
            vscode.window.onDidChangeTextEditorSelection((e: vscode.TextEditorSelectionChangeEvent) => {
                if (e && e.textEditor.document.fileName.endsWith('.cdmem')) { this.memoryProvider.handleSelection(e); }
            }),

            vscode.debug.registerDebugConfigurationProvider('cortex-debug', new CortexDebugConfigurationProvider(context)),

            this.liveWatchTreeView,
            this.liveWatchTreeView.onDidExpandElement((e) => {
                this.liveWatchProvider.expandChildren(e.element);
                this.liveWatchProvider.saveState();
            }),
            this.liveWatchTreeView.onDidCollapseElement((e) => {
                e.element.expanded = false;
                this.liveWatchProvider.saveState();
            })
        );
    }

    private textDocsClosed(e: vscode.TextDocument) {
        if (e.fileName.endsWith('.cdmem')) {
            this.memoryProvider.Unregister(e);
        }
    }

    public static getActiveCDSession() {
        const session = vscode.debug.activeDebugSession;
        if (session?.type === 'cortex-debug') {
            return session;
        }
        return null;
    }

    private resetDevice() {
        let session = CortexDebugExtension.getActiveCDSession();
        if (session) {
            let mySession = CDebugSession.FindSession(session);
            const parentConfig = mySession.config?.pvtParent;
            while (mySession && parentConfig) {
                // We have a parent. See if our life-cycle is managed by our parent, if so
                // send a reset to the parent instead
                const chConfig = mySession.config?.pvtMyConfigFromParent as ChainedConfig;
                if (chConfig?.lifecycleManagedByParent && parentConfig.__sessionId) {
                    // __sessionId is not documented but has existed forever and used by VSCode itself
                    mySession = CDebugSession.FindSessionById(parentConfig.__sessionId);
                    if (!mySession) {
                        break;
                    }
                    session = mySession.session || session;
                } else {
                    break;
                }
            }
            session.customRequest('reset-device', 'reset');
        }
    }

    private startServerConsole(context: vscode.ExtensionContext, logFName: string = ''): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const rptMsg = 'Please report this problem.';
            this.gdbServerConsole = new GDBServerConsole(context, logFName);
            this.gdbServerConsole.startServer().then(() => {
                resolve(); // All worked out
            }).catch((e) => {
                this.gdbServerConsole.dispose();
                this.gdbServerConsole = null;
                vscode.window.showErrorMessage(`Could not create gdb-server-console. Will use old style console. Please report this problem. ${e.toString()}`);
            });
        });
    }

    private settingsChanged(e: vscode.ConfigurationChangeEvent) {
        if (e.affectsConfiguration(`cortex-debug.${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`)) {
            const config = vscode.workspace.getConfiguration('cortex-debug');
            const isHex = config.get(CortexDebugKeys.VARIABLE_DISPLAY_MODE, true) ? false : true;
            let foundStopped = false;
            for (const s of CDebugSession.CurrentSessions) {
                try {
                    // Session may not have actually started according to VSCode but we know of it
                    if (this.isDebugging(s.session)) {
                        s.session.customRequest('set-var-format', { hex: isHex }).then(() => {
                            if (s.status === 'stopped') {
                                this.liveWatchProvider?.refresh(s.session);
                            }
                        });
                        if (s.status === 'stopped') {
                            foundStopped = true;
                        }
                    }
                } catch (e) {
                    console.error('set-var-format', e);
                }
            }
            if (!foundStopped) {
                const fmt = isHex ? 'hex' : 'dec';
                const msg = `Cortex-Debug: Variables window format "${fmt}" will take effect next time the session pauses`;
                vscode.window.showInformationMessage(msg);
            }
        }
        if (e.affectsConfiguration(`cortex-debug.${CortexDebugKeys.SERVER_LOG_FILE_NAME}`)) {
            const config = vscode.workspace.getConfiguration('cortex-debug');
            const fName = config.get(CortexDebugKeys.SERVER_LOG_FILE_NAME, '');
            this.gdbServerConsole.createLogFile(fName);
        }
        if (e.affectsConfiguration(`cortex-debug.${CortexDebugKeys.DEV_DEBUG_MODE}`)) {
            const config = vscode.workspace.getConfiguration('cortex-debug');
            const dbgMode = config.get(CortexDebugKeys.DEV_DEBUG_MODE, ADAPTER_DEBUG_MODE.NONE);
            for (const s of CDebugSession.CurrentSessions) {
                try {
                    s.session.customRequest('set-debug-mode', { mode: dbgMode });
                } catch (e) {
                    console.error('set-debug-mode', e);
                }
            }
        }
    }

    private getSVDFile(device: string): string {
        const entry = this.SVDDirectory.find((de) => de.expression.test(device));
        return entry ? entry.path : null;
    }

    public registerSVDFile(expression: RegExp | string, path: string): void {
        if (typeof expression === 'string') {
            expression = new RegExp(`^${expression}$`, '');
        }

        this.SVDDirectory.push({ expression: expression, path: path });
    }

    private activeEditorChanged(editor: vscode.TextEditor) {
        const session = CortexDebugExtension.getActiveCDSession();
        if (editor !== undefined && session) {
            const uri = editor.document.uri;
            if (uri.scheme === 'file') {
                // vscode.debug.activeDebugSession.customRequest('set-active-editor', { path: uri.path });
            }
        }
    }

    private examineMemory() {
        const cmd = 'cortex-debug.memory-view.addMemoryView';
        vscode.commands.executeCommand(cmd).then(() => { }, (e) => {
            const installExt = 'Install MemoryView Extension';
            vscode.window.showErrorMessage(
                `Unable to execute ${cmd}. Perhaps the MemoryView extension is not installed. `
                + 'Please install extension and try again. A restart may be needed', undefined,
                {
                    title: installExt
                },
                {
                    title: 'Cancel'
                }
            ).then((v) => {
                if (v && (v.title === installExt)) {
                    vscode.commands.executeCommand('workbench.extensions.installExtension', 'cortex-debug.memory-view');
                }
            });
        });
    }

    private examineMemoryLegacy() {
        function validateValue(address: string) {
            if (/^0x[0-9a-f]{1,8}$/i.test(address)) {
                return address;
            } else if (/^[0-9]+$/i.test(address)) {
                return address;
            } else {
                return null;
            }
        }

        function validateAddress(address: string) {
            if (address === '') {
                return null;
            }
            return address;
        }

        const session = CortexDebugExtension.getActiveCDSession();
        if (!session) {
            vscode.window.showErrorMessage('No cortex-debug session available');
            return;
        }

        vscode.window.showInputBox({
            placeHolder: 'Enter a valid C/gdb expression. Use 0x prefix for hexadecimal numbers',
            ignoreFocusOut: true,
            prompt: 'Memory Address'
        }).then(
            (address) => {
                address = address.trim();
                if (!validateAddress(address)) {
                    vscode.window.showErrorMessage('Invalid memory address entered');
                    Reporting.sendEvent('Examine Memory', 'Invalid Address', address);
                    return;
                }

                vscode.window.showInputBox({
                    placeHolder: 'Enter a constant value. Prefix with 0x for hexadecimal format.',
                    ignoreFocusOut: true,
                    prompt: 'Length'
                }).then(
                    (length) => {
                        length = length.trim();
                        if (!validateValue(length)) {
                            vscode.window.showErrorMessage('Invalid length entered');
                            Reporting.sendEvent('Examine Memory', 'Invalid Length', length);
                            return;
                        }

                        Reporting.sendEvent('Examine Memory', 'Valid', `${address}-${length}`);
                        const timestamp = new Date().getTime();
                        const addrEnc = encodeURIComponent(`${address}`);
                        const uri = vscode.Uri.parse(
                            `examinememory:///Memory%20[${addrEnc},${length}].cdmem`
                            + `?address=${addrEnc}&length=${length}&timestamp=${timestamp}`
                        );
                        this.memoryProvider.PreRegister(uri);
                        vscode.workspace.openTextDocument(uri)
                            .then((doc) => {
                                this.memoryProvider.Register(doc);
                                vscode.window.showTextDocument(doc, { viewColumn: 2, preview: false });
                                Reporting.sendEvent('Examine Memory', 'Used');
                            }, (error) => {
                                vscode.window.showErrorMessage(`Failed to examine memory: ${error}`);
                                Reporting.sendEvent('Examine Memory', 'Error', error.toString());
                            });
                    },
                    (error) => {

                    }
                );
            },
            (error) => {

            }
        );
    }

    private getConfigSource(config: vscode.WorkspaceConfiguration, section: string): [vscode.ConfigurationTarget, boolean] {
        const configurationTargetMapping: [string, vscode.ConfigurationTarget][] = [
            ['workspaceFolder', vscode.ConfigurationTarget.WorkspaceFolder],
            ['workspace', vscode.ConfigurationTarget.Workspace],
            ['global', vscode.ConfigurationTarget.Global],
            // Modify user settings if setting isn't configured yet
            ['default', vscode.ConfigurationTarget.Global],
        ];
        const info = config.inspect(section);
        for (const inspectKeySuffix of ['LanguageValue', 'Value']) {
            for (const mapping of configurationTargetMapping) {
                const [inspectKeyPrefix, mappingTarget] = mapping;
                const inspectKey = inspectKeyPrefix + inspectKeySuffix;
                if (info[inspectKey] !== undefined)
                    return [mappingTarget, inspectKeySuffix == 'LanguageValue'];
            }
        }
        // Shouldn't get here unless new configuration targets get added to the
        // VSCode API, only those sources have values for this setting, and this
        // setting doesn't have a default value. Still, do something rational
        // just in case.
        return [vscode.ConfigurationTarget.Global, false];
    }

    // Settings changes
    private variablesNaturalMode(newVal: boolean, cxt?: any) {
        // 'cxt' contains the treeItem on which this menu was invoked. Maybe we can do something
        // with it later
        const config = vscode.workspace.getConfiguration('cortex-debug');

        vscode.commands.executeCommand('setContext', `cortex-debug:${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`, newVal);
        try {
            const [target, languageOverride] = this.getConfigSource(config, CortexDebugKeys.VARIABLE_DISPLAY_MODE);
            config.update(CortexDebugKeys.VARIABLE_DISPLAY_MODE, newVal, target, languageOverride);
        } catch (e) {
            console.error(e);
        }
    }

    private toggleVariablesHexMode() {
        // 'cxt' contains the treeItem on which this menu was invoked. Maybe we can do something
        // with it later
        const config = vscode.workspace.getConfiguration('cortex-debug');
        const curVal = config.get(CortexDebugKeys.VARIABLE_DISPLAY_MODE, true);
        const newVal = !curVal;
        vscode.commands.executeCommand('setContext', `cortex-debug:${CortexDebugKeys.VARIABLE_DISPLAY_MODE}`, newVal);
        try {
            const [target, languageOverride] = this.getConfigSource(config, CortexDebugKeys.VARIABLE_DISPLAY_MODE);
            config.update(CortexDebugKeys.VARIABLE_DISPLAY_MODE, newVal, target, languageOverride);
        } catch (e) {
            console.error(e);
        }
    }

    private pvtCycleDebugMode() {
        const config = vscode.workspace.getConfiguration('cortex-debug');
        const curVal: ADAPTER_DEBUG_MODE = config.get(CortexDebugKeys.DEV_DEBUG_MODE, ADAPTER_DEBUG_MODE.NONE);
        const validVals = Object.values(ADAPTER_DEBUG_MODE);
        let ix = validVals.indexOf(curVal);
        ix = ix < 0 ? ix = 0 : ((ix + 1) % validVals.length);
        config.set(CortexDebugKeys.DEV_DEBUG_MODE, validVals[ix]);
    }

    // Debug Events
    private debugSessionStarted(session: vscode.DebugSession) {
        if (session.type !== 'cortex-debug') { return; }

        const newSession = CDebugSession.NewSessionStarted(session);

        this.functionSymbols = null;
        session.customRequest('get-arguments').then((args) => {
            newSession.config = args;
            let svdfile = args.svdFile;
            if (!svdfile) {
                svdfile = this.getSVDFile(args.device);
            }

            Reporting.beginSession(session.id, args as ConfigurationArguments);

            if (newSession.swoSource) {
                this.initializeSWO(session, args);
            }
            if (Object.keys(newSession.rttPortMap).length > 0) {
                this.initializeRTT(session, args);
            }
            this.cleanupRTTTerminals();
        }, (error) => {
            vscode.window.showErrorMessage(
                `Internal Error: Could not get startup arguments. Many debug functions can fail. Please report this problem. Error: ${error}`);
        });
    }

    private debugSessionTerminated(session: vscode.DebugSession) {
        if (session.type !== 'cortex-debug') { return; }
        const mySession = CDebugSession.FindSession(session);
        try {
            Reporting.endSession(session.id);

            this.liveWatchProvider?.debugSessionTerminated(session);
            if (mySession?.swo) {
                mySession.swo.debugSessionTerminated();
            }
            if (mySession?.swoSource) {
                mySession.swoSource.dispose();
            }
            if (mySession?.rtt) {
                mySession.rtt.debugSessionTerminated();
            }
            if (mySession?.rttPortMap) {
                for (const ch of Object.keys(mySession.rttPortMap)) {
                    mySession.rttPortMap[ch].dispose();
                }
                mySession.rttPortMap = {};
            }
        } catch (e) {
            vscode.window.showInformationMessage(`Debug session did not terminate cleanly ${e}\n${e ? e.stackstrace : ''}. Please report this problem`);
        } finally {
            CDebugSession.RemoveSession(session);
        }
    }

    private receivedCustomEvent(e: vscode.DebugSessionCustomEvent) {
        const session = e.session;
        if (session.type !== 'cortex-debug') { return; }
        switch (e.event) {
            case 'custom-stop':
                this.receivedStopEvent(e);
                break;
            case 'custom-continued':
                this.receivedContinuedEvent(e);
                break;
            case 'swo-configure':
                this.receivedSWOConfigureEvent(e);
                break;
            case 'rtt-configure':
                this.receivedRTTConfigureEvent(e);
                break;
            case 'record-event':
                this.receivedEvent(e);
                break;
            case 'custom-event-post-start-server':
                this.startChainedConfigs(e, ChainedEvents.POSTSTART);
                break;
            case 'custom-event-post-start-gdb':
                this.startChainedConfigs(e, ChainedEvents.POSTINIT);
                this.liveWatchProvider?.debugSessionStarted(session);
                break;
            case 'custom-event-session-terminating':
                ServerConsoleLog('Got event for sessions terminating', process.pid);
                this.endChainedConfigs(e);
                break;
            case 'custom-event-session-restart':
                this.resetOrResartChained(e, 'restart');
                break;
            case 'custom-event-session-reset':
                this.resetOrResartChained(e, 'reset');
                break;
            case 'custom-event-popup': {
                const msg = e.body.info?.message;
                switch (e.body.info?.type) {
                    case 'warning':
                        vscode.window.showWarningMessage(msg);
                        break;
                    case 'error':
                        vscode.window.showErrorMessage(msg);
                        break;
                    default:
                        vscode.window.showInformationMessage(msg);
                        break;
                }
                break;
            }
            case 'custom-event-ports-allocated':
                this.registerPortsAsUsed(e);
                break;
            case 'custom-event-ports-done':
                this.signalPortsAllocated(e);
                break;
            default:
                break;
        }
    }

    private signalPortsAllocated(e: vscode.DebugSessionCustomEvent) {
        if (this.serverStartedEvent) {
            this.serverStartedEvent.resolve(e);
            this.serverStartedEvent = undefined;
        }
    }

    private registerPortsAsUsed(e: vscode.DebugSessionCustomEvent) {
        // We can get this event before the session starts
        const mySession = CDebugSession.GetSession(e.session);
        mySession.addUsedPorts(e.body?.info || []);
    }

    private async startChainedConfigs(e: vscode.DebugSessionCustomEvent, evType: ChainedEvents) {
        const adapterArgs = e?.body?.info as ConfigurationArguments;
        const cDbgParent = CDebugSession.GetSession(e.session, adapterArgs);
        if (!adapterArgs || !adapterArgs.chainedConfigurations?.enabled) { return; }
        const unique = adapterArgs.chainedConfigurations.launches.filter((x, ix) => {
            return ix === adapterArgs.chainedConfigurations.launches.findIndex((v, ix) => v.name === x.name);
        });
        const filtered = unique.filter((launch) => {
            return (launch.enabled && (launch.waitOnEvent === evType) && launch.name);
        });

        let delay = 0;
        let count = filtered.length;
        for (const launch of filtered) {
            count--;
            const childOptions: vscode.DebugSessionOptions = {
                consoleMode: vscode.DebugConsoleMode.Separate,
                noDebug: adapterArgs.noDebug,
                compact: false
            };
            if (launch.lifecycleManagedByParent) {
                // VSCode 'lifecycleManagedByParent' does not work as documented. The fact that there
                // is a parent means it is managed and 'lifecycleManagedByParent' if ignored.
                childOptions.lifecycleManagedByParent = true;
                childOptions.parentSession = e.session;
            }
            delay += Math.max(launch.delayMs || 0, 0);
            const child = new CDebugChainedSessionItem(cDbgParent, launch, childOptions);
            const folder = this.getWsFolder(launch.folder, e.session.workspaceFolder, launch.name);
            setTimeout(() => {
                vscode.debug.startDebugging(folder, launch.name, childOptions).then((success) => {
                    if (!success) {
                        vscode.window.showErrorMessage('Failed to launch chained configuration ' + launch.name);
                    }
                    CDebugChainedSessionItem.RemoveItem(child);
                }, (e) => {
                    vscode.window.showErrorMessage(`Failed to launch chained configuration ${launch.name}: ${e}`);
                    CDebugChainedSessionItem.RemoveItem(child);
                });
            }, delay);
            if (launch && launch.detached && (count > 0)) {
                try {
                    // tslint:disable-next-line: one-variable-per-declaration
                    let res: (value: vscode.DebugSessionCustomEvent) => void;
                    let rej: (reason?: any) => void;
                    const prevStartedPromise = new Promise<vscode.DebugSessionCustomEvent>((resolve, reject) => {
                        res = resolve;
                        rej = reject;
                    });
                    this.serverStartedEvent = new ServerStartedPromise(launch.name, prevStartedPromise, res, rej);
                    let to = setTimeout(() => {
                        if (this.serverStartedEvent) {
                            this.serverStartedEvent.reject(new Error(`Timeout starting chained session: ${launch.name}`));
                            this.serverStartedEvent = undefined;
                        }
                        to = undefined;
                    }, 5000);
                    await prevStartedPromise;
                    if (to) { clearTimeout(to); }
                } catch (e) {
                    vscode.window.showErrorMessage(`Detached chained configuration launch failed? Aborting rest. Error: ${e}`);
                    break;      // No more children after this error
                }
                delay = 0;
            } else {
                delay += 5;
            }
        }
    }

    private endChainedConfigs(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession && mySession.hasChildren) {
            // Note that we may not be the root, but we have children. Also we do not modify the tree while iterating it
            const deathList: CDebugSession[] = [];
            const orphanList: CDebugSession[] = [];
            mySession.broadcastDFS((s) => {
                if (s === mySession) { return; }
                if (s.config.pvtMyConfigFromParent.lifecycleManagedByParent) {
                    deathList.push(s);      // Qualifies to be terminated
                } else {
                    orphanList.push(s);     // This child is about to get orphaned
                }
            }, false);

            // According to current scheme, there should not be any orphaned children.
            while (orphanList.length > 0) {
                const s = orphanList.pop();
                s.moveToRoot();     // Or should we move to our parent. TODO: fix for when we are going to have grand children
            }

            while (deathList.length > 0) {
                const s = deathList.pop();
                // We cannot actually use the following API. We have to do this ourselves. Probably because we own
                // the lifetime management.
                // vscode.debug.stopDebugging(s.session);
                ServerConsoleLog(`Sending custom-stop-debugging to ${s.session.name}`, process.pid);
                s.session.customRequest('custom-stop-debugging', e.body.info).then(() => {
                }, (reason) => {
                    vscode.window.showErrorMessage(`Cortex-Debug: Bug? session.customRequest('set-stop-debugging-type', ... failed ${reason}\n`);
                });
            }
            // Following does not work. Apparently, a customRequest cannot be sent probably because this session is already
            // terminating.
            // mySession.session.customRequest('notified-children-to-terminate');
        }
    }

    private resetOrResartChained(e: vscode.DebugSessionCustomEvent, type: 'reset' | 'restart') {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession && mySession.hasChildren) {
            mySession.broadcastDFS((s) => {
                if (s === mySession) { return; }
                if (s.config.pvtMyConfigFromParent.lifecycleManagedByParent) {
                    s.session.customRequest('reset-device', type).then(() => {
                    }, (reason) => {
                    });
                }
            }, false);
        }
    }

    private getWsFolder(folder: string, def: vscode.WorkspaceFolder, childName): vscode.WorkspaceFolder {
        if (folder) {
            const orig = folder;
            const normalize = (fsPath: string) => {
                fsPath = path.normalize(fsPath).replace(/\\/g, '/');
                fsPath = (fsPath === '/') ? fsPath : fsPath.replace(/\/+$/, '');
                if (process.platform === 'win32') {
                    fsPath = fsPath.toLowerCase();
                }
                return fsPath;
            };
            // Folder is always a full path name
            folder = normalize(folder);
            for (const f of vscode.workspace.workspaceFolders) {
                const tmp = normalize(f.uri.fsPath);
                if ((f.uri.fsPath === folder) || (f.name === folder) || (tmp === folder)) {
                    return f;
                }
            }
            vscode.window.showInformationMessage(
                `Chained configuration for '${childName}' specified folder is '${orig}' normalized path is '${folder}'`
                + ' did not match any workspace folders. Using parents folder.');
        }
        return def;
    }

    private getCurrentArgs(session: vscode.DebugSession): ConfigurationArguments {
        if (!session) {
            session = vscode.debug.activeDebugSession;
            if (!session || (session.type !== 'cortex-debug')) {
                return undefined;
            }
        }
        const ourSession = CDebugSession.FindSession(session);
        if (ourSession) {
            return ourSession.config as ConfigurationArguments;
        }
        return session.configuration as unknown as ConfigurationArguments;
    }

    // Assuming 'session' valid and it a cortex-debug session
    private isDebugging(session: vscode.DebugSession) {
        const { noDebug } = this.getCurrentArgs(session);
        return (noDebug !== true);       // If it is exactly equal to 'true' we are doing a 'run without debugging'
    }

    private receivedStopEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        mySession.status = 'stopped';
        this.liveWatchProvider?.debugStopped(e.session);
        vscode.workspace.textDocuments.filter((td) => td.fileName.endsWith('.cdmem')).forEach((doc) => {
            if (!doc.isClosed) {
                this.memoryProvider.update(doc);
            }
        });
        if (mySession.swo) { mySession.swo.debugStopped(); }
        if (mySession.rtt) { mySession.rtt.debugStopped(); }
    }

    private receivedContinuedEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        mySession.status = 'running';
        this.liveWatchProvider?.debugContinued(e.session);
        if (mySession.swo) { mySession.swo.debugContinued(); }
        if (mySession.rtt) { mySession.rtt.debugContinued(); }
    }

    private receivedEvent(e) {
        Reporting.sendEvent(e.body.category, e.body.action, e.body.label, e.body.parameters);
    }

    private receivedSWOConfigureEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.GetSession(e.session);
        if (e.body.type === 'socket') {
            let src;
            if (mySession.config.servertype === 'pe') {
                src = new PeMicroSocketSource(e.body.port);
            } else {
                src = new SocketSWOSource(e.body.port);
            }
            mySession.swoSource = src;
            this.initializeSWO(e.session, e.body.args);
            src.start().then(() => {
                CortexDebugChannel.debugMessage(`Connected after ${src.nTries} tries`);
                // Do nothing...
            }, (e) => {
                vscode.window.showErrorMessage(`Could not open SWO TCP port ${e.body.port} ${e} after ${src.nTries} tries`);
            });
            Reporting.sendEvent('SWO', 'Source', 'Socket');
            return;
        } else if (e.body.type === 'fifo') {
            mySession.swoSource = new FifoSWOSource(e.body.path);
            Reporting.sendEvent('SWO', 'Source', 'FIFO');
        } else if (e.body.type === 'file') {
            mySession.swoSource = new FileSWOSource(e.body.path);
            Reporting.sendEvent('SWO', 'Source', 'File');
        } else if (e.body.type === 'serial') {
            mySession.swoSource = new SerialSWOSource(e.body.device, e.body.baudRate);
            Reporting.sendEvent('SWO', 'Source', 'Serial');
        } else if (e.body.type === 'usb') {
            mySession.swoSource = new UsbSWOSource(e.body.device, e.body.port);
            Reporting.sendEvent('SWO', 'Source', 'USB');
        }

        this.initializeSWO(e.session, e.body.args);
    }

    private receivedRTTConfigureEvent(e: vscode.DebugSessionCustomEvent) {
        if (e.body.type === 'socket') {
            const decoder: RTTCommonDecoderOpts = e.body.decoder;
            if ((decoder.type === 'console') || (decoder.type === 'binary')) {
                Reporting.sendEvent('RTT', 'Source', 'Socket: Console');
                this.rttCreateTerninal(e, decoder as RTTConsoleDecoderOpts);
            } else {
                Reporting.sendEvent('RTT', 'Source', `Socket: ${decoder.type}`);
                if (!decoder.ports) {
                    this.createRTTSource(e, decoder.tcpPort, decoder.port);
                } else {
                    for (let ix = 0; ix < decoder.ports.length; ix = ix + 1) {
                        // Hopefully ports and tcpPorts are a matched set
                        this.createRTTSource(e, decoder.tcpPorts[ix], decoder.ports[ix]);
                    }
                }
            }
        } else {
            CortexDebugChannel.debugMessage('Error: receivedRTTConfigureEvent: unknown type: ' + e.body.type);
        }
    }

    // The returned value is a connection source. It may still be in disconnected
    // state.
    private createRTTSource(e: vscode.DebugSessionCustomEvent, tcpPort: string, channel: number): Promise<SocketRTTSource> {
        const mySession = CDebugSession.GetSession(e.session);
        return new Promise((resolve, reject) => {
            let src = mySession.rttPortMap[channel];
            if (src) {
                resolve(src);
                return;
            }
            if (mySession.config.servertype === 'jlink') {
                src = new JLinkSocketRTTSource(tcpPort, channel);
            } else {
                src = new SocketRTTSource(tcpPort, channel);
            }
            mySession.rttPortMap[channel] = src;     // Yes, we put this in the list even if start() can fail
            resolve(src);                            // Yes, it is okay to resolve it even though the connection isn't made yet
            src.start().then(() => {
                mySession.session.customRequest('rtt-poll');
            }).catch((e) => {
                vscode.window.showErrorMessage(`Could not connect to RTT TCP port ${tcpPort} ${e}`);
                // reject(e);
            });
        });
    }

    private cleanupRTTTerminals() {
        this.rttTerminals = this.rttTerminals.filter((t) => {
            if (!t.inUse) {
                t.dispose();
                return false;
            }
            return true;
        });
    }

    private rttCreateTerninal(e: vscode.DebugSessionCustomEvent, decoder: RTTConsoleDecoderOpts) {
        this.createRTTSource(e, decoder.tcpPort, decoder.port).then((src: SocketRTTSource) => {
            for (const terminal of this.rttTerminals) {
                const success = !terminal.inUse && terminal.tryReuse(decoder, src);
                if (success) {
                    if (vscode.debug.activeDebugConsole) {
                        vscode.debug.activeDebugConsole.appendLine(
                            `Reusing RTT terminal for channel ${decoder.port} on tcp port ${decoder.tcpPort}`
                        );
                    }
                    return;
                }
            }
            const newTerminal = new RTTTerminal(this.context, decoder, src);
            this.rttTerminals.push(newTerminal);
            if (vscode.debug.activeDebugConsole) {
                vscode.debug.activeDebugConsole.appendLine(
                    `Created RTT terminal for channel ${decoder.port} on tcp port ${decoder.tcpPort}`
                );
            }
        });
    }

    private terminalClosed(terminal: vscode.Terminal) {
        this.rttTerminals = this.rttTerminals.filter((t) => t.terminal !== terminal);
    }

    private initializeSWO(session: vscode.DebugSession, args) {
        const mySession = CDebugSession.FindSession(session);
        if (!mySession.swoSource) {
            vscode.window.showErrorMessage('Tried to initialize SWO Decoding without a SWO data source');
            return;
        }

        if (!mySession.swo) {
            mySession.swo = new SWOCore(session, mySession.swoSource, args, this.context.extensionPath);
        }
    }

    private initializeRTT(session: vscode.DebugSession, args) {
        const mySession = CDebugSession.FindSession(session);
        if (!mySession.rtt) {
            mySession.rtt = new RTTCore(mySession.rttPortMap, args, this.context.extensionPath);
        }
    }

    private addLiveWatchExpr() {
        vscode.window.showInputBox({
            placeHolder: 'Enter a valid C/gdb expression. Must be a global variable expression',
            ignoreFocusOut: true,
            prompt: 'Enter Live Watch Expression'
        }).then((v) => {
            if (v) {
                this.liveWatchProvider.addWatchExpr(v, vscode.debug.activeDebugSession);
            }
        });
    }

    private addToLiveWatch(arg: any) {
        if (!arg || !arg.sessionId) {
            return;
        }
        const mySession = CDebugSession.FindSessionById(arg.sessionId);
        if (!mySession) {
            vscode.window.showErrorMessage(`addToLiveWatch: Unknown debug session id ${arg.sessionId}`);
            return;
        }
        const parent = arg.container;
        const expr = arg.variable?.evaluateName;
        if (parent && expr) {
            const varRef = parent.variablesReference;
            mySession.session.customRequest('is-global-or-static', { varRef: varRef }).then((result) => {
                if (!result.success) {
                    vscode.window.showErrorMessage(`Cannot add ${expr} to Live Watch. Must be a global or static variable`);
                } else {
                    this.liveWatchProvider.addWatchExpr(expr, vscode.debug.activeDebugSession);
                }
            }, (e) => {
                console.log(e);
            });
        }
    }

    private removeLiveWatchExpr(node: any) {
        this.liveWatchProvider.removeWatchExpr(node);
    }

    private editLiveWatchExpr(node: any) {
        this.liveWatchProvider.editNode(node);
    }

    private moveUpLiveWatchExpr(node: any) {
        this.liveWatchProvider.moveUpNode(node);
    }

    private moveDownLiveWatchExpr(node: any) {
        this.liveWatchProvider.moveDownNode(node);
    }

    private showWaveform(): void {
        this.waveformWebview.show();
    }

    private addToWaveform(node: any) {
        if (node && node.getExpr) {
            const success = this.waveformDataProvider.addVariable(node);
            if (success) {
                vscode.window.showInformationMessage(`Added '${node.getName()}' to waveform monitoring`);
                // Auto-show waveform view when first variable is added
                this.waveformWebview.show();
            }
        }
    }

    private async addWaveformVariable(): Promise<void> {
        const expression = await vscode.window.showInputBox({
            prompt: 'Enter variable expression to monitor',
            placeHolder: 'e.g., myVariable, array[0], struct.member'
        });

        if (expression) {
            // Create a temporary variable node from the expression
            const variableNode = {
                getExpr: () => expression,
                getName: () => expression
            };

            const success = this.waveformDataProvider.addVariable(variableNode as any);
            if (success) {
                vscode.window.showInformationMessage(`Added '${expression}' to waveform monitoring`);
            } else {
                vscode.window.showWarningMessage(`Variable '${expression}' is already being monitored`);
            }
        }
    }

    private async removeWaveformVariable(): Promise<void> {
        const variables = this.waveformDataProvider.getVariables();
        if (variables.length === 0) {
            vscode.window.showInformationMessage('No variables are currently being monitored');
            return;
        }

        const items = variables.map((v) => ({
            label: v.name,
            description: v.expression || v.id,
            id: v.id
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select variable to remove from waveform monitoring'
        });

        if (selected) {
            this.waveformDataProvider.removeVariable(selected.id);
            vscode.window.showInformationMessage(`Removed '${selected.label}' from waveform monitoring`);
        }
    }

    private async clearWaveformData(): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            'This will clear all waveform data. Are you sure?',
            'Clear', 'Cancel'
        );

        if (result === 'Clear') {
            this.waveformDataProvider.clearAllData();
            vscode.window.showInformationMessage('All waveform data has been cleared');
        }
    }

    private async toggleWaveformVariable(): Promise<void> {
        const variables = this.waveformDataProvider.getVariables();
        if (variables.length === 0) {
            vscode.window.showInformationMessage('No variables are currently being monitored');
            return;
        }

        const items = variables.map((v) => ({
            label: v.name,
            description: `${v.enabled ? 'Enabled' : 'Disabled'} - ${v.expression || v.id}`,
            id: v.id,
            enabled: v.enabled
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select variable to toggle enable/disable'
        });

        if (selected) {
            this.waveformDataProvider.updateVariableSettings(selected.id, { enabled: !selected.enabled });
            vscode.window.showInformationMessage(
                `${selected.label} is now ${!selected.enabled ? 'enabled' : 'disabled'}`
            );
        }
    }

    private async setWaveformVariableStyle(): Promise<void> {
        const variables = this.waveformDataProvider.getVariables();
        if (variables.length === 0) {
            vscode.window.showInformationMessage('No variables are currently being monitored');
            return;
        }

        const selectedVar = await vscode.window.showQuickPick(
            variables.map((v) => ({ label: v.name, description: v.expression || v.id, id: v.id })),
            { placeHolder: 'Select variable to configure style' }
        );

        if (!selectedVar) return;

        const styleOptions = [
            { label: 'Line Style', description: 'Change line drawing style' },
            { label: 'Line Width', description: 'Change line thickness' },
            { label: 'Color', description: 'Change variable color' },
            { label: 'Opacity', description: 'Change line opacity' }
        ];

        const selectedOption = await vscode.window.showQuickPick(styleOptions, {
            placeHolder: 'Select style property to change'
        });

        if (!selectedOption) return;

        switch (selectedOption.label) {
            case 'Line Style': {
                const lineStyles = ['solid', 'dashed', 'dotted'];
                const selectedStyle = await vscode.window.showQuickPick(lineStyles, {
                    placeHolder: 'Select line style'
                });
                if (selectedStyle) {
                    this.waveformDataProvider.setVariableStyle(selectedVar.id, {
                        lineStyle: selectedStyle as any
                    });
                }
                break;
            }

            case 'Line Width': {
                const defaultWidth = this.waveformDataProvider.getDefaultLineWidth().toString();
                const width = await vscode.window.showInputBox({
                    prompt: 'Enter line width (1-10)',
                    placeHolder: defaultWidth,
                    value: defaultWidth,
                    validateInput: (value) => {
                        const num = parseFloat(value);
                        return (isNaN(num) || num < 1 || num > 10) ? 'Please enter a number between 1 and 10' : null;
                    }
                });
                if (width) {
                    this.waveformDataProvider.setVariableStyle(selectedVar.id, {
                        lineWidth: parseFloat(width)
                    });
                }
                break;
            }

            case 'Color': {
                const color = await vscode.window.showInputBox({
                    prompt: 'Enter color (hex code or color name)',
                    placeHolder: '#ff0000'
                });
                if (color) {
                    this.waveformDataProvider.setVariableStyle(selectedVar.id, { color });
                }
                break;
            }

            case 'Opacity': {
                const opacity = await vscode.window.showInputBox({
                    prompt: 'Enter opacity (0.0-1.0)',
                    placeHolder: '1.0',
                    validateInput: (value) => {
                        const num = parseFloat(value);
                        return (isNaN(num) || num < 0 || num > 1) ? 'Please enter a number between 0 and 1' : null;
                    }
                });
                if (opacity) {
                    this.waveformDataProvider.setVariableStyle(selectedVar.id, {
                        opacity: parseFloat(opacity)
                    });
                }
                break;
            }
        }
    }

    private async exportWaveformData(): Promise<void> {
        const variables = this.waveformDataProvider.getVariables();
        if (variables.length === 0) {
            vscode.window.showInformationMessage('No data to export');
            return;
        }

        const defaultFormat = this.waveformDataProvider.getDefaultDataExportFormat();
        const formatOptions = ['json', 'csv'];
        const format = await vscode.window.showQuickPick(formatOptions, {
            placeHolder: 'Select export format'
        });

        if (!format) return;

        const data = this.waveformDataProvider.exportData(format as any);

        const uri = await vscode.window.showSaveDialog({
            filters: format === 'json' ? { 'JSON Files': ['json'] } : { 'CSV Files': ['csv'] },
            defaultUri: vscode.Uri.file(`waveform_data.${format}`)
        });

        if (uri) {
            fs.writeFileSync(uri.fsPath, data);
            vscode.window.showInformationMessage(`Waveform data exported to ${uri.fsPath}`);
        }
    }

    private async importWaveformConfig(): Promise<void> {
        const uri = await vscode.window.showOpenDialog({
            filters: { 'JSON Files': ['json'] },
            canSelectMany: false
        });

        if (uri && uri.length > 0) {
            try {
                const configJson = fs.readFileSync(uri[0].fsPath, 'utf8');
                const success = this.waveformDataProvider.importConfiguration(configJson);

                if (success) {
                    vscode.window.showInformationMessage(`Configuration imported successfully`);
                } else {
                    vscode.window.showErrorMessage('Failed to import configuration. Check the file format.');
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to read configuration file: ${error}`);
            }
        }
    }

    private async exportWaveformConfig(): Promise<void> {
        const config = this.waveformDataProvider.exportConfiguration();

        const uri = await vscode.window.showSaveDialog({
            filters: { 'JSON Files': ['json'] },
            defaultUri: vscode.Uri.file('waveform_config.json')
        });

        if (uri) {
            fs.writeFileSync(uri.fsPath, config);
            vscode.window.showInformationMessage(`Configuration exported to ${uri.fsPath}`);
        }
    }

    private async performWaveformFFT(): Promise<void> {
        const variables = this.waveformDataProvider.getVariables();
        if (variables.length === 0) {
            vscode.window.showInformationMessage('No variables available for FFT analysis');
            return;
        }

        const selectedVar = await vscode.window.showQuickPick(
            variables.map((v) => ({ label: v.name, description: v.expression || v.id, id: v.id })),
            { placeHolder: 'Select variable for FFT analysis' }
        );

        if (!selectedVar) return;

        const defaultWindowSize = this.waveformDataProvider.getDefaultFFTWindowSize().toString();
        const windowSizeOptions = ['256', '512', '1024', '2048', '4096'];
        const windowSize = await vscode.window.showQuickPick(windowSizeOptions, {
            placeHolder: 'Select FFT window size'
        });

        if (!windowSize) return;

        const defaultWindowFunction = this.waveformDataProvider.getDefaultFFTWindowFunction();
        const windowFunctionOptions = ['hanning', 'hamming', 'blackman', 'rectangular'];
        const windowFunction = await vscode.window.showQuickPick(windowFunctionOptions, {
            placeHolder: 'Select window function'
        });

        if (!windowFunction) return;

        const fftResult = this.waveformDataProvider.getFFTAnalysis(
            selectedVar.id,
            parseInt(windowSize),
            windowFunction
        );

        if (fftResult) {
            const dominantPhase = (fftResult.dominantFrequency.phase * 180 / Math.PI).toFixed(1);
            const message = `
FFT Analysis Results for ${selectedVar.label}:
- Window Size: ${windowSize} samples
- Window Function: ${windowFunction}
- Sampling Rate: ${fftResult.samplingRate} Hz
- Dominant Frequency: ${fftResult.dominantFrequency.frequency.toFixed(2)} Hz
- Dominant Magnitude: ${fftResult.dominantFrequency.magnitude.toFixed(2)} dB
- Dominant Phase: ${dominantPhase}°
- Noise Floor: ${fftResult.noiseFloor.toFixed(2)} dB
- Total Harmonic Distortion: ${(fftResult.thd * 100).toFixed(3)}%
- Peak Count: ${fftResult.peaks.length}

Top 3 Peaks:
${fftResult.peaks.slice(0, 3).map((peak, i) =>
    `${i + 1}. ${peak.frequency.toFixed(2)} Hz, ${peak.magnitude.toFixed(2)} dB, SNR: ${peak.snr.toFixed(1)} dB`
).join('\n')}
            `.trim();

            vscode.window.showInformationMessage(message, 'Copy to Clipboard').then((action) => {
                if (action === 'Copy to Clipboard') {
                    vscode.env.clipboard.writeText(message);
                }
            });
        } else {
            vscode.window.showErrorMessage('Insufficient data for FFT analysis. Need at least ' + windowSize + ' data points.');
        }
    }

    private async updateWaveformSettings(): Promise<void> {
        const settings = this.waveformDataProvider.getSettings();

        const timeSpan = await vscode.window.showInputBox({
            prompt: 'Time span in seconds',
            value: settings.timeSpan.toString(),
            validateInput: (value) => {
                const num = parseFloat(value);
                return (isNaN(num) || num <= 0) ? 'Please enter a positive number' : null;
            }
        });

        if (!timeSpan) return;

        const refreshRate = await vscode.window.showInputBox({
            prompt: 'Refresh rate in Hz',
            value: settings.refreshRate.toString(),
            validateInput: (value) => {
                const num = parseFloat(value);
                return (isNaN(num) || num <= 0) ? 'Please enter a positive number' : null;
            }
        });

        if (!refreshRate) return;

        const maxDataPoints = await vscode.window.showInputBox({
            prompt: 'Maximum data points per variable',
            value: settings.maxDataPoints.toString(),
            validateInput: (value) => {
                const num = parseInt(value);
                return (isNaN(num) || num <= 0) ? 'Please enter a positive integer' : null;
            }
        });

        if (!maxDataPoints) return;

        this.waveformDataProvider.updateSettings({
            timeSpan: parseFloat(timeSpan),
            refreshRate: parseFloat(refreshRate),
            maxDataPoints: parseInt(maxDataPoints)
        });

        vscode.window.showInformationMessage('Waveform settings updated successfully');
    }

    private async setWaveformVariableStyleFromNode(node: any): Promise<void> {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const expression = node.getExpr();
        const variable = this.waveformDataProvider.getVariable(expression);

        if (!variable) {
            vscode.window.showInformationMessage(`Variable '${node.getName()}' is not currently in waveform monitoring. Please add it first.`);
            return;
        }

        // Open the waveform view and style configuration
        this.waveformWebview.show();

        // Apply style configuration for this specific variable
        await this.setWaveformVariableStyleForVariable(expression, variable);
    }

    private async setWaveformVariableStyleForVariable(variableId: string, variable: any): Promise<void> {
        const styleOptions = [
            { label: 'Line Style', description: 'Change line drawing style' },
            { label: 'Line Width', description: 'Change line thickness' },
            { label: 'Color', description: 'Change variable color' },
            { label: 'Opacity', description: 'Change line opacity' }
        ];

        const selectedOption = await vscode.window.showQuickPick(styleOptions, {
            placeHolder: 'Select style property to change'
        });

        if (!selectedOption) return;

        switch (selectedOption.label) {
            case 'Line Style': {
                const lineStyles = ['solid', 'dashed', 'dotted'];
                const selectedStyle = await vscode.window.showQuickPick(lineStyles, {
                    placeHolder: 'Select line style'
                });
                if (selectedStyle) {
                    this.waveformDataProvider.setVariableStyle(variableId, {
                        lineStyle: selectedStyle as any
                    });
                }
                break;
            }

            case 'Line Width': {
                const defaultWidth = this.waveformDataProvider.getDefaultLineWidth().toString();
                const width = await vscode.window.showInputBox({
                    prompt: 'Enter line width (1-10)',
                    placeHolder: defaultWidth,
                    value: defaultWidth,
                    validateInput: (value) => {
                        const num = parseFloat(value);
                        return (isNaN(num) || num < 1 || num > 10) ? 'Please enter a number between 1 and 10' : null;
                    }
                });
                if (width) {
                    this.waveformDataProvider.setVariableStyle(variableId, {
                        lineWidth: parseFloat(width)
                    });
                }
                break;
            }

            case 'Color': {
                const color = await vscode.window.showInputBox({
                    prompt: 'Enter color (hex code or color name)',
                    placeHolder: '#ff0000'
                });
                if (color) {
                    this.waveformDataProvider.setVariableStyle(variableId, { color });
                }
                break;
            }

            case 'Opacity': {
                const opacity = await vscode.window.showInputBox({
                    prompt: 'Enter opacity (0.0-1.0)',
                    placeHolder: '1.0',
                    validateInput: (value) => {
                        const num = parseFloat(value);
                        return (isNaN(num) || num < 0 || num > 1) ? 'Please enter a number between 0 and 1' : null;
                    }
                });
                if (opacity) {
                    this.waveformDataProvider.setVariableStyle(variableId, {
                        opacity: parseFloat(opacity)
                    });
                }
                break;
            }
        }
    }

    private performWaveformFFTFromNode(node: any): void {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const expression = node.getExpr();
        const variable = this.waveformDataProvider.getVariable(expression);

        if (!variable) {
            vscode.window.showInformationMessage(`Variable '${node.getName()}' is not currently in waveform monitoring. Please add it first.`);
            return;
        }

        // Open waveform view and perform FFT
        this.waveformWebview.show();

        // Use default FFT settings
        const defaultWindowSize = this.waveformDataProvider.getDefaultFFTWindowSize();
        const defaultWindowFunction = this.waveformDataProvider.getDefaultFFTWindowFunction();

        const fftResult = this.waveformDataProvider.getFFTAnalysis(
            expression,
            defaultWindowSize,
            defaultWindowFunction
        );

        if (fftResult) {
            const dominantPhase = (fftResult.dominantFrequency.phase * 180 / Math.PI).toFixed(1);
            const message = `
FFT Analysis Results for ${node.getName()}:
- Window Size: ${defaultWindowSize} samples
- Window Function: ${defaultWindowFunction}
- Sampling Rate: ${fftResult.samplingRate} Hz
- Dominant Frequency: ${fftResult.dominantFrequency.frequency.toFixed(2)} Hz
- Dominant Magnitude: ${fftResult.dominantFrequency.magnitude.toFixed(2)} dB
- Dominant Phase: ${dominantPhase}°
- Noise Floor: ${fftResult.noiseFloor.toFixed(2)} dB
- Total Harmonic Distortion: ${(fftResult.thd * 100).toFixed(3)}%
- Peak Count: ${fftResult.peaks.length}

Top 3 Peaks:
${fftResult.peaks.slice(0, 3).map((peak, i) =>
    `${i + 1}. ${peak.frequency.toFixed(2)} Hz, ${peak.magnitude.toFixed(2)} dB, SNR: ${peak.snr.toFixed(1)} dB`
).join('\n')}
            `.trim();

            vscode.window.showInformationMessage(message, 'Copy to Clipboard').then((action) => {
                if (action === 'Copy to Clipboard') {
                    vscode.env.clipboard.writeText(message);
                }
            });
        } else {
            vscode.window.showErrorMessage(`Insufficient data for FFT analysis. Need at least ${defaultWindowSize} data points.`);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    try {
        CortexDebugChannel.createDebugChanne();
        CortexDebugChannel.debugMessage('Starting Cortex-Debug extension.');
    } catch (_e) { /* empty */ }

    return new CortexDebugExtension(context);
}

export function deactivate() {}
