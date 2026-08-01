import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactSourceReadmeUrl,
  assertExpectedSurfaceContent,
  assertExpectedSurfaceVersion,
  assertRepresentativeImageSource,
  assertSourcePackageVersion,
  expectedRepresentativeReferences,
  extractImmutableProductReferences,
  immutableProductReference,
  parsePublicMediaVerifierArguments,
  publicSurfaceDefinitions,
  REPRESENTATIVE_PUBLIC_IMAGES
} from "./public-media-surface-contract.mjs";

const sourceSha = "a".repeat(40);
const version = "1.2.1";
const productPrefix = `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/docs/images/readme/v1.2/`;

test("public surface verification requires one exact source commit and semantic version", () => {
  assert.deepEqual(parsePublicMediaVerifierArguments(["--source-sha", sourceSha, "--version", version]), {
    sourceSha,
    version
  });
  assert.deepEqual(parsePublicMediaVerifierArguments(["--version", "1.99.0", "--source-sha", sourceSha]), {
    sourceSha,
    version: "1.99.0"
  });
  for (const arguments_ of [
    [],
    ["--source-sha", sourceSha],
    ["--source-sha", sourceSha.slice(1), "--version", version],
    ["--source-sha", sourceSha.toUpperCase(), "--version", version],
    ["--source-sha", sourceSha, "--version", `v${version}`],
    ["--source-sha", sourceSha, "--version", "01.2.1"],
    ["--source-sha", sourceSha, "--version", version, "--version", version],
    ["--source-sha", sourceSha, "--version", version, "--unexpected", "value"]
  ]) {
    assert.throws(() => parsePublicMediaVerifierArguments(arguments_));
  }
});

test("GitHub verification is pinned to the caller-supplied README commit", () => {
  const [github] = publicSurfaceDefinitions(sourceSha);
  assert.equal(github.url, `https://github.com/Matt17BR/openwrangler/blob/${sourceSha}/README.md`);
  assert.doesNotMatch(github.url, /\/blob\/(?:main|release\/1\.x)\//u);
  assert.doesNotThrow(() => assertExactSourceReadmeUrl(github.url, sourceSha));
  assert.throws(
    () => assertExactSourceReadmeUrl("https://github.com/Matt17BR/openwrangler/blob/main/README.md", sourceSha),
    /exact source README URL/u
  );
});

test("surface content and versions fail closed on stale publication", () => {
  const content = "Explore, profile, clean, and export dataframes in an open-source workbench\nWhy Open Wrangler";
  assert.doesNotThrow(() => assertExpectedSurfaceContent("Synthetic", content));
  assert.throws(() => assertExpectedSurfaceContent("Synthetic", "Why Open Wrangler"), /expected README content/u);
  assert.doesNotThrow(() => assertExpectedSurfaceVersion("Synthetic", version, version));
  assert.throws(() => assertExpectedSurfaceVersion("Synthetic", "1.2.0", version), /instead of/u);
  assert.doesNotThrow(() => assertSourcePackageVersion(JSON.stringify({ version }), version));
  assert.throws(() => assertSourcePackageVersion(JSON.stringify({ version: "1.2.0" }), version), /instead of/u);
  assert.throws(() => assertSourcePackageVersion("{", version), /malformed package metadata/u);
});

test("representative media remains bound to each immutable README URL", () => {
  const readme = REPRESENTATIVE_PUBLIC_IMAGES.map(
    (alt, index) =>
      `<img width="100" alt="${alt}" src="${productPrefix}gallery/representative-${index}.png" height="50">`
  ).join("\n");
  const references = extractImmutableProductReferences(readme);
  assert.equal(references.length, REPRESENTATIVE_PUBLIC_IMAGES.length);
  assert.deepEqual(expectedRepresentativeReferences(readme), references);

  const expected = references[0];
  assert.doesNotThrow(() =>
    assertRepresentativeImageSource(
      "Synthetic",
      { alt: expected.alt, sourceUrl: expected.url, currentUrl: expected.url },
      expected.url
    )
  );
  assert.throws(
    () =>
      assertRepresentativeImageSource(
        "Synthetic",
        { alt: expected.alt, sourceUrl: expected.url, currentUrl: `${expected.url}?proxy=stale` },
        expected.url
      ),
    /expected immutable image URL/u
  );
  assert.throws(
    () => expectedRepresentativeReferences(readme.replace(REPRESENTATIVE_PUBLIC_IMAGES[1], "Wrong alt")),
    /exactly one immutable public image/u
  );
});

test("immutable product references reject mutable or decorated media URLs", () => {
  const exact = `${productPrefix}gallery/example.png`;
  assert.deepEqual(immutableProductReference(exact), {
    url: exact,
    relativePath: "gallery/example.png"
  });
  assert.equal(
    immutableProductReference(
      "https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.2/gallery/example.png"
    ),
    undefined
  );
  assert.throws(() => immutableProductReference(`${exact}?raw=1`), /query or fragment/u);
});
