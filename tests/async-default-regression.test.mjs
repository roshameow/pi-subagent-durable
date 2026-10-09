// Real registered subagent.execute routing, with runner/discovery adapters only.
// Does NOT prove child transport/lifecycle behavior: no real worker is launched.
// All bundled child_process imports are fail-closed, including transitive ones.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "durable-async-default-")));
const envNames = ["PI_SUBAGENT_TASK_ID", "PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH", "PI_AGENT_NOTIFY_DIR", "PI_SUBAGENT_CONFIRM_PROJECT"];
const oldEnv = new Map(envNames.map(name => [name, process.env[name]]));
for (const name of envNames) delete process.env[name];
process.env.PI_AGENT_NOTIFY_DIR = path.join(root, "notify");
process.env.PI_SUBAGENT_DEPTH = "0";
const globalNames = Object.getOwnPropertyNames(globalThis);
const fixtureKey = "__asyncDefaultRegressionFixture";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const defaults = { model: "fixture/model", thinkingLevel: "high", contextWindow: 1000000 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`timed out: ${label}`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
function replaceOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
  assert.equal(matches.length, 1, `fixture must replace exactly one ${label}`);
  return source.replace(pattern, replacement);
}
function result(call, output = `output:${call.task}`, exitCode = 0) {
  return {
    agent: call.agent, agentSource: "user", task: call.task, step: call.step,
    exitCode, stderr: exitCode ? output : "", usage: { ...usage },
    messages: [{ role: "assistant", content: [{ type: "text", text: output }], stopReason: "end" }],
  };
}
function newState() {
  const state = { asyncCalls: [], syncCalls: [], pending: [], waiters: [], nextId: 0 };
  state.started = count => state.syncCalls.length >= count ? Promise.resolve() : new Promise(resolve => state.waiters.push({ count, resolve }));
  state.async = async (cwd, dispatch, _agents, agent, task) => {
    const id = `task-fixture-${++state.nextId}`;
    state.asyncCalls.push({ cwd, dispatch, agent, task, id });
    // Return an admission ID, never a completed worker result.
    return id;
  };
  state.sync = async (cwd, dispatch, _agents, agent, task, workdir, step, signal, onUpdate, makeDetails) => {
    const call = { cwd, dispatch, agent, task, workdir, step, signal, onUpdate, makeDetails };
    const gate = deferred();
    state.syncCalls.push(call); state.pending.push({ call, gate });
    for (const waiter of state.waiters) if (state.syncCalls.length >= waiter.count) waiter.resolve();
    return gate.promise;
  };
  return state;
}

const original = fs.readFileSync(path.join(repo, "extensions/index.ts"), "utf8");
// Preserve the production execute, schema, helper callsite and concurrency mapper.
let adapted = replaceOnce(original,
  /function dispatchDefaultsFromContext\([\s\S]*?\n}\n\nfunction appendInheritedContextExtension/,
  `function dispatchDefaultsFromContext(_ctx: any): DispatchDefaults { return ${JSON.stringify(defaults)}; }\n\nfunction appendInheritedContextExtension`, "dispatch defaults");
adapted = replaceOnce(adapted,
  /async function runSingleAgent\([\s\S]*?\n}\n\nconst TaskItem/,
  `async function runSingleAgent(...args: any[]): Promise<any> { return (globalThis as any).${fixtureKey}.sync(...args); }\n\nconst TaskItem`, "sync runner");
adapted = replaceOnce(adapted,
  /\tconst runAsyncSingleAgent = async \([\s\S]*?\n\tconst reloadTask = async \(/,
  `\tconst runAsyncSingleAgent = async (...args: any[]): Promise<string> => (globalThis as any).${fixtureKey}.async(...args);\n\tconst reloadTask = async (`, "async runner");

const peers = {
  "@earendil-works/pi-ai": 'export const StringEnum=(values,options={})=>({enum:values,...options});',
  "@earendil-works/pi-coding-agent": `export const CONFIG_DIR_NAME='.pi';export const getAgentDir=()=>${JSON.stringify(root)};export const getMarkdownTheme=()=>({});export const parseFrontmatter=()=>({frontmatter:{},body:''});export const withFileMutationQueue=async(_p,f)=>f();`,
  "@earendil-works/pi-tui": 'export class Container{};export class Markdown{};export class Spacer{};export class Text{};export const matchesKey=()=>false;',
  // Optional must preserve the underlying schema; a blanket ()=>({}) mock hides defaults.
  "typebox": `export const Type={
    Object:(properties,options={})=>({type:'object',properties,...options}),
    Array:(items,options={})=>({type:'array',items,...options}),
    String:(options={})=>({type:'string',...options}),
    Boolean:(options={})=>({type:'boolean',...options}),
    Optional:schema=>({...schema,optional:true})
  };`,
  "node:child_process": `const forbidden=()=>{throw Error('real spawn/exec forbidden in async-default regression')};export const spawn=forbidden,execSync=forbidden,execFileSync=forbidden;`,
  "fixture-agents": `export const discoverAgents=()=>({agents:[{name:'fixture',source:'user',description:'fixture',systemPrompt:''}],projectAgentsDir:undefined});`,
};

async function loadTool(staleHelper) {
  const suffix = staleHelper ? "stale" : "current";
  const file = path.join(root, `${suffix}.mjs`);
  const mocks = new Map();
  let mockIndex = 0;
  for (const [name, contents] of Object.entries(peers)) {
    const mock = path.join(root, `${suffix}-peer-${mockIndex++}.mjs`);
    fs.writeFileSync(mock, contents); mocks.set(name, mock);
  }
  const staleSafety = path.join(root, "stale-safety.mjs");
  if (staleHelper) fs.writeFileSync(staleSafety,
    `export * from ${JSON.stringify(path.join(repo, "extensions/safety.mjs"))};export const shouldRunSubagentsAsync=value=>value===true;`);
  const source = adapted.replace(/"\.\/([^"\n]+)"/g, (_match, name) => JSON.stringify(
    name === "agents.ts" ? mocks.get("fixture-agents") :
    staleHelper && name === "safety.mjs" ? staleSafety : path.join(repo, "extensions", name)));
  const input = path.join(root, `${suffix}.ts`); fs.writeFileSync(input, source);
  // Like recovery-extension.test.mjs, use the installed/cached CLI, without an
  // install or network fetch. Aliases also block transitive child_process users.
  const aliases = [...mocks].filter(([name]) => name !== "fixture-agents").map(([name, mock]) => `--alias:${name}=${mock}`);
  execFileSync("npx", ["--no-install", "esbuild", input, "--bundle", "--platform=node", "--format=esm", `--outfile=${file}`, ...aliases],
    { cwd: repo, stdio: "pipe", timeout: 15000 });
  const tools = new Map();
  const extension = await import(pathToFileURL(file));
  extension.default({
    registerTool: tool => tools.set(tool.name, tool), on() {}, registerCommand() {}, registerShortcut() {},
    appendEntry() {}, sendUserMessage() {}, getActiveTools: () => [],
  });
  const tool = tools.get("subagent"); assert.ok(tool, "actual extension registered subagent");
  assert.equal(tool.parameters.properties.async.type, "boolean");
  assert.equal(tool.parameters.properties.async.default, true, "model-facing async schema defaults true");
  assert.match(tool.parameters.properties.async.description, /Single\/auto always run in background/);
  return tool;
}
const ctx = { cwd: root, hasUI: false, ui: { notify() {} }, model: { provider: "ignored", id: "ignored" } };
const taskItems = [{ agent: "fixture", task: "first" }, { agent: "_worker", task: "second" }];
function invoke(tool, state, params) {
  globalThis[fixtureKey] = state;
  return tool.execute("fixture-call", params, undefined, undefined, ctx);
}
async function assertPending(promise, label) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  // Deterministic event-loop observation, not a sleep/poll of external state.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, label);
}

try {
  const tool = await loadTool(false);
  for (const asyncFlag of [undefined, true]) {
    const state = newState();
    const params = { tasks: taskItems };
    if (asyncFlag !== undefined) params.async = asyncFlag;
    else assert.equal(Object.hasOwn(params, "async"), false, "omitted test bypasses schema default injection");
    const output = await bounded(invoke(tool, state, params), "parallel background admission");
    assert.equal(state.syncCalls.length, 0, "background must never enter sync runner");
    assert.equal(state.asyncCalls.length, 2);
    assert.equal(output.details.mode, "parallel");
    assert.match(output.content[0].text, /^2 task\(s\) submitted:/);
    for (const call of state.asyncCalls) {
      assert.ok(output.content[0].text.includes(call.id), "execute returns each admission ID");
      assert.deepEqual(call.dispatch, defaults);
    }
    assert.equal(new Set(state.asyncCalls.map(call => call.id)).size, 2);
  }

  const syncState = newState();
  const syncPromise = invoke(tool, syncState, { tasks: taskItems, async: false });
  await bounded(syncState.started(2), "two synchronous workers started");
  assert.equal(syncState.asyncCalls.length, 0);
  await assertPending(syncPromise, "explicit false waits for all worker results");
  const secondResult = result(syncState.pending[1].call, "second completed");
  syncState.pending[1].gate.resolve(secondResult);
  await assertPending(syncPromise, "one completion cannot finish a parallel batch");
  const firstResult = result(syncState.pending[0].call, "first completed");
  syncState.pending[0].gate.resolve(firstResult);
  const syncOutput = await bounded(syncPromise, "complete explicit-sync results");
  assert.equal(syncOutput.details.mode, "parallel");
  assert.deepEqual(syncOutput.details.results, [firstResult, secondResult], "input order retained despite reverse completion order");
  assert.match(syncOutput.content[0].text, /Parallel: 2\/2 succeeded/);
  assert.match(syncOutput.content[0].text, /first completed/);
  assert.match(syncOutput.content[0].text, /second completed/);

  for (const asyncFlag of [undefined, true, false]) {
    const state = newState();
    const params = { chain: [{ agent: "fixture", task: "chain first" }, { agent: "fixture", task: "got {previous} and {previous}", cwd: "fixture-cwd" }] };
    if (asyncFlag !== undefined) params.async = asyncFlag;
    const promise = invoke(tool, state, params);
    await bounded(state.started(1), "chain first started");
    await assertPending(promise, "chain awaits first step");
    assert.equal(state.syncCalls.length, 1, "second chain step cannot start early");
    assert.equal(state.syncCalls[0].step, 1);
    state.pending[0].gate.resolve(result(state.pending[0].call, "previous-output"));
    await bounded(state.started(2), "chain second started");
    assert.equal(state.syncCalls[1].task, "got previous-output and previous-output");
    assert.equal(state.syncCalls[1].workdir, "fixture-cwd");
    assert.equal(state.syncCalls[1].step, 2);
    await assertPending(promise, "chain awaits second step even with async true");
    state.pending[1].gate.resolve(result(state.pending[1].call, "chain final"));
    const output = await bounded(promise, "chain final result");
    assert.equal(output.details.mode, "chain"); assert.equal(output.details.results.length, 2);
    assert.equal(output.content[0].text, "chain final"); assert.equal(state.asyncCalls.length, 0);
  }

  for (const mode of ["single", "auto"]) for (const asyncFlag of [undefined, true, false]) {
    const state = newState();
    const params = { task: `${mode} work`, ...(mode === "single" ? { agent: "fixture" } : {}) };
    if (asyncFlag !== undefined) params.async = asyncFlag;
    const output = await bounded(invoke(tool, state, params), `${mode} background`);
    assert.equal(output.details.mode, mode); assert.equal(state.syncCalls.length, 0);
    assert.equal(state.asyncCalls.length, 1); assert.ok(output.content[0].text.includes(state.asyncCalls[0].id));
    assert.equal(state.asyncCalls[0].agent, mode === "single" ? "fixture" : "_worker");
  }

  // Native .mjs imports may survive /reload: emulate the OLD helper while keeping
  // the real execute callsite. params.async ?? true must protect omitted input.
  const staleTool = await loadTool(true);
  const staleState = newState();
  const staleOutput = await bounded(invoke(staleTool, staleState, { tasks: taskItems }), "omitted async with old cached helper");
  assert.equal(staleState.syncCalls.length, 0); assert.equal(staleState.asyncCalls.length, 2);
  assert.match(staleOutput.content[0].text, /^2 task\(s\) submitted:/);
  const staleFalseState = newState();
  const staleFalsePromise = invoke(staleTool, staleFalseState, { tasks: [taskItems[0]], async: false });
  await bounded(staleFalseState.started(1), "stale-helper explicit sync started");
  assert.equal(staleFalseState.asyncCalls.length, 0);
  await assertPending(staleFalsePromise, "cached helper does not override explicit false");
  staleFalseState.pending[0].gate.resolve(result(staleFalseState.pending[0].call));
  assert.equal((await bounded(staleFalsePromise, "stale-helper sync completion")).details.results[0].exitCode, 0);
  console.log("OK: real subagent.execute omitted/true background IDs, false complete sync results, ordered chain/previous, single/auto invariance, schema true and stale-helper reload protection (runners stubbed; no transport claim)");
} finally {
  delete globalThis[fixtureKey];
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (name.startsWith("__pi_subagent_") && !globalNames.includes(name)) delete globalThis[name];
  }
  for (const [name, value] of oldEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
