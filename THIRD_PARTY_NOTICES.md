# Third-party notices

Open Wrangler is distributed under the MIT License. Its production webview bundles include the following independently licensed projects:

- CodeMirror and Lezer, including their bundled support packages: MIT License.
- React, React DOM, and Scheduler: MIT License.
- Codicons font from `@vscode/codicons`: Creative Commons Attribution 4.0 International (CC-BY-4.0).

The bundled pure-Python runtime interoperates with, but does not redistribute, the following packages from the user's selected environment:

- Pandas: BSD 3-Clause License. Loaded from the user's selected Python environment.
- Polars: MIT License. Loaded from the user's selected Python environment.
- DuckDB: MIT License. Loaded from the user's selected Python environment.
- pytz: MIT License. Loaded for deterministic DuckDB time-zone-aware timestamp values.
- PyArrow: Apache License 2.0. Loaded when required by a selected format/engine.
- openpyxl: MIT License. Loaded when Pandas opens modern `.xlsx` workbooks.
- xlrd: BSD licenses. Loaded when Pandas opens legacy `.xls` workbooks.
- fastexcel: MIT License. Loaded when Polars opens `.xlsx` or `.xls` workbooks.

The bundled R runtime can use nanoparquet 0.5.1 or newer from the selected R environment for native Parquet export.
nanoparquet uses the MIT License and is not shipped in the VSIX.

The released-Jupyter acceptance workflow may download a manifest-pinned Ubuntu Xvfb package from the X.Org Server project. X.Org Server uses its canonical MIT/X11 license plus legacy MIT/X11 and BSD-like notices; the downloaded package retains the complete `/usr/share/doc/xvfb/copyright` file. Package sources, versions, and digests are recorded in `scripts/xvfb-packages.json`. Xvfb is test tooling and is not shipped in the VSIX.

Other build and test tooling is not shipped in the VSIX. `npm run license:check` rejects a new bundled production package until its SPDX license and notice group are explicitly approved. Microsoft Data Wrangler is a behavioral reference only; its code and assets are not included.
