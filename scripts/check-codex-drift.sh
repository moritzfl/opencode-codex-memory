#!/usr/bin/env bash
#
# check-codex-drift.sh — report how far opencode-codex-memory has drifted from the
# codex memory implementation it was ported from.
#
# It answers two questions against a local codex checkout:
#   1. Do all mapped codex source files still exist? (catches renames/moves)
#   2. What changed in codex's memory code since the commit we last audited?
#
# No dependencies beyond bash + git + standard coreutils (no yq required).
#
# Usage:
#   CODEX_REPO=/path/to/codex ./scripts/check-codex-drift.sh
#   ./scripts/check-codex-drift.sh /path/to/codex
#
# Exit codes:
#   0  aligned: pinned ref present, all mapped paths exist, no upstream changes
#   1  drift:   mapped path missing, or upstream memory code changed since ref
#   2  usage/setup error (no codex checkout, bad map, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAP="$REPO_ROOT/codex-map.yaml"

CODEX_REPO="${1:-${CODEX_REPO:-}}"

err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '%s\n' "$*"; }

if [[ ! -f "$MAP" ]]; then
  err "codex-map.yaml not found at $MAP"
  exit 2
fi

if [[ -z "$CODEX_REPO" ]]; then
  err "No codex checkout given. Set CODEX_REPO or pass it as \$1."
  err "  CODEX_REPO=/path/to/codex $0"
  exit 2
fi

if [[ ! -d "$CODEX_REPO/.git" ]]; then
  err "CODEX_REPO ($CODEX_REPO) is not a git checkout."
  exit 2
fi

# --- Minimal YAML readers (flat keys + simple list blocks) -------------------

# Read a top-level scalar key: `key: value`
yaml_scalar() {
  local key="$1"
  grep -E "^${key}:[[:space:]]*" "$MAP" | head -n1 | sed -E "s/^${key}:[[:space:]]*//" | tr -d '"'
}

# Read items of a top-level list block `name:` whose entries look like `  - value`.
# Stops at the next top-level key.
yaml_list() {
  local name="$1"
  awk -v name="$name" '
    $0 ~ "^"name":[[:space:]]*$" { inblk=1; next }
    inblk && /^[^[:space:]#]/    { inblk=0 }
    inblk && /^[[:space:]]*-[[:space:]]/ {
      line=$0
      sub(/^[[:space:]]*-[[:space:]]*/, "", line)
      gsub(/"/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line != "") print line
    }
  ' "$MAP"
}

# Extract every `theirs:` value from the mappings block.
yaml_theirs() {
  grep -E "^[[:space:]]*theirs:[[:space:]]*" "$MAP" \
    | sed -E "s/^[[:space:]]*theirs:[[:space:]]*//" | tr -d '"'
}

CODEX_REF="$(yaml_scalar codex_ref)"
CODEX_REF_DATE="$(yaml_scalar codex_ref_date)"

if [[ -z "$CODEX_REF" ]]; then
  err "codex_ref missing from codex-map.yaml"
  exit 2
fi

info "codex checkout : $CODEX_REPO"
info "pinned ref     : $CODEX_REF ($CODEX_REF_DATE)"
CODEX_HEAD="$(git -C "$CODEX_REPO" rev-parse HEAD)"
info "codex HEAD     : $CODEX_HEAD"
echo

drift=0

# --- 1. Pinned ref present in the checkout? ---------------------------------

if ! git -C "$CODEX_REPO" cat-file -e "${CODEX_REF}^{commit}" 2>/dev/null; then
  warn "Pinned ref $CODEX_REF is not in this codex checkout."
  warn "  -> 'git -C $CODEX_REPO fetch' or update codex_ref in codex-map.yaml."
  drift=1
fi

# --- 2. Do all mapped codex files still exist? ------------------------------

info "== Mapped path existence =="
missing=0
while IFS= read -r theirs; do
  [[ -z "$theirs" ]] && continue
  if [[ -e "$CODEX_REPO/$theirs" ]]; then
    :
  else
    err "MISSING  $theirs"
    missing=$((missing + 1))
    drift=1
  fi
done < <(yaml_theirs | sort -u)

if [[ "$missing" -eq 0 ]]; then
  ok "All mapped codex paths exist."
else
  err "$missing mapped codex path(s) missing — likely moved/renamed upstream."
fi
echo

# --- 3. Upstream changes in watched memory code since the pinned ref --------

info "== Upstream changes since $CODEX_REF =="
WATCH=()
while IFS= read -r line; do
  [[ -n "$line" ]] && WATCH+=("$line")
done < <(yaml_list watch_paths)

if [[ "${#WATCH[@]}" -eq 0 ]]; then
  warn "No watch_paths defined in codex-map.yaml; skipping diff."
elif ! git -C "$CODEX_REPO" cat-file -e "${CODEX_REF}^{commit}" 2>/dev/null; then
  warn "Cannot diff: pinned ref not present in checkout (see above)."
else
  # Only diff watch_paths that still exist at HEAD, to avoid pathspec errors.
  existing=()
  for p in "${WATCH[@]}"; do
    if git -C "$CODEX_REPO" cat-file -e "HEAD:$p" 2>/dev/null \
       || [[ -e "$CODEX_REPO/$p" ]]; then
      existing+=("$p")
    fi
  done

  if [[ "${#existing[@]}" -eq 0 ]]; then
    warn "None of the watch_paths exist at HEAD."
  else
    stat="$(git -C "$CODEX_REPO" diff --stat "${CODEX_REF}..HEAD" -- "${existing[@]}" || true)"
    if [[ -z "$stat" ]]; then
      ok "No changes in watched memory code since $CODEX_REF."
    else
      warn "Watched memory code changed upstream:"
      echo "$stat"
      echo
      info "Review with:"
      info "  git -C \"$CODEX_REPO\" diff ${CODEX_REF}..HEAD -- ${existing[*]}"
      drift=1
    fi
  fi
fi
echo

# --- Summary ----------------------------------------------------------------

if [[ "$drift" -eq 0 ]]; then
  ok "ALIGNED — no drift detected. Nothing to do."
  exit 0
else
  warn "DRIFT DETECTED — review above, port intentionally, then bump codex_ref"
  warn "in codex-map.yaml to $CODEX_HEAD once re-audited."
  exit 1
fi
