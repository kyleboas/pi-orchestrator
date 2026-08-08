import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_LIMIT_COOLDOWN_SECONDS,
	earliestAccountReset,
	isClaudeAuthFailureText,
	isUsageLimitText,
	markClaudeAccountLimited,
	parseUsageLimitReset,
	pickClaudeAccount,
} from "../extensions/orchestrator-lib/orchestrator-accounts.ts";

function config() {
	const dir = mkdtempSync(join(tmpdir(), "orch-accounts-"));
	return {
		accounts: { a1: join(dir, "a1"), a2: join(dir, "a2"), a3: join(dir, "a3") },
		statePath: join(dir, "state.json"),
	};
}

test("round-robin picks skip cooled-down accounts and bump shared state", () => {
	const cfg = config();
	const now = 1_000_000;
	assert.equal(pickClaudeAccount(cfg, now)!.name, "a1");
	assert.equal(pickClaudeAccount(cfg, now)!.name, "a2");
	markClaudeAccountLimited(cfg, "a3", now + 3_600, now);
	assert.equal(pickClaudeAccount(cfg, now)!.name, "a1");
	const state = JSON.parse(readFileSync(cfg.statePath, "utf8"));
	assert.equal(state.accounts.a1.runs, 2);
	assert.ok(state.accounts.a3.cooldown_until > now);
});

test("all accounts limited yields no pick and an earliest reset", () => {
	const cfg = config();
	const now = 1_000_000;
	markClaudeAccountLimited(cfg, "a1", now + 100, now);
	markClaudeAccountLimited(cfg, "a2", now + 50, now);
	markClaudeAccountLimited(cfg, "a3", now + 900, now);
	assert.equal(pickClaudeAccount(cfg, now), undefined);
	assert.equal(earliestAccountReset(cfg, now), now + 100 >= now + 50 ? now + 50 : now + 100);
	assert.equal(pickClaudeAccount(cfg, now + 60)!.name, "a2");
});

test("limit marking without a reset uses the default cooldown and never shortens one", () => {
	const cfg = config();
	const now = 1_000_000;
	markClaudeAccountLimited(cfg, "a1", undefined, now);
	let state = JSON.parse(readFileSync(cfg.statePath, "utf8"));
	assert.equal(state.accounts.a1.cooldown_until, now + DEFAULT_LIMIT_COOLDOWN_SECONDS);
	markClaudeAccountLimited(cfg, "a1", now + 10, now);
	state = JSON.parse(readFileSync(cfg.statePath, "utf8"));
	assert.equal(state.accounts.a1.cooldown_until, now + DEFAULT_LIMIT_COOLDOWN_SECONDS);
});

test("state file from claude-auto is understood and corrupt state tolerated", () => {
	const cfg = config();
	writeFileSync(cfg.statePath, JSON.stringify({ next: 1, accounts: { a1: { runs: 5, cooldown_until: 0 } } }));
	assert.equal(pickClaudeAccount(cfg, 1_000)!.name, "a2");
	writeFileSync(cfg.statePath, "garbage");
	assert.equal(pickClaudeAccount(cfg, 1_000)!.name, "a1");
});

test("usage-limit text detection and reset parsing", () => {
	assert.ok(isUsageLimitText("Claude AI usage limit reached|1751234567"));
	assert.ok(isUsageLimitText("You've reached your usage limit."));
	assert.ok(isUsageLimitText("5-hour limit reached ∙ resets 3pm"));
	assert.ok(!isUsageLimitText("Tests failed with a limit of 3 retries"));
	assert.ok(!isUsageLimitText(undefined));
	const now = 1_751_000_000;
	assert.equal(parseUsageLimitReset("Claude AI usage limit reached|1751234567", now), 1_751_234_567);
	assert.equal(parseUsageLimitReset("usage limit reached|1751234567890", now), 1_751_234_567.89);
	assert.equal(parseUsageLimitReset("usage limit reached", now), undefined);
	assert.equal(parseUsageLimitReset("usage limit reached|1000", now), undefined);
});

test("credential failures are recognized across Claude Code's wordings", () => {
	assert.equal(isClaudeAuthFailureText("Not logged in \u00b7 Please run /login"), true);
	assert.equal(isClaudeAuthFailureText("Invalid API key \u00b7 Please run /login"), true);
	assert.equal(isClaudeAuthFailureText("OAuth token has expired"), true);
	assert.equal(isClaudeAuthFailureText("authentication_failed"), true);
	assert.equal(isClaudeAuthFailureText(undefined), false);
	assert.equal(isClaudeAuthFailureText("Claude AI usage limit reached|1785168600"), false, "a usage limit takes the cooldown path, not the login path");
	assert.equal(isClaudeAuthFailureText("The tests failed: expected 200, got 401 Unauthorized"), false, "a task's own auth error must not rotate the worker's account");
});

test("a logged-out account cools down on the default window with no reset to parse", () => {
	const cfg = config();
	const now = 2_000_000;
	markClaudeAccountLimited(cfg, "a1", undefined, now);
	assert.equal(earliestAccountReset(cfg, now), now + DEFAULT_LIMIT_COOLDOWN_SECONDS);
	assert.equal(pickClaudeAccount(cfg, now)!.name, "a2", "rotation must skip the account needing /login");
});
