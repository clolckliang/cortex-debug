import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { CortexDebugChannel } from '../dbgmsgs';
import { LiveWatchTreeProvider, LiveVariableNode } from './views/live-watch';
import { EditableLiveWatchPanel } from './views/editable-live-watch';
import { WaveformDataProvider } from './views/waveform-data-provider';
import { WaveformWebviewPanel } from './views/waveform-webview';
import { StructureMemberTreeDataProvider } from './views/structure-member-tree';
import { CmBacktraceAnalyzer } from './cmbacktrace';
import { FaultAnalysisTreeProvider } from './views/fault-analysis-tree';

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
    private cmBacktraceAnalyzer: CmBacktraceAnalyzer;
    private faultAnalysisProvider: FaultAnalysisTreeProvider;
    private faultAnalysisTreeView: vscode.TreeView<any>;

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

        this.cmBacktraceAnalyzer = new CmBacktraceAnalyzer();
        this.faultAnalysisProvider = new FaultAnalysisTreeProvider(this.context);
        this.faultAnalysisTreeView = vscode.window.createTreeView('cortex-debug.faultAnalysis', {
            treeDataProvider: this.faultAnalysisProvider,
            showCollapseAll: true
        });

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
            vscode.commands.registerCommand('cortex-debug.liveWatch.setValue', this.setLiveWatchValue.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.editValue', this.editLiveWatchValue.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.startInlineEdit', this.startInlineEdit.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.expand', this.expandLiveWatchItem.bind(this)),

            vscode.commands.registerCommand('cortex-debug.liveWatch.addToWaveform', this.addToWaveform.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.selectStructMembers', this.selectStructMembers.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.configureStructMembers', this.configureStructMembers.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.selectStructMembers', this.configureWaveformStructMembers.bind(this)),

            vscode.commands.registerCommand('cortex-debug.waveform.show', this.showWaveform.bind(this)),
            vscode.commands.registerCommand('cortex-debug.editableLiveWatch.show', this.showEditableLiveWatch.bind(this)),

            // Waveform-related commands
            vscode.commands.registerCommand('cortex-debug.waveform.addVariable', this.addWaveformVariable.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.removeVariable', this.removeWaveformVariable.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.clearAll', this.clearWaveformData.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.toggleVariable', this.toggleWaveformVariable.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.setStyle', this.setWaveformVariableStyle.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.setStyleFromNode', this.setWaveformVariableStyleFromNode.bind(this)),

            // Enhanced LiveWatch-Waveform integration commands
            vscode.commands.registerCommand('cortex-debug.liveWatch.configureForWaveform', this.configureVariableForWaveform.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.removeFromWaveform', this.removeFromWaveform.bind(this)),
            vscode.commands.registerCommand('cortex-debug.liveWatch.showInWaveform', this.showVariableInWaveform.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.startRecording', this.startWaveformRecording.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.stopRecording', this.stopWaveformRecording.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.exportData', this.exportWaveformData.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.importConfig', this.importWaveformConfig.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.exportConfig', this.exportWaveformConfig.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.fftAnalysis', this.performWaveformFFT.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.fftAnalysisFromNode', this.performWaveformFFTFromNode.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.updateSettings', this.updateWaveformSettings.bind(this)),

            // Logic Analyzer display type commands
            vscode.commands.registerCommand('cortex-debug.waveform.changeDisplayType', this.changeDisplayType.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.configureBitWidth', this.configureBitWidth.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.configureThreshold', this.configureThreshold.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.configureGroup', this.configureSignalGroup.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.showStatistics', this.showSignalStatistics.bind(this)),
            vscode.commands.registerCommand('cortex-debug.waveform.configureTrigger', this.configureTrigger.bind(this)),

            // CmBacktrace fault analysis commands
            vscode.commands.registerCommand('cortex-debug.analyzeFault', this.analyzeFault.bind(this)),
            vscode.commands.registerCommand('cortex-debug.showCallStack', this.showCallStack.bind(this)),
            vscode.commands.registerCommand('cortex-debug.faultAnalysis.jumpToSource', this.jumpToSource.bind(this)),
            vscode.commands.registerCommand('cortex-debug.faultAnalysis.clearFault', this.clearFault.bind(this)),

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

        // Check for fault when debug stops
        this.checkForFault(e.session).catch((err) => {
            console.error('Fault detection failed:', err);
        });
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
        console.log('[LiveWatch] removeLiveWatchExpr called, node:', node.getName());
        console.log('[LiveWatch] Debug session active:', !!vscode.debug.activeDebugSession);
        console.log('[LiveWatch] Debug session stopped:', this.liveWatchProvider['isStopped']);

        try {
            this.liveWatchProvider.removeWatchExpr(node);
            console.log('[LiveWatch] removeWatchExpr completed successfully');
        } catch (error) {
            console.error('[LiveWatch] removeWatchExpr failed:', error);
        }
    }

    private editLiveWatchExpr(node: any) {
        this.liveWatchProvider.editNode(node);
    }

    private moveUpLiveWatchExpr(node: any) {
        console.log('[LiveWatch] moveUpLiveWatchExpr called, node:', node.getName());
        try {
            this.liveWatchProvider.moveUpNode(node);
            console.log('[LiveWatch] moveUpLiveWatchExpr completed successfully');
        } catch (error) {
            console.error('[LiveWatch] moveUpLiveWatchExpr failed:', error);
        }
    }

    private moveDownLiveWatchExpr(node: any) {
        console.log('[LiveWatch] moveDownLiveWatchExpr called, node:', node.getName());
        try {
            this.liveWatchProvider.moveDownNode(node);
            console.log('[LiveWatch] moveDownLiveWatchExpr completed successfully');
        } catch (error) {
            console.error('[LiveWatch] moveDownLiveWatchExpr failed:', error);
        }
    }

    private async setLiveWatchValue(node: any): Promise<void> {
        if (!node || !node.setValue) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        // Safety check: Warn if modifying pointer values
        const nodeType = node.getType ? node.getType() : '';
        const isPointer = nodeType && (nodeType.includes('*') || nodeType.toLowerCase().includes('pointer'));

        if (isPointer) {
            const proceed = await vscode.window.showWarningMessage(
                `Warning: '${node.getName()}' is a pointer (${nodeType}). `
                + 'Modifying pointer values can cause memory corruption or system crashes. '
                + 'Are you sure you want to continue?',
                { modal: true },
                'Yes, I understand the risks',
                'Cancel'
            );

            if (proceed !== 'Yes, I understand the risks') {
                return;
            }
        }

        const currentValue = node.getCopyValue ? node.getCopyValue() : '';
        const newValue = await vscode.window.showInputBox({
            prompt: `Set value for '${node.getName()}'${nodeType ? ` (${nodeType})` : ''}`,
            placeHolder: 'Enter new value (e.g., 123, 0xFF, 0b1010, "string")',
            value: currentValue,
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return 'Value cannot be empty';
                }
                // Basic format validation
                const trimmed = value.trim();
                if (!/^-?\d+(\.\d+)?$/.test(trimmed)  // decimal
                    && !/^0[xX][0-9a-fA-F]+$/.test(trimmed)  // hex
                    && !/^0[bB][01]+$/.test(trimmed)  // binary
                    && !/^["'].*["']$/.test(trimmed)  // string
                    && !/^'.'$/.test(trimmed)  // char
                    && trimmed !== 'true' && trimmed !== 'false'  // bool
                    && !trimmed.includes('(')) {  // cast expression
                    return 'Invalid format. Use decimal, hex (0x...), binary (0b...), or string ("...")';
                }
                return null;
            }
        });

        if (newValue !== undefined && newValue !== currentValue) {
            try {
                const success = await node.setValue(newValue);
                if (success) {
                    vscode.window.showInformationMessage(`Successfully set '${node.getName()}' to '${newValue}'`);
                    // Refresh the tree view to show the new value
                    const session = vscode.debug.activeDebugSession;
                    if (session) {
                        this.liveWatchProvider.refresh(session);
                    }
                } else {
                    vscode.window.showErrorMessage(`Failed to set value for '${node.getName()}'`);
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error setting variable value: ${errorMsg}`);
            }
        }
    }

    private expandLiveWatchItem(node: any): void {
        if (!node || !node.expandChildren) {
            vscode.window.showErrorMessage('Invalid variable node for expansion');
            return;
        }

        console.log(`[LiveWatch] Manual expand triggered for ${node.getName()}`);

        // Expand the node manually
        node.expandChildren().then(() => {
            console.log(`[LiveWatch] Manual expand completed for ${node.getName()}`);
            // Refresh the tree view to show the expanded children
            const session = vscode.debug.activeDebugSession;
            if (session) {
                this.liveWatchProvider.fire();
            }
        }).catch((error) => {
            console.error(`[LiveWatch] Manual expand failed for ${node.getName()}:`, error);
            vscode.window.showErrorMessage(`Failed to expand '${node.getName()}': ${error}`);
        });
    }

    private editLiveWatchValue(node: any): void {
        if (!node || !node.setValue) {
            vscode.window.showErrorMessage('Invalid variable node for editing');
            return;
        }

        // Get current value for default
        const currentValue = node.getCopyValue ? node.getCopyValue() : '';
        const nodeType = node.getType ? node.getType() : '';
        const nodeName = node.getName ? node.getName() : '';

        console.log(`[LiveWatch] Edit value triggered for ${nodeName} (type: ${nodeType}, current: ${currentValue})`);

        // Create input box with current value as default
        vscode.window.showInputBox({
            prompt: `Edit value for '${nodeName}'${nodeType ? ` (${nodeType})` : ''}`,
            value: currentValue,
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return 'Value cannot be empty';
                }

                // Basic format validation (same as in setLiveWatchValue)
                const trimmed = value.trim();
                if (!/^-?\d+(\.\d+)?$/.test(trimmed)  // decimal
                    && !/^0[xX][0-9a-fA-F]+$/.test(trimmed)  // hex
                    && !/^0[bB][01]+$/.test(trimmed)  // binary
                    && !/^["'].*["']$/.test(trimmed)  // string
                    && !/^'.'$/.test(trimmed)  // char
                    && trimmed !== 'true' && trimmed !== 'false'  // bool
                    && !trimmed.includes('(')) {  // cast expression
                    return 'Invalid format. Use decimal, hex (0x...), binary (0b...), or string ("...")';
                }
                return null;
            }
        }).then((newValue) => {
            if (newValue !== undefined && newValue !== currentValue) {
                console.log(`[LiveWatch] Setting new value for ${nodeName}: ${currentValue} -> ${newValue}`);

                // Set the new value
                node.setValue(newValue).then((success: boolean) => {
                    if (success) {
                        vscode.window.showInformationMessage(`Successfully set '${nodeName}' to '${newValue}'`);
                        // Refresh the tree view to show the new value
                        const session = vscode.debug.activeDebugSession;
                        if (session) {
                            this.liveWatchProvider.refresh(session);
                        }
                    } else {
                        vscode.window.showErrorMessage(`Failed to set value for '${nodeName}'`);
                    }
                }).catch((error) => {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Error setting variable value: ${errorMsg}`);
                });
            }
        });
    }

    private startInlineEdit(node: any): void {
        if (!node || !node.startEdit) {
            vscode.window.showErrorMessage('Invalid variable node for inline editing');
            return;
        }

        const nodeName = node.getName ? node.getName() : 'Unknown';
        console.log(`[LiveWatch] Starting inline edit for ${nodeName}`);

        // Start inline edit mode
        node.startEdit(async (newValue: string) => {
            console.log(`[LiveWatch] Inline edit completed for ${nodeName}: ${newValue}`);

            try {
                const success = await node.setValue(newValue);
                if (success) {
                    vscode.window.showInformationMessage(`Successfully set '${nodeName}' to '${newValue}'`);
                } else {
                    vscode.window.showErrorMessage(`Failed to set value for '${nodeName}'`);
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error setting variable value: ${errorMsg}`);
            }
        });

        // Show quick pick for value input with inline editing feel
        const currentValue = node.getCopyValue ? node.getCopyValue() : '';

        vscode.window.showInputBox({
            prompt: `Edit value for '${nodeName}' (Enter to confirm, Esc to cancel)`,
            value: currentValue,
            placeHolder: 'Enter new value...',
            validateInput: (value: string) => {
                // Update the edit value in real-time
                if (node.updateEditValue) {
                    node.updateEditValue(value);
                }

                if (value.length === 0) {
                    return null; // Allow empty during typing
                }

                // Basic format validation
                const trimmed = value.trim();
                if (!/^-?\d+(\.\d+)?$/.test(trimmed)  // decimal
                    && !/^0[xX][0-9a-fA-F]+$/.test(trimmed)  // hex
                    && !/^0[bB][01]+$/.test(trimmed)  // binary
                    && !/^["'].*["']$/.test(trimmed)  // string
                    && !/^'.'$/.test(trimmed)  // char
                    && trimmed !== 'true' && trimmed !== 'false'  // bool
                    && !trimmed.includes('(')) {  // cast expression
                    return 'Invalid format';
                }
                return null;
            }
        }).then((value) => {
            if (value !== undefined) {
                // User pressed Enter
                node.finishEdit();
            } else {
                // User pressed Esc
                node.cancelEdit();
            }
        });
    }

    private showWaveform(): void {
        this.waveformWebview.show();
    }

    private showEditableLiveWatch(): void {
        EditableLiveWatchPanel.createOrShow(
            vscode.Uri.file(this.context.extensionPath),
            this.liveWatchProvider
        );
    }

    private addToWaveform(node: any) {
        if (node && node.getExpr) {
            const success = this.waveformDataProvider.addVariable(node);
            if (success) {
                const expression = node.getExpr();
                const parsed = this.waveformDataProvider.getParsedStructure(expression);

                if (parsed && (parsed.type === 'struct' || parsed.type === 'union')) {
                    // This is a complex structure, offer member selection
                    vscode.window.showInformationMessage(
                        `Added '${node.getName()}' to waveform. This appears to be a ${parsed.type}.`,
                        'Select Members',
                        'Continue'
                    ).then((choice) => {
                        if (choice === 'Select Members') {
                            this.selectStructMembers(node);
                        } else {
                            // Auto-show waveform view when first variable is added
                            this.waveformWebview.show();
                        }
                    });
                } else {
                    vscode.window.showInformationMessage(`Added '${node.getName()}' to waveform monitoring`);
                    // Auto-show waveform view when first variable is added
                    this.waveformWebview.show();
                }
            }
        }
    }

    private async selectStructMembers(node: any): Promise<void> {
        if (!node || !node.getExpr) {
            return;
        }

        const expression = node.getExpr();
        await this.selectStructMembersForExpression(expression, node.getName());
    }

    private async selectStructMembersForExpression(expression: string, name: string): Promise<void> {
        const numericMembers = this.waveformDataProvider.getNumericMembers(expression);

        if (numericMembers.length === 0) {
            vscode.window.showInformationMessage(
                `No numeric members found in '${name}'. The entire structure will be monitored.`
            );
            this.waveformWebview.show();
            return;
        }

        // Create quick pick items for member selection
        const quickPickItems = numericMembers.map((member) => ({
            label: member.path,
            description: `Select ${member.name} for individual monitoring`,
            picked: member.selected,
            detail: `Path: ${member.path}`
        }));

        const selected = await vscode.window.showQuickPick(quickPickItems, {
            canPickMany: true,
            placeHolder: `Select numeric members from ${name} to monitor individually`,
            title: `Structure Member Selection - ${name}`
        });

        if (selected) {
            const selectedPaths = selected.map((item) => item.label);
            const success = this.waveformDataProvider.selectStructureMembers(expression, selectedPaths);

            if (success) {
                const selectedCount = selectedPaths.length;
                if (selectedCount > 0) {
                    vscode.window.showInformationMessage(
                        `Selected ${selectedCount} member(s) from '${name}' for individual monitoring.`
                    );

                    // Generate expressions for selected members
                    const memberExpressions = this.waveformDataProvider.generateMemberExpressions(expression);
                    console.log(`[Extension] Generated member expressions:`, memberExpressions);
                } else {
                    vscode.window.showInformationMessage(
                        `Monitoring entire structure '${name}'.`
                    );
                }

                this.waveformWebview.show();
            }
        }
    }

    private configureStructMembers(node: any): void {
        if (!node || !node.getExpr) {
            return;
        }

        const expression = node.getExpr();
        this.configureStructMembersForExpression(expression, node.getName());
    }

    private async configureWaveformStructMembers(): Promise<void> {
        // Get all structure variables from waveform
        const variables = this.waveformDataProvider.getVariables();
        const structureVariables = variables.filter((v) => {
            const parsed = this.waveformDataProvider.getParsedStructure(v.expression);
            return parsed !== null;
        });

        if (structureVariables.length === 0) {
            vscode.window.showInformationMessage(
                'No structure variables found in waveform. Add a structure variable first.'
            );
            return;
        }

        // Let user select which structure to configure
        const items = structureVariables.map((v) => ({
            label: v.name,
            description: `Expression: ${v.expression || 'unknown'}`,
            expression: v.expression
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select structure variable to configure members'
        });

        if (selected) {
            this.configureStructMembersForExpression(selected.expression, selected.label);
        }
    }

    private configureStructMembersForExpression(expression: string, name: string): void {
        const parsed = this.waveformDataProvider.getParsedStructure(expression);

        if (!parsed) {
            vscode.window.showWarningMessage(
                `No parsed structure found for '${name}'. Try adding it to waveform first.`
            );
            return;
        }

        // Show detailed structure information
        const infoItems = [
            `Structure Type: ${parsed.type}`,
            `Total Members: ${parsed.members.length}`,
            `Current Hash: ${parsed.hash}`,
            `Total Value: ${parsed.totalValue}`,
            '',
            'Members:',
            ...parsed.members.map((member) =>
                `- ${member.name}: ${member.value} (${member.type})`
            )
        ];

        vscode.window.showInformationMessage(
            infoItems.join('\n'),
            'Select Members',
            'Close'
        ).then((choice) => {
            if (choice === 'Select Members') {
                this.selectStructMembersForExpression(expression, name);
            }
        });
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
            const message = 'FFT Analysis Results for ' + selectedVar.label + ':\n'
                + '- Window Size: ' + windowSize + ' samples\n'
                + '- Window Function: ' + windowFunction + '\n'
                + '- Sampling Rate: ' + fftResult.samplingRate + ' Hz\n'
                + '- Dominant Frequency: ' + fftResult.dominantFrequency.frequency.toFixed(2) + ' Hz\n'
                + '- Dominant Magnitude: ' + fftResult.dominantFrequency.magnitude.toFixed(2) + ' dB\n'
                + '- Dominant Phase: ' + dominantPhase + '°\n'
                + '- Noise Floor: ' + fftResult.noiseFloor.toFixed(2) + ' dB\n'
                + '- Total Harmonic Distortion: ' + (fftResult.thd * 100).toFixed(3) + '%\n'
                + '- Peak Count: ' + fftResult.peaks.length + '\n\n'
                + 'Top 3 Peaks:\n'
                + fftResult.peaks.slice(0, 3).map((peak, i) =>
                    (i + 1) + '. ' + peak.frequency.toFixed(2) + ' Hz, ' + peak.magnitude.toFixed(2) + ' dB, SNR: ' + peak.snr.toFixed(1) + ' dB'
                ).join('\n');

            vscode.window.showInformationMessage(message, 'Copy to Clipboard').then((action) => {
                if (action === 'Copy to Clipboard') {
                    vscode.env.clipboard.writeText(message);
                }
            });
        } else {
            vscode.window.showErrorMessage('Insufficient data for FFT analysis. Need at least ' + windowSize + ' data points.');
        }
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

    // Enhanced LiveWatch-Waveform integration methods
    private async configureVariableForWaveform(node: any) {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const variableName = node.getName();
        const expression = node.getExpr();

        // Quick add to waveform first
        const success = this.waveformDataProvider.addVariable(node);
        if (!success) {
            vscode.window.showErrorMessage(`Failed to add variable ${variableName} to waveform`);
            return;
        }

        // Open configuration dialog
        const config = {
            color: this.waveformDataProvider.getVariableColor(expression),
            lineWidth: this.waveformDataProvider.getVariableLineWidth(expression),
            lineStyle: this.waveformDataProvider.getVariableLineStyle(expression),
            opacity: this.waveformDataProvider.getVariableOpacity(expression),
            samplingRate: this.waveformDataProvider.getVariableSamplingRate(expression) || 1.0
        };

        const result = await vscode.window.showQuickPick([
            { label: 'Change Color', description: 'Set waveform color', action: 'color' },
            { label: 'Change Line Style', description: 'Set line appearance', action: 'style' },
            { label: 'Change Sampling Rate', description: 'Set data collection frequency', action: 'sampling' },
            { label: 'Enable/Disable', description: 'Toggle variable visibility', action: 'toggle' },
            { label: 'Remove from Waveform', description: 'Remove variable from waveform view', action: 'remove' }
        ], {
            placeHolder: `Configure ${variableName} for waveform display`,
            matchOnDescription: true
        });

        if (result) {
            switch (result.action) {
                case 'color':
                    await this.changeVariableColor(expression, variableName);
                    break;
                case 'style':
                    await this.changeVariableStyle(expression, variableName);
                    break;
                case 'sampling':
                    await this.changeVariableSamplingRate(expression, variableName);
                    break;
                case 'toggle':
                    this.waveformDataProvider.updateVariableSettings(expression, {
                        enabled: !this.waveformDataProvider.getVariable(expression)?.enabled
                    });
                    this.waveformWebview?.toggleVariable(expression, !this.waveformDataProvider.getVariable(expression)?.enabled);
                    this.waveformWebview?.refreshData();
                    break;
                case 'remove':
                    this.removeFromWaveform(node);
                    break;
            }
        }
    }

    private removeFromWaveform(node: any) {
        if (node && node.getExpr) {
            const success = this.waveformDataProvider.removeVariable(node.getExpr());
            if (success) {
                vscode.window.showInformationMessage(`Removed ${node.getName()} from waveform`);
            } else {
                vscode.window.showWarningMessage(`Variable ${node.getName()} was not in waveform`);
            }
        }
    }

    private showVariableInWaveform(node: any): void {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        // Add to waveform if not already there
        const success = this.waveformDataProvider.addVariable(node);
        if (success) {
            // Show waveform view
            this.showWaveform();

            // Focus the specific variable in the waveform
            setTimeout(() => {
                this.waveformWebview?.show();
                this.waveformWebview?.highlightVariable(node.getExpr());
            }, 500);
        }
    }

    private startWaveformRecording() {
        this.waveformDataProvider.startRecording();
        vscode.window.showInformationMessage('Waveform recording started');
    }

    private stopWaveformRecording() {
        this.waveformDataProvider.stopRecording();
        vscode.window.showInformationMessage('Waveform recording stopped');
    }

    private async exportWaveformData() {
        const format = await vscode.window.showQuickPick([
            { label: 'JSON', description: 'Export data as JSON format', value: 'json' },
            { label: 'CSV', description: 'Export data as CSV format', value: 'csv' }
        ], {
            placeHolder: 'Select export format'
        });

        if (format) {
            try {
                const data = this.waveformDataProvider.exportData(format.value as 'json' | 'csv');

                const uri = await vscode.window.showSaveDialog({
                    filters: format.value === 'json' ? { 'JSON Files': ['json'] } : { 'CSV Files': ['csv'] },
                    defaultUri: vscode.Uri.file(`waveform_data_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${format.value}`)
                });

                if (uri) {
                    const fs = await import('fs');
                    fs.writeFileSync(uri.fsPath, data);
                    vscode.window.showInformationMessage(`Waveform data exported to ${uri.fsPath}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to export data: ${error}`);
            }
        }
    }

    private async importWaveformConfig() {
        const uri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'JSON Files': ['json'] },
            title: 'Select waveform configuration file'
        });

        if (uri && uri.length > 0) {
            try {
                const fs = await import('fs');
                const configData = JSON.parse(fs.readFileSync(uri[0].fsPath, 'utf8'));
                this.waveformDataProvider.importConfiguration(configData);
                vscode.window.showInformationMessage('Waveform configuration imported successfully');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to import configuration: ${error}`);
            }
        }
    }

    private async exportWaveformConfig() {
        try {
            const config = this.waveformDataProvider.exportConfiguration();

            const uri = await vscode.window.showSaveDialog({
                filters: { 'JSON Files': ['json'] },
                defaultUri: vscode.Uri.file(`waveform_config_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`)
            });

            if (uri) {
                const fs = await import('fs');
                fs.writeFileSync(uri.fsPath, JSON.stringify(config, null, 2));
                vscode.window.showInformationMessage(`Waveform configuration exported to ${uri.fsPath}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export configuration: ${error}`);
        }
    }

    private async updateWaveformSettings() {
        const currentSettings = this.waveformDataProvider.getSettings();

        // Create a multi-step input dialog for settings
        const timeSpan = await vscode.window.showInputBox({
            prompt: 'Time span (seconds)',
            value: currentSettings.timeSpan.toString(),
            validateInput: (value) => {
                const num = parseFloat(value);
                return isNaN(num) || num <= 0 ? 'Please enter a positive number' : null;
            }
        });

        if (timeSpan === undefined) return; // User cancelled

        const refreshRate = await vscode.window.showInputBox({
            prompt: 'Refresh rate (Hz)',
            value: currentSettings.refreshRate.toString(),
            validateInput: (value) => {
                const num = parseFloat(value);
                return isNaN(num) || num <= 0 || num > 20 ? 'Please enter a number between 0.1 and 20' : null;
            }
        });

        if (refreshRate === undefined) return; // User cancelled

        const maxDataPoints = await vscode.window.showInputBox({
            prompt: 'Maximum data points',
            value: currentSettings.maxDataPoints.toString(),
            validateInput: (value) => {
                const num = parseInt(value);
                return isNaN(num) || num < 100 || num > 50000 ? 'Please enter a number between 100 and 50000' : null;
            }
        });

        if (maxDataPoints === undefined) return; // User cancelled

        // Apply settings
        const newSettings = {
            timeSpan: parseFloat(timeSpan),
            refreshRate: parseFloat(refreshRate),
            maxDataPoints: parseInt(maxDataPoints)
        };

        this.waveformDataProvider.updateSettings(newSettings);
        vscode.window.showInformationMessage('Waveform settings updated');
    }

    private async changeVariableColor(expression: string, variableName: string) {
        const colors = [
            { label: 'Blue', value: '#1f77b4' },
            { label: 'Orange', value: '#ff7f0e' },
            { label: 'Green', value: '#2ca02c' },
            { label: 'Red', value: '#d62728' },
            { label: 'Purple', value: '#9467bd' },
            { label: 'Brown', value: '#8c564b' },
            { label: 'Pink', value: '#e377c2' },
            { label: 'Gray', value: '#7f7f7f' },
            { label: 'Olive', value: '#bcbd22' },
            { label: 'Cyan', value: '#17becf' }
        ];

        const selected = await vscode.window.showQuickPick(colors, {
            placeHolder: `Select color for ${variableName}`
        });

        if (selected) {
            this.waveformDataProvider.updateVariableSettings(expression, { color: selected.value });
            vscode.window.showInformationMessage(`Updated color for ${variableName}`);
        }
    }

    private async changeVariableStyle(expression: string, variableName: string) {
        const styles = [
            { label: 'Solid Line', value: 'solid' },
            { label: 'Dashed Line', value: 'dashed' },
            { label: 'Dotted Line', value: 'dotted' }
        ];

        const lineWidths = [
            { label: 'Thin (1px)', value: 1 },
            { label: 'Normal (2px)', value: 2 },
            { label: 'Thick (3px)', value: 3 },
            { label: 'Extra Thick (4px)', value: 4 }
        ];

        const style = await vscode.window.showQuickPick(styles, {
            placeHolder: `Select line style for ${variableName}`
        });

        if (style) {
            const width = await vscode.window.showQuickPick(lineWidths, {
                placeHolder: `Select line width for ${variableName}`
            });

            if (width) {
                this.waveformDataProvider.updateVariableSettings(expression, {
                    lineStyle: style.value as 'solid' | 'dashed' | 'dotted',
                    lineWidth: width.value
                });
                vscode.window.showInformationMessage(`Updated style for ${variableName}`);
            }
        }
    }

    private async changeVariableSamplingRate(expression: string, variableName: string) {
        const rate = await vscode.window.showInputBox({
            prompt: 'Sampling rate (Hz)',
            value: '1.0',
            validateInput: (value) => {
                const num = parseFloat(value);
                return isNaN(num) || num <= 0 || num > 100 ? 'Please enter a number between 0.1 and 100' : null;
            }
        });

        if (rate !== undefined) {
            this.waveformDataProvider.updateVariableSettings(expression, {
                samplingRate: parseFloat(rate)
            });
            vscode.window.showInformationMessage(`Updated sampling rate for ${variableName} to ${rate} Hz`);
        }
    }

    // ========== Logic Analyzer Display Type Management ==========

    /**
     * Change display type for a waveform variable (Analog/Bit/State/Hex/Binary)
     */
    private async changeDisplayType(node: any) {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const variableName = node.getName();
        const expression = node.getExpr();

        // Get available display types
        const displayTypes = this.waveformDataProvider.getAvailableDisplayTypes();
        const currentType = this.waveformDataProvider.getVariableDisplayType(expression);

        const selected = await vscode.window.showQuickPick(
            displayTypes.map((dt) => ({
                label: dt.label + (dt.value === currentType ? ' (current)' : ''),
                description: dt.description,
                value: dt.value
            })),
            {
                placeHolder: `Select display type for ${variableName}`,
                matchOnDescription: true
            }
        );

        if (selected) {
            const success = this.waveformDataProvider.setVariableDisplayType(expression, selected.value);
            if (success) {
                vscode.window.showInformationMessage(`Set display type for ${variableName} to ${selected.label}`);

                // If changing to bit/hex/binary/state, prompt for bit width configuration
                if (['bit', 'hex', 'binary', 'state'].includes(selected.value)) {
                    await this.configureBitWidth(expression, variableName);
                }

                this.waveformWebview?.refreshData();
            } else {
                vscode.window.showErrorMessage(`Failed to set display type for ${variableName}`);
            }
        }
    }

    /**
     * Configure bit width for multi-bit signals
     */
    private async configureBitWidth(expression: string, variableName: string) {
        const config = this.waveformDataProvider.getVariableBitConfig(expression);

        const bitWidth = await vscode.window.showInputBox({
            prompt: `Bit width for ${variableName}`,
            value: config.bitWidth.toString(),
            validateInput: (value) => {
                const num = parseInt(value);
                return isNaN(num) || num < 1 || num > 32 ? 'Please enter a number between 1 and 32' : null;
            }
        });

        if (bitWidth !== undefined) {
            this.waveformDataProvider.setVariableBitConfig(expression, {
                bitWidth: parseInt(bitWidth)
            });
            vscode.window.showInformationMessage(`Set bit width for ${variableName} to ${bitWidth}`);
        }
    }

    /**
     * Configure digital threshold for bit display
     */
    private async configureThreshold(node: any) {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const variableName = node.getName();
        const expression = node.getExpr();
        const config = this.waveformDataProvider.getVariableBitConfig(expression);

        const threshold = await vscode.window.showInputBox({
            prompt: `Digital threshold for ${variableName} (0.0 - 1.0)`,
            value: config.threshold.toString(),
            validateInput: (value) => {
                const num = parseFloat(value);
                return isNaN(num) || num < 0 || num > 1 ? 'Please enter a number between 0.0 and 1.0' : null;
            }
        });

        if (threshold !== undefined) {
            this.waveformDataProvider.setVariableBitConfig(expression, {
                threshold: parseFloat(threshold)
            });
            vscode.window.showInformationMessage(`Set threshold for ${variableName} to ${threshold}`);
            this.waveformWebview?.refreshData();
        }
    }

    /**
     * Configure signal grouping
     */
    private async configureSignalGroup(node: any) {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const variableName = node.getName();
        const expression = node.getExpr();
        const currentGroup = this.waveformDataProvider.getVariableGroup(expression);
        const existingGroups = this.waveformDataProvider.getSignalGroups();

        // Show quick pick with existing groups and option to create new
        const items = [
            { label: '$(add) Create New Group', value: '__new__' },
            { label: '$(close) Remove from Group', value: '__none__' },
            ...existingGroups.map((g) => ({
                label: g + (g === currentGroup ? ' (current)' : ''),
                value: g
            }))
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select group for ${variableName}`
        });

        if (selected) {
            if (selected.value === '__new__') {
                const groupName = await vscode.window.showInputBox({
                    prompt: 'Enter new group name',
                    placeHolder: 'e.g., Motor Control, Sensors, etc.',
                    validateInput: (value) => {
                        return value.trim().length === 0 ? 'Group name cannot be empty' : null;
                    }
                });

                if (groupName) {
                    this.waveformDataProvider.setVariableGroup(expression, groupName.trim());
                    vscode.window.showInformationMessage(`Added ${variableName} to group "${groupName}"`);
                }
            } else if (selected.value === '__none__') {
                this.waveformDataProvider.setVariableGroup(expression, '');
                vscode.window.showInformationMessage(`Removed ${variableName} from group`);
            } else {
                this.waveformDataProvider.setVariableGroup(expression, selected.value);
                vscode.window.showInformationMessage(`Added ${variableName} to group "${selected.value}"`);
            }

            this.waveformWebview?.refreshData();
        }
    }

    /**
     * Show signal statistics
     */
    private showSignalStatistics(node: any) {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const variableName = node.getName();
        const expression = node.getExpr();
        const stats = this.waveformDataProvider.getVariableStatistics(expression);

        if (!stats) {
            vscode.window.showWarningMessage(`No statistics available for ${variableName}. Start recording data first.`);
            return;
        }

        const message = `Signal Statistics for ${variableName}:\n\n`
            + `Min: ${stats.min.toFixed(3)}\n`
            + `Max: ${stats.max.toFixed(3)}\n`
            + `Average: ${stats.avg.toFixed(3)}\n`
            + `RMS: ${stats.rms.toFixed(3)}\n`
            + `Duty Cycle: ${stats.duty.toFixed(1)}%\n`
            + (stats.frequency ? `Frequency: ${stats.frequency.toFixed(2)} Hz\n` : '')
            + (stats.period ? `Period: ${(stats.period * 1000).toFixed(2)} ms\n` : '');

        void vscode.window.showInformationMessage(message, { modal: false }, 'Copy to Clipboard').then((action) => {
            if (action === 'Copy to Clipboard') {
                vscode.env.clipboard.writeText(message);
            }
        });
    }

    /**
     * Configure trigger conditions
     */
    private async configureTrigger(node: any) {
        if (!node || !node.getExpr) {
            vscode.window.showErrorMessage('Invalid variable node');
            return;
        }

        const variableName = node.getName();
        const expression = node.getExpr();
        const currentTrigger = this.waveformDataProvider.getVariableTrigger(expression);

        // Show trigger type selection
        const triggerTypes = [
            { label: 'Rising Edge', value: 'rising', description: '0 → 1 transition' },
            { label: 'Falling Edge', value: 'falling', description: '1 → 0 transition' },
            { label: 'Change', value: 'change', description: 'Any value change' },
            { label: 'Level', value: 'level', description: 'Compare to threshold value' },
            { label: 'Disable Trigger', value: 'disable', description: 'Turn off trigger' }
        ];

        const selected = await vscode.window.showQuickPick(triggerTypes, {
            placeHolder: `Select trigger type for ${variableName}`
        });

        if (!selected) {
            return;
        }

        if (selected.value === 'disable') {
            this.waveformDataProvider.setVariableTrigger(expression, {
                enabled: false,
                type: 'rising'
            });
            vscode.window.showInformationMessage(`Disabled trigger for ${variableName}`);
            return;
        }

        const trigger: any = {
            enabled: true,
            type: selected.value
        };

        // If level trigger, get value and operator
        if (selected.value === 'level') {
            const operators = [
                { label: '== (Equal to)', value: '==' },
                { label: '!= (Not equal to)', value: '!=' },
                { label: '> (Greater than)', value: '>' },
                { label: '< (Less than)', value: '<' },
                { label: '>= (Greater than or equal)', value: '>=' },
                { label: '<= (Less than or equal)', value: '<=' }
            ];

            const op = await vscode.window.showQuickPick(operators, {
                placeHolder: 'Select comparison operator'
            });

            if (!op) {
                return;
            }

            const value = await vscode.window.showInputBox({
                prompt: 'Enter threshold value',
                validateInput: (v) => {
                    return isNaN(parseFloat(v)) ? 'Please enter a valid number' : null;
                }
            });

            if (value === undefined) {
                return;
            }

            trigger.operator = op.value;
            trigger.value = parseFloat(value);
        }

        this.waveformDataProvider.setVariableTrigger(expression, trigger);
        vscode.window.showInformationMessage(`Configured ${selected.label} trigger for ${variableName}`);
    }

    // ========== CmBacktrace Fault Analysis Methods ==========

    /**
     * Manually trigger fault analysis
     */
    private async analyzeFault() {
        const session = CortexDebugExtension.getActiveCDSession();
        if (!session) {
            vscode.window.showErrorMessage('No active Cortex-Debug session');
            return;
        }

        await this.cmBacktraceAnalyzer.setSession(session);

        const analysis = await this.cmBacktraceAnalyzer.analyzeFault();
        if (analysis) {
            this.faultAnalysisProvider.updateAnalysis(analysis);

            // Reveal the fault analysis view
            if (this.faultAnalysisTreeView) {
                this.faultAnalysisTreeView.reveal(null, { select: false, focus: true });
            }
        }
    }

    /**
     * Show current call stack (can be called anytime)
     */
    private async showCallStack() {
        const session = CortexDebugExtension.getActiveCDSession();
        if (!session) {
            vscode.window.showErrorMessage('No active Cortex-Debug session');
            return;
        }

        await this.cmBacktraceAnalyzer.setSession(session);

        const callStack = await this.cmBacktraceAnalyzer.getCurrentCallStack();

        if (callStack.length === 0) {
            vscode.window.showInformationMessage('No call stack available');
            return;
        }

        // Display call stack as quick pick
        const items = callStack.map((frame, index) => {
            const location = frame.file && frame.line ? ` (${frame.file}:${frame.line})` : '';
            return {
                label: `#${index} ${frame.function || '??'}`,
                description: `0x${frame.pc.toString(16).toUpperCase().padStart(8, '0')}${location}`,
                frame
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a stack frame to navigate to source'
        });

        if (selected && selected.frame.file && selected.frame.line) {
            await this.jumpToSource(selected.frame.file, selected.frame.line);
        }
    }

    /**
     * Jump to source file at specific line
     */
    private async jumpToSource(file: string, line: number) {
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            const editor = await vscode.window.showTextDocument(doc);
            const position = new vscode.Position(line - 1, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not open file: ${file}`);
        }
    }

    /**
     * Clear fault analysis
     */
    private clearFault() {
        this.faultAnalysisProvider.clear();
        vscode.window.showInformationMessage('Fault analysis cleared');
    }

    /**
     * Automatically check for faults when debug stops
     */
    private async checkForFault(session: vscode.DebugSession) {
        const config = this.getCurrentArgs(session);

        // Check if auto fault detection is enabled
        const autoDetect = vscode.workspace.getConfiguration('cortex-debug').get('autoFaultDetection', true);
        if (!autoDetect) {
            return;
        }

        await this.cmBacktraceAnalyzer.setSession(session);

        // Don't show messages for automatic checks - only detect actual faults
        const analysis = await this.cmBacktraceAnalyzer.analyzeFault(false);

        if (analysis) {
            // Update the tree view
            this.faultAnalysisProvider.updateAnalysis(analysis);

            // Show notification
            vscode.window.showWarningMessage(
                `Fault Detected: ${analysis.faultType}`,
                'Show Details',
                'Dismiss'
            ).then((choice) => {
                if (choice === 'Show Details' && this.faultAnalysisTreeView) {
                    this.faultAnalysisTreeView.reveal(null, { select: false, focus: true });
                }
            });
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
