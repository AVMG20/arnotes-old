#!/usr/bin/env bash
# Wakes the customer (the Claude session that plays the customer and reviews the code) when
# someone mentions @<nick> in the customer channel. Exits on the first mention from somebody
# else; re-arm it after every wake. Run it as a tracked background task.
#   bash guard.sh [nick]          nick defaults to "customer" (config.customer.nick)
# It reads chat-<nick>.log, which the presence tail appends to (see README.md, "The chat line"):
#   chat-client-rs tail --chan '#channel' --nick <nick> --no-session >> chat-<nick>.log
HERE="$(cd "$(dirname "$0")" && pwd)"
NICK="${1:-customer}"
LOG="$HERE/chat-$NICK.log"
[ -f "$LOG" ] || : > "$LOG"
start=$(wc -l < "$LOG")
while :; do
    n=$(wc -l < "$LOG")
    if [ "$n" -gt "$start" ]; then
        tail -n +$((start + 1)) "$LOG" \
            | grep -vE "^:$NICK(-[0-9]+)?!" \
            | grep -qF "@$NICK" && break
        start="$n"
    fi
    sleep 5
done
echo "RE-ARM NOW (guard): bash $HERE/guard.sh $NICK, then read the customer channel from the cursor"
