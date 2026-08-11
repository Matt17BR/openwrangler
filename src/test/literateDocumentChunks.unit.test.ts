import { describe, expect, it } from "vitest";
import {
  findLiterateCodeChunkAtLine,
  literateDocumentKind,
  literatePythonExecutionOwner
} from "../extension/literateDocumentChunks";

describe("literate document code chunks", () => {
  it("locates the mixed Quarto chunk that owns the cursor", () => {
    const source = [
      "---",
      "title: Mixed engines",
      "---",
      "",
      "```{r load-orders, echo=FALSE}",
      "orders_r <- data.frame(id = 1:3)",
      "```",
      "",
      "~~~{python load-python}",
      "#| label: load-python-orders",
      "#| echo: false",
      "orders_python = pandas.DataFrame({'id': [1, 2, 3]})",
      "~~~~",
      ""
    ].join("\n");

    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 5)).toMatchObject({
      language: "r",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "`",
      openingLine: 4,
      closingLine: 6,
      code: "orders_r <- data.frame(id = 1:3)\n"
    });
    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 11)).toMatchObject({
      language: "python",
      executableSyntax: true,
      supportedFence: true,
      enabled: true,
      fenceCharacter: "~",
      openingLine: 8,
      closingLine: 12,
      code: [
        "#| label: load-python-orders",
        "#| echo: false",
        "orders_python = pandas.DataFrame({'id': [1, 2, 3]})",
        ""
      ].join("\n")
    });
  });

  it("accepts common R Markdown labels and options without mistaking prose for a chunk", () => {
    const source = [
      "# Orders",
      "",
      "Use `orders` below.",
      "",
      "```{python, load-orders, echo=FALSE}",
      "#| label: python-orders",
      "orders = pd.DataFrame({'id': [1]})",
      "```",
      ""
    ].join("\r\n");

    expect(findLiterateCodeChunkAtLine("C:\\workspace\\orders.Rmd", source, 2)).toBeUndefined();
    expect(findLiterateCodeChunkAtLine("C:\\workspace\\orders.Rmd", source, 6)).toMatchObject({
      language: "python",
      enabled: true,
      code: "#| label: python-orders\r\norders = pd.DataFrame({'id': [1]})\r\n"
    });
  });

  it("marks disabled chunks and non-executable fences without rejecting their options", () => {
    const source = [
      "```{r disabled, eval=FALSE}",
      "orders <- data.frame(id = 1L)",
      "```",
      "",
      "```{python}",
      "#| label: disabled-python",
      "#| eval: false # retained for rendering",
      "orders = object()",
      "```",
      "",
      "```python",
      "display_only = True",
      "```",
      ""
    ].join("\n");

    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 1)).toMatchObject({
      language: "r",
      enabled: false
    });
    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 7)).toMatchObject({
      language: "python",
      enabled: false
    });
    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 11)).toMatchObject({
      executableSyntax: false,
      enabled: true
    });
  });

  it("keeps YAML, HTML comments, and outer non-code fences opaque", () => {
    const source = [
      "---",
      "payload: |",
      "  ```{python}",
      "  hidden = True",
      "  ```",
      "---",
      "",
      "<!--",
      "```{r}",
      "hidden <- TRUE",
      "```",
      "-->",
      "",
      "````text",
      "```{python}",
      "also_hidden = True",
      "```",
      "````",
      ""
    ].join("\n");

    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 3)).toBeUndefined();
    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 9)).toBeUndefined();
    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 15)).toMatchObject({
      executableSyntax: false,
      openingLine: 13,
      closingLine: 17
    });
  });

  it("supports tilde execution only where the document format supports it", () => {
    const source = "~~~{r}\norders <- data.frame(id = 1L)\n~~~\n";
    expect(findLiterateCodeChunkAtLine("/workspace/orders.qmd", source, 1)).toMatchObject({
      language: "r",
      supportedFence: true
    });
    expect(findLiterateCodeChunkAtLine("/workspace/orders.Rmd", source, 1)).toMatchObject({
      language: "r",
      supportedFence: false
    });
  });

  it("fails closed for malformed source and recognizes extensions case-insensitively", () => {
    expect(literateDocumentKind("/workspace/orders.QMD")).toBe("quarto");
    expect(literateDocumentKind("/workspace/orders.rMd")).toBe("rmarkdown");
    expect(literateDocumentKind("/workspace/orders.md")).toBeUndefined();
    expect(() => findLiterateCodeChunkAtLine("/workspace/orders.qmd", "```{python}\nvalue = 1\n", 1)).toThrow(
      /not closed/u
    );
  });

  it("assigns real-shaped Quarto Python cells to the document executor", () => {
    const implicitKnitr = [
      "---",
      "title: Mixed analysis",
      "format: html",
      "---",
      "",
      "```{r}",
      "library(reticulate)",
      "```",
      "",
      "```{python}",
      "orders = make_frame()",
      "```",
      ""
    ].join("\n");
    const explicitJupyter = [
      "---",
      "title: Python analysis",
      "jupyter: python3",
      "---",
      "",
      "```{python}",
      "orders = make_frame()",
      "```",
      ""
    ].join("\n");

    expect(literatePythonExecutionOwner("/workspace/orders.qmd", implicitKnitr)).toBe("r");
    expect(literatePythonExecutionOwner("/workspace/orders.qmd", explicitJupyter)).toBe("jupyter");
    expect(literatePythonExecutionOwner("/workspace/orders.Rmd", explicitJupyter)).toBe("r");
  });

  it("fails closed for conflicting or unsupported Quarto executor metadata", () => {
    expect(
      literatePythonExecutionOwner(
        "/workspace/orders.qmd",
        "---\nengine: knitr\njupyter: python3\n---\n```{python}\nvalue = 1\n```\n"
      )
    ).toBe("unknown");
    expect(
      literatePythonExecutionOwner("/workspace/orders.qmd", "---\nengine: julia\n---\n```{python}\nvalue = 1\n```\n")
    ).toBe("unknown");
  });

  it("does not infer knitr from R-looking fences hidden in YAML or comments", () => {
    const source = [
      "---",
      "payload: |",
      "  ```{r}",
      "  hidden <- TRUE",
      "  ```",
      "---",
      "<!--",
      "```{r}",
      "also_hidden <- TRUE",
      "```",
      "-->",
      "```{python}",
      "value = 1",
      "```",
      ""
    ].join("\n");
    expect(literatePythonExecutionOwner("/workspace/orders.qmd", source)).toBe("jupyter");
  });
});
