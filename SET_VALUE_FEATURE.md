# Set Value Feature - Implementation Documentation

**Feature**: Set Variable Value in Live Watch Window
**Status**: IMPLEMENTED ✓
**Date**: January 5, 2025
**Version**: 1.13.0-pre6

---

## Overview

This feature allows users to modify variable values directly from the Cortex Live Watch window during debugging sessions. This is particularly useful for:
- Testing different code paths without recompiling
- Simulating sensor inputs or error conditions
- Quickly testing edge cases
- Debugging state machines by forcing state transitions

---

## Implementation Details

### 1. Backend Support (GDB Adapter)

**File**: `src/gdb.ts`

Already implemented DAP protocol methods:
- `setVariableRequest()` - Line 1986
- `setExpressionRequest()` - Line 2037

These methods handle:
- Variable reference resolution
- Register variables
- Global/static variables
- Stack variables
- Struct members and array elements
- GDB MI communication via `varAssign()`

### 2. Frontend UI Integration

**File**: `src/frontend/views/live-watch.ts`

Added methods to `LiveVariableNode` class:

#### `setValue(newValue: string): Promise<boolean>`
- Validates value format
- Checks for pointer types and warns user
- Uses `setExpression` for root-level variables
- Uses `setVariable` for child variables (struct members, etc.)
- Returns `true` on success, throws error on failure

#### `isValidValue(value: string): boolean`
Validates input formats:
- Decimal numbers: `123`, `-45`, `3.14`
- Hexadecimal: `0xFF`, `0x1234`
- Binary: `0b1010`, `0B11001100`
- String literals: `"hello"`, `'test'`
- Character literals: `'a'`, `'X'`
- Boolean: `true`, `false`
- C-style casts: `(uint32_t)0x1234`

#### `getType(): string`
- Returns the C/C++ type information
- Used for safety validation

### 3. Extension Command Integration

**File**: `src/frontend/extension.ts`

#### `setLiveWatchValue(node: any): Promise<void>`
Main command implementation featuring:

**Safety Validations:**
1. **Pointer Warning**: Shows modal dialog when modifying pointer values
   - Warns about memory corruption risks
   - Requires explicit user confirmation
   - Displays variable type in warning message

2. **Input Validation**: Real-time validation as user types
   - Checks format (decimal, hex, binary, string, etc.)
   - Provides helpful error messages
   - Shows placeholder with format examples

**User Experience:**
- Pre-populates input box with current value
- Shows variable type in prompt
- Displays success/error notifications
- Automatically refreshes Live Watch view to show new value

### 4. Menu Integration

**File**: `package.json`

#### Command Registration:
```json
{
    "command": "cortex-debug.liveWatch.setValue",
    "title": "Set Value...",
    "icon": "$(edit)"
}
```

#### Context Menu:
Added to Live Watch context menu at priority `inline@2` (between Edit and Move Up):
```
✏️ Edit Expression
✏️ Set Value...        ← NEW
⬆️ Move Up
⬇️ Move Down
✖️ Remove
```

---

## Usage

### Basic Workflow

1. **Start Debug Session**
   - Start debugging your embedded application
   - Open Cortex Live Watch panel

2. **Add Variables to Watch**
   - Add variables you want to monitor
   - Variables must be in scope

3. **Set Variable Value**
   - Right-click on any variable in Live Watch
   - Select "Set Value..."
   - Enter new value in the input box
   - Press Enter to apply

### Example Use Cases

#### Example 1: Testing Error Handling
```c
int errorCode = 0;  // In Live Watch

// Set errorCode to 123 to test error path
// Right-click → Set Value → Enter "123"
```

#### Example 2: Forcing State Transitions
```c
enum State { IDLE, RUNNING, ERROR };
enum State currentState = IDLE;

// Force state to ERROR for testing
// Right-click → Set Value → Enter "2" (or "ERROR" if enum values visible)
```

#### Example 3: Simulating Sensor Input
```c
uint32_t sensorValue = 0;

// Simulate high sensor reading
// Right-click → Set Value → Enter "0xFFFF" or "65535"
```

#### Example 4: Testing Flags
```c
bool isEnabled = false;

// Enable feature during runtime
// Right-click → Set Value → Enter "true"
```

---

## Safety Features

### 1. Pointer Modification Warning

When attempting to modify a pointer variable:

```
⚠️ Warning: 'myPointer' is a pointer (uint32_t*).
Modifying pointer values can cause memory corruption or system crashes.
Are you sure you want to continue?

[Yes, I understand the risks]  [Cancel]
```

**Detected pointer types:**
- Variables with `*` in type
- Variables with "pointer" in type name (case-insensitive)

### 2. Input Format Validation

Real-time validation prevents invalid inputs:
- Empty values rejected
- Invalid formats show error message
- Helpful placeholder text
- Format examples in error messages

### 3. Error Handling

Comprehensive error handling for:
- No active debug session
- Variable out of scope
- GDB communication failures
- Type mismatches
- Memory access violations

All errors displayed to user with clear messages.

---

## Supported Value Formats

| Format | Example | Description |
|--------|---------|-------------|
| Decimal | `123`, `-45`, `3.14` | Standard decimal numbers |
| Hexadecimal | `0xFF`, `0x1234ABCD` | Hex with 0x prefix |
| Binary | `0b1010`, `0B11001100` | Binary with 0b prefix |
| String | `"hello world"` | Double-quoted strings |
| String | `'test'` | Single-quoted strings |
| Character | `'a'`, `'X'` | Single character in quotes |
| Boolean | `true`, `false` | Boolean literals |
| Cast Expression | `(uint32_t)0x1234` | C-style type casts |

---

## Limitations

### 1. Scope Restrictions
- Variables must be in current scope
- Cannot modify variables in optimized-out frames
- Cannot modify const-qualified variables (GDB restriction)

### 2. Type Restrictions
- Complex types (arrays, structs) cannot be set directly
- Must set individual members instead
- Function pointers should not be modified

### 3. Timing Considerations
- Value changes are applied immediately
- Changes visible after next update cycle
- Live Watch refresh may be needed to see new value

---

## Architecture

### Call Flow

```
User Action (Right-click → Set Value)
    ↓
extension.ts::setLiveWatchValue()
    ↓
[Safety Checks - Pointer Warning]
    ↓
[Input Dialog with Validation]
    ↓
live-watch.ts::LiveVariableNode.setValue()
    ↓
[Format Validation]
    ↓
[DAP Protocol Call]
    ├── setExpression (root variables)
    └── setVariable (child variables)
        ↓
gdb.ts::setVariableRequest() / setExpressionRequest()
    ↓
MI Debugger::varAssign()
    ↓
GDB Command Execution
    ↓
Success/Error Response
    ↓
UI Update & Notification
```

### Component Interaction

```
┌──────────────────┐
│  VSCode UI       │
│  (Context Menu)  │
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│  extension.ts    │
│  Command Handler │
│  - Validation    │
│  - Safety Checks │
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│  live-watch.ts   │
│  LiveVariableNode│
│  - setValue()    │
│  - isValidValue()│
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│  DAP Protocol    │
│  - setVariable   │
│  - setExpression │
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│  gdb.ts          │
│  Debug Adapter   │
│  - GDB MI        │
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│  GDB Server      │
│  Target Hardware │
└──────────────────┘
```

---

## Testing Recommendations

### Unit Testing
1. Test value format validation
   - All supported formats
   - Invalid formats
   - Edge cases (empty, whitespace)

2. Test pointer detection
   - Various pointer types
   - Pointer-to-pointer
   - Function pointers

### Integration Testing
1. Test with real GDB session
   - Local variables
   - Global variables
   - Static variables
   - Register variables

2. Test struct/array members
   - Nested structs
   - Array elements
   - Pointer dereferencing

3. Test error scenarios
   - Out of scope variables
   - Const variables
   - Optimized variables

### User Acceptance Testing
1. Test workflow convenience
   - Input dialog usability
   - Error message clarity
   - Success confirmation

2. Test safety features
   - Pointer warning effectiveness
   - Input validation helpfulness

---

## Configuration

No additional configuration required. Feature works with:
- All supported GDB servers (J-Link, OpenOCD, etc.)
- All Cortex-M targets
- All debug protocols (SWD, JTAG)

---

## Future Enhancements

### Potential Improvements
1. **History**: Remember recently used values
2. **Expressions**: Allow arithmetic expressions (e.g., `value + 10`)
3. **Batch Edit**: Set multiple variables at once
4. **Watchpoints**: Set value and create watchpoint
5. **Undo**: Revert to previous value
6. **Templates**: Save/load common value sets

### Advanced Features
1. **Conditional Sets**: Set value only if condition met
2. **Scripting**: Automate value changes
3. **Value Suggestions**: Suggest valid values based on type
4. **Range Validation**: Validate against known valid ranges

---

## Known Issues

None at this time.

---

## Related Features

- **Live Watch**: Real-time variable monitoring
- **Waveform**: Variable visualization over time
- **Memory View**: Direct memory editing
- **Registers View**: CPU register modification

---

## References

- DAP Protocol Specification: setVariable Request
- GDB MI Documentation: var-assign command
- VSCode Extension API: TreeDataProvider
- Cortex-Debug Documentation

---

**Implementation Status**: COMPLETE ✓
**Testing Status**: Ready for user testing
**Documentation Status**: Complete

---

*Last Updated: January 5, 2025*
