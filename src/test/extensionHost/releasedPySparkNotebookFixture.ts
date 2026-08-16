import { writeFileSync } from "node:fs";
import {
  RELEASED_JUPYTER_RESTART_RESULT,
  type ReleasedJupyterNotebookKernelTarget
} from "./releasedJupyterNotebookFixture";

export const RELEASED_JUPYTER_PYSPARK_SETUP_RESULT = "__OW_RELEASED_PYSPARK_SETUP__";
export const RELEASED_JUPYTER_PYSPARK_REBIND_RESULT = "__OW_RELEASED_PYSPARK_REBIND__";
export const RELEASED_JUPYTER_PYSPARK_SCHEMA_REBIND_RESULT = "__OW_RELEASED_PYSPARK_SCHEMA_REBIND__";
export const RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT = "__OW_RELEASED_PYSPARK_CLOSE__";

export interface ReleasedPySparkNotebookFixture {
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

export function releasedPySparkNotebookFixture(
  hostExtensionPath: string,
  target: ReleasedJupyterNotebookKernelTarget
): ReleasedPySparkNotebookFixture {
  const cell = (source: readonly string[]) => ({
    cell_type: "code" as const,
    execution_count: null,
    metadata: {},
    outputs: [] as const,
    source: source.map((line) => `${line}\n`)
  });
  return {
    cells: [
      cell([
        "import importlib.util",
        "import json",
        "import os",
        "import sys",
        `print(${JSON.stringify(RELEASED_JUPYTER_RESTART_RESULT)} + json.dumps({`,
        "    'executable': sys.executable,",
        "    'pid': os.getpid(),",
        "    'runtime': importlib.util.find_spec('openwrangler_runtime') is not None,",
        "    'bootstrap': ('__ow_bundle_root' in globals() and str(globals().get('__ow_bundle_root')) in sys.path),",
        "    'setup': None,",
        `    'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)}),`,
        "}, sort_keys=True))"
      ]),
      cell([
        "import json",
        "import os",
        "import sys",
        "os.environ['PYSPARK_PYTHON'] = sys.executable",
        "os.environ['PYSPARK_DRIVER_PYTHON'] = sys.executable",
        "from pyspark.sql import SparkSession",
        "from pyspark.sql import functions as F",
        "def _open_wrangler_forbid_local_conversion(*_args, **_kwargs):",
        "    raise AssertionError('Open Wrangler must keep PySpark execution native')",
        "def _open_wrangler_arm_conversion_traps(frame):",
        "    armed = []",
        "    for method_name in ('toPandas', 'toArrow', 'mapInPandas', 'mapInArrow'):",
        "        if hasattr(type(frame), method_name):",
        "            setattr(type(frame), method_name, _open_wrangler_forbid_local_conversion)",
        "            armed.append(method_name)",
        "    return armed",
        "spark = (SparkSession.builder",
        "    .master('local[2]')",
        "    .appName('open-wrangler-packaged-classic')",
        "    .config('spark.ui.enabled', 'false')",
        "    .config('spark.driver.bindAddress', '127.0.0.1')",
        "    .config('spark.driver.host', '127.0.0.1')",
        "    .config('spark.sql.shuffle.partitions', '2')",
        "    .getOrCreate())",
        "spark.sparkContext.setLogLevel('ERROR')",
        "spark_classic_frame = spark.createDataFrame([",
        "    (1, 'beta', 10.0),",
        "    (2, 'alpha', 30.0),",
        "    (3, 'alpha', 20.0),",
        "    (4, 'gamma', None),",
        "], 'record_id long, category string, amount double').repartition(2)",
        "_open_wrangler_classic_conversion_traps = _open_wrangler_arm_conversion_traps(spark_classic_frame)",
        'spark_unsupported_variant_frame = spark.sql("SELECT parse_json(\'{\\"region\\":\\"eu\\"}\') AS payload")',
        "_open_wrangler_variant_conversion_traps = _open_wrangler_arm_conversion_traps(spark_unsupported_variant_frame)",
        "def _open_wrangler_label(values, index):",
        "    return F.element_at(",
        "        F.array(*[F.lit(value) for value in values]),",
        "        (F.pmod(index, F.lit(len(values))) + F.lit(1)).cast('int'),",
        "    )",
        "_open_wrangler_index = F.col('id')",
        "spark_orders_frame = spark.range(100000).select(",
        "    F.format_string('ORD-%07d', _open_wrangler_index + F.lit(2400001)).alias('order_id'),",
        "    _open_wrangler_label(['Benelux', 'DACH', 'France', 'Iberia', 'Italy', 'Nordics', 'UK & Ireland'], _open_wrangler_index).alias('market'),",
        "    F.when(",
        "        F.pmod(_open_wrangler_index + F.lit(29), F.lit(113)) == F.lit(0),",
        "        F.lit(None).cast('double'),",
        "    ).otherwise(",
        "        F.round(F.lit(620.50) + F.pmod(_open_wrangler_index * F.lit(7919), F.lit(1850000)) / F.lit(100.0), 2)",
        "    ).alias('revenue'),",
        "    (F.pmod(_open_wrangler_index, F.lit(7)) != F.lit(2)).alias('fulfilled'),",
        "    F.date_add(F.lit('2026-01-01').cast('date'), F.pmod(_open_wrangler_index, F.lit(365)).cast('int')).alias('order_date'),",
        "    _open_wrangler_label(['Enterprise', 'Mid-market', 'Public sector', 'Small business'], _open_wrangler_index).alias('segment'),",
        "    _open_wrangler_label(['Direct', 'Partner', 'Online'], _open_wrangler_index).alias('channel'),",
        "    _open_wrangler_label(['Analytics', 'Automation', 'Data platform', 'Operations', 'Planning'], _open_wrangler_index).alias('product_family'),",
        "    (F.pmod(_open_wrangler_index * F.lit(7) + F.lit(2), F.lit(12)) + F.lit(1)).cast('long').alias('units'),",
        "    F.round(F.lit(79.0) + F.pmod(_open_wrangler_index * F.lit(3571), F.lit(92000)) / F.lit(100.0), 2).alias('unit_price'),",
        "    F.round(F.pmod(_open_wrangler_index * F.lit(37), F.lit(1800)) / F.lit(100.0), 2).alias('discount_pct'),",
        "    F.round(F.lit(180.0) + F.pmod(_open_wrangler_index * F.lit(1451), F.lit(610000)) / F.lit(100.0), 2).alias('gross_margin'),",
        "    _open_wrangler_label(['High', 'Standard', 'Strategic'], _open_wrangler_index).alias('priority'),",
        "    F.date_add(F.lit('2027-01-01').cast('date'), F.pmod(_open_wrangler_index, F.lit(365)).cast('int')).alias('renewal_date'),",
        "    _open_wrangler_label(['Active', 'Expansion', 'Renewal review'], _open_wrangler_index).alias('account_status'),",
        ")",
        `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_SETUP_RESULT)} + json.dumps({`,
        "    'sparkVersion': spark.version,",
        "    'javaVersion': spark.sparkContext._jvm.java.lang.System.getProperty('java.specification.version'),",
        "    'module': type(spark_classic_frame).__module__,",
        "    'pid': os.getpid(),",
        "    'sessionId': f'{os.getpid()}:{id(spark)}',",
        "    'workerPythonPinned': (",
        "        os.environ.get('PYSPARK_PYTHON') == sys.executable",
        "        and os.environ.get('PYSPARK_DRIVER_PYTHON') == sys.executable",
        "    ),",
        "    'conversionTraps': _open_wrangler_classic_conversion_traps,",
        "    'variantConversionTraps': _open_wrangler_variant_conversion_traps,",
        "}, sort_keys=True))"
      ]),
      cell([
        "spark.stop()",
        "spark = (SparkSession.builder",
        "    .master('local[2]')",
        "    .appName('open-wrangler-packaged-classic-rebound')",
        "    .config('spark.ui.enabled', 'false')",
        "    .config('spark.driver.bindAddress', '127.0.0.1')",
        "    .config('spark.driver.host', '127.0.0.1')",
        "    .config('spark.sql.shuffle.partitions', '2')",
        "    .getOrCreate())",
        "spark.sparkContext.setLogLevel('ERROR')",
        "spark_classic_frame = spark.createDataFrame([",
        "    (101, 'beta', 110.0),",
        "    (102, 'alpha', 130.0),",
        "    (103, 'alpha', 120.0),",
        "    (104, 'gamma', None),",
        "], 'record_id long, category string, amount double').repartition(2)",
        "_open_wrangler_classic_conversion_traps = _open_wrangler_arm_conversion_traps(spark_classic_frame)",
        `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_REBIND_RESULT)} + json.dumps({`,
        "    'module': type(spark_classic_frame).__module__,",
        "    'pid': os.getpid(),",
        "    'sessionId': f'{os.getpid()}:{id(spark)}',",
        "}, sort_keys=True))"
      ]),
      cell([
        "spark.stop()",
        "spark = (SparkSession.builder",
        "    .master('local[2]')",
        "    .appName('open-wrangler-packaged-classic-schema-rebound')",
        "    .config('spark.ui.enabled', 'false')",
        "    .config('spark.driver.bindAddress', '127.0.0.1')",
        "    .config('spark.driver.host', '127.0.0.1')",
        "    .config('spark.sql.shuffle.partitions', '2')",
        "    .getOrCreate())",
        "spark.sparkContext.setLogLevel('ERROR')",
        "spark_classic_frame = spark.createDataFrame([",
        "    (201, 'beta-rebound', 210.0),",
        "    (202, 'alpha-rebound', 230.0),",
        "    (203, 'alpha-rebound', 220.0),",
        "], 'record_id long, category_label string, amount double').repartition(2)",
        "_open_wrangler_classic_conversion_traps = _open_wrangler_arm_conversion_traps(spark_classic_frame)",
        `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_SCHEMA_REBIND_RESULT)} + json.dumps({`,
        "    'module': type(spark_classic_frame).__module__,",
        "    'pid': os.getpid(),",
        "    'sessionId': f'{os.getpid()}:{id(spark)}',",
        "    'schema': [",
        "        {'name': field.name, 'type': field.dataType.simpleString()}",
        "        for field in spark_classic_frame.schema.fields",
        "    ],",
        "}, sort_keys=True))"
      ]),
      cell([
        "import json",
        "import openwrangler_runtime.kernel_agent as __ow_kernel_agent",
        "_open_wrangler_classic_count = spark.range(3).count()",
        `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT)} + json.dumps({`,
        "    'count': _open_wrangler_classic_count,",
        "    'sessionId': f'{os.getpid()}:{id(spark)}',",
        "    'runtimeSessions': len(__ow_kernel_agent._manager.sessions),",
        "    'runtimeSessionIds': sorted(__ow_kernel_agent._manager.sessions),",
        "}, sort_keys=True))"
      ]),
      cell([
        "import json",
        "import os",
        "import sys",
        "os.environ['PYSPARK_PYTHON'] = sys.executable",
        "os.environ['PYSPARK_DRIVER_PYTHON'] = sys.executable",
        "spark.stop()",
        "connect_spark = (SparkSession.builder",
        "    .remote('local[2]')",
        "    .config('spark.sql.shuffle.partitions', '2')",
        "    .getOrCreate())",
        "spark_connect_frame = connect_spark.createDataFrame([",
        "    (1, 'beta', 10.0),",
        "    (2, 'alpha', 30.0),",
        "    (3, 'alpha', 20.0),",
        "    (4, 'gamma', None),",
        "], 'record_id long, category string, amount double').repartition(2)",
        "_open_wrangler_connect_conversion_traps = _open_wrangler_arm_conversion_traps(spark_connect_frame)",
        `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_SETUP_RESULT)} + json.dumps({`,
        "    'sparkVersion': connect_spark.version,",
        "    'module': type(spark_connect_frame).__module__,",
        "    'pid': os.getpid(),",
        "    'sessionId': str(id(connect_spark)),",
        "    'workerPythonPinned': (",
        "        os.environ.get('PYSPARK_PYTHON') == sys.executable",
        "        and os.environ.get('PYSPARK_DRIVER_PYTHON') == sys.executable",
        "    ),",
        "    'conversionTraps': _open_wrangler_connect_conversion_traps,",
        "}, sort_keys=True))"
      ]),
      cell([
        "connect_spark.stop()",
        "connect_spark = (SparkSession.builder",
        "    .remote('local[2]')",
        "    .config('spark.sql.shuffle.partitions', '2')",
        "    .getOrCreate())",
        "spark_connect_frame = connect_spark.createDataFrame([",
        "    (101, 'beta', 110.0),",
        "    (102, 'alpha', 130.0),",
        "    (103, 'alpha', 120.0),",
        "    (104, 'gamma', None),",
        "], 'record_id long, category string, amount double').repartition(2)",
        "_open_wrangler_connect_conversion_traps = _open_wrangler_arm_conversion_traps(spark_connect_frame)",
        `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_REBIND_RESULT)} + json.dumps({`,
        "    'module': type(spark_connect_frame).__module__,",
        "    'pid': os.getpid(),",
        "    'sessionId': str(id(connect_spark)),",
        "}, sort_keys=True))"
      ]),
      cell([
        "import json",
        "_open_wrangler_connect_count = connect_spark.range(3).count()",
        "_open_wrangler_connect_session_id = str(id(connect_spark))",
        "connect_spark.stop()",
        `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT)} + json.dumps({`,
        "    'count': _open_wrangler_connect_count,",
        "    'sessionId': _open_wrangler_connect_session_id,",
        "}, sort_keys=True))"
      ])
    ],
    metadata: {
      kernelspec: { display_name: target.label, language: "python", name: target.name },
      language_info: { name: "python" }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

export function writeReleasedPySparkNotebook(
  notebookPath: string,
  hostExtensionPath: string,
  target: ReleasedJupyterNotebookKernelTarget
): void {
  writeFileSync(notebookPath, JSON.stringify(releasedPySparkNotebookFixture(hostExtensionPath, target)));
}
