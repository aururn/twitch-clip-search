# Twitch Clip Search

Search public Twitch clip titles across streamers without entering a channel ID, signing in, or configuring an API key.

Twitch Clip Search is a Chrome side-panel extension with a Japanese interface. Search while watching Twitch. It discovers broadcasters from public categories, collects their clips, and searches titles on your device.

**Search covers collected clips, not every clip on Twitch.** Twitch may restrict additional retrieval. Previously collected results remain searchable when a request fails.

## Install

Requires Chrome 116 or later. No server or build step is required.

1. Download this repository as a ZIP and extract it, or clone it:

   ```sh
   git clone https://github.com/aururn/twitch-clip-search.git
   ```

2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository's `extension` directory, which contains `manifest.json`.
5. Pin **Twitchクリップ検索** (Twitch Clip Search) from Chrome's extensions menu, then click its toolbar icon to open the side panel alongside Twitch.

An extension-only ZIP created with `npm run pack` can also be extracted and loaded by selecting the directory containing `manifest.json`.

After updating an unpacked installation, click its reload button on `chrome://extensions`, then close and reopen the side panel. Version 1.3 adds Chrome's `sidePanel` permission. Keep the extension in the same directory to retain its local data.

## Features

- Search clip titles across streamers without selecting a broadcaster.
- Keep Twitch visible while searching in the side panel. Clip links open in background tabs.
- Automatically discover broadcasters and collect clips beyond category rankings.
- Combine keywords, exclude terms, and search quoted phrases.
- Normalize full-width and half-width characters and ignore letter case.
- Filter by date range, clip language, and collected category.
- Sort by views, newest first, or oldest first.
- Save clips locally and export search results as CSV.
- Stop collection while retaining completed results and progress.
- Press `/` to focus the search field.

## Usage

Enter a keyword and click **検索** (Search). Cached matches appear immediately, and each search automatically expands collection for up to two rounds. Defaults are Japanese clips from all time; the language filter is visible and can be changed. Existing installations switch to the all-time default once on this update, retaining their clips and saved items.

| Query | Matches |
| --- | --- |
| `爆笑` | Titles containing the keyword |
| `爆笑 初見` | Titles containing both terms |
| `爆笑 -ネタバレ` | Titles containing the first term but excluding the second |
| `"nice shot"` | Titles containing the phrase |

Click **追加取得** (Expand search coverage) to continue through unvisited broadcasters and periods. Some additional retrieval opens temporary, muted Twitch tabs; the extension closes its own tabs when the scan finishes, fails, is stopped, or the panel closes. Keep the side panel open during collection. Closing it retains completed results and checkpoints.

Use the bookmark button to save a clip. Date, language, category, and keyword filters also apply to the saved-clips view. Use **CSV** to export the current search results.

## Coverage and limitations

Twitch's official Helix API does not provide a global clip-title search. Twitch Clip Search uses publicly accessible Twitch website metadata and rendered directory pages to build a local, partial index. It does not require a broadcaster ID for collection or search.

Each round examines up to 60 categories and up to 40 automatically discovered broadcasters, requesting up to 100 clips per source. The first directory request covers up to 100 categories. Category results and the existing cache identify broadcasters; no broadcaster ID or login needs to be entered. Broadcasters associated with matching titles are prioritised among equally visited sources.

For all-time searches, broadcaster collection progresses through all-time, 30-day, 7-day, and 24-hour rankings in separate rounds. This adds recent clips that fall outside an all-time ranking. Successful periods are checkpointed, failures remain retryable, and duplicate clips are not counted as additions. Unvisited broadcaster rankings are prioritised over restricted category pagination. When these are exhausted, additional collection can discover more categories and try up to six category continuations per round.

Clips are retrieved in descending view-count order within each ranking. **This is still a partial index, not an exhaustive Twitch search.** Undiscovered broadcasters, clips below every retrieved ranking, unvisited categories, and private or deleted clips are not covered. Counts describe matches in the collected index. Removing the initial 30-day filter and adding broadcaster discovery improve coverage without making it complete.

Twitch can restrict unauthenticated pagination and stop loading additional cards on its normal website. Twitch Clip Search reads ordinary public listing pages for continuation; it does not bypass verification screens or extract authentication or client-integrity tokens. Restrictions are reported in the interface while existing results are retained. Deeper retrieval and complete historical coverage are not guaranteed.

Collection checkpoints are separate for each date range and language. Checkpoints older than one day are restarted while cached clips are retained. Clip titles and view counts are refreshed only when their metadata is retrieved again. Use the refresh action in **検索のしくみ** (How search works) to restart the current scope.

## Privacy and permissions

- Requests host access only to `gql.twitch.tv` and `www.twitch.tv`. Chrome's `sidePanel` API displays the interface alongside Twitch; `scripting` reads listing pages created by the extension.
- Does not read browsing history, account OAuth tokens, cookies, passwords, or client-integrity tokens.
- Public metadata requests use `credentials: omit`. Temporary Twitch tabs operate as normal pages in your Chrome profile.
- Does not install a persistent content script or request access to all websites.
- Stores collected clips, preferences, and saved clips in the extension's IndexedDB. No application backend receives them.
- The optional Google search link sends the query to Google only when clicked.
- Removing the extension removes its local data. Export important results as CSV first.

## Development

The extension and unit tests have no third-party dependencies. Use Node.js 20.3 or later for the scripts.

```sh
npm test
npm run test:live
npm run test:coverage
```

`npm test` runs deterministic tests for search, Unicode handling, URL validation, category and broadcaster checkpoints, prioritisation, deduplication, cancellation, partial failures, and public-page retrieval. `test:live` checks category discovery and real title matching. `test:coverage` compares five category rankings with up to 40 discovered broadcasters using the same language and date range, reporting the additional clips and keyword matches. Twitch may reject requests from outside a browser.

Browser tests require a separate development installation of Playwright:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node scripts/browser-check.js
node scripts/browser-check.js --live
```

The default browser test uses deterministic fixtures. `--live` uses actual Twitch data and reports additional-retrieval restrictions. These checks launch the actual Manifest V3 extension in an isolated Chromium profile. Generated screenshots and packages are excluded from version control.

On Windows, create an extension-only ZIP with PowerShell:

```sh
npm run pack
```

The package is written to `dist/twitch-clip-search-1.3.0.zip`.

## Design

The interface uses a white canvas, readable system fonts, compact controls, and a restrained purple accent. The side panel uses compact thumbnail rows with titles, broadcaster names, views, and dates. Search remains available while scrolling. Usage details stay in the help dialog. There are no promotional headings, decorative illustrations, suggestion chips, or footer slogans. Opening `app.html` directly still provides the wider gallery layout.

## Licence

This project's source code is licensed under the [MIT Licence](LICENCE). Twitch clips, thumbnails, trademarks, and other third-party content remain the property of their respective owners and are not granted under this licence.

Twitch Clip Search is an independent project and is not affiliated with or endorsed by Twitch, Amazon, Google, Raycast, or Refero.
