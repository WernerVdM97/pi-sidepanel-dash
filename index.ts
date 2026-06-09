/**
 * pi-sidepanel-dash — Session dashboard tab for pi-sidepanel
 *
 * Merges the standalone /context and /dash commands into a single
 * sidepanel tab. Shows goal, session metadata, context budget
 * breakdown, and top tool definitions by token cost.
 *
 * Registers via `sidepanel:register` — requires pi-sidepanel.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Estimate token count from character count (same heuristic as pi core). */
function est(s: string): number {
	return Math.ceil(s.length / 4);
}

/** Format token count for display. */
function fmtTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}

/** Render a █░ bar for percentage visualization. */
function pctBar(pct: number, w: number): string {
	const f = Math.round((pct / 100) * w);
	return "█".repeat(f) + "░".repeat(w - f);
}

// ── Theme helpers ─────────────────────────────────────────────────────────

interface ThemeColors {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

const defaultTheme: ThemeColors = {
	fg: (_c, s) => s,
	bg: (_c, s) => s,
	bold: (s) => s,
};

// ── Tool info ─────────────────────────────────────────────────────────────

interface ToolEntry {
	name: string;
	tokens: number;
	active: boolean;
}

// ── DashComponent ─────────────────────────────────────────────────────────

class DashComponent {
	// ── State ─────────────────────────────────────────────────────────

	goal = "";
	model = "—";
	turn = 0;
	thinkingLevel = "off";
	tokensTotal = 0;
	contextWindow = 200_000;
	systemPromptTokens = 0;
	toolTokens: ToolEntry[] = [];
	conversationTokens = 0;

	private theme: ThemeColors | null = null;

	// cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor() {}

	reset(): void {
		this.goal = "";
		this.model = "—";
		this.turn = 0;
		this.thinkingLevel = "off";
		this.tokensTotal = 0;
		this.contextWindow = 200_000;
		this.systemPromptTokens = 0;
		this.toolTokens = [];
		this.conversationTokens = 0;
		this.invalidate();
	}

	setTheme(theme: ThemeColors): void {
		this.theme = theme;
	}

	/** Collect tool definitions from pi (call on before_agent_start, model changes). */
	collectToolInfo(pi: ExtensionAPI): void {
		const allTools = pi.getAllTools();
		const activeSet = new Set(pi.getActiveTools());
		this.toolTokens = allTools
			.map((t: any) => ({
				name: t.name,
				tokens:
					est(t.description ?? "") + est(JSON.stringify(t.parameters ?? {})),
				active: activeSet.has(t.name),
			}))
			.sort((a: ToolEntry, b: ToolEntry) => b.tokens - a.tokens);
	}

	/** Recompute conversation tokens as remainder. */
	private recomputeConversation(): void {
		const toolTotal = this.toolTokens.reduce((s, t) => s + t.tokens, 0);
		this.conversationTokens = Math.max(
			0,
			this.tokensTotal - this.systemPromptTokens - toolTotal,
		);
	}

	// ── Component interface ──────────────────────────────────────────

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme ?? defaultTheme;
		const lines: string[] = [];
		const barW = Math.min(14, Math.max(6, width - 28));

		this.recomputeConversation();

		// ── 🎯 Goal ──────────────────────────────────────────────────
		if (this.goal) {
			lines.push(" " + th.fg("accent", th.bold("🎯 Goal")));
			const goalText = this.goal.replace(/\n/g, " ").trim();
			lines.push(
				"  " + th.fg("text", truncateToWidth(goalText, width - 3, "…", false)),
			);
			lines.push("");
		}

		// ── 🧠 Session ────────────────────────────────────────────────
		lines.push(" " + th.fg("accent", th.bold("🧠 Session")));
		lines.push("  " + th.fg("muted", "Model: ") + th.fg("text", this.model));
		lines.push(
			"  " +
				th.fg("muted", "Turn:  ") +
				th.fg("text", String(this.turn)) +
				th.fg("dim", "  ·  Lvl: ") +
				th.fg("text", this.thinkingLevel),
		);
		lines.push("");

		// ── 📊 Context ────────────────────────────────────────────────
		lines.push(" " + th.fg("accent", th.bold("📊 Context")));
		if (this.tokensTotal > 0) {
			const pct = Math.min(
				100,
				Math.round((this.tokensTotal / this.contextWindow) * 100),
			);
			const col = pct > 80 ? "warning" : "text";
			lines.push(
				"  " +
					th.fg(col, fmtTokens(this.tokensTotal)) +
					th.fg("dim", " / " + fmtTokens(this.contextWindow)) +
					"  " +
					pctBar(pct, barW) +
					"  " +
					th.fg("dim", pct + "%"),
			);
		} else {
			lines.push("  " + th.fg("dim", "No context data yet"));
		}
		lines.push("");

		// ── Breakdown ─────────────────────────────────────────────────
		const hasBreakdown =
			this.systemPromptTokens > 0 ||
			this.toolTokens.length > 0 ||
			this.conversationTokens > 0;

		if (hasBreakdown) {
			lines.push(" " + th.fg("muted", "Breakdown"));

			// System prompt
			if (this.systemPromptTokens > 0) {
				const spPct =
					this.tokensTotal > 0
						? Math.round((this.systemPromptTokens / this.tokensTotal) * 100)
						: 0;
				lines.push(
					"  " +
						th.fg("muted", "System:") +
						"  " +
						th.fg("text", fmtTokens(this.systemPromptTokens)) +
						th.fg("dim", " (" + spPct + "%)") +
						"  " +
						pctBar(spPct, barW),
				);
			}

			// Tool definitions
			const toolTotal = this.toolTokens.reduce((s, t) => s + t.tokens, 0);
			const tPct =
				this.tokensTotal > 0
					? Math.round((toolTotal / this.tokensTotal) * 100)
					: 0;
			lines.push(
				"  " +
					th.fg("muted", "Tools:") +
					"  " +
					th.fg("text", fmtTokens(toolTotal)) +
					th.fg("dim", " (" + tPct + "%)") +
					"  " +
					pctBar(tPct, barW),
			);

			// Top 5 tools by token cost
			const topTools = this.toolTokens.slice(0, 5);
			for (const tool of topTools) {
				const icon = tool.active ? th.fg("success", " ●") : th.fg("dim", " ○");
				const toolPct =
					toolTotal > 0 ? Math.round((tool.tokens / toolTotal) * 100) : 0;
				const nameW = Math.max(1, width - 24);
				const nameDisplay = truncateToWidth(tool.name, nameW, "…", false);
				const pctStr = toolPct >= 3 ? th.fg("dim", " (" + toolPct + "%)") : "";
				lines.push(
					"  " +
						icon +
						" " +
						th.fg("text", nameDisplay) +
						"  " +
						th.fg("dim", fmtTokens(tool.tokens)) +
						pctStr,
				);
			}

			// Conversation
			if (this.conversationTokens > 0) {
				const cPct =
					this.tokensTotal > 0
						? Math.round((this.conversationTokens / this.tokensTotal) * 100)
						: 0;
				lines.push(
					"  " +
						th.fg("muted", "Conv:") +
						"   " +
						th.fg("text", fmtTokens(this.conversationTokens)) +
						th.fg("dim", " (" + cPct + "%)") +
						"  " +
						pctBar(cPct, barW),
				);
			}
		}

		// Keymap footer
		lines.push(
			th.fg(
				"dim",
				truncateToWidth(" read-only overview", width, ""),
			),
		);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ── Extension entry point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const dash = new DashComponent();
	let registered = false;

	function registerTab(): void {
		if (registered) return;
		registered = true;

		try {
			const themedComponent = {
				handleInput(): void {
					// Read-only display — no input handling needed
				},
				render(width: number): string[] {
					return dash.render(width);
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
		const usage = (ctx as any).getContextUsage() as any;
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
		const usage = (ctx as any).getContextUsage() as any;
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

	pi.events.on("sidepanel:ready", () => {
		if (!registered) registerTab();
	});
}
