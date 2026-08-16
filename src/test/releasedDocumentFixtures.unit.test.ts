import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASED_JUPYTER_R_BINDING_RESULT,
  RELEASED_JUPYTER_R_KERNEL_RESULT,
  RELEASED_JUPYTER_R_MEDIA_RESULT,
  RELEASED_JUPYTER_R_SETUP_RESULT,
  releasedRDocumentCleanedCsv,
  releasedRNotebookCleanedCsvHeader,
  releasedRNotebookCleanedCsvRow,
  writeReleasedPythonQuartoDocumentFixture,
  writeReleasedRDocumentFixture,
  writeReleasedRLiterateDocumentFixture,
  writeReleasedRNotebook
} from "./extensionHost/releasedDocumentFixtures";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-released-documents-"));
  roots.push(root);
  return root;
}

describe("released R document fixtures", () => {
  it("writes one self-contained R script fixture and immutable supporting files", () => {
    const fixture = writeReleasedRDocumentFixture(fixtureRoot());
    const source = readFileSync(fixture.sourceUri.fsPath, "utf8");
    const csv = readFileSync(fixture.immutableFiles.find(({ path }) => path.endsWith("orders.csv"))!.path, "utf8");

    expect(source).toContain('source("helpers.R", local = TRUE)');
    expect(source).toContain('writeLines(as.character(Sys.getpid()), "open-wrangler-r.pid"');
    expect(csv.trimEnd().split("\n")).toHaveLength(241);
    expect(csv).toContain("240,B,240,order-240");
    expect(fixture.immutableFiles).toHaveLength(4);
    for (const file of fixture.immutableFiles) expect(readFileSync(file.path)).toEqual(file.bytes);
  });

  it("builds the exact cleaned R document CSV schema and rows", () => {
    const rows = releasedRDocumentCleanedCsv().toString("utf8").trimEnd().split("\n");
    expect(rows).toHaveLength(241);
    expect(rows[0]).toBe('"record_id","group","score","label"');
    expect(rows[1]).toBe('1,"A",1,"order-001"');
    expect(rows[240]).toBe('240,"B",240,"order-240"');
  });

  it("writes executable R Markdown while keeping decoy code non-executable", () => {
    const fixture = writeReleasedRLiterateDocumentFixture(fixtureRoot(), "rmarkdown");
    const source = readFileSync(fixture.sourceUri.fsPath, "utf8");

    expect(fixture.variableName).toBe("literate_orders");
    expect(fixture.processIdPath).toMatch(/open-wrangler-r\.pid$/u);
    expect(source).toContain("```{r orders-preview, echo=FALSE}");
    expect(source).toContain('knitr::kable(utils::head(literate_orders, 8L), caption = "Regional orders preview")');
    expect(source).toContain("A YAML block scalar is not an executable cell");
    expect(source).toContain("A disabled R cell must not run");
  });

  it("writes Quarto with one rendered dataframe preview and a matching CSV schema", () => {
    const fixture = writeReleasedRLiterateDocumentFixture(fixtureRoot(), "quarto");
    const source = readFileSync(fixture.sourceUri.fsPath, "utf8");
    const csv = readFileSync(fixture.immutableFiles.find(({ path }) => path.endsWith("orders.csv"))!.path, "utf8");

    expect(fixture.variableName).toBe("regional_orders");
    expect(fixture.processIdPath).toBeUndefined();
    expect(source).toContain("#| label: regional-orders-preview");
    expect(source).toContain('knitr::kable(utils::head(regional_orders, 8L), caption = "Regional orders preview")');
    expect(csv.trimEnd().split("\n")).toHaveLength(61);
    expect(csv.split("\n")[0]).toBe("order_id,market,score,order_date");
  });
});

describe("released R notebook fixture", () => {
  it("writes the complete local kernel, dataframe, binding, media, and display cells", () => {
    const notebookPath = join(fixtureRoot(), "released-r.ipynb");
    writeReleasedRNotebook(notebookPath, "jupyter-r", { label: "R 4.5", name: "ir45" });
    const notebook = JSON.parse(readFileSync(notebookPath, "utf8")) as {
      cells: Array<{ source: string[] }>;
      metadata: { kernelspec: { display_name: string; language: string; name: string } };
      nbformat: number;
      nbformat_minor: number;
    };
    const sources = notebook.cells.map(({ source }) => source.join(""));

    expect(notebook).toMatchObject({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { display_name: "R 4.5", language: "R", name: "ir45" } }
    });
    expect(sources).toHaveLength(5);
    expect(sources[0]).toContain(RELEASED_JUPYTER_R_KERNEL_RESULT);
    expect(sources[1]).toContain("row_count <- 1205L");
    expect(sources[1]).toContain("group = c(rep('A', 602L), rep('B', row_count - 602L))");
    expect(sources[1]).toContain("orders_frame$extra_18 <- ifelse(seq_len(row_count) %% 2L == 1L, 'A|B', 'B')");
    expect(sources[1]).toContain(RELEASED_JUPYTER_R_SETUP_RESULT);
    expect(sources[1]).toContain("privateLibraryFirst = identical");
    expect(sources[2]).toContain(RELEASED_JUPYTER_R_BINDING_RESULT);
    expect(sources[3]).toContain(RELEASED_JUPYTER_R_MEDIA_RESULT);
    expect(sources[4]).toContain("orders_frame");
  });

  it("writes the remote kernel attestation without claiming a private local library", () => {
    const notebookPath = join(fixtureRoot(), "released-r-remote.ipynb");
    writeReleasedRNotebook(notebookPath, "jupyter-r-remote", { label: "Remote R", name: "ir-remote" });
    const notebook = JSON.parse(readFileSync(notebookPath, "utf8")) as { cells: Array<{ source: string[] }> };
    const setup = notebook.cells[1]!.source.join("");

    expect(setup).toContain("list(privateLibraryFirst = NA, irKernelFromPrivateLibrary = NA)");
    expect(setup).not.toContain("privateLibraryFirst = identical");
  });

  it("builds the exact cleaned notebook CSV schema and categorical boundary rows", () => {
    expect(releasedRNotebookCleanedCsvHeader().split(",")).toHaveLength(25);
    expect(releasedRNotebookCleanedCsvHeader()).toContain('"extra_18","extra_19","extra_20"');
    expect(releasedRNotebookCleanedCsvRow(1).split(",")).toHaveLength(25);
    expect(releasedRNotebookCleanedCsvRow(1)).toContain('"A|B",2026-01-01,');
    expect(releasedRNotebookCleanedCsvRow(2)).toContain('"B",2026-01-02,"value-20-0002"');
    expect(releasedRNotebookCleanedCsvRow(1_205)).toContain('1205,"B",1205,"row-1205",1205.25');
    expect(() => releasedRNotebookCleanedCsvRow(0)).toThrow();
    expect(() => releasedRNotebookCleanedCsvRow(1_206)).toThrow();
  });
});

describe("released Python Quarto fixture", () => {
  it("writes one active dataframe chunk and a distinct later sentinel chunk", () => {
    const fixture = writeReleasedPythonQuartoDocumentFixture(fixtureRoot());
    const source = readFileSync(fixture.sourceUri.fsPath, "utf8");

    expect(source.match(/```\{python\}/gu)).toHaveLength(2);
    expect(source).toContain(`${fixture.variableName} = pd.DataFrame({`);
    expect(source).toContain(`${fixture.sentinelName} = pd.DataFrame({"unexpected": [1]})`);
    expect(fixture.immutableFiles).toEqual([{ path: fixture.sourceUri.fsPath, bytes: Buffer.from(source, "utf8") }]);
  });
});
