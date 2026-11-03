# session-memory

Mines every interactive Claude Code session for things worth remembering in later sessions (decisions, rules, proven root causes, gotchas, project state) and files them in a topic tree per repo group. Each item keeps the session quotes it came from, so a later session can judge how much to trust it.

Status: mining and recall both run. New sessions get the group's top items in the `memory_open` description and can drill down with the three tools below.

## Install

```
/plugin install session-memory --marketplace llkhacquan/claude-mods
```

## Groups

Sessions in one group share one tree. Map repo roots to groups in `~/.config/session-memory/groups.txt`, one `group root` per line:

```
# group  repo root
be       ~/code/payments
be       ~/code/ledger
devops   ~/code/gitops
skip     ~/code/sandbox
```

- A root covers its worktrees and sub folders. The longest matching root wins.
- A session in no listed root goes to group `other`. Group `skip` is never mined, and neither are sessions under `/tmp` or `/var/folders` (the macOS `$TMPDIR`, where test suites run `claude -p`).
- Headless runs (`claude -p`, the SDK) are never mined, including a headless resume of an interactive session.

### Auto groups

When an interactive session starts in a git repo that no rule covers, one model call files the repo (the main repo root, so worktrees land on it): join a listed group, make a new group, or `other`. The answer is appended to `~/.local/state/session-memory/groups.auto.txt` as `group root  # desc`, and the status line shows `memory: <repo> -> <group> (auto)`. Each root costs one call ever; `other` answers are kept too. A model error or a garbled reply writes nothing, so the next session asks again.

- The model sees the repo path, the head of its `CLAUDE.md` or `README.md`, and each group with its repos, description and top topics.
- At most 8 groups (yours and auto ones). At the cap a new group becomes `other`.
- Your `groups.txt` wins: an auto rule at or under one of your roots is ignored. To fix a wrong guess, add a line to `groups.txt`. To stop, set `autoGroups` to `false`.
- The call counts against `dailyCalls`; past the cap the session stays `other` and the next one asks.
- Items mined into `other` before the repo got a group stay in `other`.

## When it runs

| Event | What happens |
|---|---|
| main turn ends, then 10 min idle | mine the new part of this session's transcript (waits for 3 human turns) |
| compaction | mine now, in the background; compaction does not wait |
| `/clear` | mine the ended session now |
| exit | mark the session pending; the next session in its group mines it |
| session start | in the background, mine up to 10 idle transcripts of this group that grew since last time, pending ones first |
| `/memory-backfill` | in the background, the same sweep over every group (`other` too) with no per-run limit, until the day's sweep share is used; run it again on later days to go on |

A sweep or backfill stops at the first failed model call (an error, or a reply with no ops JSON) and leaves that transcript for the next one. After 3 failed sweeps a transcript is given up until it grows again.

Each slice of a transcript goes to the model once. The record of what was mined (`processed.jsonl`) is the cursor, so a resumed or crashed session continues where the last run stopped.

## Options

| Option | Default | |
|---|---|---|
| `model` | `sonnet` | model that extracts and files items |
| `dailyCalls` | `150` | model calls per day, failed ones included; past it, work waits for the next day. The start sweep gets at most a third; idle, compact and clear runs keep the rest |
| `sweepMax` | `10` | transcripts one session start picks up |
| `autoGroups` | `true` | file unlisted git repos into a group with one model call |
| `jevKey` | empty | OpenRouter key for the recall nudge judge (kept in secure storage); empty turns nudges off |
| `jevModel` | `jev-1.13` | Jev model id |
| `nudgeMin` | `0.8` | Jev YES probability at or above which a nudge is sent |

## Files

`~/.local/state/session-memory/<group>/`:

- `nodes.json`: the topic tree
- `items.jsonl`: one item per line, with vote counts per session and the repos whose sessions referenced it
- `refs/YYYY-MM.jsonl`: the quotes behind each item, one shard per month
- `processed.jsonl`: transcript ranges already mined

Secrets (keys, tokens, passwords, private keys, mnemonics) are replaced with `[redacted]` before a slice goes to the model, and again in the text and quotes it sends back.

Writes go to a temp file and `mv` over the old one, under a `mkdir` lock per group, so two sessions in one group never drop each other's items. A lock left by a crash is broken after 60 s, by one waiter at a time. Before each model call and again under the lock, a run skips any range another session already mined, and a sweep claims each transcript (`claims/<sid>`) so two sessions never mine it side by side. A group file over 4 MiB is not loaded; the status line says which.

## Recall

An interactive session in a group gets three tools:

| Tool | Input | Returns |
|---|---|---|
| `memory_open` | node id | its subtopics and items; an unknown id lists the valid ones |
| `memory_search` | key words | the best 20 item lines of the group, matched on item text and topic titles |
| `memory_refs` | item id | the item and each session quote behind it |

The `memory_open` description carries the group's top items (first the ones under this repo's node or referenced from a session in this repo) and its topics, cut to fit the 4096-char tool description limit, so the model sees them without a call. It is registered again after the session's own run changes the group. Items the session has seen this way count as echo when it repeats them, not as new votes.

`/memory-forget <item-id>` hides a wrong item: it is gone from the three tools and the description at once. It is kept on disk, and a later ref from the user (not the agent) brings it back.

### Recall nudge

Agents rarely call the memory tools on their own, so with `jevKey` set the mod points them at a topic when the conversation touches it:

1. Your prompt, and the main agent's text at each step (not tool input or output), is matched against live items: an item is a candidate when it shares at least 2 terms that few items carry. Items this session voted on, and topics it already searched or was nudged about, are skipped.
2. The best candidate goes to Jev (TypeSafe System One via OpenRouter `/v1/systemone`), which answers YES/NO with a probability: does this note fit what the conversation is working on?
3. At `nudgeMin` or above, the agent gets a one-line note naming the topic, its item ids and a ready `memory_search` query. A match in your prompt rides on that prompt (the mod waits up to 2 s for Jev). A match in the agent's text rides on its next tool result, or your next prompt if the turn ends first.

Each topic is nudged at most once per session, with at most 200 Jev calls per session. A replay over two days of real sessions found the term match alone right about 1 time in 5; with Jev at 0.85 it was right 8 times in 9, at about $0.00002 per call.

## Debugging

Every run appends one JSON line per event to `~/.local/state/session-memory/events.jsonl` (rotated at 1 MiB, three old files kept). `claude --debug` shows the same lines prefixed `session-memory:`. Each line has `ts`, `by` (the session that ran it) and `ev`:

| `ev` | When | Fields |
|---|---|---|
| `start` | an interactive session starts | `cwd`, `group`, options (`jev` says whether a key is set; the key is never logged) |
| `autogroup` | an unlisted repo is filed | `root`, `action`, `group`, `why`, `written` (`written`, `exists`, `busy`), `in`, `out`, `ms`, or `error` |
| `sweep` | the start sweep or one backfill group ends | `found`, `picked`, `done`, `stop` (`all`, `max`, `cap`, `model`) |
| `give-up` | a transcript failed 3 sweeps; skipped until it grows | `sid`, `group`, `fails` |
| `backfill` | `/memory-backfill` ends | `done` (transcripts per group) |
| `job` | one transcript is processed | `trigger`, `sid`, `group`, `stop`, `slices`, `calls`, `ms` |
| `slice` | one model call is filed | `from`, `to`, `turns`, `cands`, `in`, `out`, `ms`, `ops`, `items`, `skipped`, `errors` |
| `split` | a topic over 30 children is split | `node`, `children` or `error` |
| `tools` | the memory tools are registered | `l0Chars`, `l0Items` |
| `recall` | a memory tool is called | `tool`, `arg`, `items`, `chars` |
| `forget` | `/memory-forget` hid an item | `group`, `item` |
| `nudge` | Jev judged a candidate | `src` (`user`, `assistant`), `topic`, `items`, `shared`, `p`, `sent`, `ms`, or `status` / `error` |
| `skip` | a trigger did nothing | `why` (`debounce`, `group skip`, `no transcript`, `claimed` by another session's sweep, `cap` for an autogroup call) |
| `model-error` | a model call failed; `kind` is `reconcile`, `split` or `parse` (no ops JSON, `error` holds the reply head) | `kind`, `error` |
| `busy`, `lock-stale`, `fail` | something went wrong | the error, with `sid`, `group` or `path` when known |
| `end` | a session ends | `reason` |

```sh
jq -c 'select(.ev=="job")' ~/.local/state/session-memory/events.jsonl | tail
jq -s 'map(select(.ev=="slice" or .ev=="split")) | group_by(.ts[:10]) | map({day: .[0].ts[:10], calls: length, in: (map(.in) | add), out: (map(.out) | add)})' ~/.local/state/session-memory/events.jsonl
jq -c 'select(.ev=="skip" or .ev=="fail" or .ev=="model-error")' ~/.local/state/session-memory/events.jsonl
```

## Tests

```
cd lib && bun test            # lib specs
claude plugin test .          # hooks, against the engine's test kit
```
