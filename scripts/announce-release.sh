#!/usr/bin/env bash
# Posts a one-line note to Discord #key-system-events when a version of the app
# is promoted on Zapier, the way the SDK repos post when they publish:
#
#   🟢 `zapier-lenz 2.3.1` promoted on Zapier — https://zapier.com/apps/lenz/integrations
#
# Run it by hand after `zapier promote` (a promote is a CLI action on a
# developer's machine, so no workflow can see it):
#
#   KEY_SYSTEM_EVENTS_WEBHOOK_URL=<webhook> bash scripts/announce-release.sh 2.3.1
#
# The webhook is the same one the SDK repos hold as a repo secret; it is read
# from the environment and never written to a file. With no webhook set the
# script says so and exits 0, like the SDK workflows. ANNOUNCE_DRY_RUN=1 prints
# the message and sends nothing.
set -euo pipefail

VERSION="${1:-}"
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: bash scripts/announce-release.sh <major.minor.patch>" >&2
    exit 2
fi

MESSAGE="🟢 \`zapier-lenz ${VERSION}\` promoted on Zapier — https://zapier.com/apps/lenz/integrations"

if [ "${ANNOUNCE_DRY_RUN:-}" = "1" ]; then
    echo "${MESSAGE}"
    exit 0
fi

WEBHOOK="${KEY_SYSTEM_EVENTS_WEBHOOK_URL:-}"
if [ -z "${WEBHOOK}" ]; then
    echo "No KEY_SYSTEM_EVENTS_WEBHOOK_URL set; skipping."
    exit 0
fi

# The message holds only the validated version and a fixed link, so building the
# JSON by hand is safe.
curl -fsS -H "Content-Type: application/json" -X POST "${WEBHOOK}" \
    -d "{\"content\": \"${MESSAGE}\"}" >/dev/null
echo "Posted to #key-system-events: ${MESSAGE}"
