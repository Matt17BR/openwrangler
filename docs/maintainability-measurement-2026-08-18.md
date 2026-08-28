# Maintainability measurement — 2026-08-18

This record measures the maintainability-first freeze against exact protected-main objects. It reports current
evidence; it does not credit open pull requests, local candidates, projected reductions, or unreviewed work.

## Exact objects and method

- Freeze baseline: `bb3104a0f87c1caa4caceeead8a8d8e8246a6649`.
- Current main: `af0e5127f23ee852a59f9f88cb5881f3a50fc15e`, tree
  `883bcfc01a0570a9ac7a9cdea8059afa30aa49fa`.
- File lengths are newline counts from each commit's Git blob. Generated media and binary files are excluded.
- A new production file is an added TypeScript, JavaScript, Python, or R file below `src/extension`, `src/shared`,
  `src/webviews`, `python/openwrangler_runtime`, or `r/openwrangler_runtime`.
- A new test file is an added code file below `src/test`, `python/tests`, or `r/tests`, or an added file with a
  `.test.` or `_test.py` name. Script owners without a test name are reported separately as tooling.
- The live ruleset receipt is the sorted compact REST response for ruleset `19028896`, SHA-256
  `0abd3826cd0674ac74e9d89e91073f5b0e452bffbe868fcde7fb242b89ed2e30`.

## New-file bounds

The freeze added 167 tracked files. Of the added code files:

| Class      | Files | Largest file | Bound | Over bound |
| ---------- | ----: | ------------ | ----: | ---------: |
| Production |     9 | 630 lines    | 1,000 |          0 |
| Test       |   145 | 1,378 lines  | 1,500 |          0 |
| Tooling    |     6 | 1,141 lines  |     — |          — |
| Other code |     1 | 208 lines    |     — |          — |

The largest new production owner is `src/extension/r/rPrivateArtifactBoundary.ts` at 630 lines. The largest new test
owner is `r/tests/kernel_agent_text.R` at 1,378 lines. This proves the new-file half of approachability gate 5 for the
measured range. It does not prove that existing hotspots are acceptably decomposed.

## Named hotspot movement

| Owner                                          | Baseline | Current |   Delta |
| ---------------------------------------------- | -------: | ------: | ------: |
| `src/test/extensionHost/index.ts`              |   36,649 |  20,012 | −16,637 |
| `scripts/editor-acceptance.mjs`                |    4,931 |   4,931 |       0 |
| `src/webviews/App.tsx`                         |    3,490 |   3,410 |     −80 |
| `src/webviews/operations/OperationBuilder.tsx` |    1,499 |   1,499 |       0 |
| `src/extension/sessionCoordinator.ts`          |      977 |   1,005 |     +28 |
| `src/extension/pythonBridge.ts`                |    2,546 |   2,546 |       0 |
| `src/extension/r/rKernelBridge.ts`             |    5,466 |   5,452 |     −14 |
| `r/openwrangler_runtime/kernel_agent.R`        |    9,624 |   9,624 |       0 |
| `r/openwrangler_runtime/frame_contract.R`      |    8,934 |   9,160 |    +226 |
| `src/extension/webviewPanel.ts`                |    1,862 |   1,875 |     +13 |

The extension-host program has a real 45.4% reduction. Most other named production hotspots are flat or larger on
protected main. Wrapper extraction, open work, and local
commits receive no credit here. The existing-hotspot half of gate 5 therefore remains open.

## Approachability gate status

| Gate | Current evidence                                                                                                                                                      | Status   |
| ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
|    1 | `npm run check:pr` is the sole authoritative pull-request command. No current exact-main cold/warm timing pair is recorded.                                           | Open     |
|    2 | The dated topology comparison proves 23→11 executed jobs and 4,042→1,880 summed runner seconds. A complete rolling p95 population is not recorded.                    | Partial  |
|    3 | The active ruleset requires exactly integration-bound `validate` and `CodeQL gate`; both use integration ID `15368`.                                                  | Achieved |
|    4 | No complete trailing population of 100 qualifying first-attempt runs and explained retries is sealed.                                                                 | Open     |
|    5 | Every new production/test file meets its bound, and two hotspots shrink materially. Several named monoliths remain flat or larger.                                    | Partial  |
|    6 | The protocol schema is the sole hand-edited operation registry; generated TypeScript/Python catalogs and the independent R oracle are bound by executable checks.     | Achieved |
|    7 | Focused owners now cover many moved boundaries, but the remaining hotspot table still contains mega-fixtures and multi-owner modules.                                 | Partial  |
|    8 | Qualification and promotion are documented as separate operations. A reviewed exact-byte candidate, soak, and one-shot promotion receipt is still required.           | Partial  |
|    9 | Node 22.22, Python 3.10–3.14, and the R 4.4/4.5 qualification locks are declared; audits are blocking. Complete development-environment reproducibility remains open. | Partial  |
|   10 | Current product/support ledgers are generated or checked, but final release-candidate truth still requires its own review.                                            | Partial  |

## Remaining evidence backlog

1. Record one exact-main cold `npm ci` plus `npm run check:pr` run and one immediate warm `check:pr` run under the
   declared Node and Python toolchains. Report wall time, peak RSS, and dependency-cache state without extrapolation.
2. Seal the complete rolling population used for pull-request p95 and the trailing 100 first-attempt retry audit.
3. Continue reducing the flat or growing hotspot owners above. Each slice must move behavior behind one focused owner,
   retain characterization coverage, and reduce the original owner rather than add a wrapper around it.
4. Close development reproducibility with one reviewed contract for the remaining Python and R environment inputs;
   do not replace the current blocking advisory checks with ignores.
5. Measure the canonical VSIX and retained evidence artifacts from one exact candidate, then compare them with the
   documented pre-freeze package/evidence shapes. Do not infer artifact growth from source size.
6. Re-run this measurement only after relevant work lands. Open pull requests and local commits remain backlog, not
   protected-main evidence.

The broader backend, platform, editor, and automatic 2.0 expansion freeze remains in force until every gate is
achieved with current, reviewable evidence.
