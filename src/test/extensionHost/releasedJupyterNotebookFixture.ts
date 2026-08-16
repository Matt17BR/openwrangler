import { writeFileSync } from "node:fs";

export const RELEASED_JUPYTER_SETUP_RESULT = "__OW_RELEASED_SETUP__";
export const RELEASED_JUPYTER_RESTART_RESULT = "__OW_RELEASED_RESTART__";
export const RELEASED_JUPYTER_RUNTIME_RESULT = "__OW_RELEASED_RUNTIME__";
export const RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT = "__OW_RELEASED_DUCKDB_ALIVE__";
export const RELEASED_JUPYTER_SESSION_COUNT_RESULT = "__OW_RELEASED_SESSION_COUNT__";

export interface ReleasedJupyterNotebookKernelTarget {
  readonly label: string;
  readonly name: string;
}

export interface ReleasedJupyterNotebookFixture {
  readonly cells: ReadonlyArray<{
    readonly cell_type: "code";
    readonly execution_count: null;
    readonly metadata: Readonly<Record<string, never>>;
    readonly outputs: readonly [];
    readonly source: readonly string[];
  }>;
  readonly metadata: {
    readonly kernelspec: { readonly display_name: string; readonly language: "python"; readonly name: string };
    readonly language_info: { readonly name: "python" };
  };
  readonly nbformat: 4;
  readonly nbformat_minor: 5;
}

export function releasedJupyterNotebookFixture(
  setupMarker: string,
  target: ReleasedJupyterNotebookKernelTarget,
  hostExtensionPath: string
): ReleasedJupyterNotebookFixture {
  const setup = [
    "import importlib.util",
    "import json",
    "import os",
    "import socket",
    "import sys",
    "from datetime import date, timedelta",
    "import duckdb",
    "import pandas as pd",
    "import polars as pl",
    "pandas_frame = pd.DataFrame({'value': [1, 2], 'label': ['a', 'b']})",
    "pandas_series = pd.Series([5, 6], name='series_value')",
    "showcase_rows = 100000",
    "showcase_markets = ['DACH', 'Nordics', 'Iberia', 'France', 'Italy', 'Benelux', 'UK & Ireland']",
    "showcase_segments = ['Enterprise', 'Mid-market', 'Public sector', 'Small business']",
    "showcase_channels = ['Direct', 'Partner', 'Online']",
    "showcase_products = ['Analytics', 'Automation', 'Data platform', 'Operations', 'Planning']",
    "showcase_priorities = ['High', 'Standard', 'Strategic']",
    "showcase_statuses = ['Active', 'Expansion', 'Renewal review']",
    "orders_df = pd.DataFrame({",
    "    'order_id': list(range(2400001, 2400001 + showcase_rows)),",
    "    'market': [showcase_markets[index % len(showcase_markets)] for index in range(showcase_rows)],",
    "    'revenue': [round(620.50 + ((index * 7919) % 1850000) / 100, 2) for index in range(showcase_rows)],",
    "    'fulfilled': [index % 7 != 2 for index in range(showcase_rows)],",
    "    'order_date': pd.to_datetime('2026-01-01') + pd.to_timedelta([index % 365 for index in range(showcase_rows)], unit='D'),",
    "    'segment': [showcase_segments[index % len(showcase_segments)] for index in range(showcase_rows)],",
    "    'channel': [showcase_channels[index % len(showcase_channels)] for index in range(showcase_rows)],",
    "    'product_family': [showcase_products[index % len(showcase_products)] for index in range(showcase_rows)],",
    "    'units': [1 + ((index * 7 + 2) % 12) for index in range(showcase_rows)],",
    "    'unit_price': [round(79 + ((index * 3571) % 92000) / 100, 2) for index in range(showcase_rows)],",
    "    'discount_pct': [round(((index * 37) % 1800) / 100, 2) for index in range(showcase_rows)],",
    "    'gross_margin': [round(180 + ((index * 1451) % 610000) / 100, 2) for index in range(showcase_rows)],",
    "    'priority': [showcase_priorities[index % len(showcase_priorities)] for index in range(showcase_rows)],",
    "    'renewal_date': pd.to_datetime('2027-01-01') + pd.to_timedelta([index % 365 for index in range(showcase_rows)], unit='D'),",
    "    'account_status': [showcase_statuses[index % len(showcase_statuses)] for index in range(showcase_rows)],",
    "})",
    "showcase_preview_columns = [",
    "    'order_id', 'market', 'revenue', 'fulfilled', 'order_date', 'segment',",
    "    'channel', 'product_family', 'units', 'unit_price', 'discount_pct', 'gross_margin',",
    "]",
    "orders_preview_df = orders_df.loc[:, showcase_preview_columns].copy()",
    "orders_preview_df['order_date'] = orders_preview_df['order_date'].dt.date",
    "polars_frame = pl.DataFrame({",
    "    'units': [1 + ((index * 7 + 2) % 12) for index in range(showcase_rows)],",
    "    'order_id': list(range(2400001, 2400001 + showcase_rows)),",
    "    'market': [showcase_markets[index % len(showcase_markets)] for index in range(showcase_rows)],",
    "    'revenue': [round(620.50 + ((index * 6151) % 1250000) / 100, 2) for index in range(showcase_rows)],",
    "    'fulfilled': [index % 7 != 2 for index in range(showcase_rows)],",
    "    'order_date': [date(2026, 1, 1) + timedelta(days=index % 365) for index in range(showcase_rows)],",
    "    'segment': [showcase_segments[index % len(showcase_segments)] for index in range(showcase_rows)],",
    "    'channel': [showcase_channels[index % len(showcase_channels)] for index in range(showcase_rows)],",
    "    'product_family': [showcase_products[index % len(showcase_products)] for index in range(showcase_rows)],",
    "    'unit_price': [round(79 + ((index * 3571) % 92000) / 100, 2) for index in range(showcase_rows)],",
    "    'discount_pct': [round(((index * 37) % 1800) / 100, 2) for index in range(showcase_rows)],",
    "    'gross_margin': [round(180 + ((index * 1451) % 610000) / 100, 2) for index in range(showcase_rows)],",
    "    'priority': [showcase_priorities[index % len(showcase_priorities)] for index in range(showcase_rows)],",
    "    'renewal_date': [date(2027, 1, 1) + timedelta(days=index % 365) for index in range(showcase_rows)],",
    "    'account_status': [showcase_statuses[index % len(showcase_statuses)] for index in range(showcase_rows)],",
    "})",
    "polars_series = pl.Series('series_value', [7, 8])",
    "duckdb_connection = duckdb.connect()",
    'duckdb_connection.execute(f"CREATE TABLE private_duck_orders AS SELECT ' +
      "3400001 + row_index AS order_id, " +
      "CASE row_index % 4 WHEN 0 THEN 'DACH' WHEN 1 THEN 'Nordics' WHEN 2 THEN 'Iberia' ELSE 'Benelux' END AS market, " +
      "CAST(100.50 + ((row_index * 17) % 500000) / 100.0 AS DECIMAL(18,2)) AS revenue, " +
      "DATE '2026-01-01' + CAST(row_index % 365 AS INTEGER) AS order_date " +
      'FROM range({showcase_rows}) AS source(row_index)")',
    "duckdb_relation = duckdb_connection.table('private_duck_orders')",
    "def _open_wrangler_forbid_duckdb_conversion(*_args, **_kwargs):",
    "    raise AssertionError('DuckDB notebook acceptance forbids conversion through Pandas, Polars, or Arrow')",
    "for _duckdb_conversion_name in ('df', 'to_df', 'fetchdf', 'pl', 'arrow'):",
    "    setattr(duckdb.DuckDBPyRelation, _duckdb_conversion_name, _open_wrangler_forbid_duckdb_conversion)",
    `openwrangler_restart_marker = ${JSON.stringify(setupMarker)}`,
    `print(${JSON.stringify(RELEASED_JUPYTER_SETUP_RESULT)} + json.dumps({` +
      "'executable': sys.executable, 'pid': os.getpid(), " +
      "'runtime': importlib.util.find_spec('openwrangler_runtime') is not None, " +
      "'duckdbConversionGuards': all(" +
      "getattr(duckdb.DuckDBPyRelation, name) is _open_wrangler_forbid_duckdb_conversion " +
      "for name in ('df', 'to_df', 'fetchdf', 'pl', 'arrow')), " +
      "'remoteRunId': os.environ.get('OPEN_WRANGLER_REMOTE_RUN_ID'), " +
      "'hostname': socket.gethostname(), " +
      `'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)}), ` +
      "'setup': openwrangler_restart_marker" +
      "}, sort_keys=True))"
  ];
  return {
    cells: [
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: setup.map((line) => `${line}\n`)
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ["# Explore recent orders in Open Wrangler\n", "orders_preview_df\n", "\n"]
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ["# Open a temporary result without assigning it\n", "orders_preview_df.tail(3)\n"]
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          "import importlib.util, json, os, socket, sys\n",
          `print(${JSON.stringify(RELEASED_JUPYTER_RESTART_RESULT)} + json.dumps({` +
            "'pid': os.getpid(), " +
            "'runtime': importlib.util.find_spec('openwrangler_runtime') is not None, " +
            "'bootstrap': ('__ow_bundle_root' in globals() and str(globals().get('__ow_bundle_root')) in sys.path), " +
            "'remoteRunId': os.environ.get('OPEN_WRANGLER_REMOTE_RUN_ID'), " +
            "'hostname': socket.gethostname(), " +
            `'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)}), ` +
            "'setup': globals().get('openwrangler_restart_marker')" +
            "}, sort_keys=True))\n"
        ]
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          "import json, os, socket\n",
          "import openwrangler_runtime\n",
          `print(${JSON.stringify(RELEASED_JUPYTER_RUNTIME_RESULT)} + json.dumps({` +
            "'runtimeFile': openwrangler_runtime.__file__, " +
            "'remoteRunId': os.environ.get('OPEN_WRANGLER_REMOTE_RUN_ID'), " +
            "'hostname': socket.gethostname(), " +
            `'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)})` +
            "}, sort_keys=True))\n"
        ]
      },
      { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["duckdb_relation\n"] },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          "import json\n",
          `print(${JSON.stringify(RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT)} + json.dumps({` +
            "'count': duckdb_relation.aggregate('count(*) AS count').fetchone()[0], " +
            "'connectionCount': duckdb_connection.execute(" +
            "'SELECT count(*) FROM private_duck_orders').fetchone()[0], " +
            "'first': duckdb_relation.order('order_id').limit(1).fetchone()[0], " +
            "'conversionGuards': all(" +
            "getattr(duckdb.DuckDBPyRelation, name) is _open_wrangler_forbid_duckdb_conversion " +
            "for name in ('df', 'to_df', 'fetchdf', 'pl', 'arrow'))" +
            "}, sort_keys=True))\n"
        ]
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          "import json\n",
          "import openwrangler_runtime.kernel_agent as __ow_kernel_agent\n",
          `print(${JSON.stringify(RELEASED_JUPYTER_SESSION_COUNT_RESULT)} + json.dumps({` +
            "'count': len(__ow_kernel_agent._manager.sessions)" +
            "}, sort_keys=True))\n"
        ]
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ["# Open the first plain Jupyter result without rerunning it\n", "orders_preview_df.tail(3)\n"]
      }
    ],
    metadata: {
      kernelspec: { display_name: target.label, language: "python", name: target.name },
      language_info: { name: "python" }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

export function writeReleasedJupyterNotebook(
  notebookPath: string,
  setupMarker: string,
  target: ReleasedJupyterNotebookKernelTarget,
  hostExtensionPath: string
): void {
  writeFileSync(notebookPath, JSON.stringify(releasedJupyterNotebookFixture(setupMarker, target, hostExtensionPath)));
}
