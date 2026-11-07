import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * pi-gatekeeper — veto power, not knowledge.
 *
 * The gate never decides that work is finished. It only decides which claims
 * cannot be made: it runs one executable completion requirement and refuses to
 * let the run settle while that requirement is false.
 *
 * A gate is therefore only as good as its requirement, so the package does not
 * guess one. The operator enables the gate, the agent investigates the project
 * and proposes a requirement, and the gatekeeper validates the proposal
 * mechanically before arming it.
 */

type Kind = "completion" | "regression";

interface Baseline {
  exitCode: number;
  outputTail: string;
  durationMs: number;
  /** Working-tree fingerprint the baseline was measured against. */
  tree: string;
  at: string;
}

interface Requirement {
  kind: Kind;
  /** Executable, non-interactive, idempotent. Run through the platform shell. */
  command: string;
  /** Directory the command runs in — the scope it actually verifies. */
  cwd: string;
  /** What a green run proves. */
  covers: string;
  /** What a green run does NOT prove. Stated by the author, not inferred. */
  doesNotCover: string;
  /** Measured when the requirement was accepted; null for pre-declared ones. */
  baseline: Baseline | null;
  definedAt: string;
  source: "agent" | "operator";
  approvedBy?: "user";
}

interface Snapshot {
  root: string;
  ref: string;
  commit?: string;
  untracked: string[];
}

interface Persisted {
  enabled: boolean;
  requirement: Requirement | null;
  snapshot: Snapshot | null;
  verdict: Verdict | null;
}

interface Verdict {
  exitCode: number;
  tree: string;
  at: string;
  durationMs: number;
}

const ENTRY_TYPE = "gatekeeper-state";
const REF_PREFIX = "refs/pi-gatekeeper/snapshot";

const ENV_CHECK = process.env.PI_GATEKEEPER_CHECK?.trim() || null;
const ENV_KIND: Kind = process.env.PI_GATEKEEPER_KIND === "regression" ? "regression" : "completion";
/** Turn the gate on for this run without pre-declaring a command: the agent defines the requirement. */
const ENV_ENABLE = process.env.PI_GATEKEEPER_ENABLE === "1";
const AUTO_ROLLBACK = process.env.PI_GATEKEEPER_ROLLBACK === "1";
const NUDGE_AT = 3;
const ROLLBACK_AT = 5;
const ERROR_TAIL = 4000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_PROPOSALS = 8;
const IS_WIN = process.platform === "win32";

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

const MAX_TOTAL = positiveInt(process.env.PI_GATEKEEPER_MAX, 12);
const TIMEOUT_MS = positiveInt(process.env.PI_GATEKEEPER_TIMEOUT_MS, 5 * 60_000);
const DEFINE_TIMEOUT_MS = positiveInt(process.env.PI_GATEKEEPER_DEFINE_TIMEOUT_MS, 10 * 60_000);

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\u0000/g, "");
const tail = (s: string, n = ERROR_TAIL) => (s.length > n ? "…" + s.slice(-n) : s);
const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const signatureOf = (s: string) => sha(s.replace(/\d+/g, "N").replace(/\s+/g, " ").slice(-2000));
const refForSession = (ctx: ExtensionContext) =>
  `${REF_PREFIX}/${String(ctx.sessionManager.getSessionId()).replace(/[^A-Za-z0-9._-]/g, "-")}`;

/** Commands that are never a completion requirement, however the agent phrases them. */
const NOT_A_GATE = /^\s*(true|:|echo\b|cat\b|ls\b|pwd\b|git status|printf\b)/;

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let requirement: Requirement | null = null;
  let verdict: Verdict | null = null;
  let snapshot: Snapshot | null = null;

  // A definition window is simply "enabled with no requirement yet". The model
  // can propose then, and never after: an armed gate is not the model's to change.
  let proposals = 0;

  // Per-task state, reset on every user prompt.
  let baselineFp: string | null = null;
  let touched = false;
  let lastPassed = true;
  let lastError = "";
  let lastSig = "";
  let sameFailures = 0;
  let totalFailures = 0;
  let gaveUp = false;
  let noticedMissing = false;

  const save = () =>
    pi.appendEntry(ENTRY_TYPE, { enabled, requirement, snapshot, verdict } satisfies Persisted);

  const git = (args: string[], cwd: string, signal?: AbortSignal) =>
    pi.exec("git", args, { cwd, signal, timeout: 30_000 });

  async function fingerprint(cwd: string, signal?: AbortSignal): Promise<string | null> {
    const top = await git(["rev-parse", "--show-toplevel"], cwd, signal);
    if (top.code !== 0) return null;
    const root = top.stdout.trim();
    const st = await git(["status", "--porcelain=v1", "-uall"], root, signal);
    const df = await git(["diff", "HEAD"], root, signal);
    return sha(st.stdout + "\0" + df.stdout);
  }

  async function takeSnapshot(ctx: ExtensionContext): Promise<Snapshot | null> {
    const { cwd, signal } = ctx;
    const top = await git(["rev-parse", "--show-toplevel"], cwd, signal);
    if (top.code !== 0) return null;
    const root = top.stdout.trim();
    let ref = (await git(["stash", "create"], root, signal)).stdout.trim();
    if (!ref) {
      const head = await git(["rev-parse", "HEAD"], root, signal);
      if (head.code !== 0) return null;
      ref = head.stdout.trim();
    }
    const refName = refForSession(ctx);
    if ((await git(["update-ref", refName, ref], root, signal)).code !== 0) return null;
    const commit = (await git(["rev-parse", refName], root, signal)).stdout.trim();
    const others = await git(["ls-files", "--others", "--exclude-standard"], root, signal);
    return { root, ref: refName, commit, untracked: others.stdout.split("\n").filter(Boolean) };
  }

  async function restore(ctx: ExtensionContext): Promise<{ ok: boolean; message: string }> {
    if (!snapshot) return { ok: false, message: "No snapshot available (not a git repo, or none taken yet)." };
    const { root, ref, commit, untracked } = snapshot;
    if ((await git(["rev-parse", "--verify", "--quiet", ref], root, ctx.signal)).code !== 0) {
      return { ok: false, message: `Snapshot ${ref} is gone from the repository (gatekeeper refs are removed when a session quits).` };
    }
    const r = await git(["restore", "--source", ref, "--staged", "--worktree", "--", "."], root, ctx.signal);
    if (r.code !== 0) return { ok: false, message: `Rollback failed: ${tail(r.stderr.trim(), 500)}` };
    const now = await git(["ls-files", "--others", "--exclude-standard"], root, ctx.signal);
    const added = now.stdout.split("\n").filter(Boolean).filter((f) => !untracked.includes(f));
    return {
      ok: true,
      message:
        `Restored tracked files to the state before this task (${commit?.slice(0, 8) ?? "snapshot"}).` +
        (added.length ? ` Files created since were left in place: ${added.join(", ")}. They are NOT part of the restore.` : ""),
    };
  }

  interface RunResult {
    exitCode: number;
    output: string;
    durationMs: number;
    timedOut: boolean;
    notFound: boolean;
  }

  /** Run a candidate command. Used for both proposals and enforcement, so the baseline is real evidence. */
  async function runCommand(
    ctx: ExtensionContext,
    command: string,
    cwd: string,
    timeoutMs = TIMEOUT_MS,
  ): Promise<RunResult> {
    const [file, args] = IS_WIN ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["bash", ["-c", command]];
    const started = Date.now();
    const r = await pi.exec(file, args, { cwd, signal: ctx.signal, timeout: timeoutMs, maxBuffer: MAX_BUFFER });
    const durationMs = Date.now() - started;
    const output = tail(stripAnsi(`${r.stdout}\n${r.stderr}`).trim());
    const timedOut = r.killed && !r.truncated;
    const notFound =
      r.code === 127 ||
      /command not found|not recognized as an internal or external command|No such file or directory/i.test(output);
    return { exitCode: r.code, output, durationMs, timedOut, notFound };
  }

  const resetTask = () => {
    touched = false;
    lastPassed = true;
    lastError = "";
    lastSig = "";
    sameFailures = 0;
    totalFailures = 0;
    gaveUp = false;
  };

  const resetFailures = () => {
    lastPassed = true;
    lastError = "";
    lastSig = "";
    sameFailures = 0;
    totalFailures = 0;
  };

  // No status line at all while the gate is off: an inert gate should not take up
  // space in the footer. undefined clears the entry.
  const status = (ctx: ExtensionContext) =>
    ctx.ui.setStatus(
      "gatekeeper",
      !enabled
        ? undefined
        : !requirement
          ? "gate: NEEDS REQUIREMENT"
          : `gate: ${requirement.kind === "completion" ? "armed" : "guard"} (${shortCmd(requirement.command)})`,
    );

  const shortCmd = (c: string) => (c.length > 28 ? c.slice(0, 27) + "…" : c);

  const gateEntry = <E,>(entries: E[], content: string) => ({
    entries: [...entries, { type: "custom_message" as const, customType: "gatekeeper", content, display: true }],
    continue: true as const,
  });

  /** Project facts the agent needs to propose something concrete, not a guess. */
  function projectFacts(cwd: string): string[] {
    const facts: string[] = [];
    const read = (p: string) => {
      try {
        return readFileSync(join(cwd, p), "utf8");
      } catch {
        return null;
      }
    };
    const pkg = read("package.json");
    if (pkg) {
      try {
        const scripts = Object.keys(JSON.parse(pkg).scripts ?? {});
        if (scripts.length) facts.push(`package.json scripts: ${scripts.join(", ")}`);
      } catch {
        facts.push("package.json is present but unreadable");
      }
    }
    if (existsSync(join(cwd, "gradlew"))) facts.push("Gradle wrapper present (./gradlew …)");
    if (existsSync(join(cwd, "Package.swift"))) facts.push("SwiftPM package (swift test / swift build)");
    if (existsSync(join(cwd, "Cargo.toml"))) facts.push("Cargo project (cargo test / cargo build)");
    if (existsSync(join(cwd, "go.mod"))) facts.push("Go module (go test ./... / go build ./...)");
    if (existsSync(join(cwd, "pyproject.toml"))) facts.push("pyproject.toml (pytest / ruff)");
    if (existsSync(join(cwd, "Makefile"))) facts.push("Makefile present (make <target>)");
    if (existsSync(join(cwd, "Gemfile"))) facts.push("Gemfile (bundle exec rake test)");
    for (const dir of ["ios", "android", "app"]) {
      if (existsSync(join(cwd, dir))) facts.push(`subdirectory: ${dir}/`);
    }
    if (!facts.length) facts.push("no recognised build or test entry point at this level");
    return facts;
  }

  function definitionPrompt(ctx: ExtensionContext): string {
    const facts = projectFacts(ctx.cwd).map((f) => `  - ${f}`).join("\n");
    return [
      "[gatekeeper] The gatekeeper is enabled, but it has no completion requirement, so it currently",
      "verifies nothing. It needs one executable command that is FALSE now and becomes TRUE only when",
      "the work ahead is actually done. Until one is accepted, the gate cannot keep you working.",
      "",
      "Before continuing with anything else:",
      "",
      "1. Investigate just enough to know how this project proves things to itself — where the real",
      "   tests and acceptance paths are, and what evidence counts.",
      "2. Write ONE command that fails today and passes only when the work ahead is complete.",
      "   Scope it to the work, not the whole repo. If the task is one step of a migration, the",
      "   command must exercise that step — not a repo-wide typecheck that is already green.",
      "3. Prefer the project's own acceptance path over a bespoke grep. It must be non-interactive,",
      "   idempotent, and finish in a couple of minutes.",
      "4. State plainly what it covers and what it does not cover. Do not overclaim.",
      "5. Call gatekeeper_propose_requirement with the command, its scope, and those two statements.",
      "",
      "The gatekeeper runs your proposal and checks its baseline. If it is rejected — already passing,",
      "not executable, too slow, or the operator declines — revise it and propose again. Never weaken a",
      "command just to make it pass, and never narrow the claim in the covers field to match a weak test.",
      "",
      "Detected in this project:",
      facts,
    ].join("\n");
  }

  // ---------------------------------------------------------------- the tool

  pi.registerTool({
    name: "gatekeeper_propose_requirement",
    label: "Propose gatekeeper requirement",
    description:
      "Propose the executable completion requirement the gatekeeper will enforce. The gatekeeper runs it immediately and checks its baseline. Use only when a definition is in progress.",
    promptSnippet: "Propose the gatekeeper's executable completion requirement",
    promptGuidelines: [
      "Only call gatekeeper_propose_requirement while the gatekeeper has asked for a requirement.",
      "A completion requirement must fail right now; one that already passes cannot gate incomplete work.",
    ],
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("completion"), Type.Literal("regression")], {
        description:
          "completion: false now, must become true. regression: true now, must stay true (an invariant).",
      }),
      command: Type.String({ description: "Executable, non-interactive shell command that proves the claim." }),
      cwd: Type.Optional(Type.String({ description: "Directory to run in. Defaults to the session directory." })),
      covers: Type.String({ description: "Exactly what a green run proves." }),
      doesNotCover: Type.String({ description: "What a green run does not prove. Be specific." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reject = (reason: string, hint: string) => ({
        content: [{ type: "text" as const, text: `REJECTED: ${reason}\n\n${hint}` }],
        details: { accepted: false, reason },
      });

      if (!enabled || requirement) {
        return reject(
          requirement ? "A requirement is already armed." : "The gatekeeper is off.",
          requirement
            ? "An armed requirement is not the model's to change. The operator must run /gate define to replace it."
            : "Nothing is being gated. The operator must run /gate on first.",
        );
      }
      if (proposals >= MAX_PROPOSALS) {
        return reject(
          `Gave up after ${MAX_PROPOSALS} proposals.`,
          "Stop proposing. Tell the operator the gate could not be defined and suggest PI_GATEKEEPER_CHECK with an explicit command.",
        );
      }
      proposals += 1;

      const command = params.command.trim();
      const cwd = params.cwd?.trim() || ctx.cwd;
      if (!command) return reject("Empty command.", "Provide an executable command.");
      if (NOT_A_GATE.test(command)) {
        return reject(
          "That command cannot fail, so it cannot gate anything.",
          "Propose a command that exercises real behaviour and fails when the work is not done.",
        );
      }
      if (!existsSync(cwd)) return reject(`Directory does not exist: ${cwd}`, "Use an existing directory.");

      const run = await runCommand(ctx, command, cwd, DEFINE_TIMEOUT_MS);
      const red = run.exitCode !== 0;
      const tree = (await fingerprint(cwd, ctx.signal)) ?? "unknown";

      if (run.timedOut) {
        return reject(
          `Timed out after ${DEFINE_TIMEOUT_MS / 1000}s.`,
          "Propose something that finishes in a couple of minutes, or split the claim.",
        );
      }
      if (run.notFound) {
        return reject(
          `Not executable (exit ${run.exitCode}).`,
          `Output was:\n${run.output.slice(-600)}\n\nUse a command that exists in this project.`,
        );
      }
      if (params.kind === "completion" && !red) {
        return reject(
          "A completion requirement must be FALSE now, and this one already passes.",
          "It proves nothing about the work ahead: green today means the gate can never tell whether you finished. " +
            "Propose a command that fails right now and will pass only when this task is done.",
        );
      }
      if (params.kind === "regression" && red) {
        return reject(
          "A regression requirement must be TRUE now (it asserts an invariant that must not break), and this one already fails.",
          "Either propose a passing invariant, or propose it as kind: \"completion\" if the fix is part of the work.",
        );
      }

      const proposed: Requirement = {
        kind: params.kind,
        command,
        cwd,
        covers: params.covers.trim(),
        doesNotCover: params.doesNotCover.trim(),
        baseline: { exitCode: run.exitCode, outputTail: run.output.slice(-600), durationMs: run.durationMs, tree, at: new Date().toISOString() },
        definedAt: new Date().toISOString(),
        source: "agent",
      };

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Arm the gatekeeper?",
          [
            `${params.kind === "completion" ? "Completion" : "Regression"} requirement`,
            `command: ${command}`,
            `scope:   ${cwd}`,
            `baseline: exit ${run.exitCode} in ${(run.durationMs / 1000).toFixed(1)}s (${params.kind === "completion" ? "must be red, is red" : "must be green, is green"})`,
            "",
            `covers:         ${proposed.covers}`,
            `does not cover: ${proposed.doesNotCover}`,
          ].join("\n"),
        );
        if (!ok) {
          return reject("The operator declined this requirement.", "Ask what they want it to prove, then propose a revised command.");
        }
        proposed.approvedBy = "user";
      }

      requirement = proposed;
      verdict = null;
      save();
      status(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `ACCEPTED. The gatekeeper will now refuse to let the run settle while this requirement fails.\n\n` +
              `command: ${command}\nscope: ${cwd}\nbaseline: exit ${run.exitCode} (measured, ${(run.durationMs / 1000).toFixed(1)}s)\n\n` +
              `Now do the work. It is verified when: ${proposed.covers}`,
          },
        ],
        details: { accepted: true, exitCode: run.exitCode, durationMs: run.durationMs },
      };
    },
  });

  // ------------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    enabled = false;
    requirement = null;
    verdict = null;
    snapshot = null;
    let sawPersisted = false;
    noticedMissing = false;
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      if (e.type === "custom" && e.customType === ENTRY_TYPE) {
        const d = e.data as Persisted;
        enabled = d.enabled ?? false;
        requirement = d.requirement ?? null;
        snapshot = d.snapshot ?? null;
        verdict = d.verdict ?? null;
        sawPersisted = true;
      }
    }
    // The operator declared a command (or asked for the gate) for this run, so the
    // gate is on unless a persisted /gate off says otherwise.
    if ((ENV_CHECK || ENV_ENABLE) && !sawPersisted) enabled = true;
    if (ENV_CHECK && !requirement) {
      requirement = {
        kind: ENV_KIND,
        command: ENV_CHECK,
        cwd: ctx.cwd,
        covers: "(pre-declared via PI_GATEKEEPER_CHECK; baseline not yet measured)",
        doesNotCover: "(not stated)",
        baseline: null,
        definedAt: new Date().toISOString(),
        source: "operator",
      };
    }
    resetTask();
    status(ctx);
    if (enabled && !requirement) {
      ctx.ui.notify(
        "Gatekeeper is enabled but has no completion requirement, so it verifies nothing. Run /gate define.",
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "quit" || !snapshot) return;
    await git(["update-ref", "-d", snapshot.ref], snapshot.root).catch(() => {});
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    resetTask();
    if (!enabled) return;
    snapshot = await takeSnapshot(ctx);
    baselineFp = await fingerprint(ctx.cwd, ctx.signal);
    save();
    // No requirement yet: this run IS the definition step. Attach the instruction
    // to the run the operator just started rather than spawning a run of our own
    // (a command-triggered turn races with session teardown in non-interactive modes).
    if (!requirement) {
      return {
        message: { customType: "gatekeeper-definition", content: definitionPrompt(ctx), display: true },
      };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!enabled || requirement || noticedMissing) return;
    noticedMissing = true;
    ctx.ui.notify("The run ended with no completion requirement defined — the gate verified nothing.", "warning");
    status(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (!enabled) return;
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") touched = true;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!enabled || !requirement || gaveUp) return;

    // A pre-declared requirement (env var) is validated on first use, against the
    // same baseline rule an agent proposal must satisfy.
    if (!requirement.baseline) {
      const probe = await runCommand(ctx, requirement.command, requirement.cwd, DEFINE_TIMEOUT_MS);
      const red = probe.exitCode !== 0;
      if (probe.timedOut || probe.notFound || (requirement.kind === "completion" && !red) || (requirement.kind === "regression" && red)) {
        requirement = null;
        save();
        status(ctx);
        ctx.ui.notify(
          `PI_GATEKEEPER_CHECK rejected: ${probe.timedOut ? "timed out" : probe.notFound ? "not executable" : red ? "already failing (regression)" : "already passing (completion)"}. Run /gate define.`,
          "error",
        );
        return;
      }
      requirement.baseline = {
        exitCode: probe.exitCode,
        outputTail: probe.output.slice(-600),
        durationMs: probe.durationMs,
        tree: (await fingerprint(requirement.cwd, ctx.signal)) ?? "unknown",
        at: new Date().toISOString(),
      };
      // Replace the pre-declaration placeholders with what we now know, so the
      // messages the agent receives never quote "not yet measured" at it.
      requirement.covers = `the operator-declared command (baseline exit ${probe.exitCode}, measured)`;
      requirement.doesNotCover = "not stated — pre-declared via PI_GATEKEEPER_CHECK without a coverage statement";
      save();
    }

    const fp = await fingerprint(ctx.cwd, ctx.signal);
    const changed = fp === null ? touched : fp !== baselineFp || touched;
    if (!changed && lastPassed) return;

    const res = await runCommand(ctx, requirement.command, requirement.cwd);
    if (ctx.signal?.aborted) return;

    baselineFp = fp;
    touched = false;

    if (res.exitCode === 0 && !res.timedOut) {
      resetFailures();
      verdict = {
        exitCode: 0,
        tree: (await fingerprint(requirement.cwd, ctx.signal)) ?? "unknown",
        at: new Date().toISOString(),
        durationMs: res.durationMs,
      };
      save();
      ctx.ui.notify(`Gate passed (${verdict.tree.slice(0, 8)}, ${(res.durationMs / 1000).toFixed(1)}s)`, "info");
      return;
    }

    const output = res.timedOut
      ? `Timed out after ${TIMEOUT_MS / 1000}s. Look for a hanging process or watch mode.`
      : res.output;
    const sig = res.timedOut ? "timeout" : signatureOf(output);
    sameFailures = sig === lastSig ? sameFailures + 1 : 1;
    totalFailures += 1;
    lastSig = sig;
    lastPassed = false;
    lastError = output;

    if (totalFailures > MAX_TOTAL) {
      gaveUp = true;
      ctx.ui.notify(`Gate still failing after ${MAX_TOTAL} attempts; letting the run settle.`, "error");
      return;
    }

    let guidance =
      `Gatekeeper: requirement not satisfied (\`${requirement.command}\`, attempt ${totalFailures}). ` +
      `It verifies: ${requirement.covers} Fix the cause below, then finish.`;
    if (sameFailures >= NUDGE_AT) {
      guidance =
        `The same failure has occurred ${sameFailures} times; your recent edits are not fixing it. ` +
        `Stop patching. Re-read the error, state the root cause in one sentence, and try a materially different approach. ` +
        `Weakening or deleting the check is not a fix.`;
    }

    if (sameFailures >= ROLLBACK_AT && AUTO_ROLLBACK) {
      const r = await restore(ctx);
      baselineFp = await fingerprint(ctx.cwd, ctx.signal);
      touched = false;
      if (r.ok) {
        const after = await runCommand(ctx, requirement.command, requirement.cwd);
        if (after.exitCode === 0 && !after.timedOut) {
          resetFailures();
          return gateEntry(event.entries, `${r.message}\nThe requirement is satisfied again. Re-apply the task with a different approach; do not repeat the previous one.`);
        }
        sameFailures = 1;
        lastSig = after.timedOut ? "timeout" : signatureOf(after.output);
        lastError = after.output;
        return gateEntry(
          event.entries,
          `${r.message}\nThe requirement still fails after the revert, so the failure is in the pre-task state or in a file the revert left behind. Start again with a different approach.\n\n${after.output}`,
        );
      }
      guidance += ` Automatic rollback was not possible: ${r.message}`;
    }

    if (sameFailures >= ROLLBACK_AT && !AUTO_ROLLBACK) {
      guidance += ` Consider reverting your own changes and restarting the approach from scratch.`;
    }

    return gateEntry(event.entries, `${guidance}\n\n${lastError}`);
  });

  // -------------------------------------------------------------- commands

  pi.registerCommand("gate", {
    description: "Gatekeeper: /gate on | off | define | status | verify | rollback",
    getArgumentCompletions: (prefix: string) => {
      const items = ["on", "off", "define", "status", "verify", "rollback"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim().split(/\s+/)[0] || "status";
      switch (cmd) {
        case "on":
          enabled = true;
          save();
          status(ctx);
          ctx.ui.notify(
            requirement
              ? `Gatekeeper armed: ${requirement.covers}`
              : "Gatekeeper on — it has no completion requirement yet, so the next task will ask the agent to define one.",
            "info",
          );
          return;
        case "off":
          enabled = false;
          save();
          status(ctx);
          ctx.ui.notify("Gatekeeper disabled.", "info");
          return;
        case "define":
          if (!enabled) {
            ctx.ui.notify("Gatekeeper is off. Run /gate on first.", "warning");
            return;
          }
          requirement = null;
          verdict = null;
          proposals = 0;
          resetTask();
          save();
          status(ctx);
          ctx.ui.notify("Requirement cleared. The next task will ask the agent to define a new one.", "info");
          return;
        case "verify": {
          if (!requirement) {
            ctx.ui.notify("Gatekeeper has no completion requirement. Run /gate define.", "warning");
            return;
          }
          const res = await runCommand(ctx, requirement.command, requirement.cwd);
          const green = res.exitCode === 0 && !res.timedOut;
          if (green) resetFailures();
          ctx.ui.notify(
            green
              ? `Requirement satisfied in ${(res.durationMs / 1000).toFixed(1)}s.`
              : `Requirement NOT satisfied (exit ${res.timedOut ? "timeout" : res.exitCode}):\n${tail(res.output, 1200)}`,
            green ? "info" : "error",
          );
          return;
        }
        case "rollback": {
          if (ctx.hasUI && !(await ctx.ui.confirm("Rollback", "Restore tracked files to the pre-task snapshot?"))) return;
          const r = await restore(ctx);
          if (!r.ok) {
            ctx.ui.notify(r.message, "error");
            return;
          }
          baselineFp = await fingerprint(ctx.cwd, ctx.signal);
          touched = false;
          if (requirement) {
            const after = await runCommand(ctx, requirement.command, requirement.cwd);
            const green = after.exitCode === 0 && !after.timedOut;
            if (green) resetFailures();
            else {
              lastPassed = false;
              lastError = after.output;
            }
            ctx.ui.notify(
              `${r.message}\nRequirement is ${green ? "satisfied" : "still NOT satisfied"} on the restored tree.`,
              "info",
            );
          } else {
            ctx.ui.notify(r.message, "info");
          }
          return;
        }
        default: {
          if (!enabled) {
            ctx.ui.notify("gate off", "info");
            return;
          }
          if (!requirement) {
            ctx.ui.notify("gate: NEEDS REQUIREMENT — run /gate define. Nothing is being verified.", "warning");
            return;
          }
          ctx.ui.notify(
            [
              `gate: armed — ${requirement.kind}`,
              `command:  ${requirement.command}`,
              `scope:    ${requirement.cwd}`,
              `covers:   ${requirement.covers}`,
              `excludes: ${requirement.doesNotCover}`,
              `baseline: exit ${requirement.baseline?.exitCode} at ${requirement.baseline?.at}`,
              `failures: ${totalFailures}/${MAX_TOTAL} (identical: ${sameFailures})`,
              `last pass: ${verdict ? `${verdict.tree.slice(0, 8)} at ${verdict.at}` : "none"}`,
              `rollback: ${AUTO_ROLLBACK ? "on" : "off"} | snapshot: ${snapshot?.commit?.slice(0, 8) ?? "none"}`,
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });
}
