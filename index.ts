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
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

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

		// Capture current thinking level (survives reconnect)
		try {
			dash.thinkingLevel = (pi as any).getThinkingLevel?.() ?? "off";
		} catch {
			// getThinkingLevel not available
		}

		dash.collectToolInfo(pi);

		// Replay replied token totals from session history
		const autoSkills = new Set<string>();
		try {
			const entries = ctx.sessionManager.getEntries() as Array<{
				type: string;
				message?: {
					role: string;
					usage?: { input?: number; output?: number };
					content?: Array<{ type: string; thinking?: string }>;
				};
			}>;
			const capped = entries.slice(-100);
			let totalThinking = 0;
			let totalOutput = 0;
			for (const e of capped) {
				if (e.type !== "message") continue;
				const m = e.message;
				if (!m) continue;
				if (m.role === "assistant") {
					if (m.usage) {
						const output = m.usage.output ?? 0;
						totalOutput += output;
					}
					if (Array.isArray(m.content)) {
						for (const block of m.content) {
							if (
								block.type === "thinking" &&
								typeof (block as any).thinking === "string"
							) {
								totalThinking += est((block as any).thinking);
							}
							if (block.type === "toolCall" && (block as any).name === "read") {
								const p = (block as any).arguments?.path;
								if (p) {
									const re = /\/skills\/([\w-]+)(?:\/SKILL)?\.md$/i;
									const match = re.exec(p);
									if (match) autoSkills.add(match[1]!);
								}
							}
						}
					}
				}
			}
			dash.replyThinking = totalThinking;
			dash.replyOutput = totalOutput;
			dash.replyOther = Math.max(0, totalOutput - totalThinking);
		} catch {
			// Replay failed
		}

		// Read skill names from manual-skills.json (written by skills tab)
		// and add them in parallel — explicit first (priority), then auto.
		let explicitSet = new Set<string>();
		try {
			const mp = path.join(os.homedir(), ".pi", "agent", "manual-skills.json");
			explicitSet = new Set(JSON.parse(await fs.readFile(mp, "utf-8")));
		} catch {}
		const promises: Promise<void>[] = [];
		for (const name of explicitSet) {
			promises.push(addSkillFromDisk(name, true));
		}
		for (const name of autoSkills) {
			if (!explicitSet.has(name)) {
				promises.push(addSkillFromDisk(name, false));
			}
		}
		await Promise.all(promises);

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

		// Capture current thinking level
		try {
			dash.thinkingLevel = (pi as any).getThinkingLevel?.() ?? "off";
		} catch {
			// getThinkingLevel not available
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

		// Capture reply token breakdown from the assistant message
		const msg = (_event as any).message;
		if (msg?.role === "assistant" && msg.usage) {
			const output = msg.usage.output ?? 0;
			let thinking = 0;
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "thinking" && typeof block.thinking === "string") {
						thinking += est(block.thinking);
					}
				}
			}
			dash.replyThinking += thinking;
			dash.replyOutput += output;
			dash.replyOther = Math.max(0, dash.replyOutput - dash.replyThinking);
		}
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

	// ── Skill detection: input + tool events ─────────────────────

	// Helper: read a skill's SKILL.md and add it to the dash.
	async function addSkillFromDisk(
		name: string,
		explicit: boolean,
	): Promise<void> {
		const mdPath = path.join(
			os.homedir(),
			".pi",
			"agent",
			"skills",
			name,
			"SKILL.md",
		);
		try {
			const content = await fs.readFile(mdPath, "utf-8");
			dash.addSkillEntry(name, est(content), explicit);
		} catch {
			dash.addSkillEntry(name, 0, explicit);
		}
	}

	// 1. User types /skill:NAME — read the file and show it live
	pi.on("input", async (event, _ctx) => {
		const re = /\/skill:([\w-]+)/g;
		let match: RegExpExecArray | null;
		let found = false;
		while ((match = re.exec(event.text)) !== null) {
			await addSkillFromDisk(match[1]!, true);
			found = true;
		}
		if (found) {
			pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
		}
	});

	// 2. Agent reads a SKILL.md — show it as auto-loaded
	pi.on("tool_call", async (event) => {
		if ((event as any).toolName !== "read") return;
		const p = ((event as any).input as { path?: string })?.path;
		if (!p) return;
		const re = /\/skills\/([\w-]+)(?:\/SKILL)?\.md$/i;
		const m = re.exec(p);
		if (m) {
			// Don't override explicit if it was already set by /skill:NAME
			const existing = dash.skillEntries.find((s) => s.name === m[1]!);
			await addSkillFromDisk(m[1]!, existing?.explicit ?? false);
			pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
		}
	});

	// 3. SKILL.md read result arrives — update the char count
	pi.on("tool_result", async (event) => {
		if ((event as any).toolName !== "read") return;
		const p = ((event as any).input as { path?: string })?.path;
		if (!p) return;
		const re = /\/skills\/([\w-]+)(?:\/SKILL)?\.md$/i;
		const m = re.exec(p);
		if (!m) return;
		const content = ((event as any).content ?? []) as Array<{
			type: string;
			text?: string;
		}>;
		const rawText = content
			.filter((c: { type: string }) => c.type === "text")
			.map((c: { text?: string }) => c.text ?? "")
			.join("");
		if (rawText) {
			// Update the token count from the actual read content (more
			// accurate than the file-on-disk estimate)
			const existing = dash.skillEntries.find((s) => s.name === m[1]!);
			if (existing) {
				existing.tokens = est(rawText);
			} else {
				dash.addSkillEntry(m[1]!, est(rawText), false);
			}
			pi.events.emit("sidepanel:invalidate", { tabId: "dash" });
		}
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
