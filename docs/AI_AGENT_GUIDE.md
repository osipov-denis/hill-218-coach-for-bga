# AI Agent Guide

This repository contains a Chrome Manifest V3 extension beta.

## Goal

Help a human tester install and run a read-only card counter for The Battle for Hill 218 on Board Game Arena.

## Important Paths

- `extension/manifest.json` - Chrome extension manifest.
- `extension/src/cardModel.js` - card parsing and probability model.
- `extension/src/content.js` - floating UI injected into BGA pages.
- `extension/src/overlay.css` - panel styles.
- `extension/tests/cardModel.test.js` - model regression tests.
- `scripts/bga_gamereview_corpus.js` - local/offline corpus helper used by tests.

## Safe Install Instructions

Tell the user:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `extension` folder.
5. Open a Battle for Hill 218 game page on Board Game Arena.

## Safety Constraints

- Do not add gameplay automation.
- Do not click BGA move/action controls.
- Do not use hidden/private BGA APIs.
- Do not add telemetry without explicit consent and a privacy-policy update.
- Keep advice gated when data quality is uncertain.

## Local Checks

Run:

```bash
npm run check:syntax
npm test
```

Package a ZIP for testers:

```bash
npm run package:zip
```
