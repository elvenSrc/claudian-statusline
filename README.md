# Claudian Statusline

*[Deutsche Version](README-de.md)*

A standalone Obsidian sidecar plugin that shows a two-line status bar above
[Claudian](https://github.com/YishenTu/claudian)'s input field (left of
"New tab"/"Chat history"):

- **Line 1** – 5h/7d rate-limit usage incl. reset time. Tab-independent,
  applies to the whole account.
- **Line 2** – Context % plus in/out tokens for the currently active
  Claudian tab. Switches automatically when you select a different tab.

No fork, no patch of Claudian: the plugin only reads files that Claude Code
or Claudian already write themselves, and inserts its own DOM element into
Claudian's interface via `insertBefore`. Claudian itself is never modified.

## Installation

1. Copy this whole folder (`claudian-statusline/`, containing
   `manifest.json`, `main.js`, `styles.css`) to
   `<YourVault>/.obsidian/plugins/claudian-statusline/`.
2. Reload Obsidian (`Ctrl`/`Cmd` + `P` → "Reload app without saving") or
   restart Obsidian once.
3. Settings → Community plugins → enable **Claudian Statusline**.

No build step needed – `main.js` is deliberately written as plain CommonJS
without a bundler, so "just copy it" is enough.

## Uninstalling / disabling

Consequence-free at any time:

- **Just turn it off:** Settings → Community plugins → toggle it off.
- **Remove entirely:** delete the folder
  `<YourVault>/.obsidian/plugins/claudian-statusline/`.

Either way, Claudian itself stays unchanged – it was never written to
Claudian's own files.

## Where the data comes from

| Line | File | Fields |
|---|---|---|
| 5h/7d | `~/.claude/statusline-cache.json` (path overridable in plugin settings) | `five_hour.used_percentage`/`resets_at`, `seven_day.used_percentage`/`resets_at` |
| Active tab | `<Vault>/.obsidian/plugins/realclaudian/data.json` | `tabManagerState.activeTabId`, `tabManagerState.openTabs[].conversationId` |
| Context %/In | `<Vault>/.claudian/sessions/<conversationId>.meta.json` | `usage.percentage`, `usage.contextTokens`, `usage.contextWindow`, `usage.inputTokens`/`cacheCreationInputTokens`/`cacheReadInputTokens` |
| Out | `~/.claude/projects/<sanitizedVaultPath>/<sessionId>.jsonl` (last assistant message) | `message.usage.output_tokens` |

`sanitizedVaultPath` follows Claude Code's own scheme: the absolute vault
path with every non-alphanumeric character replaced by `-` (exactly like
the regular `claude` CLI project folders).

All access is read-only, all wrapped in `try/catch`. If a file is missing
(e.g. because no message has ever been sent in that tab), a `–` is shown
instead of an error.

## How the updates work

A hybrid of push and poll, both purely read-only:

1. **Primary: `fs.watch` (inotify on Linux).** The plugin watches the
   relevant directories specifically (`~/.claude`, `.obsidian/plugins/
   realclaudian`, `.claudian/sessions`, `~/.claude/projects/<Vault>`) and
   triggers an (debounced, 200 ms) refresh immediately on any change –
   effectively in real time, as soon as Claude Code/Claudian writes one of
   these files.
2. **Fallback: timer** (setting "Refresh interval", default 5 s). Kicks in
   if `fs.watch` isn't (yet) working on a directory, e.g. because it didn't
   exist yet when the plugin started (like `.claudian/sessions/`, as long
   as no message has been sent) – the timer also retries setting up missing
   watchers on every tick.

No API call needed for this part: all values come from files that Claude
Code/Claudian write to disk anyway (see table above).

**Good to know:** Claudian itself only writes the `usage` field into
`*.meta.json` **after** a response has fully completed – not continuously
during generation. While that's still pending (fresh tab, or a response is
currently streaming), line 2 instead shows a **live fallback**:
`Ctx: ~X (live, preliminary) · In: … · Out: …`, computed directly from the
session's JSONL transcript (the same source `claude_tools/
statusline-viewer-py` reads from) – without a % value, since the context
window isn't known yet at that point. Once Claudian finishes the response
and writes `usage`, the line automatically switches to the full view with a
% value. Only for a genuinely empty tab with no activity at all does
"Ctx: – (no usage data yet for this tab)" stay as-is.

## Live rate-limit query (experimental, off by default)

Normally line 1 comes from `~/.claude/statusline-cache.json` – but that
file is only updated while an actual `claude` terminal CLI session is
running somewhere (the CLI's own statusline logic writes it). Claudian's
`sdk-ts` sessions don't trigger this – the file stays unchanged even with
active traffic.

Optionally, the plugin can instead query the 5h/7d numbers **directly,
live**, via an Anthropic endpoint that is **not officially documented**
(`api.anthropic.com/api/oauth/usage`), using the OAuth token already stored
locally in `~/.claude/.credentials.json` (the same token Claude Code/
Claudian use for login themselves). This doesn't consume any tokens – it's
a plain query, not a generation.

- **Disabled by default.** Can be turned on in settings under "Live rate-
  limit query".
- **Unofficial = can break without notice at any time.** On any error
  (endpoint unreachable, token missing, format changed), the status bar
  automatically and silently falls back to the file-based values – no
  crash, no hard failure.
- **Activity-driven instead of continuous polling.** It doesn't poll on a
  fixed interval forever, but only while something is actually happening in
  Claudian (detected via the same `fs.watch` watchers that also keep line 2
  current – writes to `.claudian/sessions` or the transcript directory
  count as activity):
  1. First activity → immediate fetch, then polling at the configured
     interval (default: 30 s) as long as further activity keeps coming in.
  2. If no further activity arrives for the configured idle time (default:
     20 s) – the turn is presumably done → one final fetch to capture the
     final state, then polling pauses completely again until traffic
     resumes.
  While idle, the last fetched values simply stay as-is – that's fine,
  since the rate limit doesn't change without your own usage anyway. On top
  of that, there's a one-off initial fetch when you enable the setting or
  on plugin startup, so something is shown right away.
- Both intervals (poll interval while active, idle time until pausing) are
  configurable in settings.
- A small tooltip on line 1 indicates whether it's currently querying live
  or falling back to the file; on a live error, a visible "⚠" also appears
  directly in the line.
- If the endpoint responds with HTTP 200 but in an unexpected format (e.g.
  because the unofficial endpoint changed), that response is **not**
  accepted as valid data – it's treated as an error instead, so the line
  never stays permanently blank/`–` and shows the working file-based values
  instead.
- The percentage is found under `utilization` in the real response (0–100),
  not under `used_percentage` as originally assumed – verified against a
  real response via debug logging. Both field names are supported.

## Settings

- Show/hide the 5h/7d line and the context line independently
- Refresh interval (default: 5 s)
- **Font size** (9–20 px, default: 11 px) – applies to both lines
- **Progress bars for % values** (5h, 7d, Ctx): "Off" (text only, default),
  "In addition to the % number", or "Instead of the % number". Bar color
  automatically escalates green → orange → red based on two configurable
  thresholds (default: 70% / 90%)
- Claude directory overridable (for `CLAUDE_CONFIG_DIR`/portable
  installations that differ from `~/.claude`)
- **Debug logging** (console): writes refresh cycles, values read, and raw
  live-API responses to the developer console
  (`Ctrl`/`Cmd`+`Shift`+`I` → "Console" tab). Errors are always logged
  regardless. Off by default, useful when troubleshooting "not updating".

## Known limitations

- **Desktop only** (`isDesktopOnly: true`), since Node's `fs`/`path`/`os`
  are used – same as Claudian itself.
- **Multiple simultaneously open Claudian panes:** `tabManagerState` in
  Claudian's `data.json` is a single, global state. With several Claudian
  views open in parallel, line 2 shows the most recently focused tab
  everywhere, not necessarily the one locally visible in each individual
  view.
- **Update risk (accepted deliberately):** if a Claudian update changes the
  CSS classes `.claudian-input-nav-content`/`.claudian-tab-bar-container` or
  the format of `data.json`/`*.meta.json`, the status bar simply stays
  blank/invisible instead of crashing – in that case, check here whether
  the selectors/fields changed and adjust `main.js` accordingly.
- **Windows: untested.** `fs.watch` itself is platform-neutral (uses
  `ReadDirectoryChangesW` internally on Windows instead of inotify) and
  should work without modification. The only uncertain part is whether
  `resolveProjectDir()` (locating `~/.claude/projects/<sanitizedVaultPath>/`)
  exactly matches Claude Code's own sanitization on Windows paths (drive
  letter, backslashes) – the code therefore tries several plausible
  variants instead of relying on just one (see the comment there). Should
  none of them match, only "Out" (line 2) and the live-context fallback
  would stay blank (`–`) – line 1 and the rest of line 2 are independent of
  this and would keep working normally either way. With debug logging
  enabled (settings), all attempted path candidates get logged to the
  console.
