# git tidy

Two everyday git chores, done safely, for any repo:

- **Switch** — `stash → switch → pull → pop` in one command. Stops at the first error and never
  loses work: it only ever pops the stash it created, and asks before removing a worktree that
  holds the branch you want.
- **Promote** — walk a branch chain upstream (e.g. `develop → qa → stage → main`) one PR at a
  time. You merge each PR on GitHub; a worker notices and opens the next one.

- **Services** — start the local processes a project needs (a database, a gateway, an auth server)
  in the background, see which are up, and stop them, without keeping an IDE open for each.

CLI (`git-tidy`, which also makes it `git tidy`; and `tidy`), a local web dashboard, and a tray app share
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
ln -s "$PWD/packages/cli/dist/bin.js" /usr/local/bin/git-tidy
# optional short name — macOS already ships an HTML `tidy` in /usr/bin, so only if you do not use that:
# ln -s "$PWD/packages/cli/dist/bin.js" /usr/local/bin/tidy
```

## Switch

```bash
git tidy feature/login                         # in any repo
git tidy add . --name api --base origin/develop  # register repos…
git tidy group add work api web                # …and group them
git tidy feature/login --group work            # switch every repo in the group
git tidy ls                                    # branch, dirty state, worktrees
git tidy history                               # past runs, incl. any stash a failed run left
```

If a run stops (pull diverged, pop conflict, …) it prints which stash holds your changes and the
exact command to restore them. Nothing is switched back behind your back.

On a case-insensitive disk (the macOS default) a `Feature/` ref directory silently turns a new
`feature/x` branch into `Feature/x`, and a later `git gc` then leaves that checkout pointing at
nothing ("You do not have the initial commit yet"). Every switch first repairs such checkouts in
all worktrees, keeps names exactly as typed, and never triggers `gc` itself. To repair without
switching: `git tidy repair [--group <name>]` — the dashboard also flags affected repos.

## Promote

```bash
git tidy pipeline set api develop qa stage main --auto-merge develop:qa
git tidy promote api            # opens develop → qa and prints the PR link
git tidy promote --group work   # one independent promotion per repo
git tidy promote api --from qa  # start mid-chain
git tidy promote api --watch    # keep this terminal polling until done
git tidy promotions             # status of every promotion
git tidy promotions stop <id>   # stop polling (never closes a PR); resume <id> to continue
```

For each step: nothing to promote → skipped; an open PR for the same branches → reused;
otherwise a PR titled `Promote develop → qa` listing the commits is opened. Steps marked
`--auto-merge` get GitHub auto-merge with a **merge commit** (squash/rebase would make the
branches drift apart). Closing a PR without merging aborts the promotion.

The worker runs inside `git tidy ui`, the tray app, or `promote --watch`, polls GitHub every
60 s, and keeps state in `promotions.json`, so it resumes after a restart. Only one process
polls at a time.

## Services

```bash
git tidy services                         # what is up and what is down
git tidy services show api                  # folder, command, build step, env, port, needs, log file
git tidy services up [name|group…]          # start in the background, in the order given (none = all)
git tidy services down [name|group…]        # stop named services (even ones started elsewhere) and what depends on them
git tidy services restart api               # stops and starts it (and whatever depended on it), nothing else
git tidy services rename api backend        # needs, groups and logs follow
git tidy services set api --port 8081 --depends db --prepare ""   # edit; "" clears an optional field
git tidy services group set dev db api web  # a group: start order = the order given
git tidy services group rename dev backend
git tidy services branch api                # the branch it runs on (and how many it could switch to)
git tidy services switch api feature/login  # stop it, switch its checkout, start it again
git tidy services up dev                    # start the whole group, top to bottom
git tidy services logs api --lines 100    # logs live in ~/.config/git-tidy/logs/
git tidy services add api --cwd ~/code/api --port 8080 \
    --prepare 'mvn -q -DskipTests package' \
    --command 'exec java -jar target/api.jar' --depends db
git tidy services import services.json    # {"services":[{ name, cwd, command, port, … }]}
```

A service is a shell `command` (end it with `exec` so the tracked process is the service itself),
an optional `prepare` step (a build; if it fails nothing starts), the TCP `port` it listens on,
optional `env`, `dependsOn` and `startTimeoutSec`. `up` starts a service's dependencies only if they are
not already up, and never restarts one that is; `down` stops only what you name and its dependents. "Up" means the port is open, so a service
started by an IDE or another terminal shows as *up (elsewhere)*: it is never started twice.
`down` with no names leaves it alone; `down <name>` (or the dashboard's Stop, which asks first)
ends only the one process listening on that port, after which `up` runs it under tidy. Definitions live in `services.json` in the config directory. The
dashboard has two sections in its header: **Git** (Repos, Promotions, History) and **Services**
(Services, Groups). Services lists each process with its groups, state, branch, uncommitted-file
and stash counts. Click one for a side panel — the service list on the left, and on the right its
**Logs** (a live tail that follows the newest line, with Pause, Refresh and Clear log), **Uncommitted files** (with every stash entry and its files) and **Config**
(folder, command, build step, env; edit or rename). The panel also has a branch picker with
*Switch & restart*: the service is stopped, its checkout is switched with the same safe
stash → switch → pull → pop as the Repos tab (a branch that does not exist is never created from
here), and the service is started again on the new code. The **Groups** tab creates, renames,
reorders and starts/stops groups.

## Dashboard and tray app

```bash
git tidy ui       # opens http://127.0.0.1:<port>/?token=… (token changes every launch)
pnpm desktop        # tray app: repo branches, "Switch <group>…", PRs waiting for you,
                    # and a notification when a new promotion PR is ready
```

On macOS, make it a real app (goes to `~/Applications`):

```bash
scripts/make-app.sh
```

`tidy.app` is a copy-on-write clone of this checkout's Electron with its own name, icon and
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

Registry, history and promotions live in `~/.config/git-tidy/` (`$XDG_CONFIG_HOME` and
`$TIDY_HOME` are honoured).

## Packages

| Package | Role |
|---|---|
| `packages/core` | all logic: `inspect/`, `switch/`, `registry/`, `history/`, `promote/`, `services/` |
| `packages/cli` | the `git-tidy` / `tidy` binary |
| `packages/server` | localhost API (+ SSE) and the in-process promotion worker |
| `packages/web` | dashboard SPA (Repos, Promotions, Services, History) |
| `packages/desktop` | Electron tray app |

A new feature is a new `core` module + server route + an entry in `web/src/pages/index.ts`.
