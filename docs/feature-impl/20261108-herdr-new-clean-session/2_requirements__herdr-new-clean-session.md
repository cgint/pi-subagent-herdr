# Requirements: /herdr-new-clean-session

Peer-session command of the /herdr-fork family: export the active branch of the
calling Pi session to a Markdown handoff file, then open a **fresh** `pi` session
in a new Herdr pane or tab that is instructed to read the file and continue the
work from there. The new session is clean (no `--session`, no `--fork`); the
exported transcript is the only memory it inherits.

## 1. Command surface

- `/herdr-new-clean-session [right|down|tab] [instruction]`
- Argument parsing is identical to /herdr-fork: reuse `parseForkArgs`
  (placement keyword, quote protection, empty input = `right` with no user
  instruction). No new parser.
- The caller must run inside Herdr (`HERDR_PANE_ID` set); otherwise the command
  reports `outside_herdr` and creates nothing — same contract as fork.
- The active session file must exist (`ctx.sessionManager.getSessionFile()`);
  otherwise nothing is created and a warning is shown — same contract as fork.

## 2. Handoff file

- Path: `os.tmpdir()/pi-cleansession-<uuid>.md` (`crypto.randomUUID()`),
  created by the extension process (handler side, see §4).
- Permissions: `chmod 600` after successful conversion (session content must
  not be world-readable in shared `/tmp`).
- Content: the active branch of the session, exported by the bundled
  `pi-session-to-md` with **fixed** flags:
  `--mode branch` (single parentId chain to the last message id = the current
  context; abandoned branches excluded), no `--thinking`, no `--include-tools`,
  no `--user-only` (assistant messages are part of the handoff). No flag is
  user-configurable in v1.
- **Known v1 limitation (leaf semantics):** `--mode branch` resolves the
  branch from the last message id in the file, which is a best-effort
  approximation of the currently selected branch. After a `/tree` jump that
  did NOT continue the older branch, the export follows the most recently
  appended branch, not the one on screen. v1 accepts this; no `--leaf`
  plumbing is added.
- **Privacy from first byte:** the extension pre-creates the md file with
  mode `0600` (`fs.openSync(path, "w", 0o600)`) before spawning the converter,
  and the spawn carries `{ umask: 0o077 }` as belt-and-braces. The converter's
  `-o` truncates the existing file in place, preserving its mode — session
  content is never world-readable in shared `/tmp` for any window. (Post-hoc
  `chmod 600` alone was rejected: the converter's own `open(..., "w")` would
  expose the file at 0644 during the whole write.)
- The user's instruction (optional) never changes the export; it only appends
  to the handoff instruction sent to the new session.

## 3. New session

- Launched via a dedicated `scripts/pi-cleansession-launcher.sh` (peer session:
  no SubagentService ownership, no managed-Pi detection, no rename, no agent
  prompt, no worker runtime, no `.sub_agent_conf` logic — the fork contract).
- Placement is right/down (pane split) or tab (tab create), focus follows the
  fork convention; `PI_CODING_AGENT_DIR` parity forwarding is identical to fork.
- The new session is a plain `pi <instruction>` with **always-non-empty**
  instruction: a fixed handoff preamble naming the md path and telling the new
  agent to read it, continue the prior work from there, and delete the file
  once absorbed; the user's instruction (when given) is appended after it.
  This is the one deliberate departure from fork (empty fork = open without a
  prompt; a clean session with no instruction is useless).
- **Advisory cleanup:** "delete once absorbed" is a prompt instruction to the
  receiving agent, not an enforced guarantee. If the agent never deletes the
  file, OS tmp cleanup reclaims it. v1 ships no enforcement mechanism.
- The calling pane is **not** closed and stays focused-away: fork semantics,
  never reloc semantics.

## 4. Conversion runs handler-side

- The extension process (Node) spawns the bundled converter
  (`python3 <pkg>/scripts/pi-session-to-md --mode branch <sessionFile> -o <tmp>`,
  `{ umask: 0o077 }`, on the pre-created 0600 file, §2)
  **before** any Herdr call. Conversion failure (non-zero exit, missing or
  unreadable python3, partial output) deletes any partial file, reports a
  `conversion_failed` error, and creates no pane.
- `python3` is a hard runtime dependency of this command only; absence is a
  typed, honest failure, not a fallback.
- **Live-append torn-line tolerance (converter hardening):** the session file
  is appended to while the conversation runs. The stock converter hard-crashes
  on a truncated trailing line (`RuntimeError: Invalid JSON on line N` —
  verified empirically 2026-11-08, exit 1, with and without a trailing
  newline), so an export racing a live write would routinely fail. The
  bundled copy is hardened: a malformed **last** line at EOF (torn in-flight
  append) is skipped with a stderr warning; any malformed line before EOF is
  still fatal. The exported conversation then equals "everything fully written
  so far" — exactly the right handoff semantics.
- The md path then travels to the launcher as a shell-quoted argument through
  `pane run` — the same argument channel fork uses for its session file.

## 5. Packaging

- The converter ships as `scripts/pi-session-to-md` (executable bit intact;
  `scripts` is already in the package `files` manifest). It is stdlib-only
  Python 3; no dependency changes to package.json.
- Bundling source: the user's `pi-session-to-md` (dev-bin); the copy in this
  repo becomes canonical for the extension.

## 6. Acceptance criteria

- Unit tests mirror `tests/fork.test.ts` / `tests/reloc.test.ts`: fake
  in-process Herdr transport, scripted launcher dir, assertions on exact
  `pane split`/`tab create`/`pane run` argv, focus flag, profile-env parity,
  shell-quoting of the md path and instruction (multi-line instructions
  included), `outside_herdr`/missing-file/missing-launcher/missing-converter
  failures creating nothing.
- The converter invocation is injectable (`converterPath` option) so tests run
  a stub script instead of real python3.
- **Converter regression tests run the real bundled script** (not a stub):
  (a) a fixture with a torn trailing JSON line (no newline, and newline-terminated)
  exits 0 and omits only the torn record; (b) a fixture with a malformed middle
  line still exits non-zero; (c) the pre-created md file's mode is `0600`
  after conversion (`fs.statSync(mode) & 0o777 === 0o600`).
- `npm run check` (tsc + node test runner) passes; pre-existing failures
  unchanged.
- No worker-runtime, role, or ownership code is introduced; the new pane is a
  peer session indistinguishable from a manually opened one.
