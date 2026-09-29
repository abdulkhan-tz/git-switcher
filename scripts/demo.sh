#!/usr/bin/env bash
# Starts the dashboard against throwaway repos, with its own config — your real registry is untouched.
# Usage: scripts/demo.sh [port]     (DEMO_DIR overrides where the repos are created)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_DIR="${DEMO_DIR:-${TMPDIR:-/tmp}/git-helper-demo}"
PORT="${1:-4321}"
export GIT_HELPER_HOME="$DEMO_DIR/config"
CLI=(node "$ROOT/packages/cli/dist/bin.js")

if [ ! -d "$DEMO_DIR/api" ]; then
  mkdir -p "$DEMO_DIR"
  for name in api web; do
    git init -q --bare -b main "$DEMO_DIR/$name.git"
    git clone -q "$DEMO_DIR/$name.git" "$DEMO_DIR/$name" 2>/dev/null
    (
      cd "$DEMO_DIR/$name"
      git -c user.name=demo -c user.email=demo@invalid commit -q --allow-empty -m init
      git push -q origin main
      git remote set-head origin main
      for b in develop feature/login; do
        git switch -q -c "$b"
        echo "$b" > "$(echo "$b" | tr / _).txt"
        git add -A && git -c user.name=demo -c user.email=demo@invalid commit -q -m "$b"
        git push -q origin "$b"
      done
      git switch -q main
      git branch -q -D feature/login
    )
  done
  echo "local tweak" > "$DEMO_DIR/web/.env.local"
  git -C "$DEMO_DIR/api" worktree add -q "$DEMO_DIR/.api-login-wt" -b feature/login origin/feature/login
  echo "wip" > "$DEMO_DIR/.api-login-wt/scratch.txt"
  "${CLI[@]}" add "$DEMO_DIR/api" --name api --base origin/develop >/dev/null
  "${CLI[@]}" add "$DEMO_DIR/web" --name web --base origin/develop >/dev/null
  "${CLI[@]}" group add work api web >/dev/null
fi

exec "${CLI[@]}" ui --port "$PORT" --no-open
