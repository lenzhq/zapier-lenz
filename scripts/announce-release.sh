#!/usr/bin/env bash
# Posts a one-line note to Discord #key-system-events when a version of the app
# is promoted on Zapier, the way the SDK repos post when they publish:
#
#   🟢 `zapier-lenz 2.3.1` promoted on Zapier — https://zapier.com/apps/lenz/integrations
#
# Run it by hand after `zapier promote` (a promote is a CLI action on a
# developer's machine, so no workflow can see it). The webhook is the
# #key-system-events webhook URL (Discord channel settings, Integrations); the
# SDK repos hold it as a repo secret, which cannot be read back, so get it from
# Discord. Enter it without leaving it in shell history:
#
#   read -rs KEY_SYSTEM_EVENTS_WEBHOOK_URL; export KEY_SYSTEM_EVENTS_WEBHOOK_URL
#   bash scripts/announce-release.sh 2.3.1
#
# The webhook is read from the environment, never written to a file, and handed
# to curl on stdin, not as an argument, so it is not in the process list. It
# must look like a Discord webhook URL, or nothing is sent. With no webhook set
# the script says so and exits 0, like the SDK workflows.
#
# The version must be major.minor.patch and equal the version in package.json
# (the release commit sets it), so a typo cannot announce a version that was
# never promoted; ANNOUNCE_FORCE=1 skips that check. ANNOUNCE_DRY_RUN=1 prints
# the message and sends nothing.
set -euo pipefail

VERSION="${1:-}"
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: bash scripts/announce-release.sh <major.minor.patch>" >&2
    exit 2
fi

if [ "${ANNOUNCE_FORCE:-}" != "1" ]; then
    PACKAGE_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$(dirname "$0")/../package.json" | head -1)"
    if [ "${VERSION}" != "${PACKAGE_VERSION}" ]; then
        echo "package.json says ${PACKAGE_VERSION:-<none>}, not ${VERSION}; refusing to announce a version that was not released (ANNOUNCE_FORCE=1 to override)." >&2
        exit 3
    fi
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
if ! [[ "${WEBHOOK}" =~ ^https://(discord|discordapp|canary\.discord|ptb\.discord)\.com/api/webhooks/[0-9]+/[A-Za-z0-9._-]+$ ]]; then
    echo "KEY_SYSTEM_EVENTS_WEBHOOK_URL does not look like a Discord webhook URL; not sending." >&2
    exit 2
fi

# The message holds only the validated version and a fixed link, so building the
# JSON by hand is safe. The URL goes in through a curl config on stdin (-q:
# ignore any ~/.curlrc), is validated above so it cannot hold a quote, an
# option or a glob, and curl's own diagnostics are dropped so none can echo it.
if printf 'url = "%s"\n' "${WEBHOOK}" | curl -q -K - --globoff --max-time 15 -fsS \
    -H "Content-Type: application/json" -X POST -d "{\"content\": \"${MESSAGE}\"}" >/dev/null 2>&1; then
    echo "Posted to #key-system-events: ${MESSAGE}"
else
    echo "The post to #key-system-events failed (curl exit $?); nothing was announced." >&2
    exit 1
fi
