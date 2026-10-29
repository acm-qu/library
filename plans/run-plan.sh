#!/usr/bin/env bash
# List the local visual plans in this folder, then serve the chosen one and open it in Google Chrome.
# Usage: plans/run-plan.sh [plan-folder-name]
# Ctrl+C stops the local bridge.
set -euo pipefail

PLANS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI=(npx -y @agent-native/core@latest)

plans=()
for d in "$PLANS_DIR"/*/; do
  [ -f "$d/plan.mdx" ] && plans+=("$(basename "$d")")
done
if [ ${#plans[@]} -eq 0 ]; then
  echo "No plans found in $PLANS_DIR (a plan is a folder containing plan.mdx)." >&2
  exit 1
fi

frontmatter() { # frontmatter <slug> <key>
  sed -n '/^---$/,/^---$/p' "$PLANS_DIR/$1/plan.mdx" | sed -n "s/^$2: *//p" | head -1 | sed 's/^"//;s/"$//'
}

slug="${1:-}"
if [ -z "$slug" ]; then
  echo "Plans:"
  for i in "${!plans[@]}"; do
    title="$(frontmatter "${plans[$i]}" title)"
    printf "  %2d) %s%s\n" "$((i + 1))" "${plans[$i]}" "${title:+  —  $title}"
  done
  read -rp "Select a plan [1-${#plans[@]}]: " n
  if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -lt 1 ] || [ "$n" -gt ${#plans[@]} ]; then
    echo "Invalid selection." >&2
    exit 1
  fi
  slug="${plans[$((n - 1))]}"
fi

dir="$PLANS_DIR/$slug"
[ -f "$dir/plan.mdx" ] || { echo "No plan.mdx in $dir" >&2; exit 1; }
kind="$(frontmatter "$slug" kind)"; kind="${kind:-plan}"

echo "Checking ${slug}..."
"${CLI[@]}" plan local check --dir "$dir" >/dev/null

rm -f "$dir/.plan-url"
echo "Serving ${slug} (Ctrl+C to stop)..."
"${CLI[@]}" plan local serve --dir "$dir" --kind "$kind" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 120); do
  [ -s "$dir/.plan-url" ] && break
  kill -0 "$server" 2>/dev/null || { echo "Plan server exited before it was ready." >&2; exit 1; }
  sleep 0.5
done
[ -s "$dir/.plan-url" ] || { echo "Timed out waiting for $dir/.plan-url" >&2; exit 1; }

open -a "Google Chrome" "$(cat "$dir/.plan-url")"
echo "Opened in Google Chrome."
wait "$server"
