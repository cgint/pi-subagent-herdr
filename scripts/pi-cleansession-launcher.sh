#!/usr/bin/env bash
#
# pi-cleansession-launcher.sh — dedicated /herdr-new-clean-session launcher
# (peer session, NOT a worker, NOT a fork).
#
# Invoked by Herdr's `pane run` inside the freshly split/created pane:
#   herdr pane run <pane> "<this-script> -- [instruction...]"
#
# Responsibilities (requirements §3):
#   1. resolve the active profile directory WITHOUT any worker-configuration
#      logic (decoupled from the subagent worker launchers entirely):
#        - PI_CODING_AGENT_DIR, if set and non-blank, is forwarded verbatim to
#          the clean-session `pi` process so it runs with the parent's exact
#          active profile (profile parity).
#        - otherwise the clean session simply inherits whatever the Herdr
#          environment provides by default (no profile substitution, no
#          default injection).
#   2. exec `pi "<instruction>"` directly — a plain interactive Pi session
#      (no --session, no --fork), fully decoupled from the subagent worker
#      launchers (no role preambles, no restricted tool allowlists, no model
#      override). The instruction is ALWAYS non-empty by construction (the
#      extension always prepends the fixed handoff preamble naming the md
#      path); an empty instruction is a usage error (defense-in-depth).
#
# Arguments:
#   --                      REQUIRED marker separating launcher options from
#                           the instruction. There are no other launcher
#                           options for this script.
#   [instruction...]        REQUIRED; all words after `--` are joined with a
#                           single space into one instruction string and
#                           passed to `pi` as a single argument.
#
# Exit codes:
#   0   clean session launched successfully
#   2   usage error (missing `--` marker, or empty instruction after `--`);
#       in this case `pi` is never exec'd and nothing is created.

set -euo pipefail

err() {
  printf 'pi-cleansession-launcher: %s\n' "$*" >&2
}

usage_error() {
  err "$1"
  err "usage: pi-cleansession-launcher.sh -- [instruction...]"
  exit 2
}

have_instruction_marker=0
instruction_parts=()

while [ $# -gt 0 ]; do
  case "$1" in
    --)
      have_instruction_marker=1
      shift
      # Join every remaining argument with a single space into one
      # instruction string; the words are preserved verbatim (no shell
      # re-interpretation, since this script is invoked with an already
      # shell-quoted command string by `herdr pane run`).
      while [ $# -gt 0 ]; do
        instruction_parts+=("$1")
        shift
      done
      ;;
    *)
      usage_error "unexpected argument before '--': $1"
      ;;
  esac
done

if [ "$have_instruction_marker" -ne 1 ]; then
  usage_error "missing '--' marker"
fi

instruction=""
if [ "${#instruction_parts[@]}" -gt 0 ]; then
  instruction="${instruction_parts[*]}"
fi

# The handoff instruction is ALWAYS non-empty by construction (the extension
# prepends the fixed preamble). An empty instruction after `--` is a
# defense-in-depth usage error: it should never happen, but if it does, the
# clean session is useless without it, so we refuse to exec.
if [ -z "$instruction" ]; then
  usage_error "instruction is empty after '--' (the handoff preamble must always be present)"
fi

# Profile parity: forward PI_CODING_AGENT_DIR verbatim when the parent
# session's environment set it to a non-blank value; otherwise let the
# clean session `pi` inherit the surrounding environment as-is. No default
# is substituted and no other environment entry is read or touched here.
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  exec pi "$instruction"
else
  unset PI_CODING_AGENT_DIR
  exec pi "$instruction"
fi
