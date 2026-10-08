# sidebar

A side pane that shows every live Claude Code session on this machine as a card. No tmux, no daemon, no extra binary: each session writes its own card to a small file, and each pane reads all the cards.

```
╭ work/api ───────────────────── ✦ running ╮
│ 1: Fix login redirect loop               │
│ ⚡ Bash: go test ./auth/...              │
│ 🌿 fix/login · 3 changed · 1 unpushed    │
│ 🟢 416k/1M · Opus 5.5 · $2.20            │
╰──────────────────────────────────────────╯
╭ work/web ───────────────── asked you 12m ╮
│ 2: Draft release notes                   │
│ 🌿 main                                  │
│ 🟢 36k/200k · Sonnet 5.5 · $0.41         │
│ Needs: pick the changelog format         │
╰──────────────────────────────────────────╯
╔ ▶ work/docs ═══════════════════════ idle ╗
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

Type `/sidebar`. In the fullscreen layout the pane docks beside the transcript; on the main screen it opens above the prompt.

The pane has three states, and every session follows the same one:

| State | What you see | How to get there |
|-------|--------------|------------------|
| Open | The pane with the cards | `/sidebar`, or a click on the minimized row |
| Minimized | One row above the prompt: `[+] sidebar · 3 sessions · 1 needs you` | The `[-]` at the top right of the pane, under the `✕`: click it, or move to it with Tab and press Enter while the pane has the keys |
| Closed | Nothing | The `✕` of the pane, `ctrl+x x`, or `/sidebar` while the pane is open |

A change in one session reaches the others in a few milliseconds, idle ones too, and a new session starts in the same state.

Claude Code places a pane that opens by itself only on a wide terminal: 144 columns, or 110 once you have opened the pane with `/sidebar` and not closed it by hand since. A narrower session stays without the pane until you type `/sidebar` there.

Each card shows:

| Line | What |
|------|------|
| Top border | The folder with its parent (the folder alone when the border is too narrow), and the status: `running`, `needs input`, `asked you` (it ended its turn with a question), `idle`. An `idle` or `asked you` card adds how long it has waited (`12m`, `3h`, `2d`), from one minute on. A running card has a spinner beside the word, a rainbow gradient that flows around its border, and a brighter comet that runs a lap over it, then rests. A `needs input` card blinks its border. All of these move only while the pane is open |
| Title | A 3-6 word label of what the session is working on |
| Tool | `⚡` and the current tool while it runs, `▲` and the tool that waits for you |
| Branch | `🌿` and the git branch, then the count of changed files (untracked ones too) and of commits not pushed to the upstream branch. Read when the session starts, when it changes folder, and at the end of each turn |
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
     │ then appends one byte                  reads all cards on each wake │
     └─► ~/.local/state/claude-sidebar/signal ──► tail -F in every session ┘
```

- No polling. Each session keeps one `/usr/bin/tail -n 0 -F` on the `signal` file. A session appends one byte after it changes its card or the pane state, the kernel wakes every `tail`, and each session reads the cards and the pane state once. Measured on macOS: about 5 ms from the append to the redraw.
- Signals in a burst are batched: a session reads at once on the first one, then at most once every 100 ms. So a busy session does not make the idle ones read on each of its tool calls.
- The writer keeps its disk and process work low too. A change that leaves the card as it was writes nothing, and a session appends to the `signal` file at most once every 100 ms: the first change at once, the rest of a burst as one append after the gap.
- The path is `/usr/bin/tail` on purpose. GNU `tail` on macOS has no file events and polls once a second.
- The 30 second heartbeat also reads the cards and the pane state, and starts `tail` again when it has died. So a missed signal costs at most 30 seconds.
- A new session empties the `signal` file once it is over 64 KB.

- A card that is not rewritten for 90 seconds is hidden, so a crashed session drops out by itself.
- A session that ends marks its card `ended`. Any session removes a card file that was not written for a day, so the feed folder stays small. A session that is resumed within that day gets its title back. Debug mode removes nothing.
- The feed folder is `$CLAUDE_SIDEBAR_STATE_DIR/feed`, else `$XDG_STATE_HOME/claude-sidebar/feed`, else `~/.local/state/claude-sidebar/feed`.
- A card holds the folder, the branch and a short title made from your prompt. The session that creates the feed folder sets it to mode `700`, so other users of the machine can not read the cards. A feed folder made by an older version keeps its mode: run `chmod 700` on it once.

## Debug

Start a session with `CLAUDE_SIDEBAR_DEBUG=1`. It then keeps cards older than 90 seconds, and writes the drawn pane as plain text to `debug/pane.txt` beside the feed folder each time the cards change. Point `CLAUDE_SIDEBAR_STATE_DIR` at a scratch folder with hand-made card files to see every card state from one session.

## Develop

```bash
claude plugin validate plugins/sidebar
claude plugin test plugins/sidebar
npx -p typescript tsc -p plugins/sidebar
```

`tsc` needs `.claude-plugin/types/`, which is not in the repo. Claude Code writes that folder the first time it loads the mod: start one session with `claude --plugin-dir plugins/sidebar`.

## Cost

The title and the recap each use one small Haiku call: a title per prompt you type, a recap per long turn (5 or more tool calls, or a long answer). Nothing else calls a model.

## Needs

- `git` on `PATH` for the branch row. Without it the row is left out.
- `tmux` only for the jump.
