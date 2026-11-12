#!/usr/bin/env bash
# Team sync: share workstream status between laptops through git.
#
#   scripts/team-sync.sh pull [--always]   print the OTHER workstreams' outbox files (from their remote branches).
#                                          Used by the hooks in .claude/settings.json. Silent when nothing changed
#                                          since last shown, unless --always. Never fails.
#   scripts/team-sync.sh push              commit + push YOUR outbox (docs/sync/from-<X>.md) and docs/progress/<X>.md.
#
# Which workstream am I? Taken from the branch (ws-a-ai -> A, ws-b-pay -> B, ws-c-app -> C),
# or from the TEAM_WS env var (A, B or C).

set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

cmd="${1:-pull}"
always=""
[ "${2:-}" = "--always" ] && always=1

branch_of() { case "$1" in A) echo ws-a-ai ;; B) echo ws-b-pay ;; C) echo ws-c-app ;; esac; }

current="$(git branch --show-current 2>/dev/null)"
me="${TEAM_WS:-}"
if [ -z "$me" ]; then
  case "$current" in
    ws-a-ai) me=A ;;
    ws-b-pay) me=B ;;
    ws-c-app) me=C ;;
  esac
fi

# Read one outbox file from a remote branch, falling back to origin/main, then the working tree.
read_outbox() {
  local ws="$1" br file
  br="$(branch_of "$ws")"
  file="docs/sync/from-$ws.md"
  git show "origin/$br:$file" 2>/dev/null \
    || git show "origin/main:$file" 2>/dev/null \
    || cat "$file" 2>/dev/null
}

do_pull() {
  local stamp seen out others ws body hash prev requests
  stamp="$(git rev-parse --git-path team-sync-fetch)"
  seen="$(git rev-parse --git-path team-sync-seen)"

  # Fetch at most once a minute (or always at session start). Offline is fine.
  if [ -n "$always" ] || [ -z "$(find "$stamp" -mmin -1 2>/dev/null)" ]; then
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 fetch --quiet origin 2>/dev/null
    touch "$stamp" 2>/dev/null
  fi

  others="A B C"
  [ -n "$me" ] && others="$(echo "A B C" | tr ' ' '\n' | grep -v "^$me$" | tr '\n' ' ')"

  out=""
  for ws in $others; do
    body="$(read_outbox "$ws")"
    [ -n "$body" ] && out="${out}
----- workstream $ws (from-$ws.md) -----
${body}
"
  done
  [ -z "$out" ] && exit 0

  hash="$(printf '%s' "$out" | git hash-object --stdin 2>/dev/null)"
  prev="$(cat "$seen" 2>/dev/null)"
  if [ -z "$always" ] && [ "$hash" = "$prev" ]; then exit 0; fi
  printf '%s' "$hash" > "$seen" 2>/dev/null

  echo "== TEAM SYNC: status posted by the other workstreams =="
  echo "(You are workstream ${me:-unknown}. Read-only: never edit another workstream's file.)"
  printf '%s\n' "$out"
  if [ -n "$me" ]; then
    requests="$(printf '%s\n' "$out" | grep -iE "^[[:space:]]*[-*][[:space:]]*to[[:space:]]+$me[[:space:]]*:" )"
    if [ -n "$requests" ]; then
      echo "== REQUESTS ADDRESSED TO WORKSTREAM $me =="
      printf '%s\n' "$requests"
      echo "Tell your human lead about these before continuing."
    fi
  fi
  exit 0
}

do_push() {
  local files=() f
  if [ -z "$me" ]; then
    echo "team-sync: cannot tell which workstream you are. Switch to ws-a-ai / ws-b-pay / ws-c-app, or set TEAM_WS=A|B|C." >&2
    exit 1
  fi
  case "$current" in
    ""|main|master)
      echo "team-sync: refusing to sync from '$current'. Use your workstream branch ($(branch_of "$me"))." >&2
      exit 1 ;;
  esac
  for f in "docs/sync/from-$me.md" "docs/progress/$me.md"; do
    [ -f "$f" ] && files+=("$f")
  done
  if [ "${#files[@]}" -eq 0 ]; then
    echo "team-sync: nothing to sync (no docs/sync/from-$me.md)." >&2
    exit 1
  fi

  git add -- "${files[@]}"
  if git diff --cached --quiet -- "${files[@]}"; then
    echo "team-sync: outbox unchanged, nothing to commit."
  else
    git commit -q -m "chore(sync): update workstream $me status" -- "${files[@]}" || exit 1
    echo "team-sync: committed status for workstream $me."
  fi
  if git push -q -u origin "$current"; then
    echo "team-sync: pushed $current."
  else
    echo "team-sync: push failed (probably the remote has newer commits). Run: git pull --rebase origin $current, then retry." >&2
    exit 1
  fi
}

case "$cmd" in
  pull) do_pull ;;
  push) do_push ;;
  *) echo "usage: scripts/team-sync.sh pull [--always] | push" >&2; exit 2 ;;
esac
