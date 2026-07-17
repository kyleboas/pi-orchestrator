import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { renderBaseFooter } from "../extensions/orchestrator-lib/orchestrator-footer.ts";

const fixtureHome = homedir();
const ctx = {
	cwd: fixtureHome,
	model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true, contextWindow: 272_000 },
	sessionManager: {
		getCwd: () => fixtureHome,
		getSessionName: () => undefined,
		getEntries: () => [{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 923_000, output: 24_000, cacheRead: 1_200_000, cacheWrite: 0, cost: { total: 3.484 } },
			},
		}],
	},
	modelRegistry: { isUsingOAuth: () => true },
	getContextUsage: () => ({ contextWindow: 272_000, percent: 10.9 }),
};

const footerData = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

const theme = { fg: (_color: string, text: string) => text };

test("reproduces the native footer before worker rows are appended", () => {
	const lines = renderBaseFooter(ctx, footerData, theme, "high", 92);
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "~");
	assert.match(lines[1], /^↑923k ↓24k R1\.2M CH56\.5% \$3\.484 \(sub\) 10\.9%\/272k \(auto\)\s+gpt-5\.6-sol • high$/);
	assert.equal(Array.from(lines[1]).length, 92);
});

test("preserves other extension statuses above orchestrator worker rows", () => {
	const lines = renderBaseFooter(ctx, {
		...footerData,
		getExtensionStatuses: () => new Map([["z", "status z"], ["a", "status a"]]),
	}, theme, "high", 92);
	assert.equal(lines[2], "status a status z");
});
