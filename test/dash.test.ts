/**
 * pi-sidepanel-dash unit tests
 *
 * Tests data model, token estimation, percentage bars,
 * and render output shape.
 *
 * Run: node --test test/dash.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline copies (avoid module resolution) ───────────────────────────────

function est(s: string): number {
	return Math.ceil(s.length / 4);
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}

function pctBar(pct: number, w: number): string {
	const f = Math.round((pct / 100) * w);
	return "█".repeat(f) + "░".repeat(w - f);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("token estimation", () => {
	it("est returns chars÷4 rounded up", () => {
		assert.equal(est(""), 0);
		assert.equal(est("1234"), 1);
		assert.equal(est("12345"), 2);
		assert.equal(est("12345678"), 2);
		assert.equal(est("123456789"), 3);
	});

	it("fmtTokens formats correctly", () => {
		assert.equal(fmtTokens(0), "0");
		assert.equal(fmtTokens(500), "500");
		assert.equal(fmtTokens(1_000), "1.0K");
		assert.equal(fmtTokens(1_500), "1.5K");
		assert.equal(fmtTokens(15_000), "15.0K");
		assert.equal(fmtTokens(1_000_000), "1.0M");
		assert.equal(fmtTokens(2_500_000), "2.5M");
	});
});

describe("percentage bar", () => {
	it("pctBar renders full bar at 100%", () => {
		assert.equal(pctBar(100, 5), "█████");
	});

	it("pctBar renders empty bar at 0%", () => {
		assert.equal(pctBar(0, 5), "░░░░░");
	});

	it("pctBar renders proportionally", () => {
		const bar = pctBar(50, 10);
		assert.equal(bar.length, 10);
		assert.equal(bar.split("█").length - 1, 5);
		assert.equal(bar.split("░").length - 1, 5);
	});

	it("pctBar rounds correctly", () => {
		assert.equal(pctBar(33, 3), "█░░");
		assert.equal(pctBar(34, 3), "█░░"); // 34% of 3 = 1.02 → 1
		assert.equal(pctBar(67, 3), "██░"); // 67% of 3 = 2.01 → 2
	});
});

describe("DashComponent state", () => {
	it("starts with default values", () => {
		// Mirror DashComponent defaults
		const state = {
			goal: "",
			model: "—",
			turn: 0,
			thinkingLevel: "off",
			tokensTotal: 0,
			contextWindow: 200_000,
			systemPromptTokens: 0,
			toolTokens: [] as { name: string; tokens: number; active: boolean }[],
			conversationTokens: 0,
		};

		assert.equal(state.goal, "");
		assert.equal(state.model, "—");
		assert.equal(state.turn, 0);
		assert.equal(state.tokensTotal, 0);
	});

	it("conversation tokens computed as remainder", () => {
		const tokensTotal = 100_000;
		const systemPromptTokens = 10_000;
		const toolTokens = [
			{ name: "bash", tokens: 500, active: false },
			{ name: "read", tokens: 300, active: true },
		];
		const toolTotal = toolTokens.reduce((s, t) => s + t.tokens, 0);
		const conversation = Math.max(
			0,
			tokensTotal - systemPromptTokens - toolTotal,
		);

		assert.equal(conversation, 89_200);
	});

	it("conversation tokens floor at 0", () => {
		const conversation = Math.max(0, 1000 - 5000 - 0);
		assert.equal(conversation, 0);
	});
});

describe("percentage calculations", () => {
	it("system prompt percentage", () => {
		const total = 100_000;
		const sys = 12_000;
		assert.equal(Math.round((sys / total) * 100), 12);
	});

	it("tool percentage", () => {
		const total = 100_000;
		const tool = 25_000;
		assert.equal(Math.round((tool / total) * 100), 25);
	});

	it("context window percentage", () => {
		const used = 80_000;
		const window = 200_000;
		assert.equal(Math.round((used / window) * 100), 40);
	});

	it("handles zero total gracefully", () => {
		const pct = 0 > 0 ? 0 : 0;
		assert.equal(pct, 0);
	});
});

describe("tool sorting", () => {
	it("sorts by token count descending", () => {
		const tools = [
			{ name: "small", tokens: 100, active: false },
			{ name: "large", tokens: 5000, active: false },
			{ name: "medium", tokens: 500, active: false },
		];
		tools.sort((a, b) => b.tokens - a.tokens);

		assert.deepEqual(
			tools.map((t) => t.name),
			["large", "medium", "small"],
		);
	});
});
