# Security policy

## Supported versions

Open Wrangler 1.2.x and older are unsupported. Until 2.0 is published, only the latest public 1.99 preview receives
security fixes. After 2.0, the latest stable release and the latest public preview, when it is newer than stable, are
supported. Fixes are not backported to older releases.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use
[GitHub's private vulnerability reporting](https://github.com/Matt17BR/openwrangler/security/advisories/new).

Include the affected Open Wrangler versions, editor and operating system, relevant Python or R version, minimal
reproduction steps, and the security impact. Explain what an attacker or untrusted workspace must control. Remove
credentials and private data from logs or samples.

## Response and disclosure

Reports are reviewed on a best-effort basis. We cannot guarantee response or remediation times. When a report is
accepted, we coordinate disclosure with the reporter when practical, publish a GitHub Security Advisory, and request
a CVE when appropriate. Keep report details private until disclosure is agreed or the advisory is published.

## Execution and dependencies

Open Wrangler runs requested dataframe operations and custom code in the selected Python or R environment. Workspace
Trust and explicit confirmations help prevent accidental execution, but they do not sandbox that code. Approved code
has the access granted to that interpreter or notebook kernel.

Pull-request CI checks dependency locks and licenses. Release-candidate qualification verifies the exact candidate
source and runs npm and Python dependency audits before publication.
