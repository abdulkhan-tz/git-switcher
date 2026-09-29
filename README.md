# git-helper (`gsw`)

`stash → switch → pull → pop` in one command, for any git repo. Stops at the first error and
never loses work. Design: [docs/specs/2026-09-29-git-helper-design.md](docs/specs/2026-09-29-git-helper-design.md).

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Put `gsw` on your PATH (either works):

```bash
pnpm --dir packages/cli link --global
ln -s "$PWD/packages/cli/dist/bin.js" /usr/local/bin/gsw
```

## Use

```bash
git-helper feature/login                      # in any repo
git-helper add . --name api --base origin/develop
git-helper group add work api web
git-helper feature/login --group work         # both repos, each independently
git-helper ls                           # registered repos, branch, dirty state
git-helper history                      # past runs, incl. any stash a failed run left behind
git-helper ui                           # dashboard
```

Desktop tray app (macOS menu bar; also Windows/Linux):

```bash
pnpm desktop
```

It starts the dashboard server inside the app. Closing the window keeps it in the tray; the tray
menu shows each repo's branch and a "Switch <group>…" entry per group.

Try the dashboard against throwaway repos without touching your registry:

```bash
scripts/demo.sh
```

Registry and history live in `~/.config/git-helper/` (`$XDG_CONFIG_HOME` and
`$GIT_HELPER_HOME` are honoured).

## Packages

| Package | Role |
|---|---|
| `packages/core` | all git logic: `inspect/`, `switch/`, `registry/`, `history/` |
| `packages/cli` | the `gsw` binary |
| `packages/server` | localhost API + SSE for the dashboard |
| `packages/web` | dashboard SPA |
| `packages/desktop` | Electron tray app |

A new feature (worktree view, health check) is a new `core` module + server route + web page.
