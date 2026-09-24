# PR Tracker

Click the toolbar icon to open a dashboard of **your open PRs** and **PRs waiting for your review** (review requested, plus open PRs you already reviewed) on github.com. Each PR says whether any human (non-bot) has commented, lists those comments, and marks each one fixed or not:

| Status | Counts as | Evidence |
|---|---|---|
| Resolved | fixed | Review thread resolved (or review dismissed) |
| Fixed (reply) | fixed | PR author replied claiming a fix — "done", "fixed in abc123", "sudah diperbaiki" |
| Code changed | fixed | Thread is *outdated*: the commented lines changed afterwards |
| Replied | unfixed | Author replied but did not claim a fix (explained / pushed back) |
| Commit after | unfixed | A non-merge commit landed after the comment, nothing else |
| Not addressed | unfixed | No reply, no resolve, no commit since |

Bots are excluded: GitHub App accounts, `*[bot]`, plus any logins you list in Settings. The badge shows how many PRs have your review requested; it refreshes on a timer (default 15 min).

![screenshot](docs/screenshot.png)

## Setup

1. Create a token: classic PAT with `repo` scope (or fine-grained, Pull requests: read).
2. If your org enforces SAML SSO, open the token → **Configure SSO** → **Authorize** for the org, or every private PR is invisible.
3. Open PR Tracker → Settings → paste it → Save. It is stored only in `chrome.storage.local` of this browser and sent only to `api.github.com`.

## Install

No build step — the extension is plain ES modules and loads as it sits.

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this directory
2. Reload from the card after changing `manifest.json` or `background.js`

## Development

```sh
npm install
npm test            # unit tests — no browser needed
npm run typecheck   # JSDoc types via tsc --noEmit; nothing is compiled
npm run verify      # loads the extension into a real Chromium and drives it
npm run package     # Web Store zip
```

`npm run verify` is the one that catches what unit tests cannot: a manifest that
does not parse, a service worker that failed to register, a page whose modules
never loaded, or CSS that quietly defeated `element.hidden`.

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage` | Token, settings, and the last fetched snapshot |
| `alarms` | Periodic refresh for the badge |
| host `https://api.github.com/*` | The one GraphQL call that fetches the PRs |

## Limits

- Top 30 most recently updated PRs per list; per PR, the last 50 commits, first 50 threads / reviews / comments.
- "Fixed" is inferred, not proven. Commit timestamps are commit dates, so a rebase can move them.

## Real-data check

```sh
gh api graphql --input <(node tools/print-query.mjs) > /tmp/dashboard.json
FIXTURE=/tmp/dashboard.json npm run verify
```
