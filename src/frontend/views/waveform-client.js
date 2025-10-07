/**
 * Cortex-Debug Waveform View - Client-Side JavaScript
 *
 * This file contains all client-side logic for the waveform monitor webview.
 * It runs in the VS Code webview context and communicates with the extension
 * via the VS Code API.
 *
 * @file Waveform client application
 * @generated Extracted from waveform-webview.ts
 */

/* global acquireVsCodeApi */

// Get VS Code API handle
const vscode = acquireVsCodeApi();

let appState = {
    isRecording: false,
    variables: [],
    data: {},
    settings: {
        timeSpan: 60,
        refreshRate: 1.0,
        maxDataPoints: 10000,
        yAxisMode: 'auto',
        yMin: -1,
        yMax: 1
    },
    lastUpdateTime: 0,
    connectionStatus: 'connected'
};

// Save/restore state using VSCode API
function saveState() {
    const stateToSave = {
        settings: appState.settings,
        variables: appState.variables,
        lastUpdateTime: Date.now(),
        // Save UI state
        uiState: {
            collapsedGroups: Array.from(uiState.collapsedGroups),
            activeFilters: Array.from(uiState.activeFilters),
            searchText: uiState.searchText,
            searchMode: uiState.searchMode,
            caseSensitive: uiState.caseSensitive,
            customOrder: uiState.customOrder
        },
        selectedVariable: appState.selectedVariable
    };
    vscode.setState(stateToSave);
}

function restoreState() {
    const previousState = vscode.getState();
    if (previousState) {
        appState = { ...appState, ...previousState };

        // Restore UI state
        if (previousState.uiState) {
            if (previousState.uiState.collapsedGroups) {
                uiState.collapsedGroups = new Set(previousState.uiState.collapsedGroups);
            }
            if (previousState.uiState.activeFilters) {
                uiState.activeFilters = new Set(previousState.uiState.activeFilters);
            }
            if (previousState.uiState.searchText !== undefined) {
                uiState.searchText = previousState.uiState.searchText;
                const filterInput = document.getElementById('filterInput');
                if (filterInput) {
                    filterInput.value = uiState.searchText;
                }
            }
            if (previousState.uiState.searchMode) {
                uiState.searchMode = previousState.uiState.searchMode;
                const filterModeBtn = document.getElementById('filterModeBtn');
                if (filterModeBtn) {
                    filterModeBtn.classList.toggle('active', uiState.searchMode === 'regex');
                }
                const filterInput = document.getElementById('filterInput');
                if (filterInput && uiState.searchMode === 'regex') {
                    filterInput.placeholder = '🔍 Filter by regex pattern...';
                }
            }
            if (previousState.uiState.caseSensitive !== undefined) {
                uiState.caseSensitive = previousState.uiState.caseSensitive;
                const caseSensitiveBtn = document.getElementById('caseSensitiveBtn');
                if (caseSensitiveBtn) {
                    caseSensitiveBtn.classList.toggle('active', uiState.caseSensitive);
                }
            }
            if (previousState.uiState.customOrder) {
                uiState.customOrder = previousState.uiState.customOrder;
            }

            // Restore filter chip states
            if (previousState.uiState.activeFilters) {
                previousState.uiState.activeFilters.forEach((filter) => {
                    const chip = document.querySelector('.filter-chip[data-filter="' + filter + '"]');
                    if (chip) {
                        chip.classList.add('active');
                    }
                });
            }
        }

        console.log('State restored from previous session');
    }
}
let canvas, ctx;
let variables = [];
let data = {};
let settings = {
    timeSpan: 60,
    refreshRate: 1.0,
    maxDataPoints: 10000,
    yAxisMode: 'auto',
    yMin: -1,
    yMax: 1
};

// Professional interaction state
let interactionState = {
    isDragging: false,
    isSelecting: false,
    isMeasuring: false,
    measureMode: false,
    dragStart: { x: 0, y: 0 },
    dragEnd: { x: 0, y: 0 },
    selectionStart: { x: 0, y: 0 },
    selectionEnd: { x: 0, y: 0 },
    measureStart: { x: 0, y: 0 },
    measureEnd: { x: 0, y: 0 },
    zoomLevel: 1.0,
    panOffset: { x: 0, y: 0 },
    history: [],
    historyIndex: -1
};

// UI Elements
let crosshair, coordinateDisplay, selectionRect, tooltip;

// FPS tracking
let fps = 0;
let frameCount = 0;
let lastFpsUpdate = Date.now();

// Initialize application
window.addEventListener('load', () => {
    try {
        // Restore previous state
        restoreState();

        // Initialize canvas and UI elements
        initializeUI();

        // Setup event listeners
        setupEventListeners();

        // Request initial data
        vscode.postMessage({ command: 'requestInitialData' });

        // Initialize status display
        updateStatusDisplay();

        console.log('Waveform view initialized successfully');
    } catch (error) {
        console.error('Error initializing waveform view:', error);
        showError('Failed to initialize waveform view: ' + error.message);
    }
});

function initializeUI() {
    canvas = document.getElementById('waveformCanvas');
    if (!canvas) {
        throw new Error('Canvas element not found');
    }

    ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Failed to get canvas context');
    }

    // Get UI elements
    crosshair = document.getElementById('crosshair');
    coordinateDisplay = document.getElementById('coordinateDisplay');
    selectionRect = document.getElementById('selectionRect');
    tooltip = document.getElementById('tooltip');

    // Set initial canvas size
    resizeCanvas();

    // Handle window resize
    window.addEventListener('resize', () => {
        resizeCanvas();
    });

    // Apply saved settings
    if (appState.settings) {
        Object.assign(settings, appState.settings);
    }
}

function showError(message) {
    const errorDiv = document.createElement('div');
    const errorStyles = [
        'position: fixed',
        'top: 20px',
        'right: 20px',
        'background-color: var(--vscode-editor-errorBackground)',
        'color: var(--vscode-editor-errorForeground)',
        'border: 1px solid var(--vscode-editorError-border)',
        'border-radius: 4px',
        'padding: 12px',
        'max-width: 400px',
        'z-index: 10000',
        'font-family: var(--vscode-font-family)'
    ];
    errorDiv.style.cssText = errorStyles.join(';');
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);

    setTimeout(() => {
        if (errorDiv.parentNode) {
            errorDiv.parentNode.removeChild(errorDiv);
        }
    }, 5000);
}

function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    drawWaveform();
}

function setupEventListeners() {
    // Toolbar buttons
    document.getElementById('btnStartStop')?.addEventListener('click', toggleRecording);
    document.getElementById('btnClear')?.addEventListener('click', clearAllData);
    document.getElementById('btnExport')?.addEventListener('click', () => exportData('json'));
    document.getElementById('btnSettings')?.addEventListener('click', toggleSettings);
    document.getElementById('btnFFT')?.addEventListener('click', () => toggleFFTPanel());
    document.getElementById('btnZoomIn')?.addEventListener('click', zoomIn);
    document.getElementById('btnZoomOut')?.addEventListener('click', zoomOut);
    document.getElementById('btnZoomFit')?.addEventListener('click', autoFit);
    document.getElementById('btnMeasure')?.addEventListener('click', toggleMeasureMode);
    document.getElementById('btnGrid')?.addEventListener('click', toggleGrid);
    document.getElementById('btnLegend')?.addEventListener('click', toggleLegend);

    // Filter input
    const filterInput = document.getElementById('filterInput');
    if (filterInput) {
        filterInput.addEventListener('input', (e) => {
            uiState.searchText = e.target.value;
            updateVariableList();
            saveState();
        });
    }

    // Regex mode toggle
    const filterModeBtn = document.getElementById('filterModeBtn');
    if (filterModeBtn) {
        filterModeBtn.addEventListener('click', () => {
            uiState.searchMode = uiState.searchMode === 'text' ? 'regex' : 'text';
            filterModeBtn.classList.toggle('active', uiState.searchMode === 'regex');

            // Update placeholder
            if (filterInput) {
                filterInput.placeholder = uiState.searchMode === 'regex'
                    ? '🔍 Filter by regex pattern...'
                    : '🔍 Filter variables...';
            }

            updateVariableList();
            saveState();

            showNotification(
                'Search mode: ' + (uiState.searchMode === 'regex' ? 'Regular Expression' : 'Text'),
                'info'
            );
        });
    }

    // Case sensitive toggle
    const caseSensitiveBtn = document.getElementById('caseSensitiveBtn');
    if (caseSensitiveBtn) {
        caseSensitiveBtn.addEventListener('click', () => {
            uiState.caseSensitive = !uiState.caseSensitive;
            caseSensitiveBtn.classList.toggle('active', uiState.caseSensitive);
            updateVariableList();
            saveState();

            showNotification(
                'Case sensitive: ' + (uiState.caseSensitive ? 'ON' : 'OFF'),
                'info'
            );
        });
    }

    // Filter chips
    const filterChips = document.querySelectorAll('.filter-chip');
    filterChips.forEach((chip) => {
        chip.addEventListener('click', () => {
            const filter = chip.getAttribute('data-filter');
            if (uiState.activeFilters.has(filter)) {
                uiState.activeFilters.delete(filter);
                chip.classList.remove('active');
            } else {
                uiState.activeFilters.add(filter);
                chip.classList.add('active');
            }
            updateVariableList();
        });
    });

    // Canvas professional interactions
    canvas.addEventListener('mousedown', handleCanvasMouseDown);
    canvas.addEventListener('mousemove', handleCanvasMouseMove);
    canvas.addEventListener('mouseup', handleCanvasMouseUp);
    canvas.addEventListener('mouseleave', handleCanvasMouseLeave);
    canvas.addEventListener('contextmenu', handleCanvasRightClick);
    canvas.addEventListener('wheel', handleCanvasWheel);
    canvas.addEventListener('dblclick', handleCanvasDoubleClick);

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
}

// Professional mouse interaction handlers
function handleCanvasMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (e.button === 0) { // Left click
        if (interactionState.measureMode) {
            interactionState.isMeasuring = true;
            interactionState.measureStart = { x, y };
            interactionState.measureEnd = { x, y };
        } else if (e.shiftKey) {
            interactionState.isSelecting = true;
            interactionState.selectionStart = { x, y };
            interactionState.selectionEnd = { x, y };
        } else if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd + Click: Select variable at cursor position
            const coords = pixelToDataCoords(x, y);
            const closestVar = findClosestVariable(coords.x, coords.y);
            if (closestVar) {
                selectVariableOnCanvas(closestVar.variable.id);
            }
        } else {
            interactionState.isDragging = true;
            interactionState.dragStart = { x, y };
            canvas.style.cursor = 'grabbing';
        }
    }
}

function handleCanvasMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Update crosshair position
    updateCrosshair(x, y);

    // Update coordinate display
    updateCoordinateDisplay(x, y);

    if (interactionState.isDragging) {
        interactionState.dragEnd = { x, y };
        const dx = x - interactionState.dragStart.x;
        const dy = y - interactionState.dragStart.y;

        // Apply pan
        interactionState.panOffset.x += dx;
        interactionState.panOffset.y += dy;

        interactionState.dragStart = { x, y };
        drawWaveform();
    } else if (interactionState.isSelecting) {
        interactionState.selectionEnd = { x, y };
        updateSelectionRect();
    } else if (interactionState.isMeasuring) {
        interactionState.measureEnd = { x, y };
        updateMeasurementDisplay();
    }

    // Update tooltip if hovering over data points
    updateTooltip(x, y, e.clientX, e.clientY);
}

function handleCanvasMouseUp(e) {
    if (interactionState.isDragging) {
        interactionState.isDragging = false;
        canvas.style.cursor = 'crosshair';
        saveToHistory();
    } else if (interactionState.isSelecting) {
        interactionState.isSelecting = false;
        if (Math.abs(interactionState.selectionEnd.x - interactionState.selectionStart.x) > 10) {
            zoomToSelection();
        }
        hideSelectionRect();
    } else if (interactionState.isMeasuring) {
        interactionState.isMeasuring = false;
        if (Math.abs(interactionState.measureEnd.x - interactionState.measureStart.x) > 5) {
            showMeasurementResults();
        }
    }
}

function handleCanvasMouseLeave() {
    hideCrosshair();
    hideTooltip();

    if (interactionState.isDragging) {
        interactionState.isDragging = false;
        canvas.style.cursor = 'crosshair';
    }
    if (interactionState.isSelecting) {
        interactionState.isSelecting = false;
        hideSelectionRect();
    }
}

function handleCanvasRightClick(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    showContextMenu(x, y, e.clientX, e.clientY);
}

function handleCanvasWheel(e) {
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(10, interactionState.zoomLevel * delta));

    if (newZoom !== interactionState.zoomLevel) {
        // Zoom towards mouse position
        const zoomRatio = newZoom / interactionState.zoomLevel;

        interactionState.panOffset.x = x - (x - interactionState.panOffset.x) * zoomRatio;
        interactionState.panOffset.y = y - (y - interactionState.panOffset.y) * zoomRatio;
        interactionState.zoomLevel = newZoom;

        updateStatusDisplay();
        drawWaveform();
    }
}

function handleCanvasDoubleClick(e) {
    // Reset view on double click
    resetView();
}

function handleKeyDown(e) {
    switch (e.key) {
        case ' ':
            e.preventDefault();
            toggleRecording();
            break;
        case 'Escape':
            if (interactionState.measureMode) {
                toggleMeasureMode();
            }
            // Clear variable selection
            if (appState.selectedVariable) {
                appState.selectedVariable = null;
                updateVariableList();
                updateLegend();
                drawWaveform();
            }
            hideAllPanels();
            break;
        case 'g':
        case 'G':
            if (!e.ctrlKey && !e.metaKey) {
                toggleGrid();
            }
            break;
        case 'l':
        case 'L':
            if (!e.ctrlKey && !e.metaKey) {
                toggleLegend();
            }
            break;
        case 'm':
        case 'M':
            if (!e.ctrlKey && !e.metaKey) {
                toggleMeasureMode();
            }
            break;
        case 'f':
        case 'F':
            if (!e.ctrlKey && !e.metaKey) {
                autoFit();
            }
            break;
        case '+':
        case '=':
            if (!e.ctrlKey && !e.metaKey) {
                zoomIn();
            }
            break;
        case '-':
        case '_':
            if (!e.ctrlKey && !e.metaKey) {
                zoomOut();
            }
            break;
        case '0':
            if (!e.ctrlKey && !e.metaKey) {
                resetView();
            }
            break;
        case 'z':
        case 'Z':
            if (e.ctrlKey || e.metaKey) {
                if (e.shiftKey) {
                    redo();
                } else {
                    undo();
                }
            }
            break;
    }
}

function handleKeyUp(e) {
    // Handle key release if needed
}

// Professional UI control functions
function toggleRecording() {
    const btn = document.getElementById('btnStartStop');
    const icon = btn?.querySelector('.codicon');
    if (!btn || !icon) return;

    const isPlaying = icon.classList.contains('codicon-debug-start');

    if (isPlaying) {
        icon.classList.remove('codicon-debug-start');
        icon.classList.add('codicon-debug-pause');
        btn.title = 'Pause Recording';
        btn.setAttribute('aria-label', 'Pause recording');
        appState.isRecording = true;
        sendMessageToExtension('startRecording');
    } else {
        icon.classList.remove('codicon-debug-pause');
        icon.classList.add('codicon-debug-start');
        btn.title = 'Start Recording';
        btn.setAttribute('aria-label', 'Start recording');
        appState.isRecording = false;
        sendMessageToExtension('stopRecording');
    }
    saveState();
}

function zoomIn() {
    interactionState.zoomLevel = Math.min(10, interactionState.zoomLevel * 1.2);
    updateStatusDisplay();
    drawWaveform();
}

function zoomOut() {
    interactionState.zoomLevel = Math.max(0.1, interactionState.zoomLevel / 1.2);
    updateStatusDisplay();
    drawWaveform();
}

function autoFit() {
    // Auto-fit all visible data
    interactionState.zoomLevel = 1.0;
    interactionState.panOffset = { x: 0, y: 0 };
    updateStatusDisplay();
    drawWaveform();
}

function resetView() {
    interactionState.zoomLevel = 1.0;
    interactionState.panOffset = { x: 0, y: 0 };
    updateStatusDisplay();
    drawWaveform();
}

function toggleMeasureMode() {
    interactionState.measureMode = !interactionState.measureMode;
    const btn = document.getElementById('btnMeasure');
    btn.classList.toggle('active', interactionState.measureMode);

    if (!interactionState.measureMode) {
        interactionState.isMeasuring = false;
        hideMeasurementDisplay();
    }

    canvas.style.cursor = interactionState.measureMode ? 'crosshair' : 'default';
}

function toggleGrid() {
    const btn = document.getElementById('btnGrid');
    btn.classList.toggle('active');
    drawWaveform();
}

function toggleLegend() {
    const btn = document.getElementById('btnLegend');
    btn.classList.toggle('active');
    const legend = document.getElementById('legend');
    legend.style.display = legend.style.display === 'none' ? 'block' : 'none';
}

function toggleFFTPanel() {
    const panel = document.getElementById('fftPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';

    if (panel.style.display === 'block') {
        // Perform FFT on first enabled variable
        const enabledVar = variables.find((v) => v.enabled);
        if (enabledVar) {
            performFFT(enabledVar.id);
        }
    }
}

// Professional measurement and display functions
function updateCrosshair(x, y) {
    if (!crosshair) return;

    const h = crosshair.querySelector('.crosshair-h');
    const v = crosshair.querySelector('.crosshair-v');

    h.style.top = y + 'px';
    h.style.width = canvas.width + 'px';

    v.style.left = x + 'px';
    v.style.height = canvas.height + 'px';

    crosshair.style.display = 'block';
}

function hideCrosshair() {
    if (crosshair) {
        crosshair.style.display = 'none';
    }
}

function updateCoordinateDisplay(x, y) {
    if (!coordinateDisplay) return;

    const coords = pixelToDataCoords(x, y);
    coordinateDisplay.innerHTML = 'X: ' + coords.x.toFixed(3) + 's<br>Y: ' + coords.y.toFixed(3);
    coordinateDisplay.style.left = (x + 10) + 'px';
    coordinateDisplay.style.top = (y - 30) + 'px';
    coordinateDisplay.style.display = 'block';

    // Enhanced status bar update with variable context
    document.getElementById('statusX').textContent = coords.x.toFixed(3);
    document.getElementById('statusY').textContent = coords.y.toFixed(3);

    // Find closest variable at this position
    const closestVar = findClosestVariable(coords.x, coords.y);
    if (closestVar) {
        updateStatusBarWithVariable(closestVar, coords);
    }
}

function findClosestVariable(timeValue, yValue) {
    let closest = null;
    let minDist = Infinity;

    const enabledVars = variables.filter((v) => v.enabled);
    for (const variable of enabledVars) {
        const points = data[variable.id];
        if (!points || points.length === 0) continue;

        // Find point closest to timeValue
        const targetTime = Date.now() - (settings.timeSpan * 1000) + (timeValue * settings.timeSpan * 1000);
        const point = points.reduce((prev, curr) => {
            return Math.abs(curr.timestamp - targetTime) < Math.abs(prev.timestamp - targetTime) ? curr : prev;
        });

        if (point) {
            // Calculate distance (normalized)
            const timeDist = Math.abs(point.timestamp - targetTime) / (settings.timeSpan * 1000);
            const dist = timeDist; // Could add Y distance if needed

            if (dist < minDist && dist < 0.05) { // Within 5% of time range
                minDist = dist;
                closest = { variable, point };
            }
        }
    }

    return closest;
}

function updateStatusBarWithVariable(varInfo, coords) {
    const statusRange = document.getElementById('statusRange');
    if (statusRange && varInfo) {
        const displayType = varInfo.variable.displayType || 'analog';
        const value = varInfo.point.value;
        let formattedValue;

        switch (displayType) {
            case 'bit':
                formattedValue = value >= (varInfo.variable.threshold || 0.5) ? '1' : '0';
                break;
            case 'hex':
                formattedValue = '0x' + Math.floor(value).toString(16).toUpperCase();
                break;
            case 'binary':
                formattedValue = '0b' + Math.floor(value).toString(2);
                break;
            default:
                formattedValue = value.toFixed(3);
        }

        statusRange.textContent = varInfo.variable.name + ': ' + formattedValue;
    }
}

function updateSelectionRect() {
    if (!selectionRect || !interactionState.isSelecting) return;

    const left = Math.min(interactionState.selectionStart.x, interactionState.selectionEnd.x);
    const top = Math.min(interactionState.selectionStart.y, interactionState.selectionEnd.y);
    const width = Math.abs(interactionState.selectionEnd.x - interactionState.selectionStart.x);
    const height = Math.abs(interactionState.selectionEnd.y - interactionState.selectionStart.y);

    selectionRect.style.left = left + 'px';
    selectionRect.style.top = top + 'px';
    selectionRect.style.width = width + 'px';
    selectionRect.style.height = height + 'px';
    selectionRect.style.display = 'block';
}

function hideSelectionRect() {
    if (selectionRect) {
        selectionRect.style.display = 'none';
    }
}

function updateMeasurementDisplay() {
    if (!interactionState.isMeasuring) return;

    const startCoords = pixelToDataCoords(interactionState.measureStart.x, interactionState.measureStart.y);
    const endCoords = pixelToDataCoords(interactionState.measureEnd.x, interactionState.measureEnd.y);

    const deltaX = endCoords.x - startCoords.x;
    const deltaY = endCoords.y - startCoords.y;

    // Update status bar with measurements
    document.getElementById('statusDX').textContent = deltaX.toFixed(3);
    document.getElementById('statusDY').textContent = deltaY.toFixed(3);
}

function hideMeasurementDisplay() {
    document.getElementById('statusDX').textContent = '--';
    document.getElementById('statusDY').textContent = '--';
}

function showMeasurementResults() {
    const startCoords = pixelToDataCoords(interactionState.measureStart.x, interactionState.measureStart.y);
    const endCoords = pixelToDataCoords(interactionState.measureEnd.x, interactionState.measureEnd.y);

    const deltaX = endCoords.x - startCoords.x;
    const deltaY = endCoords.y - startCoords.y;
    const slope = deltaY / deltaX;

    const message = 'Measurement Results:\n'
        + 'Time: ' + deltaX.toFixed(3) + 's\n'
        + 'Amplitude: ' + deltaY.toFixed(3) + '\n'
        + 'Slope: ' + slope.toFixed(3);

    alert(message);
}

function updateTooltip(x, y, clientX, clientY) {
    // Find nearest data point
    const coords = pixelToDataCoords(x, y);
    let nearestPoint = null;
    let minDistance = Infinity;

    variables.filter((v) => v.enabled).forEach((variable) => {
        const points = data[variable.id];
        if (points && points.length > 0) {
            points.forEach((point) => {
                const pointCoords = dataToPixelCoords(point.timestamp, point.value);
                const distance = Math.sqrt(Math.pow(x - pointCoords.x, 2) + Math.pow(y - pointCoords.y, 2));

                if (distance < minDistance && distance < 10) {
                    minDistance = distance;
                    nearestPoint = { variable, point, coords: pointCoords };
                }
            });
        }
    });

    if (nearestPoint) {
        tooltip.innerHTML = nearestPoint.variable.name + '<br>'
        + 'Time: ' + (nearestPoint.point.timestamp / 1000).toFixed(3) + 's<br>'
        + 'Value: ' + nearestPoint.point.value.toFixed(3);
        tooltip.style.left = clientX + 10 + 'px';
        tooltip.style.top = clientY - 30 + 'px';
        tooltip.style.display = 'block';
    } else {
        hideTooltip();
    }
}

function hideTooltip() {
    tooltip.style.display = 'none';
}

function showContextMenu(x, y, clientX, clientY) {
    // Remove existing context menu
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = clientX + 'px';
    menu.style.top = clientY + 'px';

    const coords = pixelToDataCoords(x, y);

    let menuHTML = '';
    menuHTML += '<div class="context-menu-item" onclick="zoomIn()">Zoom In</div>';
    menuHTML += '<div class="context-menu-item" onclick="zoomOut()">Zoom Out</div>';
    menuHTML += '<div class="context-menu-item" onclick="autoFit()">Auto Fit</div>';
    menuHTML += '<div class="context-menu-separator"></div>';
    menuHTML += '<div class="context-menu-item" onclick="exportData(' + '\'json\'' + ')">Export JSON</div>';
    menuHTML += '<div class="context-menu-item" onclick="exportData(' + '\'csv\'' + ')">Export CSV</div>';
    menuHTML += '<div class="context-menu-separator"></div>';
    menuHTML += '<div class="context-menu-item" onclick="toggleMeasureMode()">Measure Mode</div>';
    menuHTML += '<div class="context-menu-item" onclick="toggleGrid()">Toggle Grid</div>';

    // Add variable-specific options
    variables.filter((v) => v.enabled).forEach((variable) => {
        menuHTML += '<div class="context-menu-separator"></div>';
        menuHTML += `<div class="context-menu-item" onclick="performFFT('${variable.id}')">FFT: ${variable.name}</div>`;
    });

    menu.innerHTML = menuHTML;
    document.body.appendChild(menu);

    // Close menu when clicking elsewhere
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
}

// Professional data conversion functions
function pixelToDataCoords(x, y) {
    const padding = 40;
    const chartWidth = canvas.width - 2 * padding;
    const chartHeight = canvas.height - 2 * padding;

    // Apply zoom and pan
    const adjustedX = (x - interactionState.panOffset.x) / interactionState.zoomLevel;
    const adjustedY = (y - interactionState.panOffset.y) / interactionState.zoomLevel;

    // Convert to data coordinates
    const now = Date.now();
    const startTime = now - (settings.timeSpan * 1000);

    const dataX = startTime + ((adjustedX - padding) / chartWidth) * (settings.timeSpan * 1000);
    const dataY = settings.yMax - ((adjustedY - padding) / chartHeight) * (settings.yMax - settings.yMin);

    return { x: dataX / 1000, y: dataY }; // Return time in seconds
}

function dataToPixelCoords(timestamp, value) {
    const padding = 40;
    const chartWidth = canvas.width - 2 * padding;
    const chartHeight = canvas.height - 2 * padding;

    const now = Date.now();
    const startTime = now - (settings.timeSpan * 1000);

    const x = padding + ((timestamp - startTime) / (settings.timeSpan * 1000)) * chartWidth;
    const y = padding + (1 - (value - settings.yMin) / (settings.yMax - settings.yMin)) * chartHeight;

    // Apply zoom and pan
    return {
        x: x * interactionState.zoomLevel + interactionState.panOffset.x,
        y: y * interactionState.zoomLevel + interactionState.panOffset.y
    };
}

// Professional navigation functions
function zoomToSelection() {
    const left = Math.min(interactionState.selectionStart.x, interactionState.selectionEnd.x);
    const top = Math.min(interactionState.selectionStart.y, interactionState.selectionEnd.y);
    const width = Math.abs(interactionState.selectionEnd.x - interactionState.selectionStart.x);
    const height = Math.abs(interactionState.selectionEnd.y - interactionState.selectionStart.y);

    if (width < 10 || height < 10) return;

    // Calculate zoom to fit selection
    const zoomX = canvas.width / width;
    const zoomY = canvas.height / height;
    interactionState.zoomLevel = Math.min(zoomX, zoomY, 5); // Limit max zoom

    // Center on selection
    interactionState.panOffset.x = canvas.width / 2 - (left + width / 2) * interactionState.zoomLevel;
    interactionState.panOffset.y = canvas.height / 2 - (top + height / 2) * interactionState.zoomLevel;

    updateStatusDisplay();
    saveToHistory();
    drawWaveform();
}

function saveToHistory() {
    const state = {
        zoomLevel: interactionState.zoomLevel,
        panOffset: { ...interactionState.panOffset }
    };

    // Remove states after current index
    interactionState.history = interactionState.history.slice(0, interactionState.historyIndex + 1);

    // Add new state
    interactionState.history.push(state);
    interactionState.historyIndex++;

    // Limit history size
    if (interactionState.history.length > 50) {
        interactionState.history.shift();
        interactionState.historyIndex--;
    }
}

function undo() {
    if (interactionState.historyIndex > 0) {
        interactionState.historyIndex--;
        const state = interactionState.history[interactionState.historyIndex];
        interactionState.zoomLevel = state.zoomLevel;
        interactionState.panOffset = { ...state.panOffset };
        updateStatusDisplay();
        drawWaveform();
    }
}

function redo() {
    if (interactionState.historyIndex < interactionState.history.length - 1) {
        interactionState.historyIndex++;
        const state = interactionState.history[interactionState.historyIndex];
        interactionState.zoomLevel = state.zoomLevel;
        interactionState.panOffset = { ...state.panOffset };
        updateStatusDisplay();
        drawWaveform();
    }
}

function updateStatusDisplay() {
    document.getElementById('statusZoom').textContent = interactionState.zoomLevel.toFixed(1) + 'x';
    document.getElementById('statusRange').textContent = (settings.timeSpan / interactionState.zoomLevel).toFixed(1) + 's';
}

function hideAllPanels() {
    document.getElementById('settingsPanel').style.display = 'none';
    document.getElementById('fftPanel').style.display = 'none';
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }
}

// Bi-directional communication functions
function highlightVariableInChart(expression) {
    // Find the variable and highlight it in the chart
    const variable = variables.find((v) => v.expression === expression || v.id === expression);
    if (variable) {
        // Flash the legend item
        const legendItems = document.querySelectorAll('.legend-item');
        legendItems.forEach((item) => {
            if (item.textContent.includes(variable.name)) {
                item.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
                item.style.color = 'var(--vscode-list-activeSelectionForeground)';

                setTimeout(() => {
                    item.style.backgroundColor = '';
                    item.style.color = '';
                }, 2000);
            }
        });

        // Show a tooltip notification
        showNotification('Highlighting: ' + variable.name, 'info');
    }
}

function toggleVariableInChart(expression, enabled) {
    const variable = variables.find((v) => v.expression === expression || v.id === expression);
    if (variable) {
        variable.enabled = enabled;
        updateVariableList();
        updateLegend();
        drawWaveform();

        showNotification(variable.name + ' ' + (enabled ? 'enabled' : 'disabled'), 'info');
    }
}

function updateVariableStyleInChart(expression, style) {
    const variable = variables.find((v) => v.expression === expression || v.id === expression);
    if (variable && style) {
        Object.assign(variable, style);
        updateLegend();
        drawWaveform();

        showNotification('Updated style for: ' + variable.name, 'info');
    }
}

// Canvas variable selection with highlighting
function selectVariableOnCanvas(variableId) {
    // Update appState selection
    appState.selectedVariable = variableId;

    // Update sidebar variable list to reflect selection
    updateVariableList();

    // Update legend to highlight selected variable
    updateLegend();

    // Redraw waveform with highlighting
    drawWaveform();

    // Find variable and show notification
    const variable = variables.find((v) => v.id === variableId);
    if (variable) {
        showNotification('Selected: ' + variable.name, 'info');

        // Scroll variable into view in sidebar if not visible
        const variableList = document.getElementById('variableList');
        const variableItem = variableList?.querySelector('[data-variable-id="' + variableId + '"]');
        if (variableItem) {
            variableItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    const colors = {
        info: 'var(--vscode-notifications-background)',
        success: 'var(--vscode-testing-iconPassed)',
        warning: 'var(--vscode-testing-iconSkipped)',
        error: 'var(--vscode-testing-iconFailed)'
    };

    const styles = [
        'position: fixed',
        'top: 10px',
        'right: 10px',
        'background-color: var(--vscode-notifications-background)',
        'color: var(--vscode-notifications-foreground)',
        'border: 1px solid var(--vscode-notifications-border)',
        'border-radius: 4px',
        'padding: 8px 12px',
        'font-size: 12px',
        'font-family: var(--vscode-font-family)',
        'z-index: 10000',
        'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2)',
        'animation: slideIn 0.3s ease-out'
    ];

    notification.style.cssText = styles.join(';');
    notification.textContent = message;
    document.body.appendChild(notification);

    // Auto remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-in';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Add CSS animations for notifications
const styleSheet = document.createElement('style');
const keyframesSlideIn = '@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } '
                         + 'to { transform: translateX(0); opacity: 1; } }';
const keyframesSlideOut = '@keyframes slideOut { from { transform: translateX(0); opacity: 1; } '
                           + 'to { transform: translateX(100%); opacity: 0; } }';
styleSheet.textContent = keyframesSlideIn + ' ' + keyframesSlideOut;
document.head.appendChild(styleSheet);

// Memory management and cleanup
let memoryCleanupInterval = setInterval(() => {
    performMemoryCleanup();
}, 30000); // Cleanup every 30 seconds

function performMemoryCleanup() {
    // Clean up old data points
    const now = Date.now();
    const maxAge = settings.timeSpan * 1000 * 2; // Keep 2x time span of data

    let totalPoints = 0;
    let removedPoints = 0;

    Object.keys(data).forEach((variableId) => {
        const points = data[variableId];
        if (points && points.length > 0) {
            const originalLength = points.length;

            // Remove old points
            const filteredPoints = points.filter((point) =>
                (now - point.timestamp) < maxAge
            );

            data[variableId] = filteredPoints;
            removedPoints += originalLength - filteredPoints.length;
            totalPoints += filteredPoints.length;
        }
    });

    // Force garbage collection hints
    if (removedPoints > 1000) {
        console.log('Memory cleanup: removed ' + removedPoints + ' old data points, kept ' + totalPoints);

        // Suggest garbage collection to browser
        if (window.gc) {
            window.gc();
        }
    }

    // Clean up performance stats if too many entries
    if (performanceStats.frameCount > 10000) {
        performanceStats = {
            frameCount: performanceStats.frameCount % 1000,
            totalTime: performanceStats.totalTime % 1000,
            maxFrameTime: performanceStats.maxFrameTime,
            minFrameTime: performanceStats.minFrameTime,
            lastStatsUpdate: performanceStats.lastStatsUpdate
        };
    }
}

// Performance monitoring for VSCode
let vscodePerformanceReport = {
    lastReport: Date.now(),
    frameCount: 0,
    renderTime: 0
};

function reportVSCodePerformance() {
    const now = Date.now();
    const timeSinceLastReport = now - vscodePerformanceReport.lastReport;

    if (timeSinceLastReport >= 60000) { // Report every minute
        const avgFPS = vscodePerformanceReport.frameCount / (timeSinceLastReport / 1000);
        const avgRenderTime = vscodePerformanceReport.renderTime / vscodePerformanceReport.frameCount;

        // Send performance data to extension
        sendMessageToExtension('performanceReport', {
            avgFPS: avgFPS.toFixed(1),
            avgRenderTime: avgRenderTime.toFixed(2),
            frameCount: vscodePerformanceReport.frameCount,
            memoryUsage: getMemoryUsage()
        });

        // Reset counters
        vscodePerformanceReport = {
            lastReport: now,
            frameCount: 0,
            renderTime: 0
        };
    }
}

function getMemoryUsage() {
    if (performance.memory) {
        return {
            used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024), // MB
            total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024), // MB
            limit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) // MB
        };
    }
    return null;
}

// Enhanced resize handler with performance optimization
let resizeTimeout;
function handleResize() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        const container = canvas.parentElement;
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;

        // Trigger re-render after resize
        drawWaveform();

        // Report new dimensions to extension
        sendMessageToExtension('canvasResized', {
            width: canvas.width,
            height: canvas.height
        });
    }, 100); // Debounce resize events
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopOptimizedRendering();
    clearInterval(memoryCleanupInterval);
    saveState();
});

// Handle messages from extension with improved error handling
window.addEventListener('message', (event) => {
    try {
        const message = event.data;
        if (!message) {
            console.warn('[Waveform Client] Received empty message');
            return;
        }

        console.log('[Waveform Client] Received message:', message.command || message.type,
            message.data ? JSON.stringify(message.data).substring(0, 100) + '...' : '');

        // Handle both command and type fields for compatibility
        const messageType = message.command || message.type;

        switch (messageType) {
            case 'connectionStatus':
                handleConnectionStatus(message);
                break;
            case 'dataUpdate':
                handleDataUpdate(message);
                break;
            case 'fftResult':
                handleFFTResult(message);
                break;
            case 'variableDataResponse':
                handleVariableDataResponse(message);
                break;
            case 'highlightVariable':
                handleHighlightVariable(message);
                break;
            case 'toggleVariable':
                handleVariableToggle(message);
                break;
            case 'variableStyleUpdate':
                handleVariableStyleUpdate(message);
                break;
            case 'chartSettingsUpdate':
                handleChartSettingsUpdate(message);
                break;
            case 'structMembersUpdate':
                handleStructMembersUpdate(message);
                break;
            case 'structMemberSelectionUpdate':
                handleStructMemberSelectionUpdate(message);
                break;
            case 'error':
                handleError(message);
                break;
            default:
                console.warn('[Waveform Client] Unknown message type:', messageType);
        }
    } catch (error) {
        console.error('[Waveform Client] Error handling message from extension:', error);
        showError('Communication error: ' + error.message);
    }
});

function handleConnectionStatus(message) {
    if (!message.data) return;

    const connected = message.data.connected;
    appState.connectionStatus = connected ? 'connected' : 'disconnected';
    updateConnectionStatus();
    console.log(`[Waveform Client] Connection status updated:`, appState.connectionStatus);
}

function handleDataUpdate(message) {
    if (!message.data) return;

    console.log('[Waveform Client] Received data update:', {
        variables: message.variables?.length || 0,
        dataKeys: Object.keys(message.data || {}),
        settings: message.settings
    });

    const now = Date.now();
    const timeSinceLastUpdate = now - appState.lastUpdateTime;

    // Update state
    appState.variables = message.variables || [];
    appState.data = message.data || {};
    appState.lastUpdateTime = now;

    // Update local variables for compatibility
    variables = appState.variables;
    data = appState.data;

    if (message.settings) {
        appState.settings = { ...appState.settings, ...message.settings };
        Object.assign(settings, appState.settings);
        saveState();
    }

    // Update UI
    updateVariableList();
    updateLegend();
    drawWaveform();

    // Update status
    appState.connectionStatus = 'connected';
    updateConnectionStatus();
}

function handleHighlightVariable(message) {
    if (message.data && message.data.expression) {
        highlightVariableInChart(message.data.expression);
    }
}

function handleVariableToggle(message) {
    if (message.data && message.data.expression) {
        toggleVariableInChart(message.data.expression, message.data.enabled);
    }
}

function handleVariableStyleUpdate(message) {
    if (message.data && message.data.expression) {
        updateVariableStyleInChart(message.data.expression, message.data.style);
    }
}

function handleChartSettingsUpdate(message) {
    if (message.data) {
        Object.assign(settings, message.data);
        appState.settings = { ...appState.settings, ...message.data };
        saveState();
        drawWaveform();
    }
}

function handleFFTResult(message) {
    if (message.result) {
        displayFFTResults(message.result);
    }
}

function handleVariableDataResponse(message) {
    if (message.data && message.data.variableId) {
        // Handle specific variable data response
        console.log('Received data for variable:', message.data.variableId);
    }
}

function handleError(message) {
    console.error('Extension error:', message.error);
    showError(message.error || 'An unknown error occurred');
    appState.connectionStatus = 'error';
    updateConnectionStatus();
}

function updateConnectionStatus() {
    const statusElement = document.getElementById('connectionStatus');
    if (statusElement) {
        statusElement.textContent = appState.connectionStatus;
        statusElement.className = 'status-value ' + appState.connectionStatus;
    }
}

function sendMessageToExtension(command, data = {}) {
    const message = {
        command: command,
        timestamp: Date.now(),
        ...data
    };

    try {
        vscode.postMessage(message);
    } catch (error) {
        console.error('Error sending message to extension:', error);
        showError('Communication error: ' + error.message);
    }
}

// ==================== UI State ====================
const uiState = {
    collapsedGroups: new Set(),
    activeFilters: new Set(),
    searchText: '',
    searchMode: 'text', // 'text' or 'regex'
    caseSensitive: false,
    draggedVariableId: null,
    customOrder: [] // Array of variable IDs in custom order
};

// Reorder variable in custom order
function reorderVariable(draggedId, targetId, insertBefore) {
    // Find indices
    const draggedVariable = variables.find((v) => v.id === draggedId);
    const targetVariable = variables.find((v) => v.id === targetId);

    if (!draggedVariable || !targetVariable) return;

    // Only reorder within same group
    if (draggedVariable.group !== targetVariable.group) {
        showNotification('Cannot reorder across groups', 'warning');
        return;
    }

    // Initialize custom order if empty
    if (uiState.customOrder.length === 0) {
        uiState.customOrder = variables.map((v) => v.id);
    }

    // Remove dragged item from current position
    const draggedIndex = uiState.customOrder.indexOf(draggedId);
    if (draggedIndex !== -1) {
        uiState.customOrder.splice(draggedIndex, 1);
    }

    // Find new position
    let targetIndex = uiState.customOrder.indexOf(targetId);
    if (targetIndex === -1) {
        targetIndex = uiState.customOrder.length;
    }

    // Insert at new position
    if (insertBefore) {
        uiState.customOrder.splice(targetIndex, 0, draggedId);
    } else {
        uiState.customOrder.splice(targetIndex + 1, 0, draggedId);
    }

    // Save state
    saveState();

    // Update UI
    updateVariableList();

    showNotification('Variable reordered', 'info');
}

// Apply custom ordering to variable array
function applyCustomOrder(vars) {
    if (uiState.customOrder.length === 0) {
        return vars; // No custom order, return as-is
    }

    // Create ordered array based on customOrder
    const ordered = [];
    const unordered = [];

    // First, add variables in custom order
    for (const id of uiState.customOrder) {
        const variable = vars.find((v) => v.id === id);
        if (variable) {
            ordered.push(variable);
        }
    }

    // Then add any variables not in custom order (newly added)
    for (const variable of vars) {
        if (!uiState.customOrder.includes(variable.id)) {
            unordered.push(variable);
        }
    }

    return [...ordered, ...unordered];
}

function updateVariableList() {
    const list = document.getElementById('variableList');
    if (!list) return;
    list.innerHTML = '';

    // Apply filters
    const filteredVars = filterVariables();

    // Group variables
    const grouped = groupVariables(filteredVars);

    // Apply custom ordering to each group
    if (grouped.ungrouped.length > 0) {
        const orderedUngrouped = applyCustomOrder(grouped.ungrouped);
        renderVariableGroup('Ungrouped', orderedUngrouped, list);
    }

    Object.keys(grouped.groups).sort().forEach((groupName) => {
        const orderedGroup = applyCustomOrder(grouped.groups[groupName]);
        renderVariableGroup(groupName, orderedGroup, list);
    });
}

function filterVariables() {
    // Remove any existing error message
    const existingError = document.querySelector('.filter-error');
    if (existingError) {
        existingError.remove();
    }

    let searchRegex = null;
    if (uiState.searchText && uiState.searchMode === 'regex') {
        try {
            const flags = uiState.caseSensitive ? '' : 'i';
            searchRegex = new RegExp(uiState.searchText, flags);
        } catch (error) {
            // Invalid regex - show error and fall back to text search
            const filterContainer = document.querySelector('.filter-container');
            if (filterContainer) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'filter-error';
                errorDiv.textContent = '⚠ Invalid regex: ' + error.message;
                filterContainer.appendChild(errorDiv);
            }
            // Fall back to text search
            searchRegex = null;
        }
    }

    return variables.filter((variable) => {
        // Search text filter
        if (uiState.searchText) {
            if (searchRegex) {
                // Regex mode
                if (!searchRegex.test(variable.name)) {
                    return false;
                }
            } else {
                // Text mode
                const varName = uiState.caseSensitive ? variable.name : variable.name.toLowerCase();
                const searchText = uiState.caseSensitive ? uiState.searchText : uiState.searchText.toLowerCase();
                if (!varName.includes(searchText)) {
                    return false;
                }
            }
        }

        // Type filters
        if (uiState.activeFilters.size > 0) {
            const displayType = variable.displayType || 'analog';

            if (uiState.activeFilters.has('trigger')) {
                if (!variable.trigger || !variable.trigger.enabled) {
                    return false;
                }
            } else {
                // Check if any type filter matches
                const hasTypeFilter = Array.from(uiState.activeFilters).some((f) => ['analog', 'bit', 'state', 'hex', 'binary'].includes(f));
                if (hasTypeFilter && !uiState.activeFilters.has(displayType)) {
                    return false;
                }
            }
        }

        return true;
    });
}

function groupVariables(vars) {
    const result = {
        ungrouped: [],
        groups: {}
    };

    vars.forEach((variable) => {
        if (variable.group) {
            if (!result.groups[variable.group]) {
                result.groups[variable.group] = [];
            }
            result.groups[variable.group].push(variable);
        } else {
            result.ungrouped.push(variable);
        }
    });

    return result;
}

// Group-level operations
function toggleGroupVariables(groupName, enabled) {
    const groupVars = variables.filter((v) => v.group === groupName);
    groupVars.forEach((variable) => {
        variable.enabled = enabled;
        vscode.postMessage({
            command: 'toggleVariable',
            variableId: variable.id,
            enabled: enabled
        });
    });
    updateVariableList();
    updateLegend();
    drawWaveform();
    showNotification(
        'Group "' + groupName + '" ' + (enabled ? 'enabled' : 'disabled'),
        'info'
    );
}

function selectAllInGroup(groupName) {
    const groupVars = variables.filter((v) => v.group === groupName);
    if (groupVars.length === 0) return;

    // Toggle: if all enabled, disable all; otherwise enable all
    const allEnabled = groupVars.every((v) => v.enabled);
    toggleGroupVariables(groupName, !allEnabled);
}

function exportGroupData(groupName) {
    const groupVars = variables.filter((v) => v.group === groupName);
    if (groupVars.length === 0) {
        showNotification('Group is empty', 'warning');
        return;
    }

    // Collect data for all variables in group
    const groupData = {};
    groupVars.forEach((variable) => {
        if (data[variable.id]) {
            groupData[variable.name] = data[variable.id];
        }
    });

    // Create export dialog
    const format = confirm('Export as JSON? (Cancel for CSV)') ? 'json' : 'csv';
    sendMessageToExtension('exportData', {
        format: format,
        variables: groupVars.map((v) => v.id),
        groupName: groupName
    });

    showNotification('Exporting group "' + groupName + '"...', 'info');
}

function showGroupContextMenu(groupName, vars, x, y) {
    hideContextMenu();

    const menu = document.createElement('div');
    menu.className = 'variable-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const allEnabled = vars.every((v) => v.enabled);
    const someEnabled = vars.some((v) => v.enabled);

    const menuItems = [
        {
            icon: someEnabled ? 'circle-slash' : 'check-all',
            label: allEnabled ? 'Disable All' : 'Enable All',
            action: () => toggleGroupVariables(groupName, !allEnabled)
        },
        { separator: true },
        {
            icon: 'export',
            label: 'Export Group Data...',
            action: () => exportGroupData(groupName)
        },
        {
            icon: 'symbol-color',
            label: 'Set Group Color...',
            action: () => {
                // Future: implement group color picker
                showNotification('Group color picker coming soon', 'info');
            }
        },
        { separator: true },
        {
            icon: 'edit',
            label: 'Rename Group...',
            action: () => {
                const newName = prompt('Enter new group name:', groupName);
                if (newName && newName !== groupName) {
                    vars.forEach((v) => {
                        v.group = newName;
                    });
                    updateVariableList();
                    showNotification('Group renamed to "' + newName + '"', 'info');
                }
            }
        },
        {
            icon: 'trash',
            label: 'Remove All from Waveform',
            action: () => {
                if (confirm('Remove all ' + vars.length + ' variables from "' + groupName + '" group?')) {
                    vars.forEach((v) => {
                        vscode.postMessage({
                            command: 'removeVariable',
                            variableId: v.id
                        });
                    });
                    showNotification('Group removed', 'info');
                }
            }
        }
    ];

    menuItems.forEach((item) => {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);
        } else {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';

            const icon = document.createElement('i');
            icon.className = 'codicon codicon-' + item.icon;
            menuItem.appendChild(icon);

            const label = document.createElement('span');
            label.textContent = item.label;
            menuItem.appendChild(label);

            menuItem.addEventListener('click', () => {
                item.action();
                hideContextMenu();
            });

            menu.appendChild(menuItem);
        }
    });

    document.body.appendChild(menu);
    activeContextMenu = menu;

    setTimeout(() => {
        document.addEventListener('click', hideContextMenu, { once: true });
        document.addEventListener('contextmenu', hideContextMenu, { once: true });
    }, 10);

    // Adjust position if off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (x - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (y - rect.height) + 'px';
    }
}

function renderVariableGroup(groupName, vars, container) {
    if (vars.length === 0) return;

    const isCollapsed = uiState.collapsedGroups.has(groupName);

    // Create group header
    const groupHeader = document.createElement('div');
    groupHeader.className = 'group-header' + (isCollapsed ? ' collapsed' : '');
    groupHeader.setAttribute('role', 'button');
    groupHeader.setAttribute('aria-expanded', !isCollapsed);

    const chevron = document.createElement('i');
    chevron.className = 'codicon codicon-chevron-down group-chevron';
    groupHeader.appendChild(chevron);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = groupName;
    groupHeader.appendChild(nameSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'group-count';
    countSpan.textContent = vars.length;
    groupHeader.appendChild(countSpan);

    // Group action buttons
    const groupActions = document.createElement('div');
    groupActions.className = 'group-actions';

    const allEnabled = vars.every((v) => v.enabled);

    // Toggle all button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'group-action-btn';
    toggleBtn.title = allEnabled ? 'Disable all in group' : 'Enable all in group';
    const toggleIcon = document.createElement('i');
    toggleIcon.className = 'codicon codicon-' + (allEnabled ? 'circle-slash' : 'check-all');
    toggleBtn.appendChild(toggleIcon);
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectAllInGroup(groupName);
    });
    groupActions.appendChild(toggleBtn);

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'group-action-btn';
    exportBtn.title = 'Export group data';
    const exportIcon = document.createElement('i');
    exportIcon.className = 'codicon codicon-export';
    exportBtn.appendChild(exportIcon);
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportGroupData(groupName);
    });
    groupActions.appendChild(exportBtn);

    groupHeader.appendChild(groupActions);

    // Click to expand/collapse
    groupHeader.addEventListener('click', (e) => {
        // Don't toggle if clicking on action buttons
        if (e.target.closest('.group-actions')) {
            return;
        }

        if (uiState.collapsedGroups.has(groupName)) {
            uiState.collapsedGroups.delete(groupName);
        } else {
            uiState.collapsedGroups.add(groupName);
        }
        updateVariableList();
        saveState();
    });

    // Right-click for group context menu
    groupHeader.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showGroupContextMenu(groupName, vars, e.clientX, e.clientY);
    });

    container.appendChild(groupHeader);

    // Create group items container
    const groupItems = document.createElement('div');
    groupItems.className = 'group-items' + (isCollapsed ? ' collapsed' : '');

    // Calculate max-height for smooth animation
    const itemHeight = 22; // approximate height per item
    const metadataHeight = 16; // approximate height for metadata
    const totalHeight = vars.reduce((acc, v) => {
        return acc + itemHeight + ((v.samplingRate || v.group) ? metadataHeight : 0);
    }, 0);
    groupItems.style.maxHeight = isCollapsed ? '0' : totalHeight + 'px';

    vars.forEach((variable) => {
        const item = createVariableItem(variable, true);
        groupItems.appendChild(item);
    });

    container.appendChild(groupItems);
}

function createVariableItem(variable, isGrouped = false) {
    const item = document.createElement('div');

    // Check if this is a struct variable
    const isStruct = variable.isStruct || (variable.expression && variable.expression.includes('.'));

    item.className = 'variable-item ' + (variable.enabled ? '' : 'disabled') + (isStruct ? ' struct' : '');

    if (isGrouped) {
        item.classList.add('group-item');
    }

    // Add selection and trigger classes
    if (appState.selectedVariable === variable.id) {
        item.classList.add('selected');
    }
    if (variable.trigger && variable.trigger.enabled) {
        item.classList.add('has-trigger');
    }

    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('data-variable-id', variable.id);

    // Enable drag-and-drop for reordering
    item.setAttribute('draggable', 'true');

    // Drag start handler
    item.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', variable.id);
        item.classList.add('dragging');
        uiState.draggedVariableId = variable.id;
    });

    // Drag end handler
    item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        uiState.draggedVariableId = null;
        // Remove all drop indicators
        document.querySelectorAll('.variable-item').forEach((el) => {
            el.classList.remove('drop-before', 'drop-after');
        });
    });

    // Drag over handler (for drop target)
    item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!e.dataTransfer || !uiState.draggedVariableId) return;
        if (uiState.draggedVariableId === variable.id) return;

        e.dataTransfer.dropEffect = 'move';

        // Determine drop position (before or after)
        const rect = item.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const dropBefore = e.clientY < midpoint;

        // Remove previous indicators
        document.querySelectorAll('.variable-item').forEach((el) => {
            el.classList.remove('drop-before', 'drop-after');
        });

        // Add indicator
        if (dropBefore) {
            item.classList.add('drop-before');
        } else {
            item.classList.add('drop-after');
        }
    });

    // Drag leave handler
    item.addEventListener('dragleave', () => {
        item.classList.remove('drop-before', 'drop-after');
    });

    // Drop handler
    item.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!uiState.draggedVariableId || uiState.draggedVariableId === variable.id) return;

        // Determine drop position
        const rect = item.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const dropBefore = e.clientY < midpoint;

        // Perform reorder
        reorderVariable(uiState.draggedVariableId, variable.id, dropBefore);

        // Clear indicators
        item.classList.remove('drop-before', 'drop-after');
    });

    const ariaLabel = variable.name + ': '
                      + (variable.lastValue !== undefined ? variable.lastValue.toFixed(3) : 'No data')
                      + '. ' + (variable.enabled ? 'Enabled' : 'Disabled')
                      + '. Type: ' + (variable.displayType || 'analog');
    item.setAttribute('aria-label', ariaLabel);

    const colorIndicator = document.createElement('div');
    colorIndicator.className = 'color-indicator';
    colorIndicator.style.backgroundColor = variable.color;
    colorIndicator.setAttribute('aria-hidden', 'true');

    const info = document.createElement('div');
    info.className = 'variable-info';

    const nameContainer = document.createElement('div');
    nameContainer.style.display = 'flex';
    nameContainer.style.alignItems = 'center';
    nameContainer.style.flex = '1';
    nameContainer.style.minWidth = '0';

    // Add expand icon for struct variables
    if (isStruct && variable.structMembers && variable.structMembers.length > 0) {
        const expandIcon = document.createElement('i');
        expandIcon.className = 'codicon codicon-chevron-right expand-icon';
        expandIcon.title = 'Expand struct members';
        expandIcon.style.cursor = 'pointer';

        // Toggle expansion on click
        expandIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStructExpansion(variable.id, item);
        });

        nameContainer.appendChild(expandIcon);
    }

    const name = document.createElement('div');
    name.className = 'variable-name';
    name.textContent = variable.name;

    // Add DisplayType icon
    const typeIcon = document.createElement('i');
    typeIcon.className = 'codicon variable-type-icon';
    const displayType = variable.displayType || 'analog';
    const iconMap = {
        'analog': 'codicon-pulse',
        'bit': 'codicon-symbol-boolean',
        'state': 'codicon-symbol-enum',
        'hex': 'codicon-symbol-number',
        'binary': 'codicon-output',
        'struct': 'codicon-symbol-class'
    };
    typeIcon.classList.add(iconMap[displayType] || (isStruct ? 'codicon-symbol-class' : 'codicon-pulse'));
    typeIcon.title = displayType.charAt(0).toUpperCase() + displayType.slice(1);

    // Add trigger indicator if enabled
    if (variable.trigger && variable.trigger.enabled) {
        const triggerIcon = document.createElement('i');
        triggerIcon.className = 'codicon codicon-debug-breakpoint-conditional trigger-indicator variable-type-icon';
        triggerIcon.title = 'Trigger: ' + variable.trigger.type;
        nameContainer.appendChild(name);
        nameContainer.appendChild(typeIcon);
        nameContainer.appendChild(triggerIcon);
    } else {
        nameContainer.appendChild(name);
        nameContainer.appendChild(typeIcon);
    }

    const value = document.createElement('div');
    value.className = 'variable-value';

    // Format value based on displayType
    if (variable.lastValue !== undefined) {
        switch (displayType) {
            case 'bit':
                value.textContent = variable.lastValue >= (variable.threshold || 0.5) ? '1' : '0';
                break;
            case 'hex': {
                const hexVal = Math.floor(variable.lastValue);
                const hexStr = hexVal.toString(16).toUpperCase();
                const hexPad = Math.ceil((variable.bitWidth || 8) / 4);
                value.textContent = '0x' + hexStr.padStart(hexPad, '0');
                break;
            }
            case 'binary': {
                const binVal = Math.floor(variable.lastValue);
                const binStr = binVal.toString(2);
                value.textContent = '0b' + binStr.padStart(variable.bitWidth || 8, '0');
                break;
            }
            case 'state':
                value.textContent = Math.floor(variable.lastValue).toString();
                break;
            default:
                value.textContent = variable.lastValue.toFixed(3);
        }
    } else {
        value.textContent = 'No data';
    }

    info.appendChild(nameContainer);
    info.appendChild(value);

    item.appendChild(colorIndicator);
    item.appendChild(info);

    // Add struct members container if this is a struct
    if (isStruct && variable.structMembers && variable.structMembers.length > 0) {
        const structContainer = document.createElement('div');
        structContainer.className = 'struct-container';
        structContainer.id = `struct-members-${variable.id}`;
        structContainer.style.display = 'none'; // Initially collapsed

        // Create struct member items
        variable.structMembers.forEach((member) => {
            const memberItem = createStructMemberItem(member, variable);
            structContainer.appendChild(memberItem);
        });

        item.appendChild(structContainer);
    }

    // Add metadata row (sampling rate, data points, etc.) - but not in grouped view to save space
    if (!isGrouped && (variable.samplingRate || variable.group)) {
        const metadata = document.createElement('div');
        metadata.className = 'variable-metadata';

        if (variable.samplingRate && variable.samplingRate !== settings.refreshRate) {
            const samplingBadge = document.createElement('span');
            samplingBadge.className = 'metadata-badge';
            samplingBadge.textContent = variable.samplingRate + ' Hz';
            metadata.appendChild(samplingBadge);
        }

        if (variable.group) {
            const groupBadge = document.createElement('span');
            groupBadge.className = 'metadata-badge';
            groupBadge.innerHTML = '<i class="codicon codicon-folder"></i> ' + variable.group;
            metadata.appendChild(groupBadge);
        }

        item.appendChild(metadata);
    }

    // Click to toggle
    const toggleVariable = () => {
        variable.enabled = !variable.enabled;
        vscode.postMessage({
            command: 'toggleVariable',
            variableId: variable.id,
            enabled: variable.enabled
        });
        updateVariableList();
        updateLegend();
    };

    // Click to select/toggle
    item.addEventListener('click', (e) => {
        // Only toggle on simple click, not on context menu icon click
        if (!e.target.closest('.context-menu-trigger')) {
            appState.selectedVariable = variable.id;
            toggleVariable();
        }
    });

    // Right-click context menu
    item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showVariableContextMenu(variable, e.clientX, e.clientY);
    });

    // Keyboard navigation
    item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            appState.selectedVariable = variable.id;
            toggleVariable();
        } else if (e.key === 'ContextMenu') {
            e.preventDefault();
            const rect = item.getBoundingClientRect();
            showVariableContextMenu(variable, rect.left, rect.bottom);
        }
    });

    // Enhanced hover tooltip
    let tooltipTimer;
    item.addEventListener('mouseenter', (e) => {
        tooltipTimer = setTimeout(() => {
            showVariableTooltip(variable, e.clientX, e.clientY);
        }, 500); // 500ms delay
    });

    item.addEventListener('mouseleave', () => {
        clearTimeout(tooltipTimer);
        hideVariableTooltip();
    });

    return item;
}

function createStructMemberItem(member, parentVariable) {
    const item = document.createElement('div');
    item.className = 'variable-item struct-member';
    item.setAttribute('data-member-path', member.path);
    item.setAttribute('data-parent-id', parentVariable.id);

    // Checkbox for member selection
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'member-checkbox';
    checkbox.checked = member.selected || false;
    checkbox.title = 'Select this member for individual monitoring';

    checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        toggleStructMemberSelection(parentVariable.id, member.path, checkbox.checked);
    });

    // Member icon
    const memberIcon = document.createElement('i');
    memberIcon.className = 'codicon variable-type-icon';

    if (member.numericValue !== undefined) {
        memberIcon.classList.add('codicon-symbol-number');
        memberIcon.title = 'Numeric member';
    } else {
        memberIcon.classList.add('codicon-symbol-misc');
        memberIcon.title = 'Non-numeric member';
    }

    // Member name
    const name = document.createElement('div');
    name.className = 'variable-name';
    name.textContent = member.name;

    // Member value
    const value = document.createElement('div');
    value.className = 'variable-value';
    value.textContent = member.value || 'N/A';

    // Member type
    const type = document.createElement('div');
    type.className = 'variable-type';
    type.textContent = member.type || 'unknown';

    item.appendChild(checkbox);
    item.appendChild(memberIcon);
    item.appendChild(name);
    item.appendChild(value);
    item.appendChild(type);

    // Click to select member for monitoring
    item.addEventListener('click', () => {
        if (member.numericValue !== undefined) {
            toggleStructMemberSelection(parentVariable.id, member.path, !checkbox.checked);
            checkbox.checked = !checkbox.checked;
        }
    });

    return item;
}

function toggleStructExpansion(variableId, item) {
    const structContainer = document.getElementById(`struct-members-${variableId}`);
    const expandIcon = item.querySelector('.expand-icon');

    if (!structContainer) return;

    const isExpanded = structContainer.style.display !== 'none';

    if (isExpanded) {
        // Collapse
        structContainer.style.display = 'none';
        expandIcon.classList.remove('expanded');
        expandIcon.classList.remove('codicon-chevron-down');
        expandIcon.classList.add('codicon-chevron-right');
    } else {
        // Expand
        structContainer.style.display = 'block';
        expandIcon.classList.add('expanded');
        expandIcon.classList.remove('codicon-chevron-right');
        expandIcon.classList.add('codicon-chevron-down');

        // Request updated struct member data if needed
        vscode.postMessage({
            command: 'getStructMembers',
            variableId: variableId
        });
    }
}

function toggleStructMemberSelection(parentVariableId, memberPath, selected) {
    vscode.postMessage({
        command: 'toggleStructMember',
        parentVariableId: parentVariableId,
        memberPath: memberPath,
        selected: selected
    });
}

function updateLegend() {
    const legend = document.getElementById('legend');
    legend.innerHTML = '';

    const enabledVariables = variables.filter((v) => v.enabled);
    if (enabledVariables.length === 0) {
        legend.style.display = 'none';
        return;
    }

    legend.style.display = 'block';
    enabledVariables.forEach((variable) => {
        const item = document.createElement('div');
        item.className = 'legend-item';

        // Highlight selected variable in legend
        if (appState.selectedVariable === variable.id) {
            item.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
            item.style.color = 'var(--vscode-list-activeSelectionForeground)';
            item.style.fontWeight = '600';
        } else if (appState.selectedVariable) {
            // Dim other items when something is selected
            item.style.opacity = '0.5';
        }

        const color = document.createElement('div');
        color.className = 'legend-color';
        color.style.backgroundColor = variable.color;

        const name = document.createElement('span');
        name.textContent = variable.name;

        item.appendChild(color);
        item.appendChild(name);

        // Allow clicking legend to select variable
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
            selectVariableOnCanvas(variable.id);
        });

        legend.appendChild(item);
    });
}

function drawWaveform() {
    if (!ctx) {
        console.error('[Waveform] drawWaveform called but ctx is null');
        return;
    }

    // Debug: log rendering status
    if (frameCount % 60 === 0) { // Log every 60 frames (roughly every 2 seconds)
        console.log(`[Waveform] Drawing frame ${frameCount}, variables: ${variables.length}, recording: ${appState.isRecording}`);
    }

    // Update FPS counter
    frameCount++;
    const now = Date.now();
    if (now - lastFpsUpdate >= 1000) {
        fps = frameCount;
        frameCount = 0;
        lastFpsUpdate = now;
        document.getElementById('statusFPS').textContent = fps;
    }

    // Save context state for performance
    ctx.save();

    // Clear canvas with optimization
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Apply transformations once
    ctx.translate(interactionState.panOffset.x, interactionState.panOffset.y);
    ctx.scale(interactionState.zoomLevel, interactionState.zoomLevel);

    // Draw grid first (background)
    drawGrid();

    // Batch draw all variables for better performance
    const enabledVariables = variables.filter((v) => v.enabled);
    if (enabledVariables.length > 0) {
        // Pre-calculate common values
        const padding = 40;
        const chartWidth = canvas.width - 2 * padding;
        const chartHeight = canvas.height - 2 * padding;
        const timeSpanMs = settings.timeSpan * 1000;
        const now = Date.now();
        const startTime = now - timeSpanMs;

        // Draw all variables with minimal context switches
        enabledVariables.forEach((variable) => {
            const points = data[variable.id];
            if (points && points.length > 1) {
                drawVariableOptimized(variable, points, padding, chartWidth, chartHeight, startTime, timeSpanMs);
            }
        });
    }

    // Restore context state
    ctx.restore();
}

function drawGrid() {
    const btn = document.getElementById('btnGrid');
    if (!btn || !btn.classList.contains('active')) return;

    ctx.save();

    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--vscode-panel-border');
    ctx.lineWidth = 1;

    // Apply zoom and pan transformations
    ctx.translate(interactionState.panOffset.x, interactionState.panOffset.y);
    ctx.scale(interactionState.zoomLevel, interactionState.zoomLevel);

    const padding = 40;
    const chartWidth = canvas.width - 2 * padding;
    const chartHeight = canvas.height - 2 * padding;

    // Vertical grid lines
    for (let i = 0; i <= 10; i++) {
        const x = padding + (chartWidth / 10) * i;
        ctx.beginPath();
        ctx.moveTo(x, padding);
        ctx.lineTo(x, padding + chartHeight);
        ctx.stroke();
    }

    // Horizontal grid lines
    for (let i = 0; i <= 5; i++) {
        const y = padding + (chartHeight / 5) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(padding + chartWidth, y);
        ctx.stroke();
    }

    ctx.restore();
}

function drawVariable(variable, points) {
    // Legacy function - use drawVariableOptimized instead
    const padding = 40;
    const chartWidth = canvas.width - 80;
    const chartHeight = canvas.height - 80;
    const timeStart = Date.now() - (settings.timeSpan * 1000);
    const timeRange = settings.timeSpan * 1000;
    drawVariableOptimized(variable, points, padding, chartWidth, chartHeight, timeStart, timeRange);
}

function drawVariableOptimized(variable, points, padding, chartWidth, chartHeight, startTime, timeSpanMs) {
    if (points.length === 0) return;

    // Apply highlighting/dimming based on selection
    let lineOpacity = variable.opacity || 1.0;
    let lineWidth = variable.lineWidth || 2;

    if (appState.selectedVariable) {
        if (variable.id === appState.selectedVariable) {
            // Selected variable: brighter and thicker
            lineOpacity = Math.min(1.0, lineOpacity * 1.2);
            lineWidth = lineWidth * 1.5;
        } else {
            // Other variables: dimmed
            lineOpacity = lineOpacity * 0.3;
        }
    }

    // Set style once
    ctx.strokeStyle = variable.color;
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = lineOpacity;

    // Apply line style
    if (variable.lineStyle === 'dashed') {
        ctx.setLineDash([5, 5]);
    } else if (variable.lineStyle === 'dotted') {
        ctx.setLineDash([2, 2]);
    } else {
        ctx.setLineDash([]);
    }

    ctx.beginPath();

    // Calculate value range once
    let yMin = settings.yMin;
    let yMax = settings.yMax;

    if (settings.yAxisMode === 'auto') {
        // Optimized min/max calculation
        let minVal = points[0].value;
        let maxVal = points[0].value;
        for (let i = 1; i < points.length; i++) {
            const val = points[i].value;
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
        }
        yMin = minVal;
        yMax = maxVal;
        const rangePadding = (yMax - yMin) * 0.1;
        yMin -= rangePadding;
        yMax += rangePadding;
    }

    const yRange = yMax - yMin;
    const xScale = chartWidth / timeSpanMs;
    const yScale = chartHeight / yRange;

    // Optimized drawing loop
    let firstPoint = true;
    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const x = padding + ((point.timestamp - startTime) * xScale);
        const y = padding + (1 - (point.value - yMin) / yRange) * chartHeight;

        if (firstPoint) {
            ctx.moveTo(x, y);
            firstPoint = false;
        } else {
            ctx.lineTo(x, y);
        }
    }

    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;
}

function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('active');

    if (panel.classList.contains('active')) {
        document.getElementById('timeSpan').value = settings.timeSpan;
        document.getElementById('refreshRate').value = settings.refreshRate;
        document.getElementById('maxDataPoints').value = settings.maxDataPoints;
    }
}

function applySettings() {
    const newSettings = {
        timeSpan: parseFloat(document.getElementById('timeSpan').value),
        refreshRate: parseFloat(document.getElementById('refreshRate').value),
        maxDataPoints: parseInt(document.getElementById('maxDataPoints').value)
    };

    vscode.postMessage({
        command: 'updateSettings',
        settings: newSettings
    });

    toggleSettings();
}

function exportData(format) {
    sendMessageToExtension('exportData', { format: format });
}

function clearAllData() {
    if (confirm('Are you sure you want to clear all waveform data?')) {
        sendMessageToExtension('clearAllData');
    }
}

function performFFT(variableId) {
    const windowSize = prompt('Enter FFT window size (256-4096):', '512');
    const windowFunction = prompt('Enter window function (hanning/hamming/blackman/rectangular):', 'hanning');

    if (windowSize && windowFunction) {
        sendMessageToExtension('performFFT', {
            variableId: variableId,
            windowSize: parseInt(windowSize),
            windowFunction: windowFunction
        });
    }
}

function displayFFTResults(result) {
    const panel = document.getElementById('fftPanel');
    const results = document.getElementById('fftResults');

    let html = '<h5>Analysis Results</h5>';
    html += '<p><strong>Dominant Frequency:</strong> ' + result.dominantFrequency.frequency.toFixed(2) + ' Hz</p>';
    html += '<p><strong>Dominant Magnitude:</strong> ' + result.dominantFrequency.magnitude.toFixed(2) + ' dB</p>';
    html += '<p><strong>Noise Floor:</strong> ' + result.noiseFloor.toFixed(2) + ' dB</p>';
    html += '<p><strong>THD:</strong> ' + (result.thd * 100).toFixed(3) + '%</p>';

    html += '<h6>Top Peaks:</h6>';
    result.peaks.slice(0, 5).forEach((peak, i) => {
        html += '<p>' + (i + 1) + '. ' + peak.frequency.toFixed(2) + ' Hz, ' + peak.magnitude.toFixed(2) + ' dB</p>';
    });

    results.innerHTML = html;
    panel.classList.add('active');
}

function closeFFT() {
    document.getElementById('fftPanel').classList.remove('active');
}

// Performance-optimized rendering with requestAnimationFrame
let animationFrameId = null;
let lastRenderTime = 0;
const targetFPS = 30; // Target 30 FPS for smooth animation
const frameInterval = 1000 / targetFPS;

function scheduleRender() {
    const now = performance.now();
    const deltaTime = now - lastRenderTime;

    if (deltaTime >= frameInterval) {
        drawWaveform();
        lastRenderTime = now - (deltaTime % frameInterval);
    }

    if (appState.isRecording || interactionState.isDragging || interactionState.isMeasuring) {
        animationFrameId = requestAnimationFrame(scheduleRender);
    }
}

// Performance monitoring
let performanceStats = {
    frameCount: 0,
    totalTime: 0,
    maxFrameTime: 0,
    minFrameTime: Infinity,
    lastStatsUpdate: Date.now()
};

function measurePerformance() {
    const start = performance.now();
    drawWaveform();
    const end = performance.now();
    const frameTime = end - start;

    performanceStats.frameCount++;
    performanceStats.totalTime += frameTime;
    performanceStats.maxFrameTime = Math.max(performanceStats.maxFrameTime, frameTime);
    performanceStats.minFrameTime = Math.min(performanceStats.minFrameTime, frameTime);

    // Update stats every 5 seconds
    const now = Date.now();
    if (now - performanceStats.lastStatsUpdate > 5000) {
        const avgFrameTime = performanceStats.totalTime / performanceStats.frameCount;
        const avgFPS = 1000 / avgFrameTime;
        const logMsg = 'Waveform Performance: Avg FPS: ' + avgFPS.toFixed(1)
                       + ', Frame Time: ' + avgFrameTime.toFixed(2) + 'ms (min: '
                       + performanceStats.minFrameTime.toFixed(2) + 'ms, max: '
                       + performanceStats.maxFrameTime.toFixed(2) + 'ms)';
        console.log(logMsg);

        // Reset stats
        performanceStats = {
            frameCount: 0,
            totalTime: 0,
            maxFrameTime: 0,
            minFrameTime: Infinity,
            lastStatsUpdate: now
        };
    }
}

// Optimized update loop
function startOptimizedRendering() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    scheduleRender();
}

function stopOptimizedRendering() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

// Update timer with performance optimization
setInterval(() => {
    if (appState.isRecording) {
        startOptimizedRendering();
    } else {
        measurePerformance(); // Measure performance even when not recording
    }
}, 1000 / settings.refreshRate);

// ==================== UI Enhancement Functions ====================

// Context Menu
let activeContextMenu = null;

function showVariableContextMenu(variable, x, y) {
    // Remove existing menu
    hideContextMenu();

    const menu = document.createElement('div');
    menu.className = 'variable-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const menuItems = [
        {
            icon: 'settings-gear',
            label: 'Configure...',
            action: () => {
                vscode.postMessage({
                    command: 'configureVariable',
                    variableId: variable.id
                });
            }
        },
        {
            icon: 'symbol-color',
            label: 'Change Color',
            action: () => {
                vscode.postMessage({
                    command: 'changeColor',
                    variableId: variable.id
                });
            }
        },
        {
            icon: 'symbol-enum',
            label: 'Change Display Type',
            action: () => {
                vscode.postMessage({
                    command: 'changeDisplayType',
                    variableId: variable.id
                });
            }
        },
        { separator: true },
        {
            icon: 'folder',
            label: 'Move to Group',
            action: () => {
                vscode.postMessage({
                    command: 'configureGroup',
                    variableId: variable.id
                });
            }
        },
        {
            icon: 'debug-breakpoint-conditional',
            label: 'Configure Trigger...',
            action: () => {
                vscode.postMessage({
                    command: 'configureTrigger',
                    variableId: variable.id
                });
            }
        },
        {
            icon: 'graph',
            label: 'Show Statistics',
            action: () => {
                vscode.postMessage({
                    command: 'showStatistics',
                    variableId: variable.id
                });
            }
        },
        { separator: true },
        {
            icon: 'trash',
            label: 'Remove from Waveform',
            action: () => {
                vscode.postMessage({
                    command: 'removeVariable',
                    variableId: variable.id
                });
            }
        }
    ];

    menuItems.forEach((item) => {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);
        } else {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item';

            const icon = document.createElement('i');
            icon.className = 'codicon codicon-' + item.icon;
            menuItem.appendChild(icon);

            const label = document.createElement('span');
            label.textContent = item.label;
            menuItem.appendChild(label);

            menuItem.addEventListener('click', () => {
                item.action();
                hideContextMenu();
            });

            menu.appendChild(menuItem);
        }
    });

    document.body.appendChild(menu);
    activeContextMenu = menu;

    // Close menu on click outside
    setTimeout(() => {
        document.addEventListener('click', hideContextMenu, { once: true });
        document.addEventListener('contextmenu', hideContextMenu, { once: true });
    }, 10);

    // Adjust position if menu goes off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (x - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (y - rect.height) + 'px';
    }
}

function hideContextMenu() {
    if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
    }
}

// Enhanced Tooltip
let activeTooltip = null;

function showVariableTooltip(variable, x, y) {
    hideVariableTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'enhanced-tooltip';

    const header = document.createElement('div');
    header.className = 'tooltip-header';
    header.textContent = variable.name;
    tooltip.appendChild(header);

    const rows = [
        { label: 'Display Type', value: (variable.displayType || 'analog').toUpperCase() },
        { label: 'Current Value', value: variable.lastValue !== undefined ? variable.lastValue.toFixed(3) : 'No data' },
        { label: 'Color', value: variable.color },
        { label: 'Enabled', value: variable.enabled ? 'Yes' : 'No' }
    ];

    if (variable.samplingRate) {
        rows.push({ label: 'Sampling Rate', value: variable.samplingRate + ' Hz' });
    }

    if (variable.group) {
        rows.push({ label: 'Group', value: variable.group });
    }

    if (variable.trigger && variable.trigger.enabled) {
        rows.push({
            label: 'Trigger',
            value: variable.trigger.type + (variable.trigger.value !== undefined ? ' @ ' + variable.trigger.value : '')
        });
    }

    if (variable.bitWidth && variable.displayType !== 'analog') {
        rows.push({ label: 'Bit Width', value: variable.bitWidth + ' bits' });
    }

    if (variable.threshold !== undefined && variable.displayType === 'bit') {
        rows.push({ label: 'Threshold', value: variable.threshold.toFixed(2) });
    }

    rows.forEach((row) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'tooltip-row';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'tooltip-label';
        labelSpan.textContent = row.label + ':';

        const valueSpan = document.createElement('span');
        valueSpan.className = 'tooltip-value';
        valueSpan.textContent = row.value;

        rowDiv.appendChild(labelSpan);
        rowDiv.appendChild(valueSpan);
        tooltip.appendChild(rowDiv);
    });

    // Position tooltip
    tooltip.style.left = (x + 15) + 'px';
    tooltip.style.top = (y + 15) + 'px';

    document.body.appendChild(tooltip);
    activeTooltip = tooltip;

    // Adjust if off-screen
    const rect = tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        tooltip.style.left = (x - rect.width - 15) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        tooltip.style.top = (y - rect.height - 15) + 'px';
    }
}

function hideVariableTooltip() {
    if (activeTooltip) {
        activeTooltip.remove();
        activeTooltip = null;
    }
}

function handleStructMembersUpdate(message) {
    if (message.data && message.data.variableId && message.data.structMembers) {
        const variable = variables.find((v) => v.id === message.data.variableId);
        if (variable) {
            variable.structMembers = message.data.structMembers;

            // Update the struct members display
            const structContainer = document.getElementById(`struct-members-${variable.id}`);
            if (structContainer) {
                structContainer.innerHTML = '';
                message.data.structMembers.forEach((member) => {
                    const memberItem = createStructMemberItem(member, variable);
                    structContainer.appendChild(memberItem);
                });
            }
        }
    }
}

function handleStructMemberSelectionUpdate(message) {
    if (message.data && message.data.variableId && message.data.selectedMembers) {
        const variable = variables.find((v) => v.id === message.data.variableId);
        if (variable && variable.structMembers) {
            // Update member selection states
            variable.structMembers.forEach((member) => {
                member.selected = message.data.selectedMembers.includes(member.path);
            });

            // Update checkboxes
            const structContainer = document.getElementById(`struct-members-${variable.id}`);
            if (structContainer) {
                const checkboxes = structContainer.querySelectorAll('.member-checkbox');
                checkboxes.forEach((checkbox) => {
                    const memberPath = checkbox.parentElement.getAttribute('data-member-path');
                    checkbox.checked = message.data.selectedMembers.includes(memberPath);
                });
            }
        }
    }
}

// Update appState to track selected variable
if (!appState.selectedVariable) {
    appState.selectedVariable = null;
}

// Initialize rendering - always start rendering to show empty canvas
console.log('[Waveform] Initializing rendering system');

// Add a simple initialization check
function ensureWaveformInitialized() {
    if (!canvas) {
        console.error('[Waveform] Canvas not initialized');
        return false;
    }
    if (!ctx) {
        console.error('[Waveform] Canvas context not initialized');
        return false;
    }
    console.log('[Waveform] Canvas and context initialized successfully');
    return true;
}

// Note: Initialization is handled by the window.addEventListener('load', ...) callback above

// ==================== End UI Enhancement Functions ====================
