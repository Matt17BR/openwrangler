# Troubleshooting Open Wrangler

Start with the notification or error shown by Open Wrangler. The recovery actions below use the current public
commands listed in the [generated interface reference](reference.md). They do not require deleting workspace state or
changing the source data.

## Open Wrangler is unavailable in Restricted Mode

**Symptom.** Open Wrangler commands or editor actions are unavailable, or the editor says the workspace must be
trusted before it can open data or run code.

**Likely cause.** Open Wrangler stays inactive in Restricted Mode. Opening data, starting Python or R, installing
dependencies, running custom code, and exporting require Workspace Trust.

**Safe recovery.** Review the workspace before trusting it. If you know and trust its contents, use the editor's
**Manage Workspace Trust** action, grant trust, and retry the original Open Wrangler action. Keep the workspace in
Restricted Mode if you do not trust it; Open Wrangler cannot run there safely.

**What to include in a report.** Include the editor name and version, whether the workspace is local or remote, the
trust state shown by the editor, and the exact Open Wrangler entry point you tried. Do not attach workspace files just
to demonstrate the trust state.

## Open Wrangler cannot select a Python interpreter

**Symptom.** A file or Python-backed session does not open because no supported interpreter can be found, the
configured executable is unavailable, or a different environment is selected than you expected.

**Likely cause.** `openWrangler.pythonPath` overrides automatic selection when it is set. Otherwise, Open Wrangler
uses the environment selected by the VS Code Python extension and then tries a supported system interpreter. The
interpreter must be Python 3.10 through 3.14 and must be available where the extension host is running.

**Safe recovery.** Use one of these paths, then retry the source:

- Run **Open Wrangler: Change Runtime** and enter the executable path for the intended interpreter.
- Select the intended environment with **Python: Select Interpreter**, then run **Open Wrangler: Clear Runtime
  Override** so the Python extension selection can take effect.

For a remote workspace, choose an interpreter on the remote host. Changing the runtime affects the next Open Wrangler
request; it does not install packages into that environment.

**What to include in a report.** Include the Python version, whether selection came from the Open Wrangler override,
the Python extension, or system discovery, and whether the extension host is local or remote. Replace user and
workspace directories in the interpreter path with placeholders. Do not send a full environment-variable dump.

## Python runtime dependencies are missing or need revalidation

**Symptom.** Open Wrangler lists packages required by the selected backend, or it reports that a previous dependency
change did not finish cleanly and the environment must be checked before another runtime starts.

**Likely cause.** A normal missing-dependency result means the exact selected interpreter does not contain compatible
versions of the packages required for this source and backend. A revalidation request means Open Wrangler recorded an
interrupted or unconfirmed package change for that environment.

The two recovery commands have different purposes:

| Command                                            | Use it when                                                          | Effect                                                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open Wrangler: Install Runtime Dependencies**    | Open Wrangler has listed missing requirements for the current source | Shows the exact requirements and interpreter in a confirmation dialog, then installs them only if you choose **Install**                                                                            |
| **Open Wrangler: Revalidate Runtime Dependencies** | Open Wrangler reports an interrupted or uncertain dependency change  | Waits for any package writer to finish, checks the recorded packages and versions, and clears the recovery marker only after a successful check; it does not install, remove, or overwrite packages |

**Safe recovery.** For missing packages, review the interpreter and requirements in the installation dialog before
confirming. You can instead install the listed requirements with your normal environment manager, using that same
interpreter. Then reselect it with **Open Wrangler: Change Runtime**, or clear the override if you rely on the Python
extension selection, and reopen the source. For an interrupted change, wait for any package manager still using the
environment to finish, repair that environment with its normal tooling if necessary, and run **Open Wrangler:
Revalidate Runtime Dependencies**. If the command cannot find an exact recovery target, reopen the affected source
and try again. Do not remove Open Wrangler state or recovery markers manually.

**What to include in a report.** Include the requirement names shown by Open Wrangler, the Python version, a sanitized
interpreter path, which of the two commands you ran, and whether package installation was interrupted. Add only the
shortest relevant excerpt from the Open Wrangler output channel. Do not attach pip configuration, credential files,
proxy URLs, or an environment export.

## Jupyter variables or previews do not appear

**Symptom.** Open Wrangler cannot find live notebook dataframes, **Open in Open Wrangler** is missing from an output,
automatic dataframe previews use another renderer, or the Jupyter integration check finds no selected kernel.

**Likely cause.** The VS Code Jupyter extension may be missing or disabled, the originating notebook may not have an
active kernel, or the cell that defines the variable has not run in the current kernel. When Microsoft Data Wrangler
is installed, `openWrangler.notebookPreviewProvider` also decides which extension owns automatic Python dataframe
previews.

**Safe recovery.** Install or enable the VS Code Jupyter extension, open the original notebook, and select or start its
kernel. Run the cell that defines the dataframe. Then run **Open Wrangler: Check Jupyter Integration**. For an
automatic-preview conflict, run **Open Wrangler: Choose Notebook Preview Provider** and choose the provider you want.
Rerun the dataframe cell after choosing Open Wrangler. A switch to Data Wrangler or **Disabled** applies to newly
started or restarted Python kernels. Explicit `openwrangler_runtime.notebook.show(...)` output remains available when
automatic previews are assigned elsewhere. Current R notebook sessions require a selected IRkernel and should be
opened through Open Wrangler's R dataframe picker.

**What to include in a report.** Include the editor, Open Wrangler, and Jupyter extension versions; notebook type;
kernel language and version; result of **Open Wrangler: Check Jupyter Integration**; preview-provider setting; and
whether another dataframe renderer is installed. Prefer a small synthetic notebook that reproduces the problem. Do
not attach the original notebook, cell output, or live dataframe.

## A source changed while it was open

**Symptom.** A file-backed grid stops paging or an operation fails after the source was saved, replaced, resized,
moved, or deleted. Open Wrangler asks you to reopen the file.

**Likely cause.** A lazy file session is tied to the version of the source that was present when the session opened.
Open Wrangler rejects later reads when that file no longer matches, so a stale session cannot mix rows from different
source versions.

**Safe recovery.** Let the external save or replacement finish and confirm that the expected file exists. Close the
stale Open Wrangler editor, then open that file again with **Open in Open Wrangler**. Review the reopened schema,
cleaning steps, draft, and viewing state before continuing, especially when columns or types changed. The source does
not need to be rewritten, and Open Wrangler state does not need to be deleted.

**What to include in a report.** Include the file format, resolved dataframe engine, local or remote storage, what kind
of external change occurred, which Open Wrangler action first noticed it, and whether a clean reopen succeeds. Share
column names or a schema summary only when they are not sensitive; otherwise use consistent placeholders or a
synthetic file.

## A backend cannot use the current import options

**Symptom.** A CSV, TSV, or Excel file opens with the wrong columns or sheet, or Open Wrangler says the selected
dataframe engine cannot open the file with its current import options.

**Likely cause.** Automatic detection may not match an unusual source. A pinned backend may also be incompatible with
the selected encoding, delimiter, or quote character. `openWrangler.defaultBackend` set to `auto` chooses among the
compatible file engines; a pinned Pandas, Polars, or DuckDB setting does not fall back to another engine.

**Safe recovery.** Run **Open Wrangler: Change Import Options**, or use **Import options** in the grid, and enter the
file's exact delimiter, encoding, quote character, header choice, or Excel sheet. If the backend itself is the problem,
set `openWrangler.defaultBackend` to `auto` in Settings, close the failed editor, and use **Open in Open Wrangler**
again. In an already open file session, you can choose a compatible engine from the engine badge. Cancelling or
failing a live import-options change leaves the last confirmed session open.

**What to include in a report.** Include the file format, backend preference, resolved engine if one opened, and the
non-sensitive import options involved. For a delimiter or quote issue, include the character or its Unicode code point.
Use a few synthetic rows to reproduce parsing problems instead of sharing the source file.

## Open the Open Wrangler output channel

**Symptom.** A notification identifies the failure but does not contain enough context to distinguish interpreter,
dependency, or runtime startup problems.

**Likely cause.** Detailed Python runtime lifecycle messages and runtime standard error are written to the **Open
Wrangler** channel instead of being placed in every notification.

**Safe recovery.** Open **View → Output**, then choose **Open Wrangler** from the channel picker. If the channel is not
listed, invoke an Open Wrangler command in a trusted workspace so the extension activates. Reproduce the problem once
and inspect the lines written around that attempt.

**What to include in a report.** Copy only the small, relevant excerpt and say which action produced it. Review it
first: the channel can contain source labels, file paths, interpreter paths, and runtime error details. Redact private
identifiers while keeping the error category and ordering intact.

## Share diagnostics without sharing private data

**Symptom.** You can reproduce a problem, but the workspace, screenshot, notebook, or output channel contains data or
environment details that should not leave your machine.

**Likely cause.** Editor surfaces and runtime diagnostics can include paths, source and variable names, interpreter
locations, remote host details, and text produced by a failing runtime.

**Safe recovery.** Reduce the problem to a synthetic file or notebook when possible. Run **Open Wrangler: Report
Issue** to open the issue template, then add the exact command or UI action, expected result, actual result, and the
smallest redacted diagnostic excerpt. Replace private names consistently so the sequence remains understandable.
Inspect screenshots for grid cells, notebook output, tabs, breadcrumbs, terminals, notifications, and account details
before attaching them.

**What to include in a report.** Include Open Wrangler and editor versions, operating system, local or remote host,
source format, selected backend or kernel type, and concise reproduction steps. Do not send a full environment dump,
workspace profile, settings database, complete output channel, original dataset, notebook contents, secrets, tokens,
private keys, or authenticated proxy and registry URLs.
