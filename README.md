# Hill 218 Coach for BGA

Read-only Chrome extension beta for **The Battle for Hill 218** on **Board Game Arena**.

It adds a small floating panel that scans the visible BGA page/log and shows a public card counter for both players. It does **not** play moves, click game controls, call hidden APIs, or collect personal data.

## Current Status

This is an early beta for friendly testing.

- Works best on live/current Battle for Hill 218 game pages.
- Advice stays hidden unless the data-quality gates pass.
- Some live-game reconciliation cases are still under active testing.
- The extension is intentionally read-only.

## Install from GitHub ZIP

1. Download this repository as a ZIP and unzip it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the `extension` folder from the unzipped project.
6. Open a Board Game Arena Battle for Hill 218 game page.
7. Use the floating **Hill 218 Coach** panel and press `Scan page` if needed.

## What It Does

- Counts visible/log-derived played cards by type.
- Shows used/left card counts for each player.
- Shows data-quality checks before giving any advice.
- Supports copying diagnostics for bug reports.

## What It Does Not Do

- It does not automate gameplay.
- It does not make moves.
- It does not access BGA hidden/private APIs.
- It does not send your data anywhere.
- It does not claim official affiliation with Board Game Arena.

## For Testers

If something looks wrong, send:

- the table URL;
- the visible counter values you expected;
- the text from `Copy status` or `Copy diagnostics`;
- a short description of the move/card that looks miscounted.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Disclaimer

This is an unofficial fan-made helper for testing and learning. Board Game Arena and The Battle for Hill 218 belong to their respective owners.
