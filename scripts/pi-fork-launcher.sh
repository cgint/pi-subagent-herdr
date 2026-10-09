#!/usr/bin/env bash
#
# pi-fork-launcher.sh — dedicated /herdr-fork launcher (peer session, NOT a
# worker).
#
# Invoked by Herdr's `pane run` inside the freshly split/created pane:
#   herdr pane run <pane> "<this-script> --session-file <abs-path> -- [instruction...]"
#
# Responsibilities (requirements §1.3 / §3.1):
#   1. resolve the active profile directory WITHOUT any worker-configuration
#      logic (decoupled from the subagent worker launchers entirely):
#        - PI_CODING_AGENT_DIR, if set and non-blank, is forwarded verbatim to
#          the forked `pi` process so the fork runs with the parent's exact
#          active profile (profile parity).
#        - otherwise the fork simply inherits whatever the Herdr environment
#          provides by default (no profile substitution, no default injection).
#   2. exec `pi --fork <session-file> [instruction]` directly — a plain
#      interactive Pi session, fully decoupled from the subagent worker
#      launchers (no role preambles, no restricted tool allowlists, no model
#      override). When no starter instruction was supplied, NO prompt
#      argument is passed: an empty /herdr-fork must not submit an initial
#      message.
#
# Arguments:
#   --session-file <path>   REQUIRED. Absolute path to the active session file
#                           to fork (already validated by the command handler
#                           before this launcher runs).
#   --                      REQUIRED marker separating launcher options from
#                           the optional starter instruction.
#   [instruction...]        Optional; all words after `--` are joined with a
#                           single space into one instruction string and
#                           passed to `pi --fork` as a single argument.
#
# Exit codes:
#   0   forked session launched successfully
#   2   usage error (missing/blank --session-file, or missing `--` marker);
#       in this case `pi` is never exec'd and nothing is created.

set -euo pipefail

err() {
  printf 'pi-fork-launcher: %s\n' "$*" >&2
}

usage_error() {
  err "$1"
  err "usage: pi-fork-launcher.sh --session-file <path> -- [instruction...]"
  exit 2
}

session_file=""
have_instruction_marker=0
instruction_parts=()

while [ $# -gt 0 ]; do
  case "$1" in
    --session-file)
      if [ $# -lt 2 ]; then
        usage_error "--session-file requires a value"
      fi
      session_file="$2"
      shift 2
      ;;
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
if [ "$have_instruction_marker" -ne 1 ]; then
  usage_error "missing '--' marker (an empty starter instruction is allowed, the marker is not)"
fi

instruction=""
if [ "${#instruction_parts[@]}" -gt 0 ]; then
  instruction="${instruction_parts[*]}"
fi

# Build the exec argv: the session file is always passed; the instruction is
# passed only when nonempty (an empty /herdr-fork must not submit an initial
# message). The array is safe under `set -u` (a non-empty array expands
# normally; expanding an empty *named* array under -u would be the Bash 3.2
# hazard, and here the array always holds at least "pi --fork <file>").
exec_argv=(pi --fork "$session_file")
if [ -n "$instruction" ]; then
  exec_argv+=("$instruction")
fi

# Profile parity: forward PI_CODING_AGENT_DIR verbatim when the parent
# session's environment set it to a non-blank value; otherwise let the
# forked `pi` inherit the surrounding environment as-is. No default is
# substituted and no other environment entry is read or touched here.
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  exec "${exec_argv[@]}"
else
  unset PI_CODING_AGENT_DIR
  exec "${exec_argv[@]}"
fi
