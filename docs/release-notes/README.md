# Release notes

Add one Markdown file for each stable release, for example `2.1.1.md`. Write it in the release pull
request and read it alongside the code and screenshots it describes. Daily previews use the frozen generated notes
described in [Releasing](../releasing.md#daily-preview).

Keep the notes short. Start with the changes a user will notice, mention compatibility or migration steps only when
the reader must act, and link to longer technical evidence instead of reproducing it. Follow
[`docs/writing-style.md`](../writing-style.md).

For stable releases and historical manual previews, the publisher reads this file from the exact tagged commit and sends its text
to GitHub. It does not ask GitHub to generate release notes from pull request titles. A missing, empty, invalid UTF-8,
oversized, or different release body stops publication. This guarantees the published text matches the tag; it does not
replace an editorial review.
