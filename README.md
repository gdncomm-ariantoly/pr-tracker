# PR Tracker

Click the toolbar icon to open a dashboard of **your open PRs** and **PRs waiting for your review** (review requested, open PRs you already reviewed, and open PRs in any *watched repositories* you list in Settings) on github.com. Each PR says whether any human (non-bot) has commented, lists those comments, and marks each one fixed or not:

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

Anything that asks for a change ("before merge", "once … is addressed", "please fix", a blocking or critical note, Changes requested) stays actionable even if it also says something positive. Fixed, No action needed and Optional comments are folded to a one-line preview; click one to open it (it stays open until you fold it again). Heuristics miss sometimes, so every unfixed comment has a **No action needed** button, with Undo. Marks are kept in this browser across refreshes.

Bots are excluded: GitHub App accounts, `*[bot]`, plus any logins you list in Settings. The badge shows how many PRs have your review requested; it refreshes on a timer (default 15 min).

### Claude (optional)

With an Anthropic API key in Settings (and a model: Opus 5 by default, Sonnet 5 or Haiku 4.5), Claude judges each comment as **fixed**, **not fixed** or **no action needed** from the thread and the PR's commit list, and writes a one-line summary of what still blocks the PR, shown on its card. Statuses it decided say *· Claude* and the "Why this status" line gives its reason. GitHub's own facts are never overruled: a resolved thread or code changed under a comment keeps that status. The **No action needed** button still works on anything Claude leaves as not fixed.

One call per PR with human comments, only when what Claude would see changed (comments, replies, commits or the model), so a quiet refresh costs nothing; at most 12 new calls per refresh, the rest follow on the next one. Answers are cached in `chrome.storage.local`. Failures, refusals and a rejected key fall back to the rules' guess, with a warning or banner. Saving the key asks Chrome for access to `api.anthropic.com`. The request goes straight from the browser (raw `fetch`, since the extension has no build step to bundle the SDK) with the key in `x-api-key`. **It sends comment text, file paths and commit messages to Anthropic** — check that's allowed for your repositories — and is billed to the key's account, so give the key a spend limit.

### Jenkins build

Jenkins reports each PR build to GitHub (a check run named "Jenkins CI"). The extension reads it from the PR's head commit, so no Jenkins login is needed, and shows a chip (e.g. **Jenkins #3 passed**, failed, running, queued) that links to the build. If several Jenkins jobs report, the worst one wins.

Test-automation repos (`cucumber-*`) never show Jenkins: no status, no link, no lookup and no build notifications, even when GitHub reports a build.

If GitHub hides builds from the token (fine-grained tokens may not see Jenkins check runs even with Commit statuses: Read), each PR gets a plain **Jenkins ↗** link built from the TRFCEE CI folder (`…/job/TRFCEE/job/{repo}/job/PR-{number}/`, `JENKINS_TEMPLATE` in `lib/store.js`) instead, and no banner nags about it.

Only the CI Jenkins (`jenkins-build-ci-2`) reports PR builds to GitHub. Deployment repos are run by other Jenkins instances that post nothing to PRs and don't let anonymous users list jobs. So they get a **Jenkins ↗** link to that Jenkins's search for the repo name (a unique match opens the job once you're signed in), with no status:

| Repo | Jenkins |
|---|---|
| `prod-infra-*` | `jenkins-prod-infra.gdn-app.com` |
| `prod-*` | `jenkins-prod-deploy.gdn-app.com` |
| `nonprod-*` | `jenkins-np-deploy.gdn-app.com` |

**Status straight from Jenkins (API token).** GitHub doesn't show Jenkins check runs to fine-grained tokens, so pass/fail comes from Jenkins itself. Settings → *Jenkins API token* takes your Jenkins user ID and an API token (Jenkins → your name → Security/Configure → API Token → Add new token). Saving it asks Chrome for access to the Jenkins host (`*.gdn-app.com`). Each refresh then asks `…/PR-{number}/lastBuild/api/json` with HTTP Basic auth, at most 6 at a time. The browser's Jenkins session is never used. No job (404): no chip. A rejected token (401): red banner. Without a token, PRs show a plain **Jenkins ↗** link and a banner offers adding one. Jenkins tokens are not scoped: it carries your full Jenkins rights, though PR Tracker only reads with it. It's stored in `chrome.storage.local` like the GitHub token.

### Layout

**Watched repositories** (Settings, up to 20; a bare name means `gdncomm/…`, a github.com URL works too) add every open, non-draft PR in those repos that you didn't write to *To review*, labelled *Watched repo*, so you see them even when nobody requests your review. The **Watched repos** checkbox above the list (To review tab) hides or shows them; the choice is remembered. A PR where you're a requested reviewer, or that you already reviewed, keeps that label and is never hidden by this filter. A new PR in a repo that was already watched also raises a *New PR* update.

Each tab is grouped by service (the repository name without `gdncomm/`). Order is "what needs me first": on *To review*, PRs you're on (review requested, or already reviewed by you) before PRs shown only because their repo is watched; then PRs with unfixed comments, then PRs with comments (all fixed or no action needed), then PRs without human comments, newest update first within each. Groups follow their most urgent PR, except deployment repos (`prod-*`, `nonprod-*`), which always come after the services. Comments you mark *No action needed* stop counting as unfixed for sorting too. PRs with no activity for more than 7 days (GitHub's `updatedAt`: any push, comment or review) move to a collapsed **Stale** group at the bottom.

### Updates panel

Every detected update (below) is also kept in an **Updates** panel on the right: newest first, unread marked with a dot and counted in the header, last 100 kept. Clicking one opens it on GitHub and marks it read; *Mark all read* clears the count. Each update is tagged **My PR** or **To review** (desktop notifications say the same in their context line), and the **×** on hover deletes it. On windows narrower than 1100px the panel becomes a drawer behind the header's **Updates** button. The panel records updates even when desktop notifications are off.

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
node tools/verify-claude.mjs   # Claude judging, against a replayed Anthropic API
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
| optional host `https://*.gdn-app.com/*` | Only once you save a Jenkins API token: reads each PR's last build from Jenkins with it |

## Limits

- Top 30 most recently updated PRs per list; per PR, the last 50 commits, first 50 threads / reviews / comments.
- "Fixed" is inferred, not proven. Commit timestamps are commit dates, so a rebase can move them.

## Real-data check

```sh
gh api graphql --input <(node tools/print-query.mjs) > /tmp/dashboard.json
FIXTURE=/tmp/dashboard.json npm run verify
```

The icon is drawn in `icons/icon.svg`; after editing it, run `node tools/make-icons.mjs` to regenerate the PNGs.
