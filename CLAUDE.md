# PR Tracker

Manifest V3 Chrome extension: a dashboard of the user's open PRs and PRs awaiting their review on github.com (gdncomm org), with every human comment and whether it was fixed. Optional extras: Jenkins build status, Claude judging/summaries through a local Claude Code helper, links to local Claude Code sessions. `README.md` is the user-facing spec of every feature; read it before changing behavior.

`AGENTS.md` is a symlink to this file. Edit `CLAUDE.md` only.

## Keep this file current

Whenever a change adds, removes or renames a module, command, setting, permission, storage key or convention described here, update this file in the same change. Also update `README.md` when user-visible behavior changes.

## Layout

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `alarms`, `notifications`; host `api.github.com`; optional `nativeMessaging` and `*.gdn-app.com` (Jenkins) |
| `background.js` | Service worker: opens the dashboard, refresh alarm, badge, desktop notifications, Updates inbox writes. Not persistent: listeners registered synchronously at top level, all state in storage |
| `platform.js` | The few `chrome.*` calls (permissions, native messaging) handed to `lib/refresh.js`, kept out of `lib/` |
| `lib/` | Pure logic, no `chrome.*`; `fetch`, storage and helper round trips are injected so everything runs under `node --test` |
| `lib/github.js` | GraphQL client: dashboard query (one request per list, retried on 504), single-PR fetch |
| `lib/analyze.js` | Per-comment status (resolved, fixed reply, code changed, replied, commit after, not addressed, no action needed, optional) |
| `lib/claude.js` | Claude judgement + one-line summary via the helper; change signature so unchanged PRs are never re-asked; model list |
| `lib/jenkins.js` | Build status from Jenkins with the user's API token (HTTP Basic, `credentials: 'omit'`), team-folder lookup |
| `lib/refresh.js` | Orchestrates a full refresh or one-PR refresh; badge count |
| `lib/group.js` | Grouping by service and "what needs me first" ordering, Stale group |
| `lib/notify.js` | Snapshot diff into update events |
| `lib/inbox.js` | Updates panel history (last 100) |
| `lib/overrides.js` | User's "No action needed" marks layered over analysis |
| `lib/signals.js` | OrgSignals per-PR metrics: scope (team repos, `master`/`release/*`, never `prod-`/`nonprod-` deployment repos), tiers and bot rule copied from growth-signals `sprint-score` `scoring.json` |
| `lib/sessions.js` | PR ↔ Claude Code session links (comment marker + helper scan) |
| `lib/store.js` | Settings, snapshot, caches in `chrome.storage.local` (storage area is an argument for tests) |
| `pages/app.html`, `app.js`, `app.css` | Dashboard page UI; Settings is a modal `<dialog>` (`#settings-dialog`), with its own error line `#settings-error` since the page banner sits behind it |
| `pages/markdown.js` | Renders GitHub `bodyHTML` through an allowlist, parsed inert; never trust remote HTML |
| `native/` | Local native-messaging helper: `host.mjs` (sessions scan, runs `claude -p` with no tools), `scan.mjs`, `claude-code-hook.mjs`, `install.sh` |
| `tests/` | `node --test` unit tests, `tests/fixtures/` sample GraphQL data |
| `tools/` | Browser verification (Playwright), packaging, icon and screenshot generation; `tools/fixture.mjs` replays the sample data with its dates moved to today so it never goes Stale |
| `docs/` | `install.html` + `screenshot.png` (install page) |
| `dist/` | Built output (gitignored) |

## Dev environment

- No build step: plain ES modules, loaded unpacked from the repo root (`chrome://extensions` → Developer mode → Load unpacked). Reload the extension after changing `manifest.json` or `background.js`.
- Types are JSDoc checked by `tsc` (`jsconfig.json`, strict); nothing compiles. Keep new code JSDoc-typed.
- `npm install`, then `npx playwright install chromium` for the browser checks.

## Testing

```sh
npm test                        # unit tests, no browser
npm run typecheck               # tsc --noEmit over JSDoc types
npm run verify                  # real Chromium: tools/verify-extension.mjs + tools/verify-jenkins.mjs
node tools/verify-claude.mjs    # Claude judging through the real helper and a stand-in claude CLI
node tools/verify-sessions.mjs  # native helper end to end: sessions + Summarize
```

Run `npm test` and `npm run typecheck` on every change; run `npm run verify` (and the relevant `verify-*.mjs`) for anything touching the manifest, worker, page or helper. Unit tests cannot catch a manifest that does not parse, a worker that fails to register, or CSS defeating `element.hidden`.

Real-data check: `gh api graphql --input <(node tools/print-query.mjs) > /tmp/dashboard.json && FIXTURE=/tmp/dashboard.json npm run verify`.

## Build and release

- `npm run package`: Web Store zip (`tools/package-extension.sh`, only files Chrome reads).
- `npm run dist`: `dist/` with install page, screenshot and zip.
- `node tools/make-screenshot.mjs`: regenerate `docs/screenshot.png` from fixture data.
- `node tools/make-icons.mjs`: regenerate PNGs after editing `icons/icon.svg`.
- Releases bump `version` in both `manifest.json` and `package.json` together; commit subject style `vX.Y.Z: <summary>`.

## Conventions

- Keep `chrome.*` out of `lib/`; inject dependencies so tests run in Node.
- Service worker holds no in-memory state that matters; everything persists in `chrome.storage.local`.
- GitHub facts (resolved thread, outdated code) are never overruled by Claude.
- Tokens (GitHub, Jenkins) live in `chrome.storage.local`, or in the macOS Keychain via the helper (storage then holds `@keychain`), and go only to their own host. Optional host permissions are requested only when the feature is enabled.
- Comment HTML goes through `pages/markdown.js`; do not insert remote HTML directly.

## Security considerations

- The GitHub token is fine-grained, read-only; the extension only reads.
- Jenkins API tokens carry the user's full Jenkins rights; only read with them.
- Claude runs through the local helper with all tools off, no settings/MCP, no session persistence; it sends comment text, file paths and commit messages to Anthropic.
