# Changelog

## [3.0.1] - 2026-11-07

- **Changed:** the footer status line only exists while the gate is on. An inert gate no longer occupies space
  with `gate: off`.
- **Fixed:** a requirement pre-declared with `PI_GATEKEEPER_CHECK` kept quoting its placeholder coverage
  text ("baseline not yet measured") in the messages sent to the agent, even after the baseline had been
  measured. It now reports the measured baseline and states plainly that the operator declared no
  coverage. Everything else is unchanged from 3.0.0.

## [3.0.0] - 2026-11-05

The gate is now defined before it is armed, because a gate is only as good as its requirement.

**Breaking.** There is no auto-detected check and no guessed default any more. A gate that verifies
nothing is worse than no gate, because it looks like one.

- **Added:** a definition step. Enabling the gate (or `/gate define`) attaches an instruction to the next
  run: the agent investigates the project and proposes one executable completion requirement through the
  new `gatekeeper_propose_requirement` tool, stating its scope and, explicitly, what it does **not** cover.
- **Added:** the baseline rule, validated mechanically. A `completion` requirement must be **false now**
  (one that already passes cannot gate unfinished work); a `regression` requirement must be **true now**.
  Commands that cannot fail, do not exist, or time out are rejected.
- **Added:** verdicts bound to a tree fingerprint. Baselines and passes record command, exit code,
  duration, tree and time, so `/gate status` reports evidence rather than a green light.
- **Added:** a hard guard on the model's own gate. It may propose only while the gate is enabled with no
  requirement armed — an armed requirement is the operator's to change, via `/gate define`.
- **Added:** `PI_GATEKEEPER_ENABLE` to turn the gate on for a run in which the agent defines the
  requirement, and `PI_GATEKEEPER_KIND` for pre-declared invariants.
- **Changed:** the state machine is `off` → `NEEDS REQUIREMENT` → armed. An enabled gate with no
  requirement is now loud on the status line, at session start, and again when a run ends having verified
  nothing.
- **Changed:** `PI_GATEKEEPER_CHECK` is validated against the same baseline rule on first use instead of
  being trusted.
- **Removed:** check-script auto-detection as an arming path. Detection survives only as project facts
  handed to the agent during the definition step.
- **Fixed:** the framing. The gate never decides that work is finished; it decides which claims cannot be
  made. The previous README promised a loop, which is a different mechanism.

## [2.1.0] - 2026-11-05

Verification is no longer skipped, and the gate can no longer claim a state it did not check.

- **Fixed:** changes made through `bash` to gitignored paths (`node_modules`, `dist`, generated code,
  `.env`) were invisible to the file fingerprint, so the gate silently skipped verification. Any
  `bash` call now counts as a possible change.
- **Fixed:** a settle that left the tree unchanged did not re-run the check and injected a failure
  message with an empty error body, which could loop to the attempt cap while the check actually
  passed. A failing gate always re-runs the check now.
- **Fixed:** `PI_GATEKEEPER_MAX=abc` produced a `NaN` cap that never triggered, allowing an unbounded
  gate loop. Invalid values now fall back to the default.
- **Fixed:** `git restore` ran through `bash`, which does not exist on Windows. The platform shell is
  used instead (`cmd.exe /d /s /c`).
- **Fixed:** the snapshot ref was shared by every session in a repository and was never cleaned up,
  so concurrent sessions clobbered each other. Refs are now per session and removed on quit.
- **Fixed:** auto-rollback set the gate to "passed" without verifying the restored tree, while files
  created during the task were left behind. The restored tree is re-checked and reported honestly.
- **Changed:** the default check command is no longer `npm run check`. The gate auto-detects a
  `check` script or reads `PI_GATEKEEPER_CHECK`, and otherwise stays idle instead of failing forever
  on projects without that script.
- **Added:** `PI_GATEKEEPER_TIMEOUT_MS`, a README, a LICENSE and a changelog.
- **Added:** `pi.image` gallery preview (`assets/card.jpg`) and a terminal transcript image in the
  README for the pi.dev package catalog.

## [2.0.0] - 2026-11-05

- Persistent verification gatekeeper with `session_start` state, `/gate` commands, same-failure
  detection and opt-in auto-rollback.

## [1.0.0]

- Initial deterministic verification gatekeeper.
