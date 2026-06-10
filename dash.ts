/**
 * pi-sidepanel-dash — Data model and rendering (no pi imports)
 *
 * Pure logic, dependency-free: the pi-tui utilities it needs are injected
 * by the entry point (index.ts), so this module is directly importable in
 * unit tests under plain `node --test`.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

/** Estimate token count from character count (same heuristic as pi core). */
export function est(s: string): number {
	return Math.ceil(s.length / 4);
}

/** Format token count for display. */
export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}

/** Render a █░ bar for percentage visualization. Clamps to [0, w] —
 *  estimates can exceed 100% (e.g. system-prompt estimate > reported
 *  total early in a session) and a negative repeat() would throw. */
export function pctBar(pct: number, w: number): string {
	const f = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
	return "█".repeat(f) + "░".repeat(w - f);
}

// ── Theme helpers ─────────────────────────────────────────────────────────

export interface ThemeColors {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

const defaultTheme: ThemeColors = {
	fg: (_c, s) => s,
	bg: (_c, s) => s,
	bold: (s) => s,
};

// ── Injected pi-tui utilities ─────────────────────────────────────────────

export interface DashTuiUtils {
	truncateToWidth: (
		s: string,
		width: number,
		ellipsis?: string,
		pad?: boolean,
	) => string;
}

// ── Tool info ─────────────────────────────────────────────────────────────

export interface ToolEntry {
	name: string;
	tokens: number;
	active: boolean;
}

/** The slice of ExtensionAPI that collectToolInfo needs. */
export interface ToolSource {
	getAllTools(): unknown[];
	getActiveTools(): string[];
}

// ── DashComponent ─────────────────────────────────────────────────────────

export class DashComponent {
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
	private utils: DashTuiUtils;

	// cache (keyed by width AND height so a vertical resize re-renders)
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];

	constructor(utils: DashTuiUtils) {
		this.utils = utils;
	}

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
	collectToolInfo(pi: ToolSource): void {
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

	render(width: number, height = 40): string[] {
		const H = Math.max(3, Math.floor(height));
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedHeight === H
		)
			return this.cachedLines;

		const { truncateToWidth } = this.utils;
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

		// Two-line keymap footer, pinned to the bottom of the viewport.
		while (lines.length < H - 2) lines.push("");
		lines.push(th.fg("dim", truncateToWidth(" read-only overview", width, "")));
		lines.push(
			th.fg(
				"dim",
				truncateToWidth(
					"  ctrl+t blocks │ shift+tab level │ ctrl+p model │ ctrl+n session │ ctrl+o tools",
					width,
					"",
				),
			),
		);

		this.cachedWidth = width;
		this.cachedHeight = H;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
	}
}
