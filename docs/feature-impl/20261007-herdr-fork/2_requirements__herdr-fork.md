# Feature Requirements: `/herdr-fork` Preset Command

## 1. Objective & Purpose
Enable a user working in a Pi session inside Herdr to quickly branch (fork) their active conversation into a separate pane or tab with a single slash command (`/herdr-fork`). This allows exploring an alternative idea, delegating an angle, or running parallel investigations without losing conversation history or manual terminal setup.

---

## 2. User Experience & Command Syntax

### Command Invocation
```text
/herdr-fork [placement] [initial instruction]
```

### Parameters from a User Perspective

| Input Parameter | Optional / Required | Default | Allowed Values & Meaning |
| :--- | :--- | :--- | :--- |
| **Placement / Layout** | Optional | `right` | Where the new conversation window opens:<br>• `right`: Split screen vertically, place new session to the right.<br>• `down`: Split screen horizontally, place new session below.<br>• `tab`: Open in a new tab within the current workspace. |
| **Initial Instruction** | Optional | *(none)* | A starter message or prompt immediately delivered to the new forked session so it can begin working right away. |

---

## 3. Behavioral Requirements

### 3.1 Session Continuity & Configuration Parity (Branching)
- The newly spawned Pi instance must inherit the complete conversational history and context of the current session up to the moment `/herdr-fork` was called.
- Changes made in the original session after the fork must not affect the new session, and vice versa (independent branches).
- **Exact Configuration Parity:**
  - The forked session must inherit the parent session's configuration and profile without worker overrides.
  - Calling `pi --fork` naturally continues the session settings.
  - **Crucial Negative Constraint:** The fork must **never** set or override a model based on sub-agent configuration files (e.g., `.sub_agent_conf`, worker defaults).
  - The fork launch mechanism must be completely decoupled from subagent worker launchers (via its own dedicated launcher script).

### 3.2 Parameter Resolution & Natural Input
- **Single text without keywords:** If the user provides a prompt without specifying a placement keyword (e.g. `/herdr-fork investigate the failing test`), the system must assume the default placement (`right`) and treat the whole sentence as the starter instruction.
- **Placement only:** If the user only enters `/herdr-fork right`, `/herdr-fork down`, or `/herdr-fork tab`, open the session with that layout and wait for user input without sending a message.
- **Empty invocation:** If invoked simply as `/herdr-fork`, split to the `right` and wait for user input.
- **Placement + Instruction:** If the first word matches one of the placement targets (e.g. `/herdr-fork tab write the acceptance test`), open in the designated location and forward the rest as the prompt.
- **Quotes protection:** If the user wants to start a prompt that accidentally begins with a direction keyword, enclosing it in quotes (e.g. `/herdr-fork "down in the cellar is a bug"`) must prevent it from being misinterpreted as a split direction.

### 3.3 Visual & Focus Feedback
- The active window focus should smoothly transfer to the newly created session so the user can continue typing there immediately.
- The parent session must display a clear, non-intrusive confirmation message confirming the fork was created and where it was placed.
- If the layout creation fails (e.g., maximum panes reached or window too small), an informative message must explain why the fork could not open, leaving the parent session unharmed.

---

## 4. Acceptance Criteria

1. **Default Split Right:** Running `/herdr-fork` splits the active pane to the right with an identical copy of the session history.
2. **Horizontal Split:** Running `/herdr-fork down` creates a split below.
3. **New Tab:** Running `/herdr-fork tab` creates a fresh workspace tab containing the forked session.
4. **Immediate Prompt Forwarding:** Running `/herdr-fork [target] <message>` opens the session and immediately submits `<message>`.
5. **Prompt Fallback:** Running `/herdr-fork <message>` (without target keyword) defaults to a split on the right with `<message>` automatically submitted.
6. **Independence:** Actions, prompts, and tool calls executed in the fork do not mutate or interfere with the parent session.
7. **Configuration & Profile Parity:** The fork runs with the parent's exact active profile, environment, and tools; it does not pick up `.sub_agent_conf` or worker constraints.
