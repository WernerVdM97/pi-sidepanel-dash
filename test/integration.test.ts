/**
 * pi-sidepanel-dash integration tests
 *
 * Loads the REAL extension entry point (index.ts) against the FakePi
 * harness, covering registration, the sidepanel:ready recovery
 * handshake, and the lifecycle event wiring.
 *
 * Run: node --test test/integration.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
	FakePi,
	captureRegistrations,
	sessionCtx,
} from "./_harness/fake-pi.ts";

register("./_harness/stub-hooks.mjs", import.meta.url);
const extension = (await import("../index.ts")).default;

const MODEL = { provider: "anthropic", id: "claude", contextWindow: 200_000 };

/** Boot the extension and return its registered component, with the
 *  framework's invalidate-on-event behavior emulated. */
async function boot(pi: FakePi, ctx: Record<string, unknown> = {}) {
	const regs = captureRegistrations(pi);
	extension(pi as any);
	// Dash relies on the framework calling component.invalidate() when it
	// receives sidepanel:invalidate — emulate that contract here.
	pi.events.on("sidepanel:invalidate", () => regs.at(-1)?.component.invalidate());
	await pi.fire("session_start", {}, sessionCtx([], { model: MODEL, ...ctx }));
	return { regs, comp: regs[0].component };
}

describe("registration", () => {
	it("registers the dash tab on session_start", async () => {
		const pi = new FakePi();
		const { regs } = await boot(pi);
		assert.equal(regs.length, 1);
		assert.equal(regs[0].id, "dash");
		assert.equal(regs[0].label, "Dash");
	});

	it("re-registers on sidepanel:ready (load-order recovery)", async () => {
		const pi = new FakePi();
		const { regs } = await boot(pi);
		pi.events.emit("sidepanel:ready", {});
		assert.equal(regs.length, 2, "ready must trigger a fresh registration");
		assert.equal(regs[1].id, "dash");
	});
});

describe("lifecycle wiring", () => {
	it("shows the model from session_start ctx", async () => {
		const pi = new FakePi();
		const { comp } = await boot(pi);
		const lines: string[] = comp.render(60, 25);
		assert.ok(lines.some((l) => l.includes("anthropic/claude")));
	});

	it("captures the goal and system prompt on before_agent_start", async () => {
		const pi = new FakePi();
		const { comp } = await boot(pi);
		await pi.fire(
			"before_agent_start",
			{ prompt: "Fix the login bug" },
			{ model: MODEL, getSystemPrompt: () => "s".repeat(4000) },
		);
		const lines: string[] = comp.render(60, 30);
		assert.ok(lines.some((l) => l.includes("Fix the login bug")));
		assert.ok(lines.some((l) => l.includes("System:") && l.includes("1.0K")));
	});

	it("tracks the turn counter", async () => {
		const pi = new FakePi();
		const { comp } = await boot(pi);
		await pi.fire("turn_start", { turnIndex: 2 });
		const lines: string[] = comp.render(60, 25);
		assert.ok(lines.some((l) => l.includes("Turn:  3")));
	});

	it("updates token usage from agent_end", async () => {
		const pi = new FakePi();
		const { comp } = await boot(pi);
		await pi.fire("agent_end", {}, { getContextUsage: () => ({ tokens: 50_000 }) });
		const lines: string[] = comp.render(60, 25);
		assert.ok(lines.some((l) => l.includes("50.0K") && l.includes("200.0K")));
	});

	it("tolerates a ctx without getContextUsage (regression)", async () => {
		const pi = new FakePi();
		await boot(pi);
		// Must not throw — the call is optional-chained.
		await pi.fire("agent_end", {}, {});
		await pi.fire("turn_end", {}, {});
	});

	it("marks tools active on tool_call and inactive on tool_execution_end", async () => {
		const pi = new FakePi();
		pi.toolDefs = [
			{ name: "bash", description: "x".repeat(400), parameters: {} },
			{ name: "read", description: "y".repeat(40), parameters: {} },
		];
		const { comp } = await boot(pi);
		await pi.fire("before_agent_start", {}, { model: MODEL });

		await pi.fire("tool_call", { toolName: "bash" });
		let lines: string[] = comp.render(60, 30);
		assert.ok(lines.some((l) => l.includes("●") && l.includes("bash")));

		await pi.fire("tool_execution_end", { toolName: "bash" });
		lines = comp.render(60, 30);
		assert.ok(lines.some((l) => l.includes("○") && l.includes("bash")));
	});

	it("updates the model on model_select", async () => {
		const pi = new FakePi();
		const { comp } = await boot(pi);
		await pi.fire("model_select", {
			model: { provider: "openai", id: "gpt", contextWindow: 128_000 },
		});
		const lines: string[] = comp.render(60, 25);
		assert.ok(lines.some((l) => l.includes("openai/gpt")));
	});
});
