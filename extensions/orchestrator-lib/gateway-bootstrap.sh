#!/bin/sh
set -eu
[ "$#" -ge 3 ] || exit 125
[ "$1" = "--" ] || exit 125
shift
/usr/sbin/ip link set lo up
exec /usr/bin/setpriv \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  -- "$@"
