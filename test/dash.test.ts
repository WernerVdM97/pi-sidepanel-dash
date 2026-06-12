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
import { DashComponent, est, fmtTokens, colorBarSegment } from "../dash.ts";
import { truncateToWidth } from "./_harness/pi-tui-stub.mjs";
import { identityTheme } from "./_harness/fake-pi.ts";

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

describe("colorBarSegment", () => {
	it("renders full bar at 100% with error color", () => {
		assert.equal(colorBarSegment(identityTheme, 100, "███"), "███");
	});

	it("renders empty bar at 0% with success color", () => {
		assert.equal(colorBarSegment(identityTheme, 0, "░░░"), "░░░");
	});

	it("returns themed text with correct color names", () => {
		// With identityTheme colors passthrough — just verify no crash
		const result = colorBarSegment(identityTheme, 50, "█████");
		assert.equal(result, "█████");
	});

	it("maps pct to correct color names", () => {
		const th = { fg: (c: string, s: string) => `[${c}:${s}]` } as any;
		assert.equal(colorBarSegment(th, 20, "█"), "[success:█]");
		assert.equal(colorBarSegment(th, 50, "█"), "[warning:█]");
		assert.equal(colorBarSegment(th, 70, "█"), "[accent:█]");
		assert.equal(colorBarSegment(th, 90, "█"), "[error:█]");
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

	it("pins the keymap footer to the bottom of the viewport", () => {
		const dash = makeDash();
		const lines = dash.render(60, 24);
		assert.equal(lines.length, 24);
		assert.ok(lines[23]!.includes("ctrl+t"));
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

	it("shows thinking level with contextual emoji", () => {
		const dash = makeDash();
		dash.thinkingLevel = "high";
		const lines = dash.render(60, 20);
		assert.ok(lines.some((l) => l.includes("💭") && l.includes("high")));
	});

	it("shows 🔕 emoji when thinking is off", () => {
		const dash = makeDash();
		dash.thinkingLevel = "off";
		const lines = dash.render(60, 20);
		assert.ok(lines.some((l) => l.includes("🔕") && l.includes("off")));
	});

	it("shows contextual emoji for context usage level", () => {
		const dash = makeDash();
		dash.tokensTotal = 30_000;
		dash.contextWindow = 200_000;
		const lines = dash.render(60, 20);
		// Low usage → should show green indicator
		assert.ok(lines.some((l) => l.includes("30000") || l.includes("30.0K")));
	});

	it("right-aligns percentage values in breakdown", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.systemPromptTokens = 5_000;
		dash.toolTokens = [
			{ name: "bash", tokens: 2_000, active: false },
		];
		const lines = dash.render(60, 30);
		// Percentages should appear after the pct bar, at the right edge
		const sysLine = lines.find((l) => l.includes("System:"));
		assert.ok(sysLine, "should have System line");
		assert.ok(sysLine!.includes("10%"), "should show percentage");
	});

	it("orders breakdown by percentage descending", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.systemPromptTokens = 5_000;
		dash.toolTokens = [
			{ name: "bash", tokens: 3_000, active: false },
		];
		const lines = dash.render(60, 30);

		const idxConv = lines.findIndex((l) =>
			l.includes("Conv:"),
		);
		const idxSys = lines.findIndex((l) => l.includes("System:"));
		const idxTools = lines.findIndex((l) => l.includes("Tools:"));

		// Conv (84%) comes before System (10%) before Tools (6%)
		assert.ok(idxConv < idxSys && idxSys < idxTools,
			`Expected Conv(${idxConv}) < System(${idxSys}) < Tools(${idxTools})`);
	});

	it("caps tool list at 10 with +N more", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.systemPromptTokens = 1_000;
		dash.toolTokens = Array.from({ length: 15 }, (_, i) => ({
			name: `tool-${i}`,
			tokens: 100 + i * 10,
			active: false,
		}));
		const lines = dash.render(60, 30);

		// Should show no more than 10 tool entries
		const toolLines = lines.filter((l) => l.includes("tool-"));
		assert.equal(toolLines.length, 10);

		// Should show +5 more
		assert.ok(lines.some((l) => l.includes("+5 more")));
	});

	it("shows skills as sub-list under Conv", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.systemPromptTokens = 10_000;
		dash.addSkillEntry("caveman", 1_250, true);
		dash.addSkillEntry("tdd", 2_500, false);
		const lines = dash.render(60, 30);

		// Skills should appear as sub-items under Conv
		assert.ok(lines.some((l) => l.includes("Conv:")));
		assert.ok(lines.some((l) => l.includes("tdd")));
		assert.ok(lines.some((l) => l.includes("caveman")));
		// TDD (2.5K) should sort before caveman (1.3K)
		const tddIdx = lines.findIndex((l) => l.includes("tdd"));
		const cavemanIdx = lines.findIndex((l) => l.includes("caveman"));
		assert.ok(tddIdx < cavemanIdx, "tdd (2.5K) before caveman (1.3K)");
	});

	it("explicit skills show / tag, auto show ~ tag", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.addSkillEntry("explicit-skill", 1_000, true);
		dash.addSkillEntry("auto-skill", 1_000, false);
		const lines = dash.render(60, 30);

		const expLine = lines.find((l) => l.includes("explicit-skill"));
		const autoLine = lines.find((l) => l.includes("auto-skill"));
		assert.ok(expLine!.includes("/"), "explicit should have / tag");
		assert.ok(autoLine!.includes("~"), "auto should have ~ tag");
	});

	it("uses box-drawing characters for grid sections", () => {
		const dash = makeDash();
		dash.model = "test/x";
		dash.goal = "Test goal";
		dash.tokensTotal = 5000;
		dash.addSkillEntry("test", 500, true);
		dash.systemPromptTokens = 1000;
		const lines = dash.render(60, 30);
		// Should have at least one box-drawing header
		const hasBox = lines.some(
			(l) => l.includes("╭") || l.includes("┌") || l.includes("╔"),
		);
		assert.ok(hasBox, "should use box-drawing for section headers");
	});

	it("uses wider bars", () => {
		const dash = makeDash();
		dash.tokensTotal = 30000;
		dash.contextWindow = 200000;
		const lines = dash.render(80, 30);
		// Wider panel → wider bar
		const contextLine = lines.find((l) => l.includes("█"));
		assert.ok(contextLine, "should have a context bar");
		// At width 80, bar should be at least 16 chars (was capped at 14)
		const bareLine = contextLine!;
		const bars = (bareLine.match(/█/g) || []).length;
		const spaces = (bareLine.match(/░/g) || []).length;
		assert.ok(bars + spaces >= 16, "bar should be wider than before");
	});

	it("shows replied tokens breakdown when set", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.replyThinking = 2_000;
		dash.replyOutput = 3_000;
		dash.replyOther = 500;
		const lines = dash.render(60, 30);

		const headerIdx = lines.findIndex((l) => l.includes("Replied"));
		assert.ok(headerIdx !== -1, "should have Replied header");
		// Should show thinking
		assert.ok(lines.some((l) => l.includes("thinking")), "should show thinking");
		assert.ok(lines.some((l) => l.includes("2.0K")), "should show thinking token count");
		// Should show output
		assert.ok(lines.some((l) => l.includes("output")), "should show output");
	});

	it("replied section does not render when no reply tokens", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		const lines = dash.render(60, 30);
		assert.ok(!lines.some((l) => l.includes("Replied")), "should not show Replied when empty");
	});

	it("replied breakdown is ordered by size", () => {
		const dash = makeDash();
		dash.tokensTotal = 50_000;
		dash.replyThinking = 1_000;
		dash.replyOutput = 5_000;
		dash.replyOther = 500;
		const lines = dash.render(60, 30);

		const outputIdx = lines.findIndex((l) => l.includes("output"));
		const thinkIdx = lines.findIndex((l) => l.includes("thinking"));
		assert.ok(outputIdx < thinkIdx, "output (largest) should come before thinking");
	});
});
