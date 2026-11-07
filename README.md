# pi-gatekeeper

A [Pi](https://pi.dev) extension that refuses to let a run settle while **your** completion requirement is false.

It is not a loop and not a planner. It has **veto power, not knowledge**: it cannot know that your task is
finished, and it never guesses. All it does is take one executable claim, run it, and refuse to let the
agent stop while that claim is false.

## The definition step

A gate is only as good as its requirement — so the gatekeeper does not invent one. Enabling it starts a
definition step:

1. You run `/gate on`.
2. On the next task, the gatekeeper attaches an instruction telling the agent to investigate the project
   and propose **one executable completion requirement** — a command that is false *right now* and becomes
   true only when the work is done.
3. The agent calls `gatekeeper_propose_requirement` with the command, its scope, what it covers and what it
   does **not** cover.
4. The gatekeeper runs it and checks the baseline mechanically.
5. You confirm. From then on, that requirement gates every settle.

Because the agent has to look at the project first, the requirement tends to be the project's own
acceptance path (tests, build, lint) rather than a bespoke grep — and because it has to declare what the
requirement does *not* cover, it cannot quietly overclaim.

### The baseline rule

This is the whole trick. A requirement is rejected unless its baseline is right:

| kind | must be now | rejected when |
| --- | --- | --- |
| `completion` | **red** (fails) | it already passes — then it proves nothing about the work ahead |
| `regression` | **green** (passes) | it already fails — an invariant that is already broken |

A green type-check cannot gate an unfinished migration. The gatekeeper says so and asks for a better
requirement, instead of settling early and letting the agent believe it is done.

Also rejected: commands that cannot fail (`true`, `echo`, `ls`…), commands that do not exist, and commands
that time out.

## What happens while the requirement is false

The check runs when the agent is about to settle and has changed something. Each failure is fed back and
the run continues:

| Attempt | What the agent is told |
| --- | --- |
| 1–2 | The requirement is not satisfied, with the error output and a reminder of what it verifies |
| 3rd *identical* failure | Stop patching; state the root cause and try a materially different approach |
| 5th *identical* failure | Consider reverting — or revert automatically with auto-rollback enabled |
| `PI_GATEKEEPER_MAX` (default 12) | The gate gives up and the run settles quietly |

Weakening, skipping or deleting the check is not a fix, and the agent is told so.

## Evidence, not a green light

Every baseline and every pass is recorded as `(tree fingerprint, command, exit code, duration,
timestamp)` in the session. A verdict names the tree revision it was produced against — move the tree and
the verdict is void, so the next settle re-runs the requirement. `/gate status` shows the requirement, its
scope, what it covers and excludes, the measured baseline, and the last pass.

## Commands

```
/gate on        enable (starts the definition step if no requirement exists)
/gate off       disable — verifies nothing, says so
/gate define    discard the requirement and define a new one on the next task
/gate status    requirement, scope, coverage, baseline, last pass
/gate verify    run the requirement now
/gate rollback  restore tracked files to the pre-task snapshot
```

## Configuration

Environment variables, read at extension load:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_GATEKEEPER_ENABLE` | – | `1` turns the gate on for this run; the agent still defines the requirement |
| `PI_GATEKEEPER_CHECK` | – | Pre-declare a command instead of the agent defining one (validated on first use) |
| `PI_GATEKEEPER_KIND` | `completion` | `regression` for a pre-declared invariant |
| `PI_GATEKEEPER_MAX` | `12` | Attempt cap before the gate lets the run settle |
| `PI_GATEKEEPER_TIMEOUT_MS` | `300000` | Per-run timeout for the requirement |
| `PI_GATEKEEPER_DEFINE_TIMEOUT_MS` | `600000` | Timeout while validating a proposed requirement |
| `PI_GATEKEEPER_ROLLBACK` | `0` | `1` enables automatic rollback after 5 identical failures |

Malformed values fall back to the default rather than disabling a limit.

## Rollback semantics

Read this before enabling `PI_GATEKEEPER_ROLLBACK=1`.

- A snapshot of tracked files is taken before each task; rollback restores it with
  `git restore --source <ref> --staged --worktree`.
- **Untracked files created during the task are left in place**, and the requirement is re-run afterwards
  rather than assumed fixed.
- **Files you edited by hand during the task are reverted too.** That is why it is opt-in.
- Each session pins its snapshot at `refs/pi-gatekeeper/snapshot/<session-id>`, removed when the session
  quits. Stale refs can be listed and deleted with `git for-each-ref refs/pi-gatekeeper` and
  `git update-ref -d <ref>`.

## Honest limits

- **A green requirement is not proof the task is done.** It is proof that this specific claim holds. If
  the requirement is weaker than your intent, the gate will settle early — that is a requirement problem,
  and the gate cannot detect it.
- **The requirement lives in the repo the agent can write to.** An agent that weakens the check defeats
  the gate. Keeping the command out of the agent's write scope (or hash-pinning it) is the caller's job.
- **The gate cannot drive work.** "Keep going until the goal is done" is a loop's job — pair it with
  something like `pi-goal-x` and let the gatekeeper be the executable floor under its completion review.
- Every `bash` call counts as a possible change, so a turn that only inspects the repo can still trigger
  one verification run.

## Requirements

- Pi with extension support.
- `git` for the tree fingerprint (and rollback).
- `bash` on macOS/Linux, `cmd.exe` on Windows.

## Maintenance

`assets/card.jpg` is the preview shown on the [pi.dev package gallery](https://pi.dev/packages), served
from the published tarball through jsDelivr and referenced from `pi.image` in `package.json`.
`assets/card.png` is the lossless master and is deliberately not published. The gallery only accepts an
absolute URL ending in `.png`/`.webp`/`.jpg`/`.jpeg`/`.gif` — `.svg` and relative paths are silently
ignored. `assets/demo.png` is a headless-Chrome render of a gate transcript; rebuild it from
`assets/card.html` with the command in that file's comment.

## License

MIT
