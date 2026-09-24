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
| No action needed | neither | An approval or clean review: "Verdict: Approve", "No blocking issues", "flagging as solid for a human reviewer". Needs a human approval, not a code change. Or you marked it yourself. |
| Optional | neither | Explicitly non-blocking: "Nit (non-blocking)", "Approve with suggestions" |

Anything that asks for a change ("before merge", "once … is addressed", "please fix", a blocking or critical note, Changes requested) stays actionable even if it also says something positive. Heuristics miss sometimes, so every unfixed comment has a **No action needed** button, with Undo. Marks are kept in this browser across refreshes.

Bots are excluded: GitHub App accounts, `*[bot]`, plus any logins you list in Settings. The badge shows how many PRs have your review requested; it refreshes on a timer (default 15 min).

### Jenkins build

Jenkins reports each PR build to GitHub (a check run named "Jenkins CI"). The extension reads it from the PR's head commit, so no Jenkins login is needed, and shows a chip (e.g. **Jenkins #3 passed**, failed, running, queued) that links to the build. If several Jenkins jobs report, the worst one wins.

If GitHub hides builds from the token (fine-grained tokens may not see Jenkins check runs even with Commit statuses: Read), each PR gets a plain **Jenkins ↗** link built from the *Jenkins job link* setting (default `…/job/TRFCEE/job/{repo}/job/PR-{number}/`) instead, and no banner nags about it.

**Status straight from Jenkins.** When builds are hidden, a blue banner offers *Show build status from Jenkins*. Accepting grants the optional host permission for the Jenkins host (`*.gdn-app.com`). From then on each refresh asks `…/PR-{number}/lastBuild/api/json` using your **own Jenkins sign-in in this browser**: no Jenkins token is stored. Not signed in (Jenkins answers 403): the chip says *Jenkins: sign in ↗* and a banner links to Jenkins. No job (404, e.g. deployment repos): no chip. At most 6 requests run at once.

### Layout

Each tab is grouped by service (the repository name without `gdncomm/`), alphabetically, newest PR first. PRs with no activity for more than 7 days (GitHub's `updatedAt`: any push, comment or review) move to a collapsed **Stale** group at the bottom.

### Notifications

On each refresh the new snapshot is diffed against the previous one, and a desktop notification is raised for:

- **My PRs:** a new human comment, a reviewer following up in an existing thread, the PR becoming Approved or Changes requested, the Jenkins build failing (and passing again after a failure)
- **PRs I review:** a new review request; one of *my* comments getting fixed (resolved / code changed / "done" reply) or answered by the author

Clicking a notification opens that comment on GitHub. More than 4 updates at once collapse into one summary that opens the dashboard. The first fetch after install never notifies. Switch off in Settings. On macOS, Chrome itself must be allowed to notify (System Settings → Notifications → Google Chrome).

![screenshot](docs/screenshot.png)

## Setup

1. Create a **fine-grained** token with Resource owner **gdncomm** ([pre-filled link](https://github.com/settings/personal-access-tokens/new?name=PR+Tracker&description=Read-only+PR+dashboard&target_name=gdncomm&expires_in=90&pull_requests=read&contents=read&statuses=read)):
   - Repository access: **All repositories**
   - Permissions: **Pull requests**, **Contents** and **Commit statuses**, all Read-only (Metadata is automatic). Commit statuses is what shows the Jenkins build.
2. If the org requires approval, wait until the token is no longer **pending**. No "Configure SSO" step is needed for fine-grained tokens.
3. Open PR Tracker → Settings → paste it → Save.

Only gdncomm repositories are covered: a fine-grained token has a single resource owner. A classic `repo` token also works (authorize it for SSO), but it grants far more than this read-only dashboard needs. It is stored only in `chrome.storage.local` of this browser and sent only to `api.github.com`.

## Install

No build step — the extension is plain ES modules and loads as it sits.

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this directory
2. Reload from the card after changing `manifest.json` or `background.js`

## Development

```sh
npm install
npm test            # unit tests — no browser needed
npm run typecheck   # JSDoc types via tsc --noEmit; nothing is compiled
npm run verify      # loads the extension into a real Chromium and drives it (incl. tools/verify-jenkins.mjs)
npm run package     # Web Store zip
```

`npm run verify` is the one that catches what unit tests cannot: a manifest that
does not parse, a service worker that failed to register, a page whose modules
never loaded, or CSS that quietly defeated `element.hidden`.

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage` | Token, settings, and the last fetched snapshot |
| `alarms` | Periodic refresh for the badge and notifications |
| `notifications` | Desktop alerts for new comments, approvals, review requests and fixes |
| host `https://api.github.com/*` | The one GraphQL call that fetches the PRs |
| optional host `https://*.gdn-app.com/*` | Only if you click *Show build status from Jenkins*: reads each PR's last build from Jenkins with your session |

## Limits

- Top 30 most recently updated PRs per list; per PR, the last 50 commits, first 50 threads / reviews / comments.
- "Fixed" is inferred, not proven. Commit timestamps are commit dates, so a rebase can move them.

## Real-data check

```sh
gh api graphql --input <(node tools/print-query.mjs) > /tmp/dashboard.json
FIXTURE=/tmp/dashboard.json npm run verify
```
