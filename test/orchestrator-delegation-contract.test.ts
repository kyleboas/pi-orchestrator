import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	INTERNAL_DELEGATION_CONTRACT_MARKER,
	withOrchestratorDelegationContract,
} from "../extensions/orchestrator-lib/orchestrator-delegation-contract.ts";
import { DEFAULT_WORKERS } from "../extensions/orchestrator-lib/orchestrator-config.ts";
import { buildCoordinatorInstructions } from "../extensions/orchestrator-lib/orchestrator-instructions.ts";

const orchestratorSource = readFileSync(new URL("../extensions/orchestrator.ts", import.meta.url), "utf8");

function requestSection(label: "request" | "requests" | "request(s)", body: string): string {
	return `Verbatim user operative ${label}:\n${body}`;
}

test("singular final request section stays the exact suffix while body stays the prefix", () => {
	const body = "Facts: preserve this exact brief.\nDo not normalize whitespace.\n\n";
	const request = requestSection("request", "make the change exactly as planned");
	const task = body + request;
	const wrapped = withOrchestratorDelegationContract(task, "root-singular");
	assert.ok(wrapped.startsWith(body));
	assert.ok(wrapped.endsWith(request));
	assert.equal(wrapped.slice(-request.length), request);
	assert.ok(wrapped.indexOf(INTERNAL_DELEGATION_CONTRACT_MARKER) > body.length);
});

test("parenthesized final request section accepted from coordinator instructions", () => {
	const request = requestSection("request(s)", "delegate the task");
	const wrapped = withOrchestratorDelegationContract(request, "root-parenthesized");
	assert.ok(wrapped.endsWith(request));
	assert.match(wrapped, /Root task ID: root-parenthesized/);
});

test("parenthesized faithful excerpt section is accepted", () => {
	const request = "Faithful excerpt of user operative request(s):\ndelegate the task";
	const wrapped = withOrchestratorDelegationContract(request, "root-parenthesized-excerpt");
	assert.ok(wrapped.endsWith(request));
});

test("plural final request section stays the exact suffix", () => {
	const body = "Investigation and constraints remain byte-for-byte before insertion.\n";
	const request = requestSection("requests", "make these operative changes");
	const wrapped = withOrchestratorDelegationContract(body + request, "root-plural");
	assert.equal(wrapped.slice(0, body.length), body);
	assert.equal(wrapped.slice(-request.length), request);
	assert.equal(wrapped.endsWith(request), true);
});

test("faithful excerpt singular preserves the exact final suffix", () => {
	const body = "Coordinator facts with exact whitespace.\n";
	const request = "Faithful excerpt of user operative request:\nmake the excerpted change";
	const wrapped = withOrchestratorDelegationContract(body + request, "root-excerpt-singular");
	assert.equal(wrapped.slice(0, body.length), body);
	assert.equal(wrapped.slice(-request.length), request);
});

test("faithful excerpt plural preserves the exact final suffix", () => {
	const body = "Coordinator facts remain unchanged.\n\n";
	const request = "Faithful excerpt of user operative requests:\nmake these excerpted changes";
	const wrapped = withOrchestratorDelegationContract(body + request, "root-excerpt-plural");
	assert.equal(wrapped.slice(0, body.length), body);
	assert.equal(wrapped.slice(-request.length), request);
});

test("the final recognized marker receives the contract when multiple sections are present", () => {
	const earlier = requestSection("request", "an earlier quoted request");
	const final = requestSection("requests", "the final operative request");
	const wrapped = withOrchestratorDelegationContract("Facts.\n" + earlier + "\nAdditional body facts.\n" + final, "root-final-marker");
	assert.equal(wrapped.slice(-final.length), final);
	assert.ok(wrapped.lastIndexOf(INTERNAL_DELEGATION_CONTRACT_MARKER) < wrapped.lastIndexOf(final));
	assert.match(wrapped, /Root task ID: root-final-marker/);
});

test("contract has no text after the final labeled user-request section", () => {
	const request = requestSection("request", "the final user bytes");
	const wrapped = withOrchestratorDelegationContract("Coordinator body\n\n" + request, "root-suffix");
	assert.equal(wrapped.slice(-request.length), request);
	assert.equal(wrapped.at(-1), "s");
	assert.ok(wrapped.indexOf(INTERNAL_DELEGATION_CONTRACT_MARKER) < wrapped.indexOf(request));
});

test("misleading marker text in user prose does not suppress the real insertion", () => {
	const body = "User prose mentions Verbatim user operative request: inline, and [INTERNAL ORCHESTRATOR DELEGATION CONTRACT v1] as ordinary text.\n";
	const request = requestSection("request", "the actual final request");
	const wrapped = withOrchestratorDelegationContract(body + request, "root-misleading");
	assert.match(wrapped, /Root task ID: root-misleading/);
	assert.equal(wrapped.slice(-request.length), request);
});

test("an existing contract at the final-section boundary is idempotent", () => {
	const task = "Facts and constraints.\n" + requestSection("requests", "continue the same root task");
	const first = withOrchestratorDelegationContract(task, "root-once");
	const second = withOrchestratorDelegationContract(first, "root-different-input");
	assert.equal(second, first);
	assert.equal(second.split(INTERNAL_DELEGATION_CONTRACT_MARKER).length - 1, 1);
	assert.equal(second.slice(-requestSection("requests", "continue the same root task").length), requestSection("requests", "continue the same root task"));
});

test("missing final request section fails closed", () => {
	assert.throws(
		() => withOrchestratorDelegationContract("Facts without the required final section.", "root-missing"),
		/missing final .*Verbatim user operative request/,
	);
});

test("delegation contract carries the resolved root task ID", () => {
	const wrapped = withOrchestratorDelegationContract(requestSection("request", "Implement the continuation."), "root-retry-42");
	assert.match(wrapped, /Root task ID: root-retry-42/);
});

test("plan-only contracts omit implementation-only worktree and PR-create rules", () => {
	const request = requestSection("request", "Plan the task.");
	const contract = withOrchestratorDelegationContract(request, "root-plan", { planOnly: true, prCreationRequested: true });
	assert.doesNotMatch(contract, /Worktree lifecycle contract/);
	assert.doesNotMatch(contract, /newly pushed commit representing the final PR contents/);
	assert.equal(contract.endsWith(request), true);
});

test("ordinary and explicit-PR implementation contracts carry worktree rules only", () => {
	const request = requestSection("request", "Implement the task.");
	const ordinary = withOrchestratorDelegationContract(request, "root-ordinary", { planOnly: false });
	const pr = withOrchestratorDelegationContract(request, "root-pr", { planOnly: false, prCreationRequested: true });
	for (const contract of [ordinary, pr]) assert.match(contract, /Worktree lifecycle contract/);
	assert.doesNotMatch(ordinary, /Resource-execution policy/);
	assert.doesNotMatch(pr, /newly pushed commit representing the final PR contents/);
});

test("explicitly read-only research contracts can omit worktree lifecycle policy", () => {
	const request = requestSection("request", "Report findings.");
	const contract = withOrchestratorDelegationContract(request, "root-research", { planOnly: false, needsWorktree: false });
	assert.doesNotMatch(contract, /Worktree lifecycle contract/);
	assert.equal(contract.endsWith(request), true);
});

test("delegation contract contains worktree safety and cleanup requirements", () => {
	const contract = withOrchestratorDelegationContract(requestSection("request", "Task"), "root-safety");
	for (const phrase of [
		"git worktree list --porcelain",
		"clean, inactive, unlocked, unshared, certain",
		"same root-task lineage and branch",
		"reuse that owned worktree",
		"Never reuse a completed worktree for a distinct task",
		"git worktree remove <exact-path>",
		"git worktree prune",
		"without force",
		"Never use `rm -rf`",
		"delete branch refs",
		"report the exact path and blocker",
	]) assert.match(contract, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("coordinator policy requires direct resource execution with explicit-policy precedence", () => {
	const instructions = buildCoordinatorInstructions(DEFAULT_WORKERS);
	for (const phrase of [
		"Run bounded, low-resource work directly whenever practical.",
		"Do not use `/home/kyle/bin/run-heavy` or a background job merely to avoid waiting",
		"Use `/home/kyle/bin/run-heavy` for genuinely heavy or long-running work",
		"Repository rules, host safety policies, and resource limits take precedence.",
		"require the live worker to clean up its owned worktree",
		"delegate the cleanup before starting replacement work",
		"same active task lineage",
	]) assert.match(instructions, new RegExp(phrase.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
});

test("active delegate execution passes the wrapped task to launchWorker", () => {
	assert.match(orchestratorSource, /withOrchestratorDelegationContract/);
	assert.match(orchestratorSource, /workerTask = withOrchestratorDelegationContract\(params\.task, rootTaskId, \{/);
	assert.match(orchestratorSource, /launchWorker\(name, profile, workerTask, cwd/);
	assert.match(orchestratorSource, /try \{\n\s*workerTask = withOrchestratorDelegationContract\(params\.task, rootTaskId, \{[\s\S]*?catch \(error\) \{[\s\S]*?Delegation rejected:/);
});
