# git helper

Two everyday git chores, done safely, for any repo:

- **Switch** — `stash → switch → pull → pop` in one command. Stops at the first error and never
  loses work: it only ever pops the stash it created, and asks before removing a worktree that
  holds the branch you want.
- **Promote** — walk a branch chain upstream (e.g. `develop → qa → stage → main`) one PR at a
  time. You merge each PR on GitHub; a worker notices and opens the next one.

CLI (`git-helper`, also `git helper` and `gsw`), a local web dashboard, and a tray app share
one engine. Design: [docs/specs/2026-09-29-git-switcher-design.md](docs/specs/2026-09-29-git-switcher-design.md).

## Setup

Requires Node ≥ 22, pnpm, git — and for promotions the [GitHub CLI](https://cli.github.com)
logged in (`gh auth login`). The app stores no tokens of its own.

```bash
pnpm install
pnpm build
pnpm test
```

Put it on your PATH (any of these):

```bash
pnpm --dir packages/cli link --global
ln -s "$PWD/packages/cli/dist/bin.js" /usr/local/bin/git-helper
ln -s "$PWD/packages/cli/dist/bin.js" /usr/local/bin/gsw
```

## Switch

```bash
git helper feature/login                         # in any repo
git helper add . --name api --base origin/develop  # register repos…
git helper group add work api web                # …and group them
git helper feature/login --group work            # switch every repo in the group
git helper ls                                    # branch, dirty state, worktrees
git helper history                               # past runs, incl. any stash a failed run left
```

If a run stops (pull diverged, pop conflict, …) it prints which stash holds your changes and the
exact command to restore them. Nothing is switched back behind your back.

## Promote

```bash
git helper pipeline set api develop qa stage main --auto-merge develop:qa
git helper promote api            # opens develop → qa and prints the PR link
git helper promote --group work   # one independent promotion per repo
git helper promote api --from qa  # start mid-chain
git helper promote api --watch    # keep this terminal polling until done
git helper promotions             # status of every promotion
git helper promotions stop <id>   # stop polling (never closes a PR); resume <id> to continue
```

For each step: nothing to promote → skipped; an open PR for the same branches → reused;
otherwise a PR titled `Promote develop → qa` listing the commits is opened. Steps marked
`--auto-merge` get GitHub auto-merge with a **merge commit** (squash/rebase would make the
branches drift apart). Closing a PR without merging aborts the promotion.

The worker runs inside `git helper ui`, the tray app, or `promote --watch`, polls GitHub every
60 s, and keeps state in `promotions.json`, so it resumes after a restart. Only one process
polls at a time.

## Dashboard and tray app

```bash
git helper ui       # opens http://127.0.0.1:<port>/?token=… (token changes every launch)
pnpm desktop        # tray app: repo branches, "Switch <group>…", PRs waiting for you,
                    # and a notification when a new promotion PR is ready
```

On macOS, make it a real app (goes to `~/Applications`):

```bash
scripts/make-app.sh
```

`git helper.app` is a copy-on-write clone of this checkout's Electron with its own name, icon and
bundle id, whose app folder links back to `packages/desktop`. It is the same app you click and the
one that runs, so Keep in Dock, Cmd+Q and clicking it again work like any Mac app, and
`pnpm build` applies without rebuilding it. It also re-points an existing "Start at login" item at
itself. Re-run the script after moving the checkout or upgrading Electron. The first launch from
Finder may ask for access to the folder the checkout lives in (e.g. Documents) — allow it.

Try them against throwaway data without touching your registry:

```bash
scripts/demo.sh             # switching, with real temporary git repos
pnpm demo:promotions        # promotions, against an in-memory GitHub that merges PRs itself
```

Registry, history and promotions live in `~/.config/git-helper/` (`$XDG_CONFIG_HOME` and
`$GIT_HELPER_HOME` are honoured).

## Packages

| Package | Role |
|---|---|
| `packages/core` | all logic: `inspect/`, `switch/`, `registry/`, `history/`, `promote/` |
| `packages/cli` | the `git-helper` / `gsw` binary |
| `packages/server` | localhost API (+ SSE) and the in-process promotion worker |
| `packages/web` | dashboard SPA (Repos, Promotions, History) |
| `packages/desktop` | Electron tray app |

A new feature is a new `core` module + server route + an entry in `web/src/pages/index.ts`.
