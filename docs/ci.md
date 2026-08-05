# CI and release checks

Open Wrangler uses three test levels. The everyday pull-request checks should find ordinary mistakes quickly. Editor and registry checks run against a packaged VSIX before a release. Scheduled jobs watch external dependencies such as VS Code, Jupyter, Python, and security advisories.

## Pull requests

Draft pull requests run `Fast feedback`: formatting, linting, TypeScript, generated files, licenses, and workflow tests. A healthy draft reports `Draft feedback`, not a fake failure. The protected `validate` check is deliberately absent until the pull request is marked ready. The `ready_for_review` event starts the merge checks on the same commit.

Ready code changes run:

| Area             | Checks                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Source           | TypeScript and Python tests, type checking, linting, coverage, generated-file checks          |
| UI               | production webview tests, visual baselines, and accessibility                                 |
| Runtime          | Python 3.10, 3.12, and 3.14; native Pandas, Polars, and DuckDB; R 4.4/4.5 transport contracts |
| VS Code          | minimum and current VS Code extension-host tests on Linux                                     |
| Native platforms | runtime and extension-host tests on macOS and Windows; Windows process-supervisor tests       |
| Package          | one VSIX build, package inspection, and a packaged VS Code journey on Linux                   |
| Security         | production dependency audits and CodeQL                                                       |
| Optional         | Remote SSH when the pull request has the `acceptance:remote-ssh` label                        |

Documentation-only changes run just the source checks. Changes limited to shipped documents such as the README also build the VSIX so the Marketplace package can be checked.

The `validate` job reads the result of every required job. Missing, cancelled, failed, or unexpectedly skipped work keeps the pull request blocked. Cross-platform and CodeQL checks keep their stable names because the repository ruleset requires them directly.

Superseded pull-request runs are cancelled. Release jobs are never cancelled this way.

## Release candidates

Preview and stable release workflows build the VSIX once. Every acceptance job downloads and verifies that same artifact.

The release tier adds the expensive product checks that no longer run on every pull request:

- packaged VS Code on macOS and Windows;
- packaged Cursor on macOS and Windows;
- released Jupyter with local and remote Python kernels in VS Code, plus local R in VS Code and Cursor and remote R in VS Code;
- Remote SSH;
- installed performance in pinned VS Code and Cursor;
- the complete source, platform, package, accessibility, and security checks.

A release cannot publish until every candidate job passes. GitHub, Open VSX, and the Visual Studio Marketplace receive the accepted VSIX; none of them rebuild it.

Cross-platform, CodeQL, and performance workflows also run on schedules so changes in external products are found between releases. Released Jupyter is run manually when that integration needs to be checked.

## Branches

The repository does not need permanent `develop`, `staging`, or maintenance branches. Reviewed changes merge to
`main`, and the release candidate VSIX is the staging artifact. Open Wrangler 2 stays on its feature branch until it
is ready for a preview pull request. A maintenance branch can be cut later if two supported release lines genuinely
need work at the same time.

This keeps promotion simple:

1. test the feature branch;
2. merge a ready pull request;
3. build and test one release candidate;
4. publish those exact bytes.

Routine Dependabot minor and patch updates are grouped once per ecosystem. Major and security updates remain separate.

## August 2026 review

A representative ready pull request before this change created 31 jobs across CI, cross-platform, and CodeQL. It used about 80 runner-minutes and finished in roughly 11 minutes because most jobs ran in parallel. The Python suite ran five times, extension-host tests ran four times, and packaged-editor journeys ran six times.

That was more than a merge check needed. macOS/Windows packaged VS Code, Cursor, and released-Jupyter journeys already run again against the exact release candidate. They now live at that release boundary. Native extension-host and Windows supervisor coverage were folded into the existing cross-platform jobs instead of paying for separate setup jobs.

The checks that catch ordinary code, runtime, UI, accessibility, packaging, and minimum-version regressions still block pull requests. The release workflow remains stricter than the pull-request workflow.

Useful comparisons:

- [VS Code Python workflows](https://github.com/microsoft/vscode-python/tree/main/.github/workflows)
- [VS Code Jupyter build and test workflow](https://github.com/microsoft/vscode-jupyter/blob/main/.github/workflows/build-test.yml)
- [Red Hat YAML extension CI](https://github.com/redhat-developer/vscode-yaml/blob/main/.github/workflows/CI.yaml)
- [GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub reusable workflow documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
