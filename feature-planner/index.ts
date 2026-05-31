/**
 * feature-planner — thin glue over @tintinweb/pi-subagents.
 *
 * File layout (per feature, all paths relative to pi's cwd):
 *   .pi/features/<slug>.md         Design doc (Goals / Design / Key Files / Edge Cases /
 *                                  Verification). Phase tracked in `> Status:` line.
 *                                  Subagents read this for design context.
 *   .pi/features/<slug>.tasks.md   Task checklist + completion tracker. Subagents read
 *                                  this to see their place in the plan and what's
 *                                  already done. Checkboxes flip on completion events
 *                                  (and from subagent self-marks where applicable);
 *                                  parent boxes roll up when children complete.
 *                                  Hand-editable.
 *   .pi/features/.current          Slug of the most recently touched feature.
 *
 * Two-phase workflow:
 *   Phase 1 (design):   /feature new <description>
 *                       Seeds <slug>.md scaffold. Parent agent + you iterate on the
 *                       design sections. No tasks file yet.
 *
 *   Phase 2 (tasks):    /feature plan [<slug>]
 *                       Once design is approved, creates <slug>.tasks.md and asks the
 *                       parent to fill it with a checklist (flat or with sub-tasks).
 *
 *   Execution:          /feature run [<slug>]
 *                       Parent fans out unchecked leaf tasks to background subagents.
 *                       Checkboxes in tasks file flip on completion; parent checkboxes
 *                       roll up when all children done; design-doc status flips to
 *                       `done` when all top-level tasks complete.
 *
 * Glue:
 *   Listens on `subagents:completed`. When description matches
 *   `feature:<slug> task:<id>`, flips that checkbox in <slug>.tasks.md, rolls up
 *   parents whose children are all done, optionally git-commits.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const AUTO_COMMIT = true;

type Phase = "design" | "tasks" | "running" | "done";

// ─── Slug + path ─────────────────────────────────────────────────────────────

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "feature";
}

/**
 * Walk up from cwd looking for the nearest `.pi/features/` directory. This
 * means commands work from any subdirectory of the project, not just the cwd
 * pi was launched in. If none is found and `fallbackCreate` is true, returns a
 * path under `cwd` (used by `/feature new`); otherwise returns null.
 */
function findFeaturesDir(startCwd: string, fallbackCreate: boolean): string | null {
	let cur = path.resolve(startCwd);
	for (;;) {
		const candidate = path.join(cur, ".pi", "features");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return fallbackCreate ? path.join(path.resolve(startCwd), ".pi", "features") : null;
}

// Module-level dir, refreshed at the entry point of each command and each
// event-handler firing. Command invocations are serialized by pi, so this is
// race-free in practice for our use; event handlers refresh from process.cwd().
let featuresDir = path.join(process.cwd(), ".pi", "features");

function refreshDir(cwd: string, fallbackCreate: boolean): boolean {
	const found = findFeaturesDir(cwd, fallbackCreate);
	if (!found) return false;
	featuresDir = found;
	return true;
}

const planPath = (slug: string) => path.join(featuresDir, `${slug}.md`);
const tasksPath = (slug: string) => path.join(featuresDir, `${slug}.tasks.md`);
const currentFile = () => path.join(featuresDir, ".current");
const ensureDir = () => fs.promises.mkdir(featuresDir, { recursive: true });

async function setCurrent(slug: string): Promise<void> {
	await ensureDir();
	await fs.promises.writeFile(currentFile(), slug, "utf-8");
}

async function getCurrent(): Promise<string | null> {
	try {
		return (await fs.promises.readFile(currentFile(), "utf-8")).trim() || null;
	} catch { return null; }
}

const resolveSlug = async (arg: string | undefined): Promise<string | null> =>
	arg ?? (await getCurrent());

// ─── Plan-file IO ────────────────────────────────────────────────────────────

async function readPlan(slug: string): Promise<string | null> {
	try { return await fs.promises.readFile(planPath(slug), "utf-8"); }
	catch { return null; }
}

async function writePlan(slug: string, content: string): Promise<void> {
	await fs.promises.writeFile(planPath(slug), content, "utf-8");
}

async function readTasks(slug: string): Promise<string | null> {
	try { return await fs.promises.readFile(tasksPath(slug), "utf-8"); }
	catch { return null; }
}

async function writeTasks(slug: string, content: string): Promise<void> {
	await fs.promises.writeFile(tasksPath(slug), content, "utf-8");
}

// ─── Phase tracking via the `> Status:` line at the top of the doc ───────────

const STATUS_RE = /^> Status: ([a-z]+)$/m;

function readPhase(content: string): Phase {
	const m = STATUS_RE.exec(content);
	return ((m?.[1] as Phase) ?? "design");
}

function withPhase(content: string, phase: Phase): string {
	return STATUS_RE.test(content)
		? content.replace(STATUS_RE, `> Status: ${phase}`)
		: content;
}

async function setPhase(slug: string, phase: Phase): Promise<void> {
	const content = await readPlan(slug);
	if (!content) return;
	await writePlan(slug, withPhase(content, phase));
}

// ─── Task parsing (hierarchical IDs: N or N.M or N.M.K) ──────────────────────

interface ParsedTask {
	id: string;            // "1" or "1.2"
	parentId: string | null; // "1" for "1.2"; null for top-level
	done: boolean;
	rawLineIndex: number;
	indent: string;
	agentType: string;
	title: string;
	/** IDs this task waits for. Parsed from a `Depends: 1, 2.1` body line. */
	depends: string[];
}

// `^(<indent>)- [<box>] <id>. **<agent>** — <title>`
const TASK_RE = /^(\s*)- \[( |x|X)\] (\d+(?:\.\d+)*)\. \*\*([a-zA-Z0-9_-]+)\*\* [—-] (.+)$/;
// Indented body line: `  Depends: 1, 2.1` (comma or whitespace separator).
const DEPENDS_RE = /^\s+Depends:\s*(.+)$/;

function parentOf(id: string): string | null {
	const lastDot = id.lastIndexOf(".");
	return lastDot === -1 ? null : id.slice(0, lastDot);
}

function parseTasks(content: string): ParsedTask[] {
	const out: ParsedTask[] = [];
	const lines = content.split("\n");
	let current: ParsedTask | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = TASK_RE.exec(line);
		if (m) {
			const id = m[3];
			current = {
				id,
				parentId: parentOf(id),
				done: m[2].toLowerCase() === "x",
				rawLineIndex: i,
				indent: m[1],
				agentType: m[4],
				title: m[5],
				depends: [],
			};
			out.push(current);
			continue;
		}
		if (!current) continue;
		const dm = DEPENDS_RE.exec(line);
		if (dm) {
			current.depends = dm[1]
				.split(/[,\s]+/)
				.map(s => s.trim())
				.filter(s => /^\d+(?:\.\d+)*$/.test(s));
		}
	}
	return out;
}

// ─── Checkbox flip + parent roll-up ──────────────────────────────────────────

interface FlipResult {
	flipped: string[];      // ids actually flipped (target + any rolled-up parents)
	titles: Record<string, string>;
}

async function flipTaskAndRollUp(slug: string, targetId: string): Promise<FlipResult> {
	const result: FlipResult = { flipped: [], titles: {} };
	const content = await readTasks(slug);
	if (!content) return result;

	const tasks = parseTasks(content);
	const target = tasks.find(t => t.id === targetId);
	if (!target || target.done) return result;

	const lines = content.split("\n");
	const flipOne = (t: ParsedTask) => {
		lines[t.rawLineIndex] = lines[t.rawLineIndex].replace(/- \[ \]/, "- [x]");
		t.done = true;
		result.flipped.push(t.id);
		result.titles[t.id] = t.title;
	};

	flipOne(target);

	// Roll up: walk up the parent chain, flipping any parent whose direct children
	// are all done.
	for (let pid = target.parentId; pid; pid = parentOf(pid)) {
		const parent = tasks.find(t => t.id === pid);
		if (!parent || parent.done) break;
		const directChildren = tasks.filter(t => t.parentId === pid);
		if (directChildren.length === 0) break;
		if (!directChildren.every(c => c.done)) break;
		flipOne(parent);
	}

	await writeTasks(slug, lines.join("\n"));

	// Phase lives in the design doc. Flip to "done" only when all top-level tasks complete.
	const tops = tasks.filter(t => t.parentId === null);
	if (tops.length > 0 && tops.every(t => t.done)) await setPhase(slug, "done");

	return result;
}

// ─── Git auto-commit (best-effort) ───────────────────────────────────────────

async function autoCommit(pi: ExtensionAPI, slug: string, taskId: string, title: string): Promise<void> {
	if (!AUTO_COMMIT) return;
	const { code: inRepo } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (inRepo !== 0) return;
	await pi.exec("git", ["add", "-A"]);
	const { stdout: staged } = await pi.exec("git", ["diff", "--cached", "--stat"]);
	if (!staged.trim()) return;
	await pi.exec("git", ["commit", "-m", `feature(${slug}): task ${taskId} — ${title}`]);
}

// ─── Scaffold for a fresh feature ────────────────────────────────────────────

function makeDesignScaffold(slug: string, description: string): string {
	const today = new Date().toISOString().slice(0, 10);
	return `# Feature: ${slug}

> Description: ${description}
> Created: ${today}
> Status: design

## Goals

_TBD — what does success look like? What are we NOT trying to do?_

## Design

_TBD — architecture, key components, data flow, types/interfaces, dependencies. This is the human-readable design that someone unfamiliar with the work could read and understand the shape of what you're about to build._

## Key Files

_TBD — paths the implementer should read first to orient. Include short notes on what each contains._

## Edge Cases

_TBD — failure modes, race conditions, surprising states, things that need careful handling._

## Verification

_TBD — how do we confirm this works? Tests to add, commands to run, manual checks._
`;
}

function makeTasksScaffold(slug: string): string {
	return `# Tasks: ${slug}

> Design doc: \`${planPath(slug)}\`

_To be filled by \`/feature plan\`. Format (parsed by tooling — preserve exactly):_

\`\`\`
- [ ] 1. **<agent-type>** — <imperative title>
  Brief: <one sentence: what + why>
  Files: <comma-separated file paths>
  Acceptance: <observable result>
  Depends: <optional comma-separated task ids — omit the line if none>
\`\`\`

_Sub-tasks use dotted ids (\`1.1\`, \`1.2\`) and indent under their parent. Parent/child relationships are implicit — only declare \`Depends:\` for horizontal dependencies (sibling-to-sibling, cross-tree)._
`;
}

// ─── Command: /feature new ───────────────────────────────────────────────────

async function cmdNew(pi: ExtensionAPI, ctx: ExtensionCommandContext, description: string): Promise<void> {
	if (!description.trim()) {
		ctx.ui.notify("Usage: /feature new <description>", "error");
		return;
	}
	await ensureDir();
	const slug = slugify(description);
	const file = planPath(slug);

	if (fs.existsSync(file)) {
		const overwrite = await ctx.ui.confirm("Feature exists", `${file} already exists. Overwrite?`);
		if (!overwrite) return;
	}

	await writePlan(slug, makeDesignScaffold(slug, description));
	await setCurrent(slug);

	ctx.ui.notify(`Created ${file} (phase: design). Tasks file will be created by /feature plan.`, "info");

	pi.sendUserMessage(
		`I'm starting work on a new feature. The design doc is at \`${file}\` and currently has \`> Status: design\`.

Description: ${description}

We're in **Phase 1 — design**. Help me build out the design doc collaboratively. Read the scaffold first, then propose content for each section in turn (Goals, Design, Key Files, Edge Cases, Verification). Edit \`${file}\` in place as we converge — replace each \`_TBD — ...\` placeholder with real content.

There is intentionally NO Tasks section in this file. Tasks live in a separate file (\`${tasksPath(slug)}\`) created later by \`/feature plan\` — keep planning and execution artifacts separate.

For investigation, you may spawn read-only subagents via the \`Agent\` tool:
- \`explore\` for codebase scouting (current patterns, files that need to change)
- \`librarian\` for external library/API questions
- \`oracle\` for architectural second opinions

Iterate with me — ask clarifying questions, propose alternatives, surface edge cases I might not have considered. The goal is a design doc a teammate could read and understand the shape of the work.

When I'm satisfied with the design, I'll run \`/feature plan\` and that's when we break it into tasks.`,
		{ deliverAs: "followUp" },
	);
}

// ─── Command: /feature plan ──────────────────────────────────────────────────

async function cmdPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext, slugArg: string | undefined): Promise<void> {
	const slug = await resolveSlug(slugArg);
	if (!slug) {
		ctx.ui.notify("No current feature. Run `/feature new <desc>` first.", "error");
		return;
	}
	const design = planPath(slug);
	const tasks = tasksPath(slug);
	const designContent = await readPlan(slug);
	if (!designContent) {
		ctx.ui.notify(`Design doc not found: ${design}. Run \`/feature new\` first.`, "error");
		return;
	}

	const phase = readPhase(designContent);
	if (phase === "running" || phase === "done") {
		const cont = await ctx.ui.confirm(
			"Re-plan?",
			`Feature ${slug} is in phase '${phase}'. Re-generating tasks may conflict with in-flight work. Continue?`,
		);
		if (!cont) return;
	}

	// Create or refresh the tasks file scaffold so the model has a target to edit.
	const existingTasks = await readTasks(slug);
	if (existingTasks) {
		const overwrite = await ctx.ui.confirm(
			"Tasks file exists",
			`${tasks} already exists. Overwrite with a fresh scaffold?`,
		);
		if (!overwrite) {
			ctx.ui.notify(`Keeping existing tasks file. Asking model to edit it in place.`, "info");
		} else {
			await writeTasks(slug, makeTasksScaffold(slug));
		}
	} else {
		await writeTasks(slug, makeTasksScaffold(slug));
	}

	await setPhase(slug, "tasks");
	await setCurrent(slug);

	ctx.ui.notify(`Phase 2: breaking ${slug} into tasks → ${tasks}`, "info");

	pi.sendUserMessage(
		`The design doc at \`${design}\` is finalized. We're in **Phase 2 — task breakdown**.

Read the design doc, then EDIT \`${tasks}\` in place. Replace its scaffold body (everything below the \`> Design doc:\` line and the \`_To be filled by ...\`/code-block placeholder) with a real checklist. Keep the top header (\`# Tasks: ${slug}\`) and the \`> Design doc:\` reference line.

Format (parsed by tooling — preserve exactly):

\`\`\`
- [ ] 1. **<agent-type>** — <imperative title>
  Brief: <one sentence: what + why>
  Files: <comma-separated file paths>
  Acceptance: <observable result>
  Depends: <optional comma-separated task ids this one waits for, e.g. \`1, 2.1\`>
\`\`\`

\`Depends:\` is optional — omit the line if there are no horizontal dependencies. Parent/child relationships (via dotted ids) are implicit and DON'T need to be declared.

For tasks that decompose, add indented sub-tasks. Sub-task IDs are dotted (\`1.1\`, \`1.2\`):

\`\`\`
- [ ] 2. **plan** — Implement auth layer
  Brief: top-level orchestration of the auth pieces
  Files: src/auth/*
  Acceptance: all sub-tasks below complete and verification passes
  - [ ] 2.1. **general-purpose** — Add JWT validator
    Brief: ...
    Files: src/auth/jwt.ts
    Acceptance: ...
  - [ ] 2.2. **general-purpose** — Wire middleware
    Brief: ...
    Files: src/server/middleware.ts
    Acceptance: ...
\`\`\`

Sub-tasks are for when a single conceptual unit naturally splits into multiple agent calls. If a task is small enough to do in one shot, leave it flat — don't invent sub-tasks.

Valid agent-types: \`general-purpose\` (default worker), \`explore\` (read-only investigation), \`oracle\` (architectural/tricky), \`librarian\` (external lib research), \`reviewer\` (final QA). Pick the cheapest that fits.

Order tasks by dependency: things that produce contracts (types, APIs) before consumers. Use the \`Depends:\` field whenever a task can't safely start until another finishes.

Do NOT modify the design doc \`${design}\` — that's intentionally separate from the tasks file.

After editing, briefly summarize: total task count, top-level count, and which tasks have sub-tasks.`,
		{ deliverAs: "followUp" },
	);
}

// ─── Command: /feature run ───────────────────────────────────────────────────

async function cmdRun(pi: ExtensionAPI, ctx: ExtensionCommandContext, slugArg: string | undefined): Promise<void> {
	const slug = await resolveSlug(slugArg);
	if (!slug) {
		ctx.ui.notify("No current feature. Run `/feature new <desc>` first.", "error");
		return;
	}
	const design = planPath(slug);
	const tasksFile = tasksPath(slug);
	const tasksContent = await readTasks(slug);
	if (!tasksContent) {
		ctx.ui.notify(`Tasks file not found: ${tasksFile}. Run \`/feature plan\` first.`, "error");
		return;
	}

	const tasks = parseTasks(tasksContent);
	if (tasks.length === 0) {
		ctx.ui.notify(`No parseable tasks in ${tasksFile}. Run \`/feature plan\` or hand-edit the file.`, "error");
		return;
	}

	// Leaf tasks = those with no children. Only leaves get farmed out; parents
	// flip via roll-up.
	const isParent = (id: string) => tasks.some(t => t.parentId === id);
	const pendingLeaves = tasks.filter(t => !t.done && !isParent(t.id));
	if (pendingLeaves.length === 0) {
		ctx.ui.notify(`All leaf tasks already done in ${tasksFile}.`, "info");
		return;
	}

	await setPhase(slug, "running");
	await setCurrent(slug);

	const lines = pendingLeaves.map(t => {
		const dep = t.depends.length > 0 ? ` deps=${t.depends.join(",")}` : "";
		return `  ${t.id} ${t.agentType}${dep}`;
	}).join("\n");

	// Note on prompt length: keep this tight. The orchestrator burns tokens
	// (and risks TUI render glitches) when given a verbose essay to react to.
	// All policy lives in the task file + the per-subagent prompt template.
	pi.sendUserMessage(
		`Phase 3 — dispatch.

Tasks file: \`${tasksFile}\` (single source of truth, subagents read it).
Design doc: \`${design}\` (subagents read it for context).

Ready tasks (id agent-type [deps=…]):
${lines}

**Dispatch rule**: a task is ready when every id in its \`deps=\` is \`[x]\` in the tasks file. Spawn EVERY ready task now in parallel via \`Agent\`. Re-check readiness as completion notifications arrive; spawn next wave. No essays, no manual dependency analysis — the \`Depends:\` field already encodes it.

For each ready task, call \`Agent\` with:
- \`subagent_type\`: <agent-type>
- \`description\`: \`feature:${slug} task:<ID>\` (exact, including dotted ID)
- \`run_in_background\`: true
- \`isolation\`: "worktree" only if multiple ready tasks edit the same file
- \`prompt\`: this exact template (substitute <ID>):

  Task <ID> in ${tasksFile}. Read it (your Brief/Files/Acceptance live there) and read ${design} for context. Do the work to meet Acceptance. Do NOT run project-wide test/lint/format — full verification is the user's job at the end. If you have edit tools, flip \`- [ ]\` → \`- [x]\` on your line when done.

Do NOT inline Brief/Files/Acceptance into the prompt — that defeats the single-source-of-truth design.`,
		{ deliverAs: "followUp" },
	);
}

// ─── Status + list ───────────────────────────────────────────────────────────

async function cmdStatus(ctx: ExtensionCommandContext, slugArg: string | undefined): Promise<void> {
	const slug = await resolveSlug(slugArg);
	if (!slug) { ctx.ui.notify("No current feature.", "info"); return; }
	const design = await readPlan(slug);
	if (!design) { ctx.ui.notify(`Design doc not found: ${planPath(slug)}`, "error"); return; }
	const phase = readPhase(design);
	const tasksContent = await readTasks(slug);
	const tasks = tasksContent ? parseTasks(tasksContent) : [];
	const done = tasks.filter(t => t.done).length;
	const tops = tasks.filter(t => t.parentId === null).length;
	const tasksLine = tasksContent
		? `${done}/${tasks.length} tasks (${tops} top-level)`
		: `no tasks file yet`;
	ctx.ui.notify(
		`Feature ${slug} [${phase}] — ${tasksLine}\n  design: ${planPath(slug)}\n  tasks:  ${tasksPath(slug)}`,
		"info",
	);
}

async function cmdList(ctx: ExtensionCommandContext): Promise<void> {
	try {
		const entries = await fs.promises.readdir(featuresDir);
		// Design docs are <slug>.md; tasks files are <slug>.tasks.md — exclude the latter.
		const slugs = entries
			.filter(e => e.endsWith(".md") && !e.endsWith(".tasks.md"))
			.map(e => e.replace(/\.md$/, ""));
		if (slugs.length === 0) { ctx.ui.notify("No features yet.", "info"); return; }
		const current = await getCurrent();
		const rows = await Promise.all(slugs.map(async s => {
			const c = await readPlan(s);
			const phase = c ? readPhase(c) : "?";
			const marker = s === current ? "*" : " ";
			return `${marker} ${s} [${phase}]`;
		}));
		ctx.ui.notify(`Features:\n${rows.join("\n")}`, "info");
	} catch {
		ctx.ui.notify("No features yet.", "info");
	}
}

// ─── Completion → flip + roll-up + auto-commit ───────────────────────────────

// Description shape: `feature:<slug> task:<dotted-id>`
const DESC_RE = /^feature:([a-z0-9-]+) task:(\d+(?:\.\d+)*)$/;

interface SubagentCompletedEvent {
	id: string;
	type: string;
	description?: string;
	result?: string;
}

interface SubagentFailedEvent extends SubagentCompletedEvent {
	error?: string;
	status?: string;
}

function wireCompletionHandler(pi: ExtensionAPI): void {
	pi.events.on("subagents:completed", async (raw: unknown) => {
		const ev = raw as SubagentCompletedEvent;
		const desc = ev?.description ?? "";
		const m = DESC_RE.exec(desc);
		if (!m) return;
		const [, slug, taskId] = m;
		// Event handler — refresh dir from process.cwd() since we have no ctx.
		refreshDir(process.cwd(), false);
		const { flipped, titles } = await flipTaskAndRollUp(slug, taskId);
		if (flipped.length === 0) return;
		// Clear any stale failure annotation now that the task succeeded.
		await clearFailureAnnotation(slug, taskId);
		// Single commit per completion event; message reflects whatever rolled up too.
		const summary = flipped.length === 1
			? `${flipped[0]} — ${titles[flipped[0]] ?? ""}`
			: `${flipped[0]} (${flipped.slice(1).join(", ")}) — ${titles[flipped[0]] ?? ""}`;
		try { await autoCommit(pi, slug, flipped[0], summary); }
		catch { /* best-effort */ }
	});
}

function wireFailureHandler(pi: ExtensionAPI): void {
	pi.events.on("subagents:failed", async (raw: unknown) => {
		const ev = raw as SubagentFailedEvent;
		const desc = ev?.description ?? "";
		const m = DESC_RE.exec(desc);
		if (!m) return;
		const [, slug, taskId] = m;
		refreshDir(process.cwd(), false);
		const errMsg = (ev.error ?? ev.result ?? "(no error message)")
			.split("\n")[0]
			.slice(0, 200);
		const status = ev.status ?? "failed";
		await annotateFailure(slug, taskId, `${status}: ${errMsg}`);
		// Surface to the conversation so the orchestrator can react (retry, skip,
		// decompose, etc.). Doesn't auto-retry — that's the orchestrator's call.
		pi.sendUserMessage(
			`feature-planner: task ${taskId} of \`${slug}\` ${status} — ${errMsg}\n\nThe checkbox stays \`[ ]\` so it's eligible for retry. See \`${tasksPath(slug)}\` for the annotated failure. Re-run \`/feature run\` to retry pending tasks, or hand-edit the task before retrying.`,
			{ deliverAs: "followUp" },
		);
	});
}

const FAILURE_RE = /^\s*> Last failure: /;

async function annotateFailure(slug: string, taskId: string, message: string): Promise<void> {
	const content = await readTasks(slug);
	if (!content) return;
	const tasks = parseTasks(content);
	const target = tasks.find(t => t.id === taskId);
	if (!target) return;
	const lines = content.split("\n");

	// Find the end of this task's body — first subsequent line that's either
	// another task line, a non-indented heading, or EOF.
	let end = target.rawLineIndex + 1;
	while (end < lines.length) {
		if (TASK_RE.exec(lines[end])) break;
		if (/^#{1,6} /.test(lines[end])) break;
		end++;
	}

	// Remove any existing failure annotation in this task's body, then append a fresh one.
	for (let i = end - 1; i > target.rawLineIndex; i--) {
		if (FAILURE_RE.test(lines[i])) { lines.splice(i, 1); end--; }
	}
	const indent = target.indent + "  ";
	lines.splice(end, 0, `${indent}> Last failure: ${message}`);
	await writeTasks(slug, lines.join("\n"));
}

async function clearFailureAnnotation(slug: string, taskId: string): Promise<void> {
	const content = await readTasks(slug);
	if (!content) return;
	const tasks = parseTasks(content);
	const target = tasks.find(t => t.id === taskId);
	if (!target) return;
	const lines = content.split("\n");
	let end = target.rawLineIndex + 1;
	while (end < lines.length) {
		if (TASK_RE.exec(lines[end])) break;
		if (/^#{1,6} /.test(lines[end])) break;
		end++;
	}
	let changed = false;
	for (let i = end - 1; i > target.rawLineIndex; i--) {
		if (FAILURE_RE.test(lines[i])) { lines.splice(i, 1); changed = true; }
	}
	if (changed) await writeTasks(slug, lines.join("\n"));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export default function featurePlannerExtension(pi: ExtensionAPI): void {
	wireCompletionHandler(pi);
	wireFailureHandler(pi);

	pi.registerCommand("feature", {
		description: "Plan a feature (design doc → task breakdown → farm to subagents)",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["new", "plan", "run", "status", "list"];
			return subs.filter(s => s.startsWith(prefix)).map(s => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const spaceAt = trimmed.indexOf(" ");
			const sub = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)) || "status";
			const rawRest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();
			// `new` takes a free-text description. `plan|run|status` take an optional
			// slug — guard against the user typing prose ("/feature run make sure
			// you use TDD") by rejecting anything that doesn't look like a slug and
			// falling back to `.current`.
			const slugLike = (s: string) => /^[a-z0-9][a-z0-9-]*$/.test(s);
			let rest = rawRest;
			if (sub !== "new" && rest && !slugLike(rest)) {
				ctx.ui.notify(
					`Argument "${rest.slice(0, 40)}..." doesn't look like a slug; ignoring and using the current feature. Pass an exact slug (lowercase, dashes) or none.`,
					"warning",
				);
				rest = "";
			}

			// Resolve `.pi/features/` for this command. `new` is allowed to create the
			// directory under cwd if none exists up the tree; other commands require
			// finding an existing one.
			const createIfMissing = sub === "new";
			const found = refreshDir(ctx.cwd, createIfMissing);
			if (!found && sub !== "new") {
				ctx.ui.notify(
					`No \`.pi/features/\` directory found at or above ${ctx.cwd}. Run \`/feature new <desc>\` to create one.`,
					"error",
				);
				return;
			}

			switch (sub) {
				case "new":    await cmdNew(pi, ctx, rest); return;
				case "plan":   await cmdPlan(pi, ctx, rest || undefined); return;
				case "run":    await cmdRun(pi, ctx, rest || undefined); return;
				case "status": await cmdStatus(ctx, rest || undefined); return;
				case "list":   await cmdList(ctx); return;
				default:
					ctx.ui.notify("Usage: /feature <new|plan|run|status|list> [args]", "error");
			}
		},
	});
}
