# sidebar

A side pane that shows every live Claude Code session on this machine as a card. No tmux, no daemon, no extra binary: each session writes its own card to a small file, and each pane reads all the cards.

```
╭ api ─────────────────────────── running ╮
│ 1: Fix login redirect loop               │
│ ⚡ Bash: go test ./auth/...              │
│ 🌿 fix/login                             │
│ 🟢 416k/1M · Opus 5.5 · $2.20            │
╰──────────────────────────────────────────╯
╭ web ───────────────────────── asked you ╮
│ 2: Draft release notes                   │
│ 🌿 main                                  │
│ 🟢 36k/200k · Sonnet 5.5 · $0.41         │
│ Needs: pick the changelog format         │
╰──────────────────────────────────────────╯
╔ ▶ docs ═══════════════════════════ idle ╗
║ Rewrite the install guide                ║
║ 🌿 main                                  ║
║ 🟡 120k/200k · Opus 5.5 · $1.10          ║
╚══════════════════════════════════════════╝
```

## Install

```
/plugin install sidebar --marketplace llkhacquan/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope so every session loads it. A session without the mod has no card.

## Use

Type `/sidebar`. In the fullscreen layout the pane docks beside the transcript; on the main screen it opens above the prompt. Close it with `ctrl+x x`, or type `/sidebar` again.

The choice is remembered. After `/sidebar`, every new session opens the pane by itself; after a close, new sessions leave it closed. Claude Code places a pane that opens by itself only on a terminal of 110 columns or more. Below that, type `/sidebar`.

Each card shows:

| Line | What |
|------|------|
| Top border | The folder, and the status: `running`, `needs input`, `asked you` (it ended its turn with a question), `idle` |
| Title | A 3-6 word label of what the session is working on |
| Tool | `⚡` and the current tool while it runs, `▲` and the tool that waits for you |
| Branch | `🌿` and the git branch |
| Usage | Context use (`🟢` under 50%, `🟡` under 80%, `🔴` above), model, cost so far |
| Needs | After a long turn: the one thing it waits for from you, two lines at most |

The card with the double border and the `▶` is the session you are in.

## Jump to a session (tmux only, optional)

When both sessions run inside tmux, each other card gets a hotkey `1`-`9`. While the pane has the keys (right after `/sidebar`, or after `ctrl+x tab`), press the digit to switch the tmux client to that session's pane. Outside tmux the key does nothing and a toast says why. Everything else works the same without tmux.

## How it works

```
session A ─┐ writes its own card                              ┌─► pane in A
session B ─┼─► ~/.local/state/claude-sidebar/feed/<id>.json ──┼─► pane in B
session C ─┘ on each event + every 30s                        └─► pane in C
                                                    reads all cards every 2s
```

- A card that is not rewritten for 90 seconds is hidden, so a crashed session drops out by itself.
- A session that ends marks its card `ended`. The files stay; they are a few hundred bytes each.
- The feed folder is `$CLAUDE_SIDEBAR_STATE_DIR/feed`, else `$XDG_STATE_HOME/claude-sidebar/feed`, else `~/.local/state/claude-sidebar/feed`.

## Debug

Start a session with `CLAUDE_SIDEBAR_DEBUG=1`. It then keeps cards older than 90 seconds, and writes the drawn pane as plain text to `debug/pane.txt` beside the feed folder each time the cards change. Point `CLAUDE_SIDEBAR_STATE_DIR` at a scratch folder with hand-made card files to see every card state from one session.

## Cost

The title and the recap each use one small Haiku call: a title per prompt you type, a recap per long turn (5 or more tool calls, or a long answer). Nothing else calls a model.

## Needs

- `git` on `PATH` for the branch name. Without it the branch is left out.
- `tmux` only for the jump.
