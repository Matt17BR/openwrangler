/** Opens Parquet and Excel files by default. */
export const DEFAULT_DATA_EDITOR_ID = "openWrangler.viewer";
/** Offers CSV, TSV and JSON Lines files through Reopen Editor With, so the text editor stays their default. */
export const TEXT_DATA_EDITOR_ID = "openWrangler.textDataViewer";
export const CUSTOM_EDITOR_IDS: readonly string[] = [DEFAULT_DATA_EDITOR_ID, TEXT_DATA_EDITOR_ID];
