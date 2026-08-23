#!/usr/bin/env bash
# Add an issue to Rly Gateway Backlog and set Status.
# Usage: scripts/sync-project-board.sh <issue-url>
set -euo pipefail

OWNER="${PROJECT_OWNER:-trungtaottn}"
REPOSITORY="${PROJECT_REPOSITORY:-RLY-Gateway}"
PROJECT_NUMBER="${PROJECT_NUMBER:-4}"
PROJECT_ID="${PROJECT_ID:-PVT_kwHOCNDwxM4BgUfN}"
STATUS_FIELD_ID="${STATUS_FIELD_ID:-PVTSSF_lAHOCNDwxM4BgUfNzhahGVs}"
STATUS_BACKLOG="${STATUS_BACKLOG:-ebc073f7}"
STATUS_TODO="${STATUS_TODO:-f75ad846}"
STATUS_IN_PROGRESS="${STATUS_IN_PROGRESS:-47fc9ee4}"
STATUS_DONE="${STATUS_DONE:-98236657}"

url="${1:-}"
if [[ -z "$url" ]]; then
  echo "usage: $0 <issue-url>" >&2
  exit 2
fi
# Case-insensitive: repo moved to lowercase rly-gateway
_low_url="$(tr '[:upper:]' '[:lower:]' <<<"$url")"
_low_prefix="$(tr '[:upper:]' '[:lower:]' <<<"https://github.com/${OWNER}/${REPOSITORY}/issues/")"
if [[ "$_low_url" != "$_low_prefix"* ]]; then
  echo "refusing non-issue URL: $url" >&2
  exit 2
fi

item_json="$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" --format json)"
item_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$item_json")"

status="$STATUS_TODO"
payload="$(gh issue view "$url" --json state,labels)"
state="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])' <<<"$payload")"
labels="$(python3 -c 'import json,sys; print(",".join(l["name"] for l in json.load(sys.stdin)["labels"]))' <<<"$payload")"
if [[ "$state" == "CLOSED" ]]; then
  status="$STATUS_DONE"
elif [[ ",$labels," == *",backlog,"* ]]; then
  status="$STATUS_BACKLOG"
else
  status="$STATUS_TODO"
fi

gh project item-edit \
  --project-id "$PROJECT_ID" \
  --id "$item_id" \
  --field-id "$STATUS_FIELD_ID" \
  --single-select-option-id "$status" >/dev/null

echo "synced $url -> $item_id"
