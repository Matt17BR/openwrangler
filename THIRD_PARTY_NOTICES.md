# Third-party notices

Open Wrangler is distributed under the MIT License. Its production webview bundles include the following independently licensed projects:

- CodeMirror and Lezer, including their bundled support packages: MIT License.
- React, React DOM, and Scheduler: MIT License.
- Codicons font from `@vscode/codicons`: Creative Commons Attribution 4.0 International (CC-BY-4.0).

The extension host bundles js-yaml's CommonJS runtime for bounded Quarto and R Markdown front matter parsing.
js-yaml remains a build-time development dependency; only that runtime file is shipped.
The upstream notice follows in full:

```text
(The MIT License)

Copyright (C) 2011-2015 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The bundled pure-Python runtime interoperates with, but does not redistribute, the following packages from the user's selected environment:

- Pandas: BSD 3-Clause License. Loaded from the user's selected Python environment.
- Polars: MIT License. Loaded from the user's selected Python environment.
- DuckDB: MIT License. Loaded from the user's selected Python environment.
- fsspec 2026.7.0: BSD-3-Clause License. Loaded with DuckDB from the user's selected Python environment.
- pytz: MIT License. Loaded for deterministic DuckDB time-zone-aware timestamp values.
- PyArrow: Apache License 2.0. Loaded when required by a selected format/engine.
- openpyxl: MIT License. Loaded when Pandas opens modern `.xlsx` workbooks.
- xlrd: BSD licenses. Loaded when Pandas opens legacy `.xls` workbooks.
- fastexcel: MIT License. Loaded when Polars opens `.xlsx` or `.xls` workbooks.

The bundled R runtime can use nanoparquet 0.5.1 or newer from the selected R environment for native Parquet export.
nanoparquet uses the MIT License and is not shipped in the VSIX.

The released-Jupyter acceptance workflow may download a manifest-pinned Ubuntu Xvfb package from the X.Org Server project. X.Org Server uses its canonical MIT/X11 license plus legacy MIT/X11 and BSD-like notices; the downloaded package retains the complete `/usr/share/doc/xvfb/copyright` file. Package sources, versions, and digests are recorded in `scripts/xvfb-packages.json`. Xvfb is test tooling and is not shipped in the VSIX.

Other build and test tooling is not shipped in the VSIX. `npm run license:check` rejects a new bundled production package until its SPDX license and notice group are explicitly approved. Microsoft Data Wrangler is a behavioral reference only; its code and assets are not included.
