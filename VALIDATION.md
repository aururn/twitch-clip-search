# Verification — 2026-10-15 JST

- Version 1.2.0: removed promotional copy, decorative illustrations, suggestion chips, and the footer. The desktop result grid starts approximately 287px from the top. The real-data index still returns 10 matches for `爆笑`; layouts from 320px to 1440px remain within the viewport. Existing browser checks cover search, saved clips, CSV, incremental retrieval, persistence, and cancellation.

- Version 1.1.0: light gallery redesign checked with the existing real-data index. Layouts at 320, 390, 640, 768, 1024, and 1440 pixels have no horizontal overflow. Search, bookmarking, CSV, collection, cancellation, and persistence are covered by the extension browser checks.

- Unit tests: keyword AND / phrases / exclusions, Unicode normalization and highlighting, title-only matching, date / language / sorting, URL restrictions, incremental cursor checkpoints, partial failures, abort, API errors, public-page fallback, and refusing to treat interrupted public-page loading as successful exhaustion.
- Browser tests: actual Manifest V3 extension loaded into a separate Chromium test profile; search, bookmarks and persistence after reload, CSV download, additional retrieval, cache deletion preserving bookmarks, desktop and mobile layout.
- Real Twitch data: approximately 3,100 Japanese clips from 52 categories in one initial scan. Query `爆笑` returned 10 matching titles across multiple broadcasters.
- Network smoke check: 50 categories discovered, 98 Japanese GTA clips from 42 different broadcasters fetched; title matching passed.
- Public directory fallback: 30 rendered categories read, including 13 additional categories beyond the initial directory in this run.
- Material limitation: Twitch rejected unauthenticated raw cursor pagination and its public clip list did not load enough additional cards in the test browser. The extension reads normal public pages for continuation, reports incomplete loading, and keeps the existing index. Deeper retrieval depends on what Twitch's normal page can load in the user's browser; full historical coverage has not been verified and is not promised.
- No account credentials, browser cookies, client integrity tokens, or external private data were read during implementation or testing.

Local test runs write actual screenshots to `artifacts/live-results-desktop.png` and `artifacts/live-mobile.png`. Screenshots whose name begins `fixture-` show only deterministic test fixtures. Generated artifacts are excluded from version control.
