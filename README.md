# git-switcher (`gsw`)

`stash → switch → pull → pop` in one command, for any git repo. Stops at the first error and
never loses work. Design: [docs/specs/2026-09-29-git-switcher-design.md](docs/specs/2026-09-29-git-switcher-design.md).

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
gsw feature/login                      # in any repo
gsw add . --name api --base origin/develop
gsw group add work api web
gsw feature/login --group work         # both repos, each independently
gsw ls                           # registered repos, branch, dirty state
gsw history                      # past runs, incl. any stash a failed run left behind
gsw ui                           # dashboard
```

Registry and history live in `~/.config/git-switcher/` (`$XDG_CONFIG_HOME` and
`$GIT_SWITCHER_HOME` are honoured).

## Packages

| Package | Role |
|---|---|
| `packages/core` | all git logic: `inspect/`, `switch/`, `registry/`, `history/` |
| `packages/cli` | the `gsw` binary |
| `packages/server` | localhost API + SSE for the dashboard |
| `packages/web` | dashboard SPA |
| `packages/desktop` | Electron tray app |

A new feature (worktree view, health check) is a new `core` module + server route + web page.
