# git-helper — Design Spec

- **Date:** 2026-09-29
- **Status:** Implemented (phases 1–3)
- **Location:** standalone git repo, branch `main`

## 1. Purpose

Replace the manual, frequently repeated sequence

```
git stash → git checkout <branch> → git pull → git stash pop
```

with one safe command that works on any local repo, stops at the first error, never loses
work, and handles the "branch is checked out in another worktree" case with an explicit prompt.
Several local repos can be registered and viewed/switched together from a UI.

### Success criteria

- `git-helper <branch>` in any repo performs the sequence and leaves the working changes restored on
  the target branch, or stops with a precise recovery instruction.
- It never pops a stash it did not create, and never deletes a dirty worktree without a second
  explicit confirmation.
- Registered repos can be switched together (e.g. an API repo and a web repo to `feature/login`) from the CLI,
  the web UI and the desktop tray app, all using the same engine.

### Non-goals (for now)

- Worktree management views, health checks, and other repo tooling — planned later; the
  architecture leaves room for them (§3.2) but none is built in this spec.
- Submodule recursion, auto-merge/rebase on pull, rolling back other repos when one fails.

## 2. Terminology

- **Run** — one switch attempt on one repo.
- **Multi-run** — the same target branch applied to several repos; each repo is an independent run.
- **Own stash** — the stash entry created by this run, identified by its message.
- **Prompter** — a callback the engine calls when it needs a human decision.

## 3. Architecture

### 3.1 Packages (pnpm workspace, TypeScript, Node ≥ 22)

```
git-helper/
├── packages/core      git logic only; no I/O to the user
├── packages/cli       `git-helper` binary (alias `gsw`)
├── packages/server    localhost HTTP API + Server-Sent Events
├── packages/web       dashboard SPA
└── packages/desktop   Electron tray app hosting the web UI
```

Dependency direction: `cli`, `server`, `desktop` → `core`; `web` → `server` (HTTP only);
`cli` and `desktop` start `server` in-process and serve `web`'s build.

### 3.2 `core` layout — by feature module

```
core/src/
├── git/          thin wrapper: exec git with args (no shell), capture stdout/stderr/exit code
├── inspect/      read-only repo state
├── switch/       the switch run (steps, stash, worktree, pull)
├── registry/     registered repos + groups
└── history/      append-only run log
```

A future feature (worktree view, health checks) is a new module plus a server route plus a web
page; it reads data through `inspect/` and does not change `switch/`.

### 3.3 Public core API

```ts
inspect(repoPath): Promise<RepoState>
switchBranch(repoPath, branch, opts: SwitchOptions, prompter: Prompter,
             onEvent?: (e: StepEvent) => void): Promise<RunResult>
switchMany(repoPaths[], branch, opts, prompter, onEvent?): Promise<RunResult[]>
registry.list() / add(path, {name?, base?}) / remove(id) / groups.*
history.append(result) / history.list({repo?, limit?})
```

`RepoState`: current branch (or detached), uncommitted count, untracked count, ahead/behind
upstream, upstream name, in-progress operation (merge/rebase/cherry-pick/none), worktrees
(path, branch, isMain, locked, dirty count).

`Prompter` questions (discriminated union, each with a typed answer):

| Kind | Asked when | Answers |
|---|---|---|
| `createBranch` | branch not found locally or on remote | create from base / cancel |
| `removeWorktree` | target branch is checked out in another worktree | delete & continue / cancel |
| `confirmDirtyWorktree` | that worktree has uncommitted changes | confirm loss / cancel |

`StepEvent`: `{ repo, step, status: start|ok|skip|fail, message }`, streamed live.

`RunResult`: `{ repo, from, to, outcome: switched|cancelled|failed, failedStep?, stashRef?,
stashMessage?, conflictedFiles?, recovery?: string, events[] }`.

### 3.4 Front ends

- **CLI** — prompter = interactive terminal y/N. Commands:
  - `git-helper <branch>` — current repo
  - `git-helper <branch> --group <name>` / `--repos a,b` — multi-run
  - `git-helper add [path] [--name n] [--base origin/develop]`, `git-helper rm <name>`, `git-helper ls`
  - `git-helper group add <name> <repo...>`, `git-helper group ls`
  - `git-helper history [--repo n]`
  - `git-helper ui` — start the server and open the browser
  - Exit code: 0 all switched; 1 any failed; 2 any cancelled (and none failed).
- **Server** — binds `127.0.0.1` only, random free port unless `--port`. Endpoints for
  registry CRUD, `GET /repos/:id/state`, `POST /switch` (returns run id), `GET /runs/:id/events`
  (SSE: step events and prompt requests), `POST /runs/:id/answer`. A per-launch random token
  is required on every request (sent in a header) to stop other local pages from driving it.
- **Web** — dashboard of repo cards (branch, dirty/untracked, ahead/behind, worktrees);
  multi-select + branch input → switch; live step log per repo; prompts as modal dialogs;
  result table at the end; history view.
- **Desktop** — Electron tray icon: menu shows registered repos with current branch (● when
  dirty), a "Switch <group>…" entry per group (opens the dashboard with that group preselected),
  History, Quit. The main process runs the `server` in-process on a random localhost port and the
  window loads the same web UI, so prompts use the web dialogs. Closing the window keeps the app
  in the tray; the window cannot navigate away from the dashboard origin.
  *(Changed during implementation from "core via IPC + native dialogs": hosting the server
  in-process reuses the whole web UI and its prompt flow with no second transport.)*

## 4. Switch algorithm (one run)

Each step emits events; any failure stops the run and produces `recovery` text.

1. **Preflight** — must be a git work tree; refuse if a merge, rebase, cherry-pick, revert or
   bisect is in progress. Prune stale worktree entries (`git worktree prune`) — always safe.
2. **Fetch** — `git fetch --prune <remote>` for the target branch's remote (default `origin`).
   If fetch fails (offline), stop — the pull would fail anyway.
3. **Resolve branch** (case-sensitive), in order:
   1. If any local or remote branch name differs from `<branch>` only in case, stop and list
      all such names — even when an exact match also exists. macOS folds case in ref files,
      so guessing is unsafe.
   2. Local branch exists → target it.
   3. Only `<remote>/<branch>` exists → will create a local tracking branch.
   4. Neither → prompt `createBranch` from the repo's configured base (default: the remote's
      default branch). Cancel → outcome `cancelled`, nothing changed yet.
4. **Worktree check** — if the target branch is checked out in another worktree:
   - If that worktree is the main checkout → stop (never removed).
   - Prompt `removeWorktree` showing path, uncommitted count, unpushed commit count, locked flag.
   - If uncommitted count > 0 → additionally prompt `confirmDirtyWorktree`.
   - On confirmation: `git worktree remove [--force if dirty or locked] <path>`.
   - Cancel → outcome `cancelled`, nothing changed yet.
5. **Already on target** — if current branch = target, skip step 7 (checkout) but still do 6, 8, 9.
6. **Stash** — if uncommitted or untracked changes exist:
   `git stash push -u -m "git-helper: <from> → <to> @ <ISO time> #<run id>"`.
   Record that a stash was made. Clean tree → skip; record *no* stash (step 9 then does nothing).
7. **Checkout** — `git switch <branch>`, or `git switch -c <branch> --track <remote>/<branch>`,
   or `git switch -c <branch> <base>` for a newly created branch.
8. **Pull** — if the branch has an upstream: `git pull --ff-only`. No upstream → skip with a
   note. Divergence or any error → stop.
9. **Pop own stash** — locate the stash entry whose message contains `#<run id>` (never
   assume `stash@{0}`), then `git stash pop <that ref>`. On conflict git keeps the stash; stop,
   list conflicted files, outcome `failed` at step `pop`.

**On any failure:** stay where the run stopped — do not switch back. `recovery` states the
current branch, whether an own stash exists and its message, and the exact commands to restore
(e.g. `git stash pop stash@{2}` on branch `X`). The CLI prints it; the UI shows it.

**Multi-run:** repos run sequentially in registry order (keeps prompts one at a time and output
readable). One repo failing or cancelling does not stop the others or roll anything back.

## 5. Persistence

Directory: `~/.config/git-helper/` (respect `XDG_CONFIG_HOME`).

- `repos.json` — `{ version: 1, repos: [{ id, name, path, base?, remote? }], groups: [{ name, repoIds[] }] }`.
  Writes are atomic (temp file + rename). Paths are stored absolute and resolved to the
  repository top level on add; duplicates rejected.
- `history.jsonl` — one `RunResult` (without full event list, with step summary) per line,
  appended after each run.

## 6. Error handling principles

- Git runs via `execFile` with an argument array — never a shell string (branch names are
  user input).
- Every git failure surfaces git's own stderr alongside the step name.
- A run never performs a destructive action (worktree removal, `--force`) without the
  corresponding prompter answer in the same run.
- A registered repo whose path no longer exists shows as "missing" in `ls` / UI; it is not
  auto-removed.

## 7. Testing

- **core:** integration tests against real temporary repos (bare "remote" + clone + extra
  worktrees) created per test with the system `git`. Required cases:
  clean tree (no stash made, older unrelated stash untouched); dirty + untracked tree restored;
  remote-only branch; not-found → create / cancel; case-only mismatch stops; worktree clean /
  dirty / locked / main; already on target; pull diverged stops with stash retained; no
  upstream skips pull; pop conflict keeps stash; preflight refuses mid-rebase; multi-run where
  one repo fails and others succeed.
- **cli:** argument parsing and exit codes; prompter wired to stdin (scripted answers).
- **server:** token enforcement, localhost binding, SSE prompt/answer round trip.
- **web / desktop:** smoke tests only (renders registry, completes a switch against a temp repo).
- Test runner: Vitest.

## 8. Build phases

Each phase is independently usable and gets its own implementation plan.

1. `core` + `cli` — the daily command.
2. `server` + `web` — dashboard and multi-repo switching in the browser.
3. `desktop` — Electron tray app.
