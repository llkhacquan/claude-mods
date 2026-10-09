# auto-approve: learn a rule in the session

Status: built, 2026-10-09: the core and the three UIs, band by default. Not yet run in a live
session as the gate (see "Before this").

## Problem

The gate asks, the person approves, and the same kind of command asks again a minute later. The
only way to stop it today is `/auto-approve add` by hand, or the weekly `/auto-approve learn`.

## Goal

- After a few approvals of the same kind in one session, the mod offers one rule.
- The person picks where it goes: this session, this repository, or nowhere.
- A rule saved for the session stops the next ask in that session, with no file written.
- No new way for a tool call to allow itself: a rule is saved only by the person, and only with the
  full rule text shown.

## Non-goals

- A global rule from the session. A few approvals in one session are too thin for all projects;
  that stays with `/auto-approve learn`.
- Learned `ASK:` or `DENY:` rules. An approval teaches an allow, nothing else.
- Any change to the hard ask and hard allow layers. One exception came out of the review: a change
  to a rules file now always asks (`rulesFileReason`). Without it the agent could write the rule
  itself, `cp` is a hard-allowed command, and the person's key press on an offer would guard
  nothing.

## Before this: the mod must be the gate

The flow below runs only where this mod decides the tool calls. On the author's machine the gate
is still the qflow skill (three node hooks in `~/.claude/settings.json`). Switching is its own
unit of work:

- install the mod and remove the three hooks from `settings.json`
- carry the hand-tuned rules of the skill's `global-rules.txt` into
  `~/.config/auto-approve/rules.txt`
- the mod has no hard allow list for MCP tools (`HARD_ALLOW_MCP` in the skill), so those calls go
  to the model until one is added
- measure the plan quota a real day of haiku gate calls uses

## Flow

```
PreToolUse:  gate asks            -> pendingAsks[id] = { tool, input, layer }
PostToolUse: the tool ran         -> USER_APPROVED logged (today)
                                  -> approvals += { tool, input }      only for a parsed model ASK
                                  -> if approvals >= 2 and no offer is open: draft (not awaited)
draft:       sonnet reads approvals + current rules
                                  -> NONE, or { rule, covers }
                                  -> offer = { id, rule, covered }     only if no offer is open
UI:          shows the offer and the calls behind it, calls settle(id, scope) or reword(id, text)
settle:      claim the offer by id (one winner), then
             session -> sessionRules += rule
             repo    -> append the line to <git common dir>/auto-approve-rules.txt;
                        on a failed write the offer is put back
             no      -> declined += rule
             always  -> drop the covered approvals, log the outcome
dismiss:     Esc on the pane or the question: claim the offer, drop the covered approvals,
             log RULE_DISMISSED, nothing saved and nothing declined
classify:    prompt = [global + repo rules, cached] + [session rules] + [tool block]
```

## State

All in `$.state` under `auto-approve`, declared in `types/index.d.ts`. `$.state` belongs to the
session and survives a hot reload, so nothing here needs a file.

| Key | Type | Holds |
|-----|------|-------|
| `approvals` | `{ tool: string; input: string }[]` | asked calls the person approved, newest last, at most 20 |
| `sessionRules` | `string[]` | `ALLOW:` lines saved for this session, at most 30 |
| `declined` | `string[]` | rule lines the person refused, so the drafter does not offer them again, at most 30 |
| `offer` | `{ id: string; rule: string; covered: string[]; isRewording: boolean; isInBand: boolean } \| null` | the one open offer; `covered` holds the inputs of the approvals behind it, since an index moves when the list is cut to 20 |

`id` names one exact rule text: a reword gives the offer a new id. Every writer (`settle`,
`dismiss`, `reword`) acts only on the id it was drawn with, so a second press, or a press on a
stale drawing, does nothing. `isInBand` says the band draws the offer: always in band mode, and
in pane mode when the pane could not be placed.

`pendingAsks` stays a module variable and gains `isLearnable`. It holds at most 200 entries.

## Pieces

1. **Collect.** In the `classic.PostToolUse` hook, next to the `USER_APPROVED` record, push the call
   to `approvals`. Skip the layers `hard-ask`, `danger-llm` and `oversize`: an approved push to
   `master` or an approved `rm -rf` must never feed a rule. Skip a call the model answered `DENY`
   too: the person went against a rule there, and an `ALLOW:` line drafted from it would
   contradict the rules file. Skip a call asked because the model timed out, failed or gave no
   verdict (`isJudged` false): nobody judged it, so it may be one the model would have denied.
2. **Draft.** `draftRule($, approvals, rules, declined)` makes one `$.model.complete` call with
   `model: 'sonnet'`. It runs after the tool call and is not awaited by the hook, so no tool result
   waits on it. Input: the approvals as untrusted data inside a fence (one line per call, control
   characters dropped, `<` and `>` written as entities so a call cannot close the fence), the
   current rules, the declined lines. Output: `{"rule": "ALLOW: ...", "covers": [0, 2]}` or `{"rule": null}`.
3. **Check the draft.** `parseDraft(text, approvalCount)` accepts a reply only when it is one JSON
   object, `rule` is one line that starts with `ALLOW:`, is at most 200 characters, holds no
   control, format or odd space character (so the text shown is the text saved), and `covers`
   names at least 2 existing approvals. Anything else is NONE. No offer on a timeout or an error.
4. **Settle.** `settle($, id, scope)` is the only writer of rules. `reword($, id, text)` puts the
   reworded line through the same one-line `ALLOW:` check. A repo save skips an exact duplicate,
   appends the line with `sh` and `>>` (`$.fs` can only replace a whole file, which would drop a
   line another session added), and reads the file back to prove the line is there. Outside a git
   repository, or when the write fails, the repo choice is refused and the offer stays open.
5. **Read session rules.** `rulesBlock` keeps the cached part as it is (global and repo). The
   session rules go in a second prompt part, not cached, so a new session rule does not break the
   cache of the first part.
6. **Log.** Four new records in the session log: `RULE_OFFERED`, `RULE_SAVED` (with `scope`),
   `RULE_DECLINED` and `RULE_DISMISSED`. `/auto-approve learn` can then promote a rule saved for a session in several
   sessions to the repo or global file.

## Safety

- The hard ask layer runs before the model, so no learned rule can allow a push to a protected
  branch, a force push, `gh pr create` or `gh release create`.
- The command text is written by the agent and now feeds a draft. It reaches the drafter as fenced
  untrusted data, the reply is held to one `ALLOW:` line, and the person's click on the full rule
  text is the last guard. The UI must show the whole line, never a summary, and the calls the
  rule was drafted from beside it.
- In the pane and the question dialog the default answer is No, and the pane's save buttons have
  no hotkey: a key meant for the prompt must not save a rule.
- One offer at a time. A draft is not started while an offer is open.
- A session rule is never written to disk. It ends with the session.

## UI seam

The core exposes two things and knows nothing else about the UI:

- the `offer` state value, to draw
- `settle($, choice, text?)`, to call

The spike mod `learn-spike` tried three shapes on a sample offer: a band above the prompt, a pane
that behaves as a dialog, and `$.ui.ask`. All three worked from a slash command. The band is the
default, and the `learn` option of the mod picks one of `band`, `pane`, `ask` or `off`.

## Tests

In `tests/auto-approve.test.ts`, one test per line:

- an approved ask is collected; an allowed call is not
- an approved hard ask, danger or oversize call is not collected
- no draft call with one approval; one draft call with two
- no draft call while an offer is open
- a draft that is not one `ALLOW:` line gives no offer (multi-line, `DENY:`, prose, over 200
  characters, `covers` with one entry)
- a declined rule is sent to the drafter and a draft equal to it gives no offer
- a session save puts the rule in the classifier prompt of the next call and writes no file
- a repo save appends one line, and a second save of the same line does not add it twice
- a repo save outside a git repository is refused and the offer stays
- a reworded line that fails the check is refused
- the log records are written
- a rule with a control or hidden character is refused; a rules file cannot hide a second rule
- a call cannot close the fence of the draft prompt
- an approved destructive call, and a call after a classifier timeout, feed no draft
- two approvals at once give one draft; two presses settle once
- a failed repo write keeps the offer; an unplaced pane hands the offer to the band
- a dismissed offer comes back only after two more approvals

- an offer left open by a reload is shown again on `session.start`

Not proven by the plugin harness:

- a pane closed by the person: the harness cannot raise `ui.close`
- session rules across a module reload: `$.state` is the host's, and the harness has no reload
- the draft flag race: the test of two approvals at once also passes with the flag set after an
  `await`, so the harness does not interleave the two hooks there. The fix holds by construction:
  the flag is set before the first `await`, and the offer is written only when none is open.

Known gap: a repo save claims the offer, runs the append (up to 3 s), and puts the offer back on
a failed write. A draft that finishes inside that window takes the slot, and the failed offer is
lost though the toast says it stayed.

## Open questions

1. Does an approval inside a subagent's loop reach the same `PostToolUse` hook and the same
   `$.state`? Check with a subagent that runs one asked command.
2. Does `$.state` survive `/clear`? If it does, the session rules should be dropped on the
   `session.start` that follows a clear.
3. Quota: one sonnet call per approval after the first. Measure the calls of a real day before
   making this on by default; a `userConfig` switch may be needed.
4. Should a session rule also skip the model call (a hard allow)? No in this plan: session rules
   are plain language, so the model still judges each call against them.
