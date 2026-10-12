#!/usr/bin/env bash
#
# pi-reloc-launcher.sh — dedicated /herdr-reloc-tab launcher (peer session
# RESUME, NOT a worker, NOT a fork).
#
# Invoked by Herdr's `pane run` inside the new tab's root pane:
#   herdr pane run <pane> "<this-script> --session-file <abs-path>"
#
# Responsibilities (requirements §3.3 / plan §1.3, §4):
#   1. PI_CODING_AGENT_DIR is ALREADY IN THE PROCESS ENVIRONMENT (placed in
#      the target pane's launch environment by `herdr tab create --env` in
#      step 3 of the choreography). `exec` inherits the current environment
#      verbatim — no re-export, no default injection. If the variable is
#      absent, the `pi` process inherits whatever Herdr defaults to (no
#      substitution, no default injection).
#   2. exec `pi --session <session-file>` directly — a Pi-native RESUME of
#      the same session (not `--fork`), fully decoupled from the subagent
#      worker launchers (no `.sub_agent_conf` parsing, no role preambles,
#      no model override, no tool restrictions).
#
# Unlike pi-fork-launcher.sh there is NO `--` instruction marker and NO
# instruction joining: reloc resumes the session as-is; there is nothing new
# to tell it.
#
# Arguments:
#   --session-file <path>   REQUIRED. Absolute path to the active session file
#                           (already validated by the command handler before
#                           this launcher runs).
#
# Exit codes:
#   0   resumed session launched successfully
#   2   usage error (missing/blank/absent --session-file); in this case `pi`
#       is never exec'd and nothing is created.

set -euo pipefail

err() {
  printf 'pi-reloc-launcher: %s\n' "$*" >&2
}

usage_error() {
  err "$1"
  err "usage: pi-reloc-launcher.sh --session-file <path>"
  exit 2
}

session_file=""

while [ $# -gt 0 ]; do
  case "$1" in
    --session-file)
      if [ $# -lt 2 ]; then
        usage_error "--session-file requires a value"
      fi
      session_file="$2"
      shift 2
      ;;
    *)
      usage_error "unexpected argument: $1"
      ;;
  esac
done

if [ -z "$session_file" ]; then
  usage_error "--session-file is required"
fi
if [ ! -f "$session_file" ]; then
  usage_error "session file not found: $session_file"
fi

# Profile parity: PI_CODING_AGENT_DIR is already in the process environment
# (set via `herdr tab create --env` in step 3). `exec` inherits the current
# environment verbatim — no re-export needed. If the variable is absent, the
# `pi` process inherits the Herdr default (no substitution, no default
# injection). No other environment entry is read or touched here.
exec pi --session "$session_file"
