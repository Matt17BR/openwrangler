import { describe, expect, it } from "vitest";
import {
  formatGeneratedRDocumentCode,
  prepareRDocumentSource,
  rDocumentKind,
  rDocumentLabel
} from "../extension/r/rDocumentSource";

describe("R document source preparation", () => {
  it("recognizes plain R, R Markdown, and Quarto paths case-insensitively", () => {
    expect(rDocumentKind("/workspace/analysis.R")).toBe("r");
    expect(rDocumentKind("/workspace/analysis.RMD")).toBe("rmarkdown");
    expect(rDocumentKind("/workspace/analysis.Qmd")).toBe("quarto");
    expect(rDocumentKind("/workspace/analysis.md")).toBeUndefined();
    expect(rDocumentLabel("rmarkdown")).toBe("R Markdown document");
  });

  it("runs a plain R source exactly as captured", () => {
    const source = "orders <- data.frame(id = 1:3)\r\nprint(orders)\r\n";
    expect(prepareRDocumentSource("/workspace/orders.R", source)).toEqual({
      kind: "r",
      executableText: source,
      executableUnits: [source],
      rChunkCount: 0,
      runnableRChunkCount: 0
    });
  });

  it("extracts real fenced R cells while preserving source line numbers", () => {
    const source = [
      "---",
      "title: Orders",
      "---",
      "",
      "Narrative with `r nrow(orders)` inline code.",
      "",
      "```{python}",
      "orders = 'not R'",
      "```",
      "",
      "```{r setup, echo=FALSE}",
      "library(tibble)",
      "orders <- tibble(id = 1:3)",
      "```",
      "",
      "```{R}",
      "summary_frame <- data.frame(rows = nrow(orders))",
      "```",
      ""
    ].join("\n");
    const prepared = prepareRDocumentSource("/workspace/orders.qmd", source);

    expect(prepared.kind).toBe("quarto");
    expect(prepared.rChunkCount).toBe(2);
    expect(prepared.runnableRChunkCount).toBe(2);
    const lines = prepared.executableText.split("\n");
    expect(lines).toHaveLength(source.split("\n").length);
    expect(lines[4]).toBe("");
    expect(lines[7]).toBe("");
    expect(lines[11]).toBe("library(tibble)");
    expect(lines[12]).toBe("orders <- tibble(id = 1:3)");
    expect(lines[16]).toBe("summary_frame <- data.frame(rows = nrow(orders))");
    expect(prepared.executableUnits).toEqual([
      "library(tibble)\norders <- tibble(id = 1:3)\n",
      "summary_frame <- data.frame(rows = nrow(orders))\n"
    ]);
  });

  it("does not run cells disabled by R Markdown or Quarto options", () => {
    const source = [
      "```{r hidden, eval=FALSE}",
      "must_not_run <- stop('disabled')",
      "```",
      "",
      "```{r}",
      "#| label: visible",
      "visible <- data.frame(id = 1L)",
      "```",
      "",
      "```{r}",
      "#| eval: false",
      "also_disabled <- stop('disabled')",
      "```",
      ""
    ].join("\n");
    const prepared = prepareRDocumentSource("/workspace/orders.Rmd", source);

    expect(prepared.rChunkCount).toBe(3);
    expect(prepared.runnableRChunkCount).toBe(1);
    expect(prepared.executableText).toContain("visible <- data.frame(id = 1L)");
    expect(prepared.executableText).not.toContain("must_not_run");
    expect(prepared.executableText).not.toContain("also_disabled");
  });

  it("keeps commas inside nested R chunk options", () => {
    const source = [
      '```{r summary, fig.cap=paste("Shots", c("made", "missed"), collapse=", "), fig.alt={paste("Made", "missed")}, fig.pos=list(values=c("H", "t"))[["values"]], echo=FALSE}',
      "shots <- data.frame(made = c(TRUE, FALSE))",
      "```",
      ""
    ].join("\n");

    expect(prepareRDocumentSource("/workspace/analysis.Rmd", source)).toMatchObject({
      rChunkCount: 1,
      runnableRChunkCount: 1,
      executableUnits: ["shots <- data.frame(made = c(TRUE, FALSE))\n"]
    });
  });

  it("skips valid disabled chunks even when they use execution overrides", () => {
    const overrides = ["engine", "child", "code", "file", "ref.label", "opts.label"];
    const chunks = overrides.flatMap((key, index) => {
      const value = key === "ref.label" ? 'all_labels(c("source-a", "source-b"))' : '"other.Rmd"';
      const options = index % 2 === 0 ? `eval=FALSE, ${key}=${value}` : `${key}=${value}, eval=FALSE`;
      return [`\`\`\`{r, ${options}}`, "stop('disabled')", "```", ""];
    });
    chunks.push("```{r}", "#| child: other.Rmd", "#| eval: false", "stop('disabled')", "```", "");
    chunks.push("```{r}", "#| eval: false", "#| file: replacement.R", "stop('disabled')", "```", "");

    expect(prepareRDocumentSource("/workspace/analysis.Rmd", chunks.join("\n"))).toMatchObject({
      rChunkCount: 8,
      runnableRChunkCount: 0,
      executableUnits: []
    });
  });

  it("still rejects enabled or malformed nested execution options", () => {
    expect(() =>
      prepareRDocumentSource(
        "/workspace/analysis.Rmd",
        '```{r, ref.label=all_labels(c("source-a", "source-b"))}\norders <- data.frame(id = 1L)\n```\n'
      )
    ).toThrow(/ref\.label/u);
    expect(() =>
      prepareRDocumentSource(
        "/workspace/analysis.qmd",
        [
          "```{r}",
          "#| label: disabled-template",
          "#| eval: false",
          "invisible(NULL)",
          "```",
          "",
          "```{r}",
          "#| opts-label: disabled-template",
          'stop("must not run")',
          "```",
          ""
        ].join("\n")
      )
    ).toThrow(/opts\.label/u);
    expect(() =>
      prepareRDocumentSource(
        "/workspace/analysis.qmd",
        "```{r}\n#| ref-label: source-chunk\nstop('must not run')\n```\n"
      )
    ).toThrow(/ref\.label/u);
    for (const options of [
      'eval=FALSE, ref.label=all_labels(c("source-a", "source-b")',
      'eval=FALSE, ref.label=all_labels(c("source-a", "source-b"]',
      "eval=FALSE, child="
    ]) {
      expect(() =>
        prepareRDocumentSource("/workspace/analysis.Rmd", `\`\`\`{r, ${options}}\nstop('disabled')\n\`\`\`\n`)
      ).toThrow(/unbalanced option delimiters|plain key=value/u);
    }
    const nested = `${"(".repeat(65)}1${")".repeat(65)}`;
    expect(() =>
      prepareRDocumentSource(
        "/workspace/analysis.Rmd",
        `\`\`\`{r, eval=FALSE, fig.cap=${nested}}\nstop('disabled')\n\`\`\`\n`
      )
    ).toThrow(/nested beyond 64 levels/u);
    expect(() =>
      prepareRDocumentSource("/workspace/analysis.Rmd", "```{r}\n#| eval: false\n#| child:\nstop('disabled')\n```\n")
    ).toThrow(/plain key: value/u);
    for (const options of [
      'fig.cap=local({identity(r"(one " quote)")}), eval=FALSE',
      "fig.cap=local({identity(r'(one ' quote)')}), eval=FALSE"
    ]) {
      expect(() =>
        prepareRDocumentSource("/workspace/analysis.Rmd", `\`\`\`{r, ${options}}\nstop("disabled")\n\`\`\`\n`)
      ).toThrow(/raw-string options/u);
    }
    expect(() =>
      prepareRDocumentSource(
        "/workspace/analysis.Rmd",
        "```{r, foo=quote(1 %x'y% 2), eval=FALSE, bar=quote(1 %a'b% 2)}\nstop('disabled')\n```\n"
      )
    ).toThrow(/special infix operators/u);
  });

  it("never treats fences embedded in YAML or HTML comments as R cells", () => {
    const source = [
      "---",
      "title: Safe document",
      "payload: |",
      "  ```{r}",
      "  must_not_run_from_yaml <- system('false')",
      "  ```",
      "---",
      "",
      "<!--",
      "```{r}",
      "must_not_run_from_comment <- system('false')",
      "```",
      "-->",
      "",
      "```{r}",
      "orders <- data.frame(id = 1L)",
      "```",
      ""
    ].join("\n");
    const prepared = prepareRDocumentSource("/workspace/orders.qmd", source);

    expect(prepared.rChunkCount).toBe(1);
    expect(prepared.runnableRChunkCount).toBe(1);
    expect(prepared.executableText).toContain("orders <- data.frame(id = 1L)");
    expect(prepared.executableText).not.toContain("must_not_run");
    expect(prepared.executableText.split("\n")).toHaveLength(source.split("\n").length);
  });

  it("keeps R-looking text inside a non-R fence inert even when its info contains an HTML comment", () => {
    const source = [
      "```text <!-- example -->",
      "```{r}",
      "must_not_run <- system('false')",
      "```",
      "",
      "```{r}",
      "orders <- data.frame(id = 1L)",
      "```",
      ""
    ].join("\n");
    const prepared = prepareRDocumentSource("/workspace/orders.qmd", source);

    expect(prepared.rChunkCount).toBe(1);
    expect(prepared.runnableRChunkCount).toBe(1);
    expect(prepared.executableText).toContain("orders <- data.frame(id = 1L)");
    expect(prepared.executableText).not.toContain("must_not_run");
  });

  it("ignores horizontal rules, display math, and raw TeX that do not contain executable cells", () => {
    const source = [
      "---",
      "title: Real document",
      "---",
      "",
      "---",
      "",
      "<!--- \\vfill",
      "\\raggedleft",
      "Rendered cover art",
      "\\vfill --->",
      "",
      "\\AddToHookNext{shipout/background}{%",
      "  \\put (3.4in,-\\paperheight){Rendered background}",
      "}",
      "",
      "\\newpage",
      "\\tableofcontents",
      "$$",
      "E = mc^2",
      "$$",
      "\\begin{center}",
      "Rendered title",
      "\\end{center}",
      "",
      '```{r 3ptprog, out.width="100%", fig.cap="Three-point field goals"}',
      "shots <- data.frame(made = c(TRUE, FALSE))",
      "```",
      "",
      "```{r setup, include=FALSE, purl=TRUE}",
      "summary_frame <- data.frame(rows = nrow(shots))",
      "```",
      ""
    ].join("\n");

    const prepared = prepareRDocumentSource("/workspace/analysis.Rmd", source);
    expect(prepared).toMatchObject({ rChunkCount: 2, runnableRChunkCount: 2 });
    expect(prepared.executableUnits).toEqual([
      "shots <- data.frame(made = c(TRUE, FALSE))\n",
      "summary_frame <- data.frame(rows = nrow(shots))\n"
    ]);
  });

  it("fails closed when an R fence is hidden inside raw HTML, display math, or raw TeX", () => {
    for (const [label, source] of [
      ["raw HTML", "<script type=\"text/plain\">\n```{r}\nsystem('false')\n```\n</script>\n"],
      ["display math", "$$\n```{r}\nsystem('false')\n```\n$$\n"],
      ["raw TeX", "\\begin{verbatim}\n```{r}\nsystem('false')\n```\n\\end{verbatim}\n"]
    ] as const) {
      expect(() => prepareRDocumentSource("/workspace/orders.qmd", source), label).toThrow(
        /cannot safely distinguish/u
      );
    }
    for (const source of [
      "<?processing\n```{r}\nsystem('false')\n```\n?>\n",
      "<script><!--\ncomment\n-->\n```{r}\nsystem('false')\n```\n",
      "$$ `open\nclose`\n```{r}\nsystem('false')\n```\n"
    ]) {
      expect(() => prepareRDocumentSource("/workspace/orders.qmd", source)).toThrow(/cannot safely distinguish/u);
    }
  });

  it("fails closed when raw containers are nested in Markdown lists", () => {
    for (const [label, source] of [
      ["raw HTML", "- <script type=\"text/plain\">\n  ```{r}\n  system('false')\n  ```\n  </script>\n"],
      ["display math", "1. $$\n   ```{r}\n   system('false')\n   ```\n   $$\n"],
      ["raw TeX", "- \\begin{verbatim}\n  ```{r}\n  system('false')\n  ```\n  \\end{verbatim}\n"]
    ] as const) {
      expect(() => prepareRDocumentSource("/workspace/orders.qmd", source), label).toThrow(
        /cannot safely distinguish/u
      );
    }
  });

  it("rejects ambiguous execution engines, body overrides, and eval expressions", () => {
    for (const source of [
      "```{r, engine='bash'}\nsystem('false')\n```\n",
      "```{r, child='other.Rmd'}\norders <- data.frame(id = 1L)\n```\n",
      "```{r, eval=1:3}\norders <- data.frame(id = 1L)\n```\n",
      "```{r}\n#| engine: bash\nsystem('false')\n```\n",
      "```{r}\n#| file: replacement.R\norders <- data.frame(id = 1L)\n```\n",
      "```{r, 'engine'='bash'}\nsystem('false')\n```\n",
      "```{r}\n#| 'engine': bash\nsystem('false')\n```\n",
      "```{r}\n#| {engine: bash}\nsystem('false')\n```\n",
      "```{r, opts.label='external-options'}\norders <- data.frame(id = 1L)\n```\n"
    ]) {
      expect(() => prepareRDocumentSource("/workspace/orders.qmd", source)).toThrow(
        /does not run|literal true or false|plain key(?:: value|=value)/u
      );
    }
    expect(
      prepareRDocumentSource("/workspace/orders.qmd", "```{r label=`demo`}\nsystem('false')\n```\n")
    ).toMatchObject({ rChunkCount: 0, runnableRChunkCount: 0, executableUnits: [] });
  });

  it("honors literal document and cell evaluation switches", () => {
    const source = [
      "---",
      "title: Orders",
      "execute:",
      "  eval: false",
      "---",
      "```{r}",
      "orders <- data.frame(id = 1L)",
      "```",
      ""
    ].join("\n");
    expect(prepareRDocumentSource("/workspace/orders.qmd", source)).toMatchObject({
      rChunkCount: 1,
      runnableRChunkCount: 0
    });
    expect(() =>
      prepareRDocumentSource("/workspace/orders.qmd", "---\njupyter: ir\n---\n```{r}\nx <- 1\n```\n")
    ).toThrow(/YAML uses "jupyter"/u);
    for (const yaml of [
      "{execute: {eval: false}}",
      "? execute\n: {eval: false}",
      "defaults: &off\n  eval: false\nexecute:\n  <<: *off"
    ]) {
      expect(() =>
        prepareRDocumentSource(
          "/workspace/orders.qmd",
          `---\n${yaml}\n---\n\`\`\`{r}\norders <- data.frame(id = 1L)\n\`\`\`\n`
        )
      ).toThrow(/does not support this YAML syntax/u);
    }
    expect(
      prepareRDocumentSource(
        "/workspace/orders.qmd",
        "\n---\nexecute:\n  eval: false\n---\n```{r}\norders <- data.frame(id = 1L)\n```\n"
      )
    ).toMatchObject({ rChunkCount: 1, runnableRChunkCount: 1 });
  });

  it("rejects indented and tilde R fences that do not have portable document semantics", () => {
    const source = "  ```{r}\n  value <- paste0(\n    'kept-indent'\n  )\n  ```\n";
    expect(() => prepareRDocumentSource("/workspace/orders.Rmd", source)).toThrow(/top-level R code fences/u);
    expect(() => prepareRDocumentSource("/workspace/orders.Rmd", "~~~{r}\nvalue <- 1\n~~~\n")).toThrow(
      /backticks, not tildes/u
    );
  });

  it("rejects structurally incomplete documents and invalid source text", () => {
    expect(() =>
      prepareRDocumentSource("/workspace/orders.qmd", "```{r}\norders <- data.frame(id=1)\n```\n<!-- unclosed\n")
    ).toThrow(/HTML comment opened on line 4/u);
    expect(() => prepareRDocumentSource("/workspace/orders.qmd", "---\ntitle: Missing close\n")).toThrow(
      /front matter is not closed/u
    );
    expect(() => prepareRDocumentSource("/workspace/orders.qmd", "```{r}\nvalue <- '\ud800'\n```\n")).toThrow(
      /valid Unicode/u
    );
  });

  it("checks the original literate document against the source-size bound", () => {
    const oversized = `${"x".repeat(64 * 1_024 * 1_024)}\n\n\`\`\`{r}\norders <- data.frame(id=1)\n\`\`\`\n`;
    expect(() => prepareRDocumentSource("/workspace/orders.qmd", oversized)).toThrow(/64 MiB source limit/u);
  });

  it("preserves CRLF line count and reports an unclosed fence at its source line", () => {
    const prepared = prepareRDocumentSource(
      "/workspace/orders.Rmd",
      "Title\r\n\r\n```{r}\r\norders <- data.frame(id = 1L)\r\n```\r\n"
    );
    expect(prepared.executableText).toBe("\r\n\r\n\r\norders <- data.frame(id = 1L)\r\n\r\n");
    expect(() => prepareRDocumentSource("/workspace/orders.qmd", "text\n```{r}\norders <- data.frame()\n")).toThrow(
      "opened on line 2"
    );
  });

  it("does not reinterpret Unicode line separators or longer R Markdown fences", () => {
    const unicode = prepareRDocumentSource(
      "/workspace/orders.qmd",
      "Narrative\u2028```{r}\nmarker <- data.frame(id = 1L)\n```\n"
    );
    expect(unicode).toMatchObject({ rChunkCount: 0, runnableRChunkCount: 0, executableUnits: [] });
    expect(() =>
      prepareRDocumentSource("/workspace/orders.Rmd", "````{r}\nx <- r\"{\n```\n}\"\nsystem('false')\n````\n")
    ).toThrow(/code fence opened/u);
  });

  it("inserts generated code as R source or a fenced executable cell", () => {
    const code = "orders <- subset(orders, amount > 0)\n";
    expect(formatGeneratedRDocumentCode("/workspace/orders.R", code)).toBe(code);
    expect(formatGeneratedRDocumentCode("/workspace/orders.Rmd", code)).toBe(
      "```{r}\norders <- subset(orders, amount > 0)\n```"
    );
    expect(formatGeneratedRDocumentCode("/workspace/orders.qmd", "value <- '```'\n")).toBe(
      "````{r}\nvalue <- '```'\n````"
    );
    expect(() => formatGeneratedRDocumentCode("/workspace/orders.Rmd", 'value <- r"{\n```\n}"\n')).toThrow(
      /would close an R Markdown code cell/u
    );
    for (const indentation of ["    ", "\t"]) {
      expect(() =>
        formatGeneratedRDocumentCode("/workspace/orders.Rmd", `value <- r"{\n${indentation}\`\`\`\n}"\n`)
      ).toThrow(/would close an R Markdown code cell/u);
    }
  });
});
