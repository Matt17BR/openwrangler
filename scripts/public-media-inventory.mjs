export const PUBLIC_MEDIA_ROOT_PATH = "docs/images/readme/";
export const PUBLIC_MEDIA_SERIES_PATH = `${PUBLIC_MEDIA_ROOT_PATH}v1.2/`;
export const PUBLIC_README_IMAGE_COUNT = 20;
export const PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES = 64;
export const PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH = 4;
export const PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES = 240;

const definitions = [
  ["explore.png", 1_440, 870],
  ["filter-result.png", 1_440, 861],
  ["gallery/applied-step-inspection-detail.png", 995, 320],
  ["gallery/applied-step-inspection.png", 1_440, 870],
  ["gallery/by-example-preview-detail.png", 700, 525],
  ["gallery/by-example-preview.png", 1_280, 760],
  ["gallery/by-example-setup-detail.png", 660, 760],
  ["gallery/by-example-setup.png", 1_080, 760],
  ["gallery/column-search-wide-detail.png", 540, 420],
  ["gallery/column-search-wide.png", 1_440, 865],
  ["gallery/cursor-explore.png", 1_440, 865],
  ["gallery/duckdb-rich-parquet-detail.png", 1_500, 595],
  ["gallery/duckdb-rich-parquet.png", 1_920, 640],
  ["gallery/export-data-detail.png", 995, 344],
  ["gallery/export-data.png", 1_440, 870],
  ["gallery/export-script-detail.png", 995, 230],
  ["gallery/export-script.png", 1_440, 870],
  ["gallery/file-explorer-action-detail.png", 920, 616],
  ["gallery/file-explorer-action.png", 1_440, 870],
  ["gallery/file-title-action.png", 1_440, 120],
  ["gallery/high-contrast-explore.png", 1_440, 845],
  ["gallery/histogram-hover.png", 448, 480],
  ["gallery/import-options.png", 1_440, 870],
  ["gallery/latest-step-edited-detail.png", 448, 440],
  ["gallery/latest-step-edited.png", 1_440, 860],
  ["gallery/latest-step-undone-detail.png", 448, 440],
  ["gallery/latest-step-undone.png", 1_440, 860],
  ["gallery/notebook-code-insertion.png", 1_000, 288],
  ["gallery/notebook-duckdb-detail.png", 872, 700],
  ["gallery/notebook-duckdb.png", 1_440, 900],
  ["gallery/notebook-pandas-detail.png", 698, 535],
  ["gallery/notebook-polars-detail.png", 884, 675],
  ["gallery/notebook-polars.png", 1_440, 900],
  ["gallery/notebook-pyspark-detail.png", 820, 610],
  ["gallery/notebook-pyspark.png", 1_440, 900],
  ["gallery/notebook-r-editing.png", 1_440, 900],
  ["gallery/r-quarto-variable-picker-detail.png", 1_280, 520],
  ["gallery/r-quarto-variable-picker.png", 1_440, 900],
  ["gallery/notebook-variable-picker-detail.png", 602, 380],
  ["gallery/notebook-variable-picker.png", 1_040, 590],
  ["gallery/operation-catalog.png", 1_280, 874],
  ["gallery/operation-configuration-detail.png", 510, 605],
  ["gallery/operation-configuration.png", 1_280, 874],
  ["gallery/sidebar-overview.png", 1_440, 874],
  ["gallery/sort-priority.png", 448, 480],
  ["gallery/tab-context-menu.png", 540, 570],
  ["notebook-pandas.png", 1_210, 540],
  ["workflow.png", 1_440, 870]
];

export const PUBLIC_MEDIA_ASSETS = Object.freeze(
  definitions.map(([relativePath, logicalWidth, logicalHeight]) =>
    Object.freeze({ relativePath, logicalWidth, logicalHeight })
  )
);
