/**
 * pi-sidepanel-dash unit tests
 *
 * Tests the REAL data model and rendering from ../dash.ts (no mirrors):
 * token estimation, percentage bars, state, and render output shape.
 *
 * Run: node --test test/dash.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DashComponent, est, fmtTokens, pctBar } from "../dash.ts";
import { truncateToWidth } from "./_harness/pi-tui-stub.mjs";

function makeDash(): DashComponent {
	return new DashComponent({ truncateToWidth });
}

// ── Pure helpers ──────────────────────────────────────────────────────────

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

	it("pctBar clamps out-of-range percentages (regression: >100% threw)", () => {
		assert.equal(pctBar(500, 5), "█████");
		assert.equal(pctBar(-10, 5), "░░░░░");
	});
});

// ── DashComponent state ───────────────────────────────────────────────────

describe("DashComponent state", () => {
	it("starts with default values", () => {
		const dash = makeDash();
		assert.equal(dash.goal, "");
		assert.equal(dash.model, "—");
		assert.equal(dash.turn, 0);
		assert.equal(dash.thinkingLevel, "off");
		assert.equal(dash.tokensTotal, 0);
		assert.equal(dash.contextWindow, 200_000);
		assert.deepEqual(dash.toolTokens, []);
	});

	it("reset restores defaults", () => {
		const dash = makeDash();
		dash.goal = "do things";
		dash.model = "x/y";
		dash.turn = 7;
		dash.tokensTotal = 5;
		dash.reset();
		assert.equal(dash.goal, "");
		assert.equal(dash.model, "—");
		assert.equal(dash.turn, 0);
		assert.equal(dash.tokensTotal, 0);
	});

	it("collectToolInfo estimates, marks active, sorts descending", () => {
		const dash = makeDash();
		dash.collectToolInfo({
			getAllTools: () => [
				{ name: "small", description: "abcd", parameters: {} },
				{ name: "large", description: "x".repeat(4000), parameters: {} },
				{ name: "medium", description: "y".repeat(400), parameters: {} },
			],
			getActiveTools: () => ["medium"],
		});

		assert.deepEqual(
			dash.toolTokens.map((t) => t.name),
			["large", "medium", "small"],
		);
		assert.equal(dash.toolTokens.find((t) => t.name === "medium")!.active, true);
		assert.equal(dash.toolTokens.find((t) => t.name === "large")!.active, false);
	});
});

// ── Rendering ─────────────────────────────────────────────────────────────

describe("DashComponent render", () => {
	it("shows session info and empty-context placeholder", () => {
		const dash = makeDash();
		dash.model = "anthropic/claude";
		const lines = dash.render(60, 20);
		assert.ok(lines.some((l) => l.includes("Model: anthropic/claude")));
		assert.ok(lines.some((l) => l.includes("No context data yet")));
	});

	it("shows the goal when set", () => {
		const dash = makeDash();
		dash.goal = "Fix the\nparser bug";
		const lines = dash.render(60, 20);
		assert.ok(lines.some((l) => l.includes("Goal")));
		// Newlines collapsed into one line
		assert.ok(lines.some((l) => l.includes("Fix the parser bug")));
	});

	it("computes conversation tokens as the remainder", () => {
		const dash = makeDash();
		dash.tokensTotal = 100_000;
		dash.systemPromptTokens = 10_000;
		dash.toolTokens = [
			{ name: "bash", tokens: 500, active: false },
			{ name: "read", tokens: 300, active: true },
		];
		dash.render(60, 30);
		assert.equal(dash.conversationTokens, 89_200);
	});

	it("conversation tokens floor at 0", () => {
		const dash = makeDash();
		dash.tokensTotal = 1000;
		dash.systemPromptTokens = 5000;
		dash.render(60, 30);
		assert.equal(dash.conversationTokens, 0);
	});

	it("shows breakdown with bars and top tools", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.systemPromptTokens = 5_000;
		dash.toolTokens = [
			{ name: "bash", tokens: 2_000, active: true },
			{ name: "read", tokens: 1_000, active: false },
		];
		const lines = dash.render(60, 30);
		assert.ok(lines.some((l) => l.includes("System:") && l.includes("5.0K")));
		assert.ok(lines.some((l) => l.includes("Tools:") && l.includes("3.0K")));
		assert.ok(lines.some((l) => l.includes("●") && l.includes("bash")));
		assert.ok(lines.some((l) => l.includes("○") && l.includes("read")));
		assert.ok(lines.some((l) => l.includes("█")));
	});

	it("pins the two-line footer to the bottom of the viewport", () => {
		const dash = makeDash();
		const lines = dash.render(60, 24);
		assert.equal(lines.length, 24);
		assert.ok(lines[22]!.includes("read-only overview"));
	});

	it("caches by width and height; invalidate busts the cache", () => {
		const dash = makeDash();
		const first = dash.render(60, 20);
		dash.turn = 9;
		assert.equal(dash.render(60, 20), first, "same w/h → cached array");
		assert.notEqual(dash.render(50, 20), first, "width change re-renders");
		dash.invalidate();
		const fresh = dash.render(50, 20);
		assert.ok(fresh.some((l) => l.includes("Turn:  9")));
	});
});
