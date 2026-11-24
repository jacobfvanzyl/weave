#!/bin/sh
# What a machine `weave hosts launch` made runs (WVE-238): join the person's tailnet if it was
# given a key, run the Host, and have it join the Dispatcher the first time.
#
# Everything that should outlive a stop is under /data, the machine's volume: the Host's state,
# Tailscale's, and the mark that says the Host joined.

set -eu

state=/data
export HOME="$state/home"
mkdir -p "$HOME" "$state/tailscale" /var/run/tailscale

# Check for existing Tailscale state before starting tailscaled, which creates the file on boot.
had_ts_state=0
[ -s "$state/tailscale/tailscaled.state" ] && had_ts_state=1

if [ -n "${TS_AUTHKEY:-}" ] || [ "$had_ts_state" = 1 ]; then
  tailscaled --statedir="$state/tailscale" --socket=/var/run/tailscale/tailscaled.sock \
    >"$state/tailscaled.log" 2>&1 &
  until [ -S /var/run/tailscale/tailscaled.sock ]; do sleep 0.2; done
  # The key is used the first time; after that the node's own state signs it in.
  if [ "$had_ts_state" = 0 ] && [ -n "${TS_AUTHKEY:-}" ]; then
    tailscale up --authkey="$TS_AUTHKEY" \
      --hostname="${WEAVE_HOST_NAME:-weave-host}" --accept-dns=true
  else
    tailscale up --hostname="${WEAVE_HOST_NAME:-weave-host}" --accept-dns=true
  fi
  echo "tailnet: $(tailscale ip -4 2>/dev/null || echo 'no address')"
fi

weave daemon run &
daemon=$!
trap 'kill -TERM "$daemon" 2>/dev/null; wait "$daemon"' TERM INT

# The Host answers on its socket once it is up.
tries=0
until weave daemon status >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 150 ]; then
    echo "the Host didn't start" >&2
    exit 1
  fi
  sleep 0.2
done

if [ ! -e "$state/joined" ]; then
  : "${WEAVE_DISPATCHER_URL:?no Dispatcher to join}" "${WEAVE_JOIN_CODE:?no code to join with}"
  weave hosts add "$WEAVE_DISPATCHER_URL" "$WEAVE_JOIN_CODE" \
    --name "${WEAVE_HOST_NAME:-weave-host}" --json
  touch "$state/joined"
fi

wait "$daemon"
