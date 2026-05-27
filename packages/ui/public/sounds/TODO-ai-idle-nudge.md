## ai-idle-nudge.ogg

"Walking Care Free" — happy musical nudge (~8s).

### When to use
- No user input for 10+ minutes AND at least one AI session is awaiting input/action.
- One global roll, not per-session (avoid probability stacking with multiple waiting sessions).
- Low chance per check, low volume.

### Prerequisites
- Notification system (native `Notification` API or similar) — audio alone won't work
  from a background browser tab (Chrome suspends AudioContext).
- Daemon endpoint to query which sessions are awaiting input.
- Frontend idle timer tracking last user interaction.
- Pair audio with a native notification so it works when the tab is backgrounded.

### Open questions
- Trim to 2-3s for a crisper nudge, or keep full 8s?
- Should this be a new SoundTag (`ai-idle-nudge`) or reuse `ai-attention`?
- Exact probability / interval for the roll (e.g. 20% chance every 2 minutes after 10min idle?).
