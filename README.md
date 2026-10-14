# Clip Scout

Search public Twitch clip titles across streamers without entering a channel ID, signing in, or configuring an API key.

Clip Scout is a local Chrome extension with a Japanese interface. It collects public clips from categories, stores them in your browser, and searches their titles on your device.

**Search covers collected clips, not every clip on Twitch.** Twitch may restrict additional retrieval. Previously collected results remain searchable when a request fails.

## Install

Requires Chrome 116 or later. No server or build step is required.

1. Download this repository as a ZIP and extract it, or clone it:

   ```sh
   git clone https://github.com/aururn/clip-scout.git
   ```

2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository's `extension` directory, which contains `manifest.json`.
5. Open **Clip Scout** from Chrome's extensions menu. Pin it for easier access.

An extension-only ZIP created with `npm run pack` can also be extracted and loaded by selecting the directory containing `manifest.json`.

## Features

- Search clip titles across streamers without selecting a broadcaster.
- Combine keywords, exclude terms, and search quoted phrases.
- Normalize full-width and half-width characters and ignore letter case.
- Filter by date range, clip language, and collected category.
- Sort by views, newest first, or oldest first.
- Save clips locally and export search results as CSV.
- Stop collection while retaining completed results and progress.
- Press `/` to focus the search field.

## Usage

Enter a keyword and click **検索する** (Search). The first search automatically collects public clips. Defaults are Japanese clips from the past 30 days.

| Query | Matches |
| --- | --- |
| `爆笑` | Titles containing the keyword |
| `爆笑 初見` | Titles containing both terms |
| `爆笑 -ネタバレ` | Titles containing the first term but excluding the second |
| `"nice shot"` | Titles containing the phrase |

Click **もっと広く探す** (Expand search coverage) to discover more categories and continue collection. Some additional retrieval opens temporary, muted Twitch tabs; the extension closes the tabs it created when the scan finishes, fails, or is stopped. Keep the Clip Scout tab open during collection.

Use the bookmark button to save a clip. Date, language, category, and keyword filters also apply to the saved-clips view. Use **CSV** to export the current search results.

## Coverage and limitations

Twitch's official Helix API does not provide a global clip-title search. Clip Scout uses publicly accessible Twitch website metadata and rendered directory pages to build a local, partial index. It does not require a broadcaster ID for collection or search.

An initial round examines up to 60 categories and requests up to 100 clips per category. It starts with common Japanese categories and Twitch's public category directory. Additional rounds discover more categories and try to advance up to six previously visited categories, increasing each category's collection target by 100 clips.

Clips are initially retrieved in descending view-count order. Finding older or less-viewed clips may require additional collection. Categories absent from the available directory, pages that have not been collected, and unavailable clips are not covered.

Twitch can restrict unauthenticated pagination and stop loading additional cards on its normal website. Clip Scout reads ordinary public listing pages for continuation; it does not bypass verification screens or extract authentication or client-integrity tokens. Restrictions are reported in the interface while existing results are retained. Deeper retrieval and complete historical coverage are not guaranteed.

Collection checkpoints are separate for each date range and language. Checkpoints older than one day are restarted while cached clips are retained. Clip titles and view counts are refreshed only when their metadata is retrieved again. Use the refresh action in **検索のしくみ** (How search works) to restart the current scope.

## Privacy and permissions

- Requests access only to `gql.twitch.tv`, `www.twitch.tv`, and Chrome's `scripting` API for reading Twitch listing pages created by the extension.
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
```

`npm test` runs deterministic tests for search, Unicode handling, URL validation, collection checkpoints, cancellation, partial failures, and public-page retrieval. `test:live` checks category discovery, one page of real Japanese clips across broadcasters, and title matching. Twitch may reject requests from outside a browser.

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

The package is written to `dist/clip-scout-1.1.0.zip`.

## Design

The interface draws on the [Figma gallery reference in Refero Styles](https://styles.refero.design/style/5fd3b3b4-02ab-456a-87aa-e4395636b671): a light canvas, spacious thumbnail galleries, and a restrained purple accent. It uses system fonts and original interface code and icons.

## License

This project's source code is licensed under the [MIT License](LICENSE). Twitch clips, thumbnails, trademarks, and other third-party content remain the property of their respective owners and are not granted under this license.

Clip Scout is an independent project and is not affiliated with or endorsed by Twitch, Amazon, Google, Raycast, or Refero.
