# Release notes

Add one Markdown file named after each release, for example `1.2.1.md`. Write it in the release pull request and read
it alongside the code and screenshots it describes.

Keep the notes short. Start with the changes a user will notice, mention compatibility or migration steps only when
the reader must act, and link to longer technical evidence instead of reproducing it. Follow
[`docs/writing-style.md`](../writing-style.md).

The publisher reads this file from the exact tagged commit and sends its text to GitHub. It does not ask GitHub to
generate release notes from pull request titles. A missing, empty, invalid UTF-8, oversized, or different release body
stops publication. This guarantees the published text matches the tag; it does not replace an editorial review.
