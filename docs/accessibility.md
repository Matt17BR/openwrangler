# Accessibility and keyboard use

Open Wrangler runs its workbench inside a VS Code webview. It uses the editor's theme colors, native form controls,
named regions, status announcements, and managed keyboard focus. This guide describes the current behavior of the
workbench; it does not replace the keyboard commands provided by VS Code itself.

`Ctrl` below means Control on Windows and Linux. Use `Cmd` instead on macOS where the table says `Ctrl/Cmd`.

## Data grid

The data table exposes a named ARIA grid. Its row and column counts describe the complete current view when the row
count is known. Rendered rows and columns keep their absolute ARIA positions even though the grid renders only a
window of a large dataset. A row-number or row-label header precedes the data columns. The row range below the grid
is a polite, atomic status such as `Rows 1–200 of 1,000`.

Only one rendered body cell is in the Tab order at a time. Put focus on that cell, then use:

| Key                         | Result                                                               |
| --------------------------- | -------------------------------------------------------------------- |
| Arrow keys                  | Move one data cell in that direction.                                |
| `Home` / `End`              | Move to the first or last data column in the current row.            |
| `Page Up` / `Page Down`     | Move by the number of rows that fit in the current grid viewport.    |
| `Ctrl/Cmd+Home`             | Move to the first data cell.                                         |
| `Ctrl/Cmd+End`              | Move to the final row and column in an exact-total non-PySpark view. |
| Context Menu or `Shift+F10` | Open the filter-by-cell actions for the focused cell.                |

Navigation can cross a fetched row or column block. Open Wrangler requests the required block, keeps the absolute
cell position, and restores focus after it arrives if the webview still owns focus. For a PySpark view whose total is
not known yet, the grid exposes an unknown ARIA row count and only a bounded next block. **Next block** continues the
traversal until a terminal page establishes the total.

Click a cell to start a selection. Drag across rendered cells with a mouse or pen, or use `Shift+click` or
`Shift+Arrow`, to extend the anchor into one rectangular range. Pointer dragging suppresses native text selection and
returns the grid's roving Tab stop to the range endpoint when the webview still owns focus. Bounded edge scrolling can
bring adjacent rendered cells into the drag. Touch pointers retain native scrolling; use the keyboard commands for a
precise touch-assisted selection.

`Ctrl/Cmd+click` starts a new rectangle. Open Wrangler does not support non-contiguous grid selections. The grid's
accessible description states these rules, and the footer reports the selected dimensions. **Copy range** or
`Ctrl/Cmd+C` copies the displayed values in the rectangle as tab-separated rows. **Copy cell** copies the focused
cell. **Copy row** copies the loaded columns in the focused row and says when the row is only a projected set of
columns. A keyboard rectangle can cross a fetched block and remains selected, but **Copy range** and `Ctrl/Cmd+C`
report that every selected row and column must be loaded before copying. They do not copy a partial rectangle.

Select a column header with the pointer or `Enter`/`Space`; `Ctrl/Cmd+Space` is the explicit spreadsheet-style
shortcut. The footer reports that the whole filtered and sorted column is selected while Open Wrangler prepares it one
projected page at a time. **Copy column** becomes available only after preparation succeeds. A later click or
`Ctrl/Cmd+C` writes the prepared data in that user gesture, and moving to another cell or data view discards the
prepared column. Column copy starts with the column header and does not include row labels.

PySpark traversal remains contiguous even after the total becomes exact. In that backend, `Ctrl/Cmd+End` advances
only to the next permitted block instead of skipping directly to the final row.

The cell filter menu focuses its first enabled action, or the menu itself when no action is available. `Arrow Up` and
`Arrow Down` move through enabled actions and wrap at the ends. `Home` and `End` move to the first and last action.
`Escape` closes the menu and returns focus to the cell.

Column headers are separate Tab stops. `Enter` or `Space` selects a focused header. Header menus contain the filter
and sort actions available for that column. A column's **Resize** control accepts `Arrow Left` and `Arrow Right` in
10-pixel steps, `Home` for the 80-pixel minimum, and `End` for the 640-pixel maximum.

## Finding a column

The **Column** field is an editable combobox. Focusing it opens the matching-column list. Search matches the displayed
name, native type, semantic type, and the human type label. Duplicate names include their one-based column position
in the option label.

| Key                       | Result                                                         |
| ------------------------- | -------------------------------------------------------------- |
| `Arrow Up` / `Arrow Down` | Open the list or move through matches, wrapping at either end. |
| `Home` / `End`            | Move to the first or last match.                               |
| `Page Up` / `Page Down`   | Move by ten matches without leaving the list.                  |
| `Enter`                   | Select the active match and reveal that column in the grid.    |
| `Escape`                  | Close the list without changing the selected column.           |

The list is virtualized for wide schemas, but its options expose their position and the complete result count. A
search with no result keeps the controlled list present and announces **No matching columns**.

## Column profiles, filters, and sorts

The toolbar's profiles-and-filters button opens a non-modal drawer. Its label reflects whether the current backend
offers profiles, filters, sorts, or a combination of them. Focus moves to **Close panel** when the drawer opens.
`Escape` closes it and returns focus to the control that opened it. If a column-menu opener disappeared, focus returns
to the toolbar drawer button. The drawer does not trap Tab focus.

Delayed focus restoration occurs only while the webview still owns keyboard focus. Open Wrangler does not pull focus
back from a workbench prompt, another editor surface, or a deliberate focus move.

The **Column**, **Dataset**, and **Filters / Sorts** tabs use one roving Tab stop:

| Key                          | Result                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| `Arrow Left` / `Arrow Right` | Select and focus the previous or next visible tab, wrapping at the ends. |
| `Home` / `End`               | Select and focus the first or last visible tab.                          |

Filter and sort forms use native inputs, selects, checkboxes, buttons, and disclosures. In the value-search field,
`Enter` runs the search. Selected values and predicates appear as individually named removal buttons. Active viewing
filters also appear above the grid with **Clear filters** and **Undo latest filter** controls; this filter undo is
separate from cleaning-plan undo.

When a focused filter chip is removed, Open Wrangler keeps a stable focus target while the request is pending. After
the confirmed response, focus moves to the nearest remaining chip, an available filter-history action, or the current
grid cell. A deliberate focus move is preserved.

### Histograms and categories

When filtering is available, a numeric histogram has one keyboard focus target for the complete chart. Its accessible
name and tooltip identify the current interval, row count, percentage, and whether the upper boundary is included.

| Key                          | Result                            |
| ---------------------------- | --------------------------------- |
| `Arrow Left` / `Arrow Right` | Move to the previous or next bin. |
| `Home` / `End`               | Move to the first or last bin.    |
| `Enter` / `Space`            | Filter to the current bin.        |

Categorical top values and Boolean values are ordinary buttons when they can be used as filters. Their accessible
names include the value, count, and percentage; `Enter` or `Space` applies the filter. **Counts** and **%** are pressed
buttons that change how profile values are displayed. **More values…** opens the searchable value list when that
action is available.

When filtering is unavailable, distributions remain labeled images or text instead of inactive buttons. The
aggregated **Other** category is descriptive rather than selectable because it does not identify one exact value.

## Cleaning steps and operation dialogs

The operation picker is a modal dialog. The workbench behind it becomes inert and is hidden from the accessibility
tree. The operation search receives initial focus, and `Tab` and `Shift+Tab` wrap through the dialog's enabled
controls. `Escape`, the close button, or a click on the backdrop closes the dialog while no preview is running. During
a preview, the dialog announces **Previewing changes…** and disables its controls.

Closing the dialog returns focus to its opener when that control still exists and is enabled. Otherwise Open Wrangler
uses the current cleaning action or grid cell as a fallback. A successful preview closes the dialog through the same
focus-restoration path. Restoration is cancelled if another workbench surface owns focus.

Cleaning-plan shortcuts are available only in an active Open Wrangler custom editor and only in the relevant plan
state:

| Action           | Windows / Linux | macOS         | Available when                                                   |
| ---------------- | --------------- | ------------- | ---------------------------------------------------------------- |
| Apply draft      | `Ctrl+Enter`    | `Cmd+Enter`   | A draft is ready and no projection or mutation is pending.       |
| Discard draft    | `Escape`        | `Escape`      | A draft is ready and no higher-priority surface consumes Escape. |
| Edit latest step | `Ctrl+Shift+E`  | `Cmd+Shift+E` | At least one step is applied and no draft is open.               |
| Undo latest step | `Ctrl+Alt+Z`    | `Cmd+Alt+Z`   | At least one step is applied and no draft is open.               |

Inside the webview, the edit-latest and cleaning-undo shortcuts are ignored while focus is in an input, textarea,
select, or editable content so they do not replace the control's editing behavior. `Escape` closes the highest-priority
surface in this order: the operation dialog, an applied-step inspection, the profiles drawer, then a draft.

If focused **Undo** removes the last applied step, focus moves to **Add step** after the confirmed response. This
restoration occurs only while that Undo control remains the focus origin and the webview still owns focus.

## Themes, high contrast, and zoom

The workbench takes its foreground, background, selection, focus, input, button, chart, and border colors from VS Code
theme tokens. It supports light and dark color schemes and adds forced-color rules for controls, focus indicators,
disabled states, pressed states, grid changes, and histogram selection. Draft and inspection changes use text labels
and accessible names in addition to color.

The responsive acceptance fixtures cover light, dark, high-contrast dark and light, 80%, 150%, and 200% zoom, narrow
320-pixel layouts, and forced colors. Open Wrangler has no separate zoom control; it follows the editor's webview zoom.
At short heights or high zoom, header profiles can hide their distribution charts while retaining exact statistics.
The layout change is announced. If focus was inside a chart that disappears, focus moves to **Header profiles**.

## Current limitations

- Large grids virtualize both dimensions. Keyboard navigation requests off-screen data as needed, but cells outside
  the rendered window are not present in the document at the same time.
- Pointer range selection advances only through rendered cells. Use Shift-modified keyboard navigation to extend a
  range farther than bounded edge scrolling can reveal during a drag.
- PySpark does not expose an exact grid row count until traversal reaches its terminal page. Before then, the row-count
  status says that the total appears after the last page.
- Some distributions are intentionally non-interactive when the backend or current state does not permit filtering.
  The **Other** category cannot be filtered directly; use **More values…** or the Filters value search when available.
- `Escape` closes the open column-search list, but the event also reaches the workbench shortcut handler. If a draft
  is open and no dialog, inspection, or drawer has priority, that same key discards the draft.
- Automated coverage runs tagged WCAG 2.0, 2.1, and 2.2 axe rules in production-bundle Chromium fixtures and rejects
  non-minor violations. It also exercises specific keyboard and focus workflows. This coverage is not screen-reader
  certification and does not prove every editor, operating system, zoom level, or assistive-technology combination.

## Report an accessibility problem

Run **Open Wrangler: Report Issue** from the Command Palette or the Open Wrangler view menu. The command opens a
GitHub issue with the editor version, operating-system family, and an empty reproduction section already filled in.
It does not attach dataframe content, notebooks, logs, screenshots, or environment dumps.

Include the Open Wrangler and editor versions, operating system, theme, zoom level, assistive technology and version,
the focused control, the exact key sequence, and the expected and observed result. Prefer a small synthetic dataframe.
Review any diagnostic excerpt or screenshot before attaching it.

Never post proprietary data, credentials, notebook secrets, full environment dumps, or screenshots that expose data,
paths, notifications, or account details. Reproduce the problem with invented labels and values when possible. Report
a security-sensitive accessibility problem through GitHub's private vulnerability-reporting channel described in
`SECURITY.md`, not through a public issue.
