/**
 * Plan Parser
 *
 * Parses `.ralph/plan.md` to extract tasks with their completion state
 * and acceptance criteria.
 *
 * Expected format in the ## Tasks section:
 *
 *   - [ ] 1. Create auth middleware
 *     - Acceptance: validates JWT, returns 401 on invalid
 *   - [x] 2. Add login endpoint
 *     - Acceptance: returns JWT on valid credentials
 *
 * The parser is intentionally lenient — it handles variations like:
 *   - [ ] 1. Task      (standard)
 *   - [ ] Task          (no number — auto-numbered)
 *   - [x] 3. Task       (completed)
 *   - [ ] 1) Task        (parenthesis instead of dot)
 *
 * Acceptance criteria are optional. If missing, defaults to empty string.
 */

export interface RalphTask {
	/** 1-based task number */
	index: number;
	/** Task title text */
	title: string;
	/** Short description of what needs to be done and why */
	description: string;
	/** Acceptance criteria (what "done" looks like) */
	acceptance: string;
	/** Most important file paths relevant to this task */
	files: string[];
	/** Whether the checkbox is checked [x] */
	done: boolean;
	/** Raw line for reference */
	raw: string;
	/** Agent name to use for this task (from Agent: field) */
	agent?: string;
}

/**
 * Parse a plan markdown string and return structured tasks.
 *
 * Only parses lines within a "## Tasks" section (stops at the next ##).
 * Each task is a line matching `- [ ] ` or `- [x] ` pattern.
 */
export function parsePlan(content: string): RalphTask[] {
	const lines = content.split("\n");
	const tasks: RalphTask[] = [];

	// Find the ## Tasks section
	let inTasksSection = false;
	let autoIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Detect section boundaries
		if (/^##\s+Tasks/i.test(line)) {
			inTasksSection = true;
			continue;
		}
		if (inTasksSection && /^##\s+/.test(line)) {
			// Hit the next section — stop
			break;
		}
		if (!inTasksSection) continue;

		// Match task lines: - [ ] or - [x]
		// Captures: done marker, optional number, title text
		const taskMatch = line.match(/^-\s+\[([ xX])\]\s+(?:(\d+)[.)]\s+)?(.+)/);
		if (!taskMatch) continue;

		const done = taskMatch[1].toLowerCase() === "x";
		const explicitIndex = taskMatch[2] ? parseInt(taskMatch[2], 10) : null;
		const title = taskMatch[3].trim();

		autoIndex++;
		const index = explicitIndex ?? autoIndex;

		// Look ahead for metadata on the next lines (Description, Acceptance, Files, Agent)
		let description = "";
		let acceptance = "";
		let files: string[] = [];
		let agent: string | undefined;
		for (let j = i + 1; j < lines.length; j++) {
			const nextLine = lines[j];
			// Skip empty lines within task block
			if (!nextLine.trim()) continue;
			// Stop looking if we hit another task or a section header
			if (/^-\s+\[/.test(nextLine) || /^##\s+/.test(nextLine)) break;
			// Also stop if we hit a non-indented non-empty line
			if (!nextLine.startsWith("  ") && !nextLine.startsWith("\t")) break;

			const descMatch = nextLine.match(/^\s+-\s+Description:\s*(.+)/i);
			if (descMatch) { description = descMatch[1].trim(); continue; }

			const accMatch = nextLine.match(/^\s+-\s+Acceptance:\s*(.+)/i);
			if (accMatch) { acceptance = accMatch[1].trim(); continue; }

			const filesMatch = nextLine.match(/^\s+-\s+Files:\s*(.+)/i);
			if (filesMatch) {
				files = filesMatch[1].split(",").map(f => f.trim()).filter(Boolean);
				continue;
			}

			const agentMatch = nextLine.match(/^\s+-\s+Agent:\s*(.+)/i);
			if (agentMatch) { agent = agentMatch[1].trim(); continue; }
		}

		tasks.push({ index, title, description, acceptance, files, done, raw: line, agent });
	}

	return tasks;
}

/**
 * Find a task by its index number.
 */
export function findTaskByIndex(tasks: RalphTask[], index: number): RalphTask | undefined {
	return tasks.find(t => t.index === index);
}

/**
 * Find the next unchecked task starting from a given index.
 */
export function findNextUncheckedTask(tasks: RalphTask[], startIndex: number = 0): RalphTask | null {
	for (let i = startIndex; i < tasks.length; i++) {
		if (!tasks[i].done) return tasks[i];
	}
	return null;
}

/**
 * Serialize a single task back into the plan format.
 * Used when the extension needs to update task states programmatically.
 */
export function serializeTask(task: RalphTask): string {
	const checkbox = task.done ? "[x]" : "[ ]";
	const line = `- ${checkbox} ${task.index}. ${task.title}`;
	const meta: string[] = [];
	if (task.description) meta.push(`  - Description: ${task.description}`);
	if (task.acceptance) meta.push(`  - Acceptance: ${task.acceptance}`);
	if (task.files.length > 0) meta.push(`  - Files: ${task.files.join(", ")}`);
	if (task.agent) meta.push(`  - Agent: ${task.agent}`);
	return meta.length > 0 ? `${line}\n${meta.join("\n")}` : line;
}

/**
 * Serialize all tasks back into markdown format.
 * Returns the Tasks section content (without headers).
 */
export function serializeTasks(tasks: RalphTask[]): string {
	return tasks.map(t => serializeTask(t)).join("\n");
}
