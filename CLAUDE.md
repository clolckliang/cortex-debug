# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Development
- `npm install` - Install dependencies
- `npm run compile` - Compile TypeScript to JavaScript with development mode webpack
- `npm run watch` - Start webpack in watch mode for development (auto-compiles on changes)
- `npm run vscode:prepublish` - Full production build including linting, documentation generation, and dependency management
- `npm run lint` - Run ESLint for code quality checks
- `npm run test-compile` - Compile TypeScript tests without webpack

### Packaging and Publishing
- `npm run package` - Package the extension for distribution
- `npm run publish` - Publish the extension to VS Code marketplace (also publishes to Open VSX)

## Architecture Overview

Cortex-Debug is a VS Code extension for debugging ARM Cortex-M microcontrollers. The extension has a two-part architecture:

### Core Components
1. **Frontend Extension** (`src/frontend/extension.ts`): VS Code extension entry point, manages UI components like:
   - Live Watch tree view for real-time variable monitoring
   - Waveform display for SWO/RTT data visualization
   - RTT terminals and GDB server console
   - Memory content provider

2. **Debug Adapter** (`src/gdb.ts`): Backend debug adapter that implements the Debug Adapter Protocol (DAP)
   - Interfaces between VS Code frontend, GDB, and GDB servers
   - Manages GDB MI (Machine Interface) communication
   - Handles breakpoints, stepping, memory access, and variable evaluation

### GDB Server Controllers
Located in root `src/` directory, each supporting different debug probes:
- `jlink.ts` - SEGGER J-Link probes
- `openocd.ts` - OpenOCD GDB server
- `stlink.ts` - STM32 ST-LINK GDB server
- `stutil.ts` - Texane's st-util
- `pyocd.ts` - pyOCD for CMSIS-DAP probes
- `bmp.ts` - Black Magic Probe
- `pemicro.ts` - P&E Micro probes
- `external.ts` - External GDB servers

### Key Subsystems
- **SWO/RTT Processing** (`src/frontend/swo/`): Serial Wire Output and Real-Time Trace data handling
  - Multiple decoders for console, binary, and custom data formats
  - Various data sources (socket, serial, USB, file, FIFO)
  - Graphing capabilities for live data visualization

- **Memory and Symbols** (`src/backend/`):
  - Symbol table management and variable expansion
  - Memory reading utilities and disassembly
  - GDB/MI parsing and communication

- **Live Monitoring** (`src/frontend/views/`):
  - Live watch for real-time variable monitoring
  - Waveform visualization for time-series data
  - Tree data structures for hierarchical display

### Configuration
- `src/frontend/configprovider.ts` - VS Code launch configuration provider
- `debug_attributes.md` - Complete reference for all launch.json configuration options
- Extension supports chained configurations for multi-core debugging

### Dependencies
- Built on WebFreak's code-debug extension base for GDB MI parsing
- Uses VS Code Debug Adapter SDK
- Relies on external ARM GCC toolchain (arm-none-eabi-gdb, objdump, nm)
- Requires compatible GDB server software (J-Link, OpenOCD, etc.)

## Testing and Debugging
To debug the extension itself, use the "Extension + Debug Server" launch configuration which:
1. Launches a new VS Code window (debuggee)
2. Allows you to set `debugServer: 4711` in the debuggee's launch.json
3. Enables full debugging of both frontend and debug adapter components