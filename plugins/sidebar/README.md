# sidebar

A side pane that shows every live Claude Code session on this machine as a card. No tmux, no daemon, no extra binary: each session writes its own card to a small file, and each pane reads all the cards.

```
╭──────────────────────────────────────────╮
│ 1: Fix login redirect loop               │
│ ● Bash: go test ./auth/...               │
│ api · fix/login · opus-5-5 · 42%         │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│ 2: Draft release notes                   │
│ ? asked you                              │
│ web · main · sonnet-5-5 · 18%            │
│ Needs: pick the changelog format         │
│ Did: collected 14 merged PRs             │
╰──────────────────────────────────────────╯
```

## Install

```
/plugin install sidebar --marketplace llkhacquan/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope so every session loads it. A session without the mod has no card.

## Use

Type `/sidebar`. In the fullscreen layout the pane docks beside the transcript; on the main screen it opens above the prompt. Close it with `ctrl+x x`.

Each card shows:

| Line | What |
|------|------|
| Title | A 3-6 word label of what the session is working on |
| Status | `●` running (with the current tool), `▲` needs input, `?` asked you a question, `○` idle |
| Meta | folder, git branch, model, context use |
| Recap | After a long turn: what it needs from you, what it did, what it left |

The card with the highlighted border and no hotkey is the session you are in.

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

## Cost

The title and the recap each use one small Haiku call: a title per prompt you type, a recap per long turn (5 or more tool calls, or a long answer). Nothing else calls a model.

## Needs

- `git` on `PATH` for the branch name. Without it the branch is left out.
- `tmux` only for the jump.
