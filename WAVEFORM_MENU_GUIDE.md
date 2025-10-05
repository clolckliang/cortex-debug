# Waveform Context Menu Integration

This document describes the Live Watch context menu integration with waveform features.

## Live Watch Context Menu Structure

When you right-click on a variable in the **Cortex Live Watch** view, you'll see the following menu structure:

### 📌 Inline Actions (Quick Access)
1. **Edit expression** `$(edit)` - Edit the watch expression
2. **Move expression up** `$(arrow-up)` - Move the variable up in the list
3. **Move expression down** `$(arrow-down)` - Move the variable down in the list
4. **Remove expression** `$(close)` - Remove from Live Watch

---

### 📊 Waveform Management
5. **Add to Waveform** `$(graph)` - Add variable to waveform monitoring
6. **Configure for Waveform...** `$(settings-gear)` - Open configuration dialog for waveform settings
   - Change color
   - Change line style (solid, dashed, dotted)
   - Change line width
   - Set sampling rate
   - Enable/Disable
   - Remove from waveform
7. **Show in Waveform** `$(eye)` - Focus the waveform view and highlight this variable
8. **Remove from Waveform** `$(trash)` - Remove variable from waveform monitoring

---

### 🔬 Waveform Analysis
9. **Set Waveform Style** - Quick style configuration
10. **Perform FFT Analysis** `$(graph)` - Analyze frequency spectrum of the variable data

---

## Command Palette Commands

All waveform commands are also available through the Command Palette (`Ctrl+Shift+P`):

### Recording Control
- **Cortex-Debug: Start Waveform Recording** `$(record)` - Start data collection
- **Cortex-Debug: Stop Waveform Recording** `$(stop)` - Stop data collection

### Data Management
- **Cortex-Debug: Export Waveform Data** - Export data as JSON or CSV
- **Cortex-Debug: Clear All Waveform Data** - Clear all collected data

### Configuration
- **Cortex-Debug: Import Waveform Configuration** - Load saved configuration
- **Cortex-Debug: Export Waveform Configuration** - Save current configuration
- **Cortex-Debug: Update Waveform Settings** - Configure display settings
  - Time span
  - Refresh rate
  - Maximum data points

### Display
- **Cortex-Debug: Show Waveform** `$(graph)` - Open waveform view

---

## Workflow Examples

### Example 1: Add and Configure a Variable
1. Right-click on variable in Live Watch
2. Select **"Add to Waveform"**
3. Right-click again
4. Select **"Configure for Waveform..."**
5. Choose color, line style, etc.

### Example 2: Analyze Frequency Content
1. Right-click on variable in Live Watch
2. Select **"Perform FFT Analysis"**
3. Choose window size (256, 512, 1024, 2048, 4096)
4. Choose window function (hanning, hamming, blackman, rectangular)
5. View frequency analysis results

### Example 3: Focus on Specific Variable
1. Right-click on variable in Live Watch
2. Select **"Show in Waveform"**
3. Waveform view opens and highlights the variable

---

## Menu Groups

The context menu is organized into logical groups:

1. **inline@1-4**: Quick actions (edit, move, remove)
2. **waveform@1-4**: Waveform management actions
3. **waveformAnalysis@1-2**: Analysis tools

This grouping ensures related actions appear together with visual separators.

---

## Icon Reference

| Icon | Meaning |
|------|---------|
| `$(edit)` | Edit/Configure |
| `$(arrow-up)` / `$(arrow-down)` | Move in list |
| `$(close)` / `$(trash)` | Remove/Delete |
| `$(graph)` | Waveform/Graph related |
| `$(settings-gear)` | Settings/Configuration |
| `$(eye)` | Show/Focus |
| `$(record)` | Start recording |
| `$(stop)` | Stop recording |
| `$(save)` | Export/Save |

---

## VSCode Context Menu Best Practices

The menu follows VSCode best practices:

- ✅ Uses menu groups with `@` priorities for ordering
- ✅ Uses Codicons for consistent iconography
- ✅ Groups related actions together
- ✅ Provides keyboard shortcuts where applicable
- ✅ Shows inline actions for most common operations
- ✅ Separates destructive actions (remove, clear)
- ✅ Uses conditional visibility (`when` clauses)

---

## Debug Variables Context Menu

When you right-click on a variable in the **Debug Variables** view:

- **Add to Live Watch** - Add the variable to Live Watch (then use waveform features)

This creates a seamless workflow from Debug Variables → Live Watch → Waveform.
