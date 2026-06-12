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

/** Strip ANSI escape sequences for measuring visible width. */
const ANSI_RE = /\x1b\[[0-9;?=]*[A-Za-z]/g;
export function visibleWidth(s: string): number {
	return s.replace(ANSI_RE, "").length;
}

/** Format token count for display. */
export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
	return String(n);
}

/** Apply themed color to a bar segment based on percentage range. */
export function colorBarSegment(
	th: ThemeColors,
	pct: number,
	barChar: string,
): string {
	let col: string;
	if (pct <= 40) col = "success";
	else if (pct <= 60) col = "warning";
	else if (pct <= 80) col = "accent";
	else col = "error";
	return th.fg(col, barChar);
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

/** Skill entry tracked by the dash for breakdown display. */
export interface SkillEntry {
name: string;
tokens: number;
/** Whether the skill was explicitly invoked by user */
explicit: boolean;
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
	skillEntries: SkillEntry[] = [];
	conversationTokens = 0;

	// Response token breakdown
	replyThinking = 0;
	replyOutput = 0;
	replyOther = 0;

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
		this.skillEntries = [];
		this.conversationTokens = 0;
		this.replyThinking = 0;
		this.replyOutput = 0;
		this.replyOther = 0;
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

	/** Record a skill load with its token estimate. Deduplicates by name. */
	addSkillEntry(name: string, tokens: number, explicit: boolean): void {
		const existing = this.skillEntries.find((s) => s.name === name);
		if (existing) {
			existing.tokens = Math.max(existing.tokens, tokens);
			existing.explicit = existing.explicit || explicit;
		} else {
			this.skillEntries.push({ name, tokens, explicit });
		}
	}

	/** Recompute conversation tokens as remainder. */
	private recomputeConversation(): void {
		const toolTotal = this.toolTokens.reduce((s, t) => s + t.tokens, 0);
		// Skills are part of conversation context, shown as sub-list under Conv
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
		// Wider bars: scale with width, min 12, max 30
		const barW = Math.min(30, Math.max(12, Math.floor(width * 0.35)));

		this.recomputeConversation();

		// ── 🎯 Goal ──────────────────────────────────────────────────
		if (this.goal) {
			lines.push(th.fg("dim", "╭─" + th.bold("🎯 Goal") + "─" + "─".repeat(Math.max(0, width - 12))));
			const goalText = this.goal.replace(/\n/g, " ").trim();
			lines.push(
				"  " + th.fg("text", truncateToWidth(goalText, width - 3, "…", false)),
			);
			lines.push(th.fg("dim", "╰" + "─".repeat(width - 1)));
			lines.push("");
		}

		// ── 🧠 Session ────────────────────────────────────────────────
		lines.push(th.fg("dim", "╭─" + th.bold("🧠 Session") + "─" + "─".repeat(Math.max(0, width - 14))));
		lines.push("  " + th.fg("muted", "Model: ") + th.fg("text", this.model));
		const thinkEmoji = this.thinkingLevel === "off" ? "🔕" : "💭";
		lines.push(
			"  " +
				th.fg("muted", "Turn:  ") +
				th.fg("text", String(this.turn)) +
				th.fg("dim", "  ·  ") +
				thinkEmoji +
				" " +
				th.fg("text", this.thinkingLevel),
		);
		lines.push("");

		// ── 📊 Context ────────────────────────────────────────────────
		lines.push(th.fg("dim", "╭─" + th.bold("📊 Context") + "─" + "─".repeat(Math.max(0, width - 14))));
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
					colorBarSegment(th, pct, "█".repeat(Math.round((pct / 100) * barW))) +
					th.fg("dim", "░".repeat(barW - Math.round((pct / 100) * barW))) +
					"  " +
					th.fg("dim", pct + "%"),
			);
			// Cached: total replied minus active context
			const sent = this.replyOutput + this.replyThinking + this.replyOther;
			if (sent > this.tokensTotal) {
				const cached = sent - this.tokensTotal;
				lines.push("  " + th.fg("dim", "cache  ") + th.fg("muted", fmtTokens(cached) + " saved"));
			}
		} else {
			lines.push("  " + th.fg("dim", "No context data yet"));
		}
		lines.push(th.fg("dim", "╰" + "─".repeat(width - 1)));
		lines.push("");

		// ── 📤 Sent ─────────────────────────────────────────────────
		const toolTotal = this.toolTokens.reduce((s, t) => s + t.tokens, 0);
		const skillTotal = this.skillEntries.reduce((s, sk) => s + sk.tokens, 0);
		const hasSkills = skillTotal > 0 || this.skillEntries.length > 0;

		const hasSent =
			this.systemPromptTokens > 0 ||
			toolTotal > 0 ||
			this.conversationTokens > 0 ||
			hasSkills;

		if (hasSent && (this.tokensTotal > 0 || hasSkills)) {
			lines.push(th.fg("dim", "╭─" + th.bold("📤 Sent") + "─" + "─".repeat(Math.max(0, width - 11))));

			// Helper: render a row with right-aligned percentage
			const addRow = (
				label: string,
				tokens: number,
				pct: number,
			) => {
				const p = Math.min(100, pct);
				const filled = Math.min(barW, Math.round((p / 100) * barW));
				const tokenStr = fmtTokens(tokens);
				const pctStr = th.fg("dim", pct + "%");
				const lhs = `  ${label}  ${th.fg("text", tokenStr)}`;
				const lhsW = visibleWidth(lhs);
				const rhsW = visibleWidth(pctStr);
				const gap = Math.max(1, width - lhsW - barW - rhsW - 2);
				const bar = colorBarSegment(th, p, "█".repeat(filled)) +
					th.fg("dim", "░".repeat(barW - filled));
				lines.push(lhs + " ".repeat(gap) + bar + " " + pctStr);
			};

			// Build ordered items (by pct descending)
			interface SentItem {
				kind: "system" | "tools" | "conv";
				label: string;
				tokens: number;
				pct: number;
			}

			const items: SentItem[] = [];

			if (this.systemPromptTokens > 0) {
				items.push({
					kind: "system",
					label: th.fg("muted", "System:"),
					tokens: this.systemPromptTokens,
					pct: this.tokensTotal > 0
						? Math.round((this.systemPromptTokens / this.tokensTotal) * 100)
						: 0,
				});
			}

			if (toolTotal > 0) {
				items.push({
					kind: "tools",
					label: th.fg("muted", "Tools:"),
					tokens: toolTotal,
					pct: this.tokensTotal > 0
						? Math.round((toolTotal / this.tokensTotal) * 100)
						: 0,
				});
			}

			// Show Conv when there's conversation OR skills to display
			if (this.conversationTokens > 0 || hasSkills) {
				items.push({
					kind: "conv",
					label: th.fg("muted", "Conv:"),
					tokens: this.conversationTokens > 0 ? this.conversationTokens : skillTotal,
					pct: this.tokensTotal > 0
						? Math.round((this.conversationTokens / this.tokensTotal) * 100)
						: 0,
				});
			}

			// Sort by percentage descending
			items.sort((a, b) => b.pct - a.pct);

			for (const item of items) {
				addRow(item.label, item.tokens, item.pct);

				// Inline tool entries under the Tools row
				if (item.kind === "tools") {
					const MAX_TOOLS = 10;
					const topTools = this.toolTokens.slice(0, MAX_TOOLS);
					const moreCount = this.toolTokens.length - MAX_TOOLS;
					for (const tool of topTools) {
						const icon = tool.active
							? th.fg("success", " ●")
							: th.fg("dim", " ○");
						const tokenStr = th.fg("dim", fmtTokens(tool.tokens));
						const tokenVw = visibleWidth(tokenStr);
						const maxNameW = Math.max(1, width - 8 - tokenVw);
						const nameDisplay = truncateToWidth(tool.name, maxNameW, "…", false);
						const nameVw = visibleWidth(nameDisplay);
						const gap = Math.max(1, width - 5 - nameVw - tokenVw);
						lines.push(
							"  " + icon + " " + th.fg("text", nameDisplay) +
							" ".repeat(gap) + tokenStr,
						);
					}
					if (moreCount > 0) {
						lines.push(
							"   " + th.fg("dim", `+${moreCount} more…`),
						);
					}
				}

				// Inline skill entries under the Conv row
				if (item.kind === "conv" && hasSkills) {
					const MAX_SKILLS = 8;
					const topSkills = [...this.skillEntries]
						.sort((a, b) => b.tokens - a.tokens)
						.slice(0, MAX_SKILLS);
					const moreCount = this.skillEntries.length - MAX_SKILLS;
					for (const sk of topSkills) {
						const tag = sk.explicit
							? th.fg("accent", "/")
							: th.fg("success", "~");
						const tokenStr = sk.tokens > 0
							? th.fg("dim", fmtTokens(sk.tokens))
							: th.fg("dim", "—");
						const tokenVw = visibleWidth(tokenStr);
						const maxNameW = Math.max(1, width - 10 - tokenVw);
						const nameDisplay = truncateToWidth(sk.name, maxNameW, "…", false);
						const nameVw = visibleWidth(nameDisplay);
						const gap = Math.max(1, width - 6 - nameVw - tokenVw);
						lines.push(
							"   " + tag + " " + th.fg("text", nameDisplay) +
							" ".repeat(gap) + tokenStr,
						);
					}
					if (moreCount > 0) {
						lines.push(
							"   " + th.fg("dim", `+${moreCount} more…`),
						);
					}
				}
			}
			lines.push(th.fg("dim", "╰" + "─".repeat(width - 1)));
		}

		// ── 💬 Replied Tokens ─────────────────────────────────────
		const replyTotal = this.replyThinking + this.replyOutput + this.replyOther;
		if (replyTotal > 0) {
			lines.push(th.fg("dim", "╭─" + th.bold("💬 Replied") + "─" + "─".repeat(Math.max(0, width - 13))));
			lines.push("  " + th.fg("text", fmtTokens(replyTotal)) + th.fg("dim", " tokens · session total"));

			// Build ordered items by size descending
			const reItems: { label: string; tokens: number; pct: number }[] = [];
			if (this.replyOutput > 0) reItems.push({ label: th.fg("muted", "output"), tokens: this.replyOutput, pct: Math.round((this.replyOutput / replyTotal) * 100) });
			if (this.replyThinking > 0) reItems.push({ label: th.fg("muted", "thinking"), tokens: this.replyThinking, pct: Math.round((this.replyThinking / replyTotal) * 100) });
			if (this.replyOther > 0) reItems.push({ label: th.fg("muted", "overhead"), tokens: this.replyOther, pct: Math.round((this.replyOther / replyTotal) * 100) });
			reItems.sort((a, b) => b.tokens - a.tokens);

			for (const ri of reItems) {
				const p = Math.min(100, ri.pct);
				const filled = Math.min(barW, Math.round((p / 100) * barW));
				const tokenStr = fmtTokens(ri.tokens);
				const pctStr = th.fg("dim", ri.pct + "%");
				// Right-align like the breakdown: label + tokens left, bar + pct% right
				const lhs = `   ${ri.label}  ${th.fg("text", tokenStr)}`;
				const lhsW = visibleWidth(lhs);
				const rhsW = visibleWidth(pctStr);
				const gap = Math.max(1, width - lhsW - barW - rhsW - 2);
				const bar = colorBarSegment(th, p, "█".repeat(filled)) +
					th.fg("dim", "░".repeat(barW - filled));
				lines.push(lhs + " ".repeat(gap) + bar + " " + pctStr);
			}
			lines.push(th.fg("dim", "╰" + "─".repeat(width - 1)));
		}

		// Keymap footer, pinned to the bottom
		while (lines.length < H - 1) lines.push("");
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
