import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = process.env.GATEKEEPER_SOURCE ?? join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "index.ts");
/**
 * The extension imports `typebox`, which Pi supplies at runtime. Tests run the
 * extension as real Node code, so a copy has to be resolvable: the repo's own
 * dependency tree (CI, `npm install`) first, then a local Pi installation so the
 * suite runs on a fresh clone without installing anything.
 *
 * Deliberately path-based rather than require.resolve: typebox's "exports" map
 * does not expose ./package.json, so package.json-based resolution throws.
 */
function typeboxCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.GATEKEEPER_TYPEBOX) candidates.push(process.env.GATEKEEPER_TYPEBOX);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    candidates.push(join(dir, "node_modules", "typebox"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox",
    join(homedir(), ".pi", "agent", "npm", "node_modules", "typebox"),
  );
  return candidates;
}

function resolveTypebox(): string {
  for (const candidate of typeboxCandidates()) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new Error("typebox not found. Run `npm install`, or set GATEKEEPER_TYPEBOX to its directory.");
}

const ROOT = mkdtempSync(join(tmpdir(), "gatekeeper-test-"));
mkdirSync(join(ROOT, "node_modules"), { recursive: true });
try {
  symlinkSync(resolveTypebox(), join(ROOT, "node_modules", "typebox"), "dir");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
let seq = 0;

/** Load a fresh copy of the extension so module-level env reads see this test's env. */
async function loadExtension(env: Record<string, string> = {}) {
  const saved = new Map<string, string | undefined>();
  for (const key of ["PI_GATEKEEPER_CHECK", "PI_GATEKEEPER_KIND", "PI_GATEKEEPER_MAX", "PI_GATEKEEPER_ROLLBACK"]) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const copy = join(ROOT, `ext-${seq++}.ts`);
  copyFileSync(SOURCE, copy);
  const mod = await import(copy);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return mod.default as (pi: any) => void;
}

/** A throwaway git repo. */
function repo(files: Record<string, string> = {}, ignored: string[] = []) {
  const dir = mkdtempSync(join(ROOT, "repo-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  if (ignored.length) files[".gitignore"] = ignored.map((i) => `${i}/`).join("\n") + "\n";
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

/** Fake ExtensionAPI: records handlers, commands, tools, messages and appended entries. */
function makePi() {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: any[] = [];
  const entries: any[] = [];
  const execs: Array<{ file: string; args: string[]; cwd: string }> = [];
  const pi = {
    on(event: string, handler: any) {
      handlers.set(event, handler);
      return () => {};
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    sendMessage(message: any) {
      sent.push(message);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    async exec(file: string, args: string[], options: any = {}) {
      execs.push({ file, args, cwd: options.cwd ?? process.cwd() });
      const r = spawnSync(file, args, {
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeout,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        encoding: "utf8",
      });
      return {
        stdout: typeof r.stdout === "string" ? r.stdout : "",
        stderr: typeof r.stderr === "string" ? r.stderr : "",
        code: r.status ?? -1,
        killed: r.status === null,
        truncated: (r.error as any)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      };
    },
  };
  const checkRuns = () => execs.filter((e) => e.file !== "git").length;
  return { pi, handlers, commands, tools, sent, entries, execs, checkRuns };
}

function makeCtx(cwd: string, { branch = [] as any[], hasUI = false, confirmAnswer = true } = {}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      confirm: async () => confirmAnswer,
    },
    hasUI,
    mode: "tui",
    cwd,
    signal: undefined,
    sessionManager: { getBranch: () => branch, getSessionId: () => "testsession" },
  };
  return { ctx, notifications, statuses };
}

const start = (h: Map<string, any>, ctx: any) => h.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
const begin = (h: Map<string, any>, ctx: any) =>
  h.get("before_agent_start")({ type: "before_agent_start", messageType: "user" }, ctx);
const tool = (h: Map<string, any>, ctx: any, toolName: string, input: any = {}) =>
  h.get("tool_call")({ type: "tool_call", toolName, toolCallId: "c1", input }, ctx);
const settle = (h: Map<string, any>, ctx: any) =>
  h.get("agent_before_settle")(
    { type: "agent_before_settle", entries: [], continue: false, context: {}, outcome: "completed" },
    ctx,
  );
const text = (result: any) => result?.entries?.map((e: any) => e.content).filter(Boolean).join("\n") ?? "";

/** /gate on, then have the agent propose a requirement, as the real flow does. */
async function arm(handlers: Map<string, any>, commands: Map<string, any>, tools: Map<string, any>, ctx: any, params: any) {
  await start(handlers, ctx);
  await commands.get("gate").handler("on", ctx);
  return propose(tools, ctx, params);
}

const propose = (tools: Map<string, any>, ctx: any, params: any) =>
  tools.get("gatekeeper_propose_requirement").execute("t1", params, undefined, undefined, ctx);

test("tests resolve typebox from the repo's own tree when it is installed", () => {
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "typebox");
  if (!existsSync(join(local, "package.json"))) return; // no local install, the fallback is in use
  assert.equal(
    readlinkSync(join(ROOT, "node_modules", "typebox")),
    local,
    "the suite must exercise the same dependency tree CI installs",
  );
});

test("the gate is off by default", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, checkRuns } = makePi();
  (await loadExtension())(pi);
  const { ctx, statuses } = makeCtx(dir);

  await start(handlers, ctx);
  assert.ok(
    statuses.some((s) => s.key === "gatekeeper" && s.text === undefined),
    "no status line is shown while the gate is off",
  );

  await begin(handlers, ctx);
  writeFileSync(join(dir, "seed.txt"), "seed\nx\n");
  await tool(handlers, ctx, "write", { path: "seed.txt" });

  assert.equal(await settle(handlers, ctx), undefined);
  assert.equal(checkRuns(), 0, "nothing runs while the gate is off");
});

test("a completion requirement that already passes is rejected", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension())(pi);
  const { ctx } = makeCtx(dir);

  const proposal = await arm(handlers, commands, tools, ctx, {
    kind: "completion",
    command: "test -f seed.txt",
    covers: "that seed.txt exists (already true)",
    doesNotCover: "everything else",
  });

  assert.match(proposal.content[0].text, /REJECTED/);
  assert.match(proposal.content[0].text, /must be FALSE now/);
  assert.ok(handlers.get("agent_before_settle"), "handler still registered");
});

test("a requirement that fails now is accepted, then enforced and cleared", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools, checkRuns } = makePi();
  (await loadExtension())(pi);
  const { ctx } = makeCtx(dir);

  const proposal = await arm(handlers, commands, tools, ctx, {
    kind: "completion",
    command: "test -f done.txt",
    covers: "done.txt exists",
    doesNotCover: "that its contents are correct",
  });
  assert.match(proposal.content[0].text, /ACCEPTED/);
  assert.equal(proposal.details.exitCode, 1, "baseline was measured and was red");

  // Work, then settle: still red, so the gate refuses and continues the run.
  await begin(handlers, ctx);
  writeFileSync(join(dir, "seed.txt"), "seed\nx\n");
  await tool(handlers, ctx, "write", { path: "seed.txt" });
  const first = await settle(handlers, ctx);
  assert.match(text(first), /requirement not satisfied/);
  assert.match(text(first), /done\.txt exists/, "tells the model what the gate verifies");
  assert.equal(first.continue, true);

  // Satisfy it: now the gate lets the run settle.
  writeFileSync(join(dir, "done.txt"), "ok\n");
  await tool(handlers, ctx, "write", { path: "done.txt" });
  assert.equal(await settle(handlers, ctx), undefined, "green requirement settles without injection");
  assert.ok(checkRuns() >= 3);
});

test("enabling the gate attaches the definition step to the next run", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands } = makePi();
  (await loadExtension())(pi);
  const { ctx, notifications } = makeCtx(dir);

  await start(handlers, ctx);
  await commands.get("gate").handler("on", ctx);
  assert.ok(notifications.some((n) => /no completion requirement yet/.test(n.message)));

  const result = await handlers.get("before_agent_start")({ type: "before_agent_start", messageType: "user" }, ctx);
  assert.equal(result?.message?.customType, "gatekeeper-definition");
  // The instruction that makes the requirement concrete.
  assert.match(result.message.content, /FALSE now/);
  assert.match(result.message.content, /gatekeeper_propose_requirement/);
  assert.match(result.message.content, /scope it to the work/i);
  // And the project facts it needs to stop guessing.
  assert.match(result.message.content, /Detected in this project/);
  assert.match(result.message.content, /seed\.txt|package\.json|recognised build/);
});

test("the model cannot define a gate without the operator, nor change an armed one", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension())(pi);
  const { ctx } = makeCtx(dir);

  // Gate off: nothing to define against.
  await start(handlers, ctx);
  const off = await propose(tools, ctx, { kind: "completion", command: "false", covers: "x", doesNotCover: "y" });
  assert.match(off.content[0].text, /gatekeeper is off/i);

  // Armed: an armed requirement is the operator's, not the model's, to replace.
  await arm(handlers, commands, tools, ctx, { kind: "completion", command: "test -f done.txt", covers: "done.txt exists", doesNotCover: "its contents" });
  const armed = await propose(tools, ctx, { kind: "completion", command: "true", covers: "something weaker", doesNotCover: "nothing" });
  assert.match(armed.content[0].text, /already armed/);
});

test("a regression requirement must be green at baseline", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension())(pi);
  const { ctx } = makeCtx(dir);

  const proposal = await arm(handlers, commands, tools, ctx, {
    kind: "regression",
    command: "false",
    covers: "an invariant",
    doesNotCover: "nothing",
  });
  assert.match(proposal.content[0].text, /REJECTED/);
  assert.match(proposal.content[0].text, /must be TRUE now/);
});

test("commands that cannot fail are refused", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension())(pi);
  const { ctx } = makeCtx(dir);

  const proposal = await arm(handlers, commands, tools, ctx, {
    kind: "completion",
    command: "true",
    covers: "nothing",
    doesNotCover: "everything",
  });
  assert.match(proposal.content[0].text, /REJECTED/);
  assert.match(proposal.content[0].text, /cannot fail/);
});

test("the operator can decline an otherwise valid requirement", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension())(pi);
  const { ctx } = makeCtx(dir, { hasUI: true, confirmAnswer: false });

  const proposal = await arm(handlers, commands, tools, ctx, {
    kind: "completion",
    command: "test -f done.txt",
    covers: "done.txt exists",
    doesNotCover: "its contents",
  });
  assert.match(proposal.content[0].text, /operator declined/);
});

test("enabled with no requirement verifies nothing and says so", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, checkRuns } = makePi();
  (await loadExtension())(pi);
  const branch = [{ type: "custom", customType: "gatekeeper-state", data: { enabled: true, requirement: null, snapshot: null, verdict: null } }];
  const { ctx, notifications, statuses } = makeCtx(dir, { branch });

  await start(handlers, ctx);
  assert.ok(statuses.some((s) => s.text === "gate: NEEDS REQUIREMENT"), "state is unmistakable");
  assert.ok(notifications.some((n) => /verifies nothing/.test(n.message)));

  await begin(handlers, ctx);
  writeFileSync(join(dir, "seed.txt"), "seed\nx\n");
  await tool(handlers, ctx, "write", { path: "seed.txt" });
  assert.equal(await settle(handlers, ctx), undefined);
  assert.equal(checkRuns(), 0, "an undefined gate must never claim anything");

  await handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, ctx);
  assert.ok(notifications.some((n) => /verified nothing/.test(n.message)));
});

test("a failing gate always re-runs the requirement", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools, checkRuns } = makePi();
  (await loadExtension())(pi);
  const { ctx } = makeCtx(dir);

  await arm(handlers, commands, tools, ctx, { kind: "completion", command: "false", covers: "always fails", doesNotCover: "nothing" });
  await begin(handlers, ctx);
  writeFileSync(join(dir, "seed.txt"), "seed\nx\n");
  await tool(handlers, ctx, "write", { path: "seed.txt" });

  const first = await settle(handlers, ctx);
  assert.match(text(first), /attempt 1/);
  const afterFirst = checkRuns();
  const second = await settle(handlers, ctx);
  assert.match(text(second), /attempt 2/);
  assert.equal(checkRuns(), afterFirst + 1, "the requirement is re-run, not assumed");
});

test("an invalid PI_GATEKEEPER_MAX cannot disable the cap", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension({ PI_GATEKEEPER_MAX: "abc" }))(pi);
  const { ctx, notifications } = makeCtx(dir);

  await arm(handlers, commands, tools, ctx, { kind: "completion", command: "false", covers: "always fails", doesNotCover: "nothing" });
  await begin(handlers, ctx);
  writeFileSync(join(dir, "seed.txt"), "seed\nx\n");
  await tool(handlers, ctx, "write", { path: "seed.txt" });

  let messages = 0;
  for (let i = 0; i < 40; i++) if (await settle(handlers, ctx)) messages++;
  assert.equal(messages, 12);
  assert.ok(notifications.some((n) => /letting the run settle/.test(n.message)));
});

test("PI_GATEKEEPER_ENABLE turns the gate on and leaves the definition to the agent", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers } = makePi();
  (await loadExtension({ PI_GATEKEEPER_ENABLE: "1" }))(pi);
  const { ctx, statuses } = makeCtx(dir);

  await start(handlers, ctx);
  assert.ok(statuses.some((s) => s.text === "gate: NEEDS REQUIREMENT"), "on, and honest about being undefined");
  const result = await begin(handlers, ctx);
  assert.equal(result?.message?.customType, "gatekeeper-definition");
});

test("a pre-declared env requirement is validated on first use", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers } = makePi();
  (await loadExtension({ PI_GATEKEEPER_CHECK: "true", PI_GATEKEEPER_KIND: "completion" }))(pi);
  const { ctx, notifications } = makeCtx(dir);

  await start(handlers, ctx);
  await begin(handlers, ctx);
  writeFileSync(join(dir, "seed.txt"), "seed\nx\n");
  await tool(handlers, ctx, "write", { path: "seed.txt" });
  assert.equal(await settle(handlers, ctx), undefined, "a green completion requirement is rejected, not enforced");
  assert.ok(notifications.some((n) => /already passing/.test(n.message)));
});

test("auto-rollback re-verifies the requirement instead of claiming success", async () => {
  const dir = repo({ "seed.txt": "original\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension({ PI_GATEKEEPER_ROLLBACK: "1" }))(pi);
  const { ctx } = makeCtx(dir);

  await arm(handlers, commands, tools, ctx, { kind: "completion", command: "false", covers: "always fails", doesNotCover: "nothing" });
  await begin(handlers, ctx);
  writeFileSync(join(dir, "seed.txt"), "original\nx\n");
  await tool(handlers, ctx, "edit", { path: "seed.txt" });

  let last = "";
  for (let i = 0; i < 4; i++) last = text(await settle(handlers, ctx));
  assert.match(last, /same failure has occurred 4 times/);

  const rollback = text(await settle(handlers, ctx));
  assert.equal(readFileSync(join(dir, "seed.txt"), "utf8"), "original\n");
  assert.match(rollback, /still fails after the revert/);
  assert.doesNotMatch(rollback, /satisfied again/);

  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
  const refs = execFileSync("git", ["for-each-ref", "refs/pi-gatekeeper", "--format=%(refname)"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(refs, "", "the per-session snapshot ref is removed on quit");
});

test("/gate status reports the requirement, its scope and its baseline", async () => {
  const dir = repo({ "seed.txt": "seed\n" });
  const { pi, handlers, commands, tools } = makePi();
  (await loadExtension())(pi);
  const { ctx, notifications } = makeCtx(dir);

  await arm(handlers, commands, tools, ctx, {
    kind: "completion",
    command: "test -f done.txt",
    covers: "done.txt exists",
    doesNotCover: "its contents",
  });
  await commands.get("gate").handler("status", ctx);
  const report = notifications.map((n) => n.message).join("\n");
  assert.match(report, /gate: armed — completion/);
  assert.match(report, /covers:\s+done\.txt exists/);
  assert.match(report, /excludes:\s+its contents/);
  assert.match(report, /baseline: exit 1/);
  assert.ok(existsSync(dir));
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
