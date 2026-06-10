/**
 * pi-sidepanel-dash — Session dashboard tab for pi-sidepanel
 *
 * Merges the standalone /context and /dash commands into a single
 * sidepanel tab. Shows goal, session metadata, context budget
 * breakdown, and top tool definitions by token cost.
 *
 * Registers via `sidepanel:register` — requires pi-sidepanel.
 * Purely event wiring — data model and rendering live in ./dash.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { DashComponent, est, type ThemeColors } from "./dash.ts";

// ── Extension entry point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const dash = new DashComponent({ truncateToWidth });
	let registered = false;

	function registerTab(): void {
		if (registered) return;
		registered = true;

		try {
			const themedComponent = {
				handleInput(): void {
					// Read-only display — no input handling needed
				},
				render(width: number, height?: number): string[] {
					return dash.render(width, height);
				},
				invalidate(): void {
					dash.invalidate();
				},
				setTheme(t: ThemeColors): void {
					dash.setTheme(t);
				},
			};

			pi.events.emit("sidepanel:register", {
				id: "dash",
				label: "Dash",
				component: themedComponent,
			});
		} catch {
			// silent
		}
	}

	// ── Session start ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		registered = false;
		dash.reset();

		// Set model info from context
		if (ctx.model) {
			dash.model = `${ctx.model.provider}/${ctx.model.id}`;
			dash.contextWindow = ctx.model.contextWindow ?? 200_000;
		}

		dash.collectToolInfo(pi);
		registerTab();
	});

	// ── Before agent start — capture goal, system prompt ────────────

	pi.on("before_agent_start", async (event, ctx) => {
		const goal = (event as any).prompt;
		if (goal) dash.goal = goal;

		// Update model context window if changed
		if (ctx.model) {
			dash.model = `${ctx.model.provider}/${ctx.model.id}`;
			dash.contextWindow = ctx.model.contextWindow ?? dash.contextWindow;
		}

		// Estimate system prompt tokens
		const sysPrompt = (ctx as any).getSystemPrompt?.() ?? "";
		if (sysPrompt) {
			dash.systemPromptTokens = est(sysPrompt);
		}

		dash.collectToolInfo(pi);
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	// ── Agent start — clear active tools ─────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		dash.turn = 0;
		// Clear active markers on all tools
		for (const t of dash.toolTokens) t.active = false;
		if (ctx.model) {
			dash.model = `${ctx.model.provider}/${ctx.model.id}`;
			dash.contextWindow = ctx.model.contextWindow ?? dash.contextWindow;
		}
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	// ── Agent end — update token usage ───────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const usage = (ctx as any).getContextUsage?.() as any;
		if (usage?.tokens) dash.tokensTotal = usage.tokens;
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	// ── Turn events ──────────────────────────────────────────────────

	pi.on("turn_start", async (event) => {
		dash.turn = ((event as any).turnIndex ?? 0) + 1;
		// Clear active tool markers
		for (const t of dash.toolTokens) t.active = false;
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	pi.on("turn_end", async (_event, ctx) => {
		const usage = (ctx as any).getContextUsage?.() as any;
		if (usage?.tokens) dash.tokensTotal = usage.tokens;
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	// ── Tool call — mark as active ───────────────────────────────────

	pi.on("tool_call", async (event) => {
		const toolName = (event as any).toolName;
		for (const t of dash.toolTokens) {
			if (t.name === toolName) {
				t.active = true;
				break;
			}
		}
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	// ── Tool execution end — mark as inactive ────────────────────────

	pi.on("tool_execution_end", async (event) => {
		const toolName = (event as any).toolName;
		for (const t of dash.toolTokens) {
			if (t.name === toolName) {
				t.active = false;
				break;
			}
		}
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	// ── Model / thinking changes ─────────────────────────────────────

	pi.on("model_select", async (event) => {
		dash.model = `${event.model.provider}/${event.model.id}`;
		dash.contextWindow = event.model.contextWindow ?? dash.contextWindow;
		dash.collectToolInfo(pi);
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	pi.on("thinking_level_select", async (event) => {
		dash.thinkingLevel = (event as any).level ?? "off";
		pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
	});

	// ── Fallback registration ────────────────────────────────────────
	//
	// The framework resets its registry on ITS session_start and then emits
	// "sidepanel:ready". If this extension's session_start handler ran first,
	// the registration was wiped — re-register unconditionally (a guard on
	// `registered` would skip the recovery; it's already true). Registration
	// is idempotent: the framework dedups by id.

	pi.events.on("sidepanel:ready", () => {
		registered = false;
		registerTab();
	});
}
