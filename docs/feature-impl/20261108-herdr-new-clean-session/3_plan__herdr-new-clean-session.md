# Plan: /herdr-new-clean-session

Implements `2_requirements__herdr-new-clean-session.md`. Peer-session command of
the /herdr-fork family: export the active branch of the calling session to a
0600 Markdown handoff file, then open a **fresh** `pi` session in a new Herdr
pane/tab instructed to read it and continue.

## Architecture

```
/herdr-new-clean-session [right|down|tab] [instruction]
        │  index.ts handler (mirror of the herdr-fork handler)
        │  parseForkArgs()  ·  getSessionFile() validation
        ▼
HerdrCleanSessionService (new: clean-session.ts, mirror of fork.ts)
  1. pre-create  os.tmpdir()/pi-cleansession-<uuid>.md   (0600, fs.openSync "w")
  2. spawn       python3 <converterPath> --mode branch <sessionFile> -o <mdPath>
                 with { umask: 0o077 }  (child_process, bounded output, no shell)
                 → on any failure: delete partial file, outcome conversion_failed,
                   NO Herdr call was made
  3. compose handoff instruction = fixed preamble (read <mdPath>, continue the
     prior work from there, delete the file once absorbed) + user instruction
     (when given); ALWAYS non-empty
  4. pane split --focus / tab create --focus   (exact fork.ts choreography,
     PI_CODING_AGENT_DIR parity via --env)
  5. pane run <pane> "<pi-cleansession-launcher.sh> -- [instruction...]"
     (instruction travels shell-quoted, the fork session-file channel)
        ▼
scripts/pi-cleansession-launcher.sh (new, dedicated, peer-session)
  exec pi "<joined instruction>"      (profile parity like the fork launcher)
```

No SubagentService ownership, no managed-Pi detection, no rename, no agent
prompt. Original pane stays open (fork semantics, never reloc).

## Implementation steps

1. **`clean-session.ts`** — `HerdrCleanSessionService` mirroring `fork.ts`:
   - Constructor options: `transport?`, `launcherPath`, `converterPath`,
     `paneId?`, `cwd?`, `env?` (PI_CODING_AGENT_DIR only, as in fork).
   - `cleanSession(args: { sessionFile, placement, instruction? }, signal?)`.
   - Converter invocation: `spawn("python3", [converterPath, "--mode", "branch",
     sessionFile, "-o", mdPath], { umask: 0o077 })`; capture stdout+stderr
     (bounded); non-zero exit or empty/missing md output → `conversion_failed`
     (delete partial file first).
   - Result type `CleanSessionResult` mirrors `ForkResult` (outcome:
     `clean_session` | `error` | `aborted` | `outside_herdr` |
     `launcher_missing` | `conversion_failed`).
   - `defaultCleanSessionLauncherPath()` and a converter default path
     `scripts/pi-session-to-md` beside the package root.
2. **`scripts/pi-cleansession-launcher.sh`** — dedicated launcher (mirror of
   `pi-fork-launcher.sh`, no `--session-file`, no `--fork`): required `--`
   marker, join the rest into one instruction, `exec pi "$instruction"`.
   Empty instruction after `--` is a usage error (the handoff is always
   non-empty by construction, so this is defense-in-depth, exit 2).
3. **`scripts/pi-session-to-md`** — copy of the user's converter, hardened in
   its JSONL reader: a malformed **last** line at EOF (torn live append) is
   skipped with a stderr warning; any malformed line before EOF is still fatal.
   No other behavior change; executable bit preserved. The `dev-bin` original
   stays untouched.
4. **`index.ts`** — register `/herdr-new-clean-session` mirroring the
   herdr-fork handler block: `parseForkArgs` (reused verbatim), session-file
   validation, service construction with `process.env` and ctx cwd/signal,
   success/error/outside_herdr notifications. Add a `cleanSessionTransport?`
   registration dep (tests) next to `forkTransport?`/`relocTransport?`.
5. **Tests** — `tests/clean_session.test.ts` mirroring `tests/fork.test.ts`:
   fake in-process Herdr transport (same two response shapes), scripted
   launcher/converter dirs, exact-argv assertions (split/tab create/run,
   focus, `--env` parity, shell-quoting of md path + multi-line instruction),
   all failure modes creating nothing. Plus real-converter tests (run the
   bundled script, not a stub): torn trailing line (with/without newline)
   exits 0 and omits only the torn record; malformed middle line exits
   non-zero; pre-created md file mode is 0600 after conversion; launcher
   asset checks (`bash -n`, usage errors, exec-argv isolation against a fake
   `pi`).
6. **`package.json`** — `files` already ships `scripts`; add `clean-session.ts`
   to the files list beside `fork.ts`.

## Acceptance

- `npm run check` (tsc + node test runner on `.test-build/`) — no new failures;
  the 5 pre-existing failures (fork_command 4 + core zsh 1, re-verified
  2026-12-02) remain the only red.
- Diff review by the lead against this plan; no worker-runtime, role or
  ownership code touched.
