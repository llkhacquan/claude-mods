# sidebar: sync between sessions without polling

Status: built (size 2), 2026-10-08. Results are at the end.

## Problem

Each session polls every 2 seconds (`POLL_MS` in `plugins/sidebar/hooks/register.tsx`). One poll is
one directory list of the feed folder plus two store reads. So:

- a change in one session (pane open, minimized, closed; a card that starts to run or needs input)
  shows in the others up to 2 seconds late
- every open session does this work forever, also when nothing changes

## Goal

- A change shows in every other session in under 100 ms.
- An idle session does no work: no timer that reads the disk.

## What the mod API gives

- No file watch and no push event between sessions.
- `$.process.spawn`: a child process that lives as long as the session and streams what it prints
  to the mod. The engine kills it when the loop ends or the module unloads.

## Idea: `tail -F` as the watcher

```
session A: state changes -> appends one line to <state dir>/signal
                                   |
       the kernel wakes every `tail -F signal` (kqueue on macOS, inotify on Linux)
                                   |
session B, C: tail prints the line -> the mod reads the store and the cards -> redraw
```

- Each session starts one `tail -n 0 -F <state dir>/signal` at `session.start`.
- A session appends one line to `signal` after it writes its card or changes the pane mode.
- On each piece that `tail` prints, the session runs what the poll runs today (`poll`).
- The 2 second poll goes away. The 30 second heartbeat stays and also runs `poll`, as the safety
  net for a `tail` that died.
- Idle cost: one sleeping `tail` per session.

## Check first (a short probe, before any build)

1. Delay from the append in one session to the redraw in another. Target: under 100 ms.
2. How `$.fs.write` replaces a file. If it writes a new file and renames it, `tail -F` has to
   reopen and may lag about a second. Then append the line with `$.process.run` and a plain
   append, not with `$.fs.write`.
3. The engine kills the `tail` at session end, at `/clear`, and at each hot reload of the mod.
   No orphan `tail` may stay behind. Count them with `pgrep -fl "tail -n 0 -F"`.
4. `tail` is restarted when it exits by itself (the signal file was deleted, the state folder is
   on a file system with no events).
5. The signal file grows by one line per change. Decide who cuts it and when; `tail -F` follows a
   truncated file.

## Two sizes

1. Signal for the pane mode only. Small. The 2 second poll stays for the cards, so the goal of no
   polling is not met.
2. Signal for the mode and the cards, and drop the 2 second poll. This is the one that meets both
   goals.

Lean: 2.

## Done when

- Minimize in one session shows in another in under 100 ms, measured.
- A session that sits idle for a minute makes no feed or store reads other than the heartbeat.
- No `tail` process is left after its session ends.
- Tests cover: a signal piece triggers a refresh; the heartbeat still catches a missed signal.

## Results (2026-10-08, macOS)

| Check | Result |
|-------|--------|
| 1. Delay | Bare `/usr/bin/tail`: 6-16 ms from the append to the wake. In a live session: 4.4-5.9 ms from the append to the redraw dump, 5 runs |
| 1. Which `tail` | GNU `tail` (coreutils, first in `PATH` on the test machine) polls on macOS: 81-975 ms. So the mod runs `/usr/bin/tail` by its full path |
| 2. `$.fs.write` | Rewrites in place: same inode, new mtime. It can not append, and a rewrite of the same size wakes no `tail`. So the append is `tee -a` through `$.process.run` |
| 3. Orphans | One `tail` per session after `/clear`, none after the session is killed |
| 4. Restart | The heartbeat starts `tail` again when the stream has ended. Covered by a test, not seen live |
| 5. Growth | One byte per signal. A new session empties the file over 64 KB. A wake after the cut was seen live |

Idle cost, 5 sessions, 21 minutes: 0.23 s of CPU and about 350 KB per `tail`. `tail -F` wakes once a
second to check that the file was not renamed, so it is not fully asleep.

Wakes are batched: the first signal reads at once, later ones inside 100 ms share one read at the
end of the 100 ms. A lone change still shows in about 5 ms; a change inside a burst in up to 100 ms.

Not seen live: a pane mode change between two sessions (the store is shared with the real
sessions, so the scratch sessions left it alone). The tests cover it through the same wake.

Left out: a fallback poll while `tail` can not start. Such a session syncs at the 30 second
heartbeat only.
