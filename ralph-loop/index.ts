/**
 * Ralph Loop Extension for PI
 *
 * A plan-driven iterative coding loop.
 *
 * Commands (session-based, fine for planning):
 *   /ralph plan [desc]  → Start planning conversation
 *   /ralph tasks        → Generate task breakdown
 *   /ralph edit         → Edit plan in editor
 *
 * Tool (execution via spawned pi processes):
 *   ralph_loop           → Read plan, spawn pi for each task, stream results
 *
 * Workflow:
 *   1. /ralph plan [description] → Discuss requirements
 *   2. /ralph tasks             → Generate task breakdown
 *   3. /ralph start             → Trigger ralph_loop tool
 *   4. Tool executes sequentially, updating plan.md
 *
 * State management:
 *   - .ralph/plan.md is source of truth (task completion tracked via checkboxes)
 *   - .ralph/log.md updated for history
 *
 * Execution:
 *   - ralph_loop tool reads plan.md, finds unchecked tasks
 *   - For each task, spawns `pi --mode json` with task prompt
 *   - Parses JSON events, streams progress via onUpdate
 *   - After each task, checks plan.md, auto-commits
 *   - Supports --max-retries, --max-iterations
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";
import { findNextUncheckedTask, parsePlan, type RalphTask } from "./plan-parser.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const RALPH_DIR = ".ralph";
const PLAN_FILE = `${RALPH_DIR}/plan.md`;
const LOG_FILE = `${RALPH_DIR}/log.md`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RalphLoopDetails {
	mode: "loop";
	iteration: number;
	currentTaskIndex: number;
	maxRetries: number;
	maxIterations: number;
	currentTask: RalphTask | null;
	results: TaskResult[];
}

interface TaskResult {
	taskIndex: number;
	taskTitle: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	messages: Message[];
	usage: UsageStats;
	commit?: string;
	agentName?: string;
	model?: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

// ─── Helpers: File I/O ──────────────────────────────────────────────────────

async function readFile(filePath: string): Promise<string | null> {
	try {
		return await fs.promises.readFile(filePath, "utf-8");
	} catch {
		return null;
	}
}

async function writeFile(filePath: string, content: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	});
}

async function ensureRalphDir(pi: ExtensionAPI): Promise<void> {
	if (!fs.existsSync(RALPH_DIR)) {
		await pi.exec("mkdir", ["-p", RALPH_DIR]);
	}
	// Ensure .ralph/ is gitignored
	const gitignorePath = ".gitignore";
	if (fs.existsSync(gitignorePath)) {
		const { code } = await pi.exec("grep", ["-qF", ".ralph/", gitignorePath]);
		if (code !== 0) {
			await fs.promises.appendFile(gitignorePath, "\n# Ralph loop state\n.ralph/\n", "utf-8");
		}
	} else {
		await writeFile(gitignorePath, "# Ralph loop state\n.ralph/\n");
	}
}

// ─── Helpers: Git ───────────────────────────────────────────────────────────

async function autoCommit(pi: ExtensionAPI, task: RalphTask): Promise<string | null> {
	const { code: gitCheck } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (gitCheck !== 0) return null;

	// Stage everything, then unstage .ralph/ so it's never committed
	await pi.exec("git", ["add", "-A"]);
	await pi.exec("git", ["reset", "HEAD", "--", ".ralph/"]);

	// Check if there's anything staged
	const { stdout: diff } = await pi.exec("git", ["diff", "--cached", "--stat"]);
	if (!diff.trim()) return null;

	const msg = `ralph(${task.index}): ${task.title}`;
	const { code: commitCode } = await pi.exec("git", ["commit", "-m", msg]);
	if (commitCode !== 0) return null;

	const { stdout: hash } = await pi.exec("git", ["rev-parse", "--short", "HEAD"]);
	return hash.trim();
}

// ─── Helpers: Log ───────────────────────────────────────────────────────────

async function appendLog(pi: ExtensionAPI, iteration: number, task: RalphTask, result: string, commit: string | null): Promise<void> {
	await ensureRalphDir(pi);
	const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
	const logEntry = `| ${iteration} | ${task.title} | ${result} | ${commit || "-"} | ${timestamp} |\n`;

	await withFileMutationQueue(LOG_FILE, async () => {
		if (!fs.existsSync(LOG_FILE)) {
			const header = `# Ralph Loop Log\n\n| # | Task | Result | Commit | Time |\n|---|---|---|---|---|\n`;
			await fs.promises.appendFile(LOG_FILE, header + logEntry, "utf-8");
		} else {
			await fs.promises.appendFile(LOG_FILE, logEntry, "utf-8");
		}
	});
}

// ─── Helpers: pi invocation ─────────────────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ─── Helpers: Temp file for prompt ─────────────────────────────────────────

async function writePromptToTempFile(taskIndex: number, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ralph-task-"));
	const filePath = path.join(tmpDir, `task-${taskIndex}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function cleanupTempDir(tmpDir: string | null): void {
	if (!tmpDir) return;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

// ─── Helpers: Task prompt ───────────────────────────────────────────────────

function buildTaskPrompt(task: RalphTask, planContent: string, iteration: number, totalTasks: number, retry: number, maxRetries: number): string {
	const retryStr = retry > 0 ? `, Retry ${retry}/${maxRetries}` : "";
	return `[RALPH LOOP - Iteration ${iteration}, Task ${task.index}/${totalTasks}${retryStr}]

## Your Plan
${planContent}

## Current Task
Task ${task.index}: ${task.title}
Acceptance: ${task.acceptance}

## Instructions
1. Work ONLY on the current task above.
2. When the task meets its acceptance criteria, mark it as done by changing \`- [ ] ${task.index}.\` to \`- [x] ${task.index}.\` in \`.ralph/plan.md\`.
3. Do NOT work on other tasks.
4. Run any test/validation commands specified in the Standards section.
5. If you genuinely cannot complete this task, explain why clearly.`;
}

// ─── Helpers: Progress formatting ─────────────────────────────────────────

function formatProgressHeader(
	task: RalphTask,
	totalTasks: number,
	doneTasks: number,
	retry: number,
	maxRetries: number,
	agentName?: string,
): string {
	const bar = buildProgressBar(doneTasks, totalTasks, 20);
	const retryStr = retry > 0 ? ` (retry ${retry}/${maxRetries})` : "";
	const agentStr = agentName ? ` [agent: ${agentName}]` : "";
	return `${bar} ${doneTasks}/${totalTasks} done\n` +
		`▶ Task ${task.index}: ${task.title}${retryStr}${agentStr}`;
}

function buildProgressBar(done: number, total: number, width: number): string {
	const filled = total > 0 ? Math.round((done / total) * width) : 0;
	return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Run single task via pi --mode json ────────────────────────────────────

async function runTask(
	pi: ExtensionAPI,
	cwd: string,
	task: RalphTask,
	planContent: string,
	iteration: number,
	totalTasks: number,
	retry: number,
	maxRetries: number,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<RalphLoopDetails>) => void) | undefined,
	makeDetails: (results: TaskResult[], currentTask: RalphTask | null, iteration: number, currentTaskIndex: number) => RalphLoopDetails,
	currentResults: TaskResult[],
	currentTaskIndex: number,
	doneTasks: number,
	agentConfig?: AgentConfig,
): Promise<TaskResult> {
	const prompt = buildTaskPrompt(task, planContent, iteration, totalTasks, retry, maxRetries);

	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	// Apply agent-specific model and tools
	if (agentConfig?.model) args.push("--model", agentConfig.model);
	if (agentConfig?.tools && agentConfig.tools.length > 0) args.push("--tools", agentConfig.tools.join(","));

	// Write agent system prompt to temp file if present
	let tmpPromptDir: string | null = null;
	if (agentConfig?.systemPrompt?.trim()) {
		try {
			const tmp = await writePromptToTempFile(task.index, agentConfig.systemPrompt);
			tmpPromptDir = tmp.dir;
			args.push("--append-system-prompt", tmp.filePath);
		} catch (err) {
			console.error("[ralph] Failed to create temp prompt file:", err);
		}
	}

	// Pass the task prompt as a positional argument (the user message)
	args.push(prompt);

	const invocation = getPiInvocation(args);

	const result: TaskResult = {
		taskIndex: task.index,
		taskTitle: task.title,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		agentName: agentConfig?.name,
		model: agentConfig?.model,
	};

	let wasAborted = false;
	let buffer = "";

	const progressHeader = formatProgressHeader(task, totalTasks, doneTasks, retry, maxRetries, agentConfig?.name);

	const emitUpdate = () => {
		if (onUpdate) {
			const agentOutput = getFinalOutput(result.messages);
			const body = agentOutput ? `\n\n${agentOutput}` : "\n\n(running...)";
			onUpdate({
				content: [{ type: "text", text: progressHeader + body }],
				details: makeDetails([...currentResults, result], task, iteration, currentTaskIndex),
			});
		}
	};

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				result.messages.push(msg);

				if (msg.role === "assistant") {
					result.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
				}
				emitUpdate();
			}

			if (event.type === "tool_result_end" && event.message) {
				result.messages.push(event.message as Message);
				emitUpdate();
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			console.error("[ralph] pi stderr:", data.toString());
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", (err) => {
			result.errorMessage = `Failed to spawn pi: ${err.message}`;
			resolve(1);
		});

		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});

	result.exitCode = exitCode;
	if (wasAborted) result.stopReason = "aborted";

	cleanupTempDir(tmpPromptDir);

	return result;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

// ─── Helpers: Load tasks from plan ─────────────────────────────────────────

async function loadTasksFromPlan(): Promise<{ tasks: RalphTask[]; planContent: string } | null> {
	const content = await readFile(PLAN_FILE);
	if (!content) return null;
	const tasks = parsePlan(content);
	return { tasks, planContent: content };
}

// ─── Main Extension ─────────────────────────────────────────────────────────

export default function ralphLoop(pi: ExtensionAPI) {

	// ─── Commands (session-based, fine for planning) ───────────────────────

	pi.registerCommand("ralph", {
		description: "Ralph loop: plan | tasks | edit | start | stop | status",
		getArgumentCompletions: (prefix) => {
			const subs = ["plan", "tasks", "edit", "start", "stop", "status"];
			const filtered = subs.filter(s => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map(s => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "";
			const rest = parts.slice(1);

			switch (sub) {
				case "plan":
					return handlePlan(pi, rest.join(" "), ctx);
				case "tasks":
					return handleTasks(pi, rest, ctx);
				case "edit":
					return handleEdit(pi, ctx);
				case "start":
					return handleStart(pi, rest, ctx);
				case "stop":
					return handleStop(pi, ctx);
				case "status":
					return handleStatus(pi, ctx);
				default:
					ctx.ui.notify(
						"Usage:\n  /ralph plan [description]  — Start planning conversation\n  /ralph tasks  — Generate task breakdown from discussion\n  /ralph edit  — Edit plan in editor\n  /ralph start [--max-retries N] [--max-iterations N]  — Start the loop\n  /ralph stop  — Stop the loop\n  /ralph status  — Show progress",
						"info"
					);
			}
		},
	});

	// ─── Command: /ralph plan ──────────────────────────────────────────────

	async function handlePlan(pi: ExtensionAPI, description: string, ctx: ExtensionCommandContext): Promise<void> {
		const existingPlan = await readFile(PLAN_FILE);
		if (existingPlan) {
			const choice = await ctx.ui.select("A plan already exists.", [
				"Start fresh (replace)",
				"Edit existing plan in editor",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return;
			if (choice === "Edit existing plan in editor") {
				const edited = await ctx.ui.editor("Edit your plan:", existingPlan);
				if (edited && edited.trim()) {
					await ensureRalphDir(pi);
					await writeFile(PLAN_FILE, edited);
					const tasks = parsePlan(edited);
					ctx.ui.notify(`Plan updated. ${tasks.length} tasks. Run /ralph start to begin.`, "info");
				}
				return;
			}
		}

		const featureDesc = description.trim();
		const prompt = featureDesc
			? `I want to plan a feature: ${featureDesc}

Before writing any plan or code, you must do thorough discovery:

1. **Research the codebase** — Read relevant files, search for related patterns, understand the existing architecture, conventions, and dependencies. Identify where this feature fits in.
2. **Research the web** — If the feature involves external libraries, APIs, protocols, or concepts you're unsure about, search the web to understand current best practices and constraints.
3. **Ask me questions** — Based on your research, ask targeted questions about requirements, edge cases, scope, and priorities. Don't assume — clarify ambiguities.

Your goal is to deeply understand what needs to be built and why before proposing anything. Only once you have a clear picture should we move to task breakdown (via /ralph tasks).

Do NOT write a plan yet. Start with discovery and questions.`
			: `I want to plan a feature. Before we begin:

1. **Ask me what I'm building** — Understand the goal and motivation.
2. **Research the codebase** — Once you know the feature, explore the relevant code, architecture, and conventions.
3. **Research the web** — Look up any external libraries, APIs, or patterns that are relevant.
4. **Ask follow-up questions** — Clarify requirements, edge cases, scope, and priorities.

Your goal is thorough discovery before any planning. Do NOT write a plan yet — just help us define what needs to be built.`;

		pi.sendUserMessage(prompt);
	}

	// ─── Command: /ralph tasks ──────────────────────────────────────────────

	async function handleTasks(pi: ExtensionAPI, _args: string[], ctx: ExtensionCommandContext): Promise<void> {
		pi.sendUserMessage(`Based on everything we've discussed, generate the full plan now.

Write it to \`.ralph/plan.md\` using this exact format:

\`\`\`markdown
# Feature: <name>

## Goal
<one paragraph summary of what we're building>

## Context
<relevant files, tech stack, constraints from our discussion>

## Tasks
- [ ] 1. <task title>
  - Acceptance: <what "done" looks like>
- [ ] 2. <task title>
  - Acceptance: <criteria>
(add as many tasks as needed)

## Standards
<testing requirements, code patterns, rules from our discussion>
\`\`\`

Create the \`.ralph/\` directory first if it doesn't exist. Write the complete plan — don't leave placeholders.`);
	}

	// ─── Command: /ralph edit ──────────────────────────────────────────────

	async function handleEdit(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
		const existing = await readFile(PLAN_FILE);
		if (!existing) {
			ctx.ui.notify("No plan found. Run /ralph plan first.", "warning");
			return;
		}
		const edited = await ctx.ui.editor("Edit your plan:", existing);
		if (edited && edited.trim()) {
			await ensureRalphDir(pi);
			await writeFile(PLAN_FILE, edited);
			const tasks = parsePlan(edited);
			ctx.ui.notify(`Plan updated. ${tasks.length} tasks. Run /ralph start to begin.`, "info");
		}
	}

	// ─── Command: /ralph start ─────────────────────────────────────────────

	async function handleStart(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
		let maxRetries = 3;
		let maxIterations = 0;
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--max-retries" && args[i + 1]) {
				maxRetries = parseInt(args[i + 1], 10) || 3;
				i++;
			} else if (args[i] === "--max-iterations" && args[i + 1]) {
				maxIterations = parseInt(args[i + 1], 10) || 0;
				i++;
			}
		}

		if (!fs.existsSync(PLAN_FILE)) {
			ctx.ui.notify("No plan found. Run /ralph plan first to create one.", "warning");
			return;
		}

		const loaded = await loadTasksFromPlan();
		if (!loaded || loaded.tasks.length === 0) {
			ctx.ui.notify("Plan has no parseable tasks. Check .ralph/plan.md format.", "warning");
			return;
		}

		const { tasks } = loaded;
		const firstUnchecked = findNextUncheckedTask(tasks);
		if (!firstUnchecked) {
			ctx.ui.notify("All tasks are already done!", "info");
			return;
		}

		ctx.ui.notify(
			`Ralph loop starting. ${tasks.filter(t => !t.done).length} tasks remaining.\n` +
			`Options: max-retries=${maxRetries}, max-iterations=${maxIterations || "unlimited"}`,
			"info"
		);

		pi.sendUserMessage(`Start the Ralph loop execution now.

Use the ralph_loop tool with these options:
- maxRetries: ${maxRetries}
- maxIterations: ${maxIterations || 0}

Execute tasks sequentially, marking each complete in .ralph/plan.md as you finish them.`);
	}

	// ─── Command: /ralph stop ──────────────────────────────────────────────

	async function handleStop(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
		ctx.ui.notify("To stop the loop, use Ctrl+C. The plan and log are preserved.", "info");
	}

	// ─── Command: /ralph status ───────────────────────────────────────────

	async function handleStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
		const loaded = await loadTasksFromPlan();
		if (!loaded || loaded.tasks.length === 0) {
			if (fs.existsSync(PLAN_FILE)) {
				ctx.ui.notify("Plan exists but has no parseable tasks. Check .ralph/plan.md format.", "warning");
			} else {
				ctx.ui.notify("No plan found. Run /ralph plan first.", "info");
			}
			return;
		}

		const { tasks } = loaded;
		const done = tasks.filter(t => t.done).length;
		const remaining = tasks.filter(t => !t.done).length;
		const current = findNextUncheckedTask(tasks);

		const lines = [
			`Tasks: ${done}/${tasks.length} completed`,
			remaining > 0 ? `Next: ${current?.index}. ${current?.title}` : "All tasks done!",
		].join("\n");

		ctx.ui.notify(`Ralph Loop Status\n${lines}`, "info");
	}

	// ─── Tool: ralph_loop ──────────────────────────────────────────────────

	pi.registerTool({
		name: "ralph_loop",
		label: "Ralph Loop",
		description: "Execute the Ralph loop: read plan, spawn pi for each task, stream results, auto-commit",
		parameters: Type.Object({
			maxRetries: Type.Optional(Type.Integer({ description: "Max retries per task (default: 3)", default: 3 })),
			maxIterations: Type.Optional(Type.Integer({ description: "Max total iterations (0 = unlimited, default: 0)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const maxRetries = params.maxRetries ?? 3;
			const maxIterations = params.maxIterations ?? 0;

			const makeDetails = (
				allResults: TaskResult[],
				currentTask: RalphTask | null,
				currentIteration: number,
				currentTaskIndex: number,
			): RalphLoopDetails => ({
				mode: "loop",
				iteration: currentIteration,
				currentTaskIndex,
				maxRetries,
				maxIterations,
				currentTask,
				results: allResults,
			});

			// Load plan
			const loaded = await loadTasksFromPlan();
			if (!loaded) {
				return {
					content: [{ type: "text", text: "No plan found. Create .ralph/plan.md first." }],
					details: makeDetails([], null, 0, -1),
					isError: true,
				};
			}

			let { tasks, planContent } = loaded;
			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "Plan has no parseable tasks. Check .ralph/plan.md format." }],
					details: makeDetails([], null, 0, -1),
					isError: true,
				};
			}

			// Discover agents for task→agent resolution
			const { agents } = discoverAgents(ctx.cwd, "both");
			const agentMap = new Map(agents.map(a => [a.name, a]));

			const results: TaskResult[] = [];
			const blockedTasks = new Set<number>();
			let iteration = 0;
			let lastTaskIndex: number | null = null;
			let retries = 0;

			onUpdate?.({
				content: [{ type: "text", text: `Starting Ralph loop. ${tasks.filter(t => !t.done).length} tasks to complete.` }],
				details: makeDetails([], null, 0, -1),
			});

			// Main loop
			while (true) {
				// Reload tasks from disk (agent may have modified them)
				const reloaded = await loadTasksFromPlan();
				if (reloaded) {
					tasks = reloaded.tasks;
					planContent = reloaded.planContent;
				}

				// Find next unchecked, non-blocked task
				const currentTask = tasks.find(t => !t.done && !blockedTasks.has(t.index)) ?? null;
				if (!currentTask) {
					const doneCount = tasks.filter(t => t.done).length;
					const bar = buildProgressBar(doneCount, tasks.length, 20);
					const msg = blockedTasks.size > 0
						? `${bar} ${doneCount}/${tasks.length} done\nAll remaining tasks are blocked.`
						: `${bar} ${doneCount}/${tasks.length} done\nAll tasks completed!`;
					onUpdate?.({
						content: [{ type: "text", text: msg }],
						details: makeDetails(results, null, iteration, -1),
					});
					break;
				}

				// Reset retries when moving to a different task
				if (currentTask.index !== lastTaskIndex) {
					retries = 0;
					lastTaskIndex = currentTask.index;
				}

				// Check max iterations
				iteration++;
				if (maxIterations > 0 && iteration > maxIterations) {
					onUpdate?.({
						content: [{ type: "text", text: `Max iterations (${maxIterations}) reached. Stopping.` }],
						details: makeDetails(results, currentTask, iteration, currentTask.index),
					});
					break;
				}

				// Resolve agent config from task's agent field
				const agentConfig = currentTask.agent ? agentMap.get(currentTask.agent) : undefined;

				const doneTasks = tasks.filter(t => t.done).length;
				const header = formatProgressHeader(currentTask, tasks.length, doneTasks, retries, maxRetries, agentConfig?.name);
				onUpdate?.({
					content: [{ type: "text", text: `${header}\n\nSpawning agent...` }],
					details: makeDetails(results, currentTask, iteration, currentTask.index),
				});

				// Run the task
				const taskResult = await runTask(
					pi,
					ctx.cwd,
					currentTask,
					planContent,
					iteration,
					tasks.length,
					retries,
					maxRetries,
					signal,
					onUpdate,
					makeDetails,
					results,
					currentTask.index,
					doneTasks,
					agentConfig,
				);
				results.push(taskResult);

				// Re-parse the plan file to check if task was marked complete
				const postTaskReload = await loadTasksFromPlan();
				const freshTask = postTaskReload?.tasks.find(t => t.index === currentTask.index);
				const taskCompleted = freshTask?.done ?? false;

				const isError = taskResult.exitCode !== 0 || taskResult.stopReason === "error" || taskResult.stopReason === "aborted";

				if (taskCompleted) {
					const commit = await autoCommit(pi, currentTask);
					taskResult.commit = commit ?? undefined;
					await appendLog(pi, iteration, currentTask, "done", commit);

					const newDone = doneTasks + 1;
					const doneBar = buildProgressBar(newDone, tasks.length, 20);
					onUpdate?.({
						content: [{ type: "text", text: `${doneBar} ${newDone}/${tasks.length} done\n✓ Task ${currentTask.index}: ${currentTask.title}${commit ? ` (${commit})` : ""}` }],
						details: makeDetails(results, currentTask, iteration, currentTask.index),
					});

					retries = 0;
					lastTaskIndex = null;
				} else {
					// Task not completed — either errored or agent didn't mark it done
					if (isError) {
						await appendLog(pi, iteration, currentTask, taskResult.stopReason || "failed", null);
					}

					retries++;
					if (retries >= maxRetries) {
						blockedTasks.add(currentTask.index);
						await appendLog(pi, iteration, currentTask, "blocked", null);
						const bar = buildProgressBar(doneTasks, tasks.length, 20);
						onUpdate?.({
							content: [{ type: "text", text: `${bar} ${doneTasks}/${tasks.length} done\n✗ Task ${currentTask.index} blocked after ${maxRetries} attempts: ${currentTask.title}` }],
							details: makeDetails(results, currentTask, iteration, currentTask.index),
						});
						retries = 0;
						lastTaskIndex = null;
					} else {
						const bar = buildProgressBar(doneTasks, tasks.length, 20);
						onUpdate?.({
							content: [{ type: "text", text: `${bar} ${doneTasks}/${tasks.length} done\n↻ Task ${currentTask.index}: ${currentTask.title} — retry ${retries}/${maxRetries}` }],
							details: makeDetails(results, currentTask, iteration, currentTask.index),
						});
					}
				}

				if (signal?.aborted) {
					onUpdate?.({
						content: [{ type: "text", text: "Ralph loop aborted." }],
						details: makeDetails(results, currentTask, iteration, currentTask.index),
					});
					break;
				}
			}

			// Summary — count unique tasks by final plan state
			const finalPlan = await loadTasksFromPlan();
			const totalTasks = finalPlan?.tasks.length ?? tasks.length;
			const completedCount = finalPlan?.tasks.filter(t => t.done).length ?? 0;
			const blockedCount = blockedTasks.size;
			const remainingCount = totalTasks - completedCount;

			const summary = `Ralph loop finished.\n` +
				`Tasks: ${completedCount}/${totalTasks} completed` +
				(blockedCount > 0 ? `, ${blockedCount} blocked` : "") +
				(remainingCount - blockedCount > 0 ? `, ${remainingCount - blockedCount} remaining` : "") +
				`, ${iteration} iterations.`;

			return {
				content: [{ type: "text", text: summary }],
				details: makeDetails(results, null, iteration, -1),
			};
		},
	});
}
