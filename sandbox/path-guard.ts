/**
 * Path guard for pi's built-in file tools.
 *
 * The OS sandbox only wraps `bash`. pi's own `read`, `write`, `edit`, `grep`,
 * `find` and `ls` tools run in the pi process itself, outside the sandbox, so
 * without this guard the model could simply `read ~/.ssh/id_ed25519` or
 * `write .env`. This module applies the same filesystem policy to those tools
 * from a `tool_call` handler.
 *
 * Semantics follow @anthropic-ai/sandbox-runtime:
 * - Read: allowed everywhere except under `denyRead`; `allowRead` re-allows
 *   paths inside a denied region (allowRead wins over denyRead).
 * - Write: denied everywhere except under `allowWrite`; `denyWrite` carves
 *   paths back out (denyWrite wins over allowWrite).
 *
 * Entries may be absolute, `~`-relative or relative to the project cwd, may
 * use glob patterns (`*`, `**`, `?`, `[...]`), or may be
 * `{ path, literal: true }` to name a path that is never a pattern. A pattern
 * without a `/` (e.g. `*.pem`, `.env.*`) matches a file name at any depth, as
 * in .gitignore. Unlike bubblewrap on Linux, which skips glob entries in
 * allowWrite/denyWrite, this guard enforces them for pi's own tools.
 *
 * Symlinks are resolved, so a link inside the project that points at a denied
 * location is treated as that location.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type PathEntry = string | { path: string; literal: true };

export interface FilesystemPolicy {
	denyRead?: PathEntry[];
	allowRead?: PathEntry[];
	allowWrite?: PathEntry[];
	denyWrite?: PathEntry[];
}

export type Access = "read" | "write" | "search";

/** Built-in pi tools and the kind of access their `path` argument implies. */
export const GUARDED_TOOLS: Record<string, Access> = {
	read: "read",
	ls: "read",
	grep: "search",
	find: "search",
	write: "write",
	edit: "write",
};

interface CompiledEntry {
	/** Original spelling, for messages. */
	label: string;
	/** Absolute path (literal entries) or the literal prefix of a pattern. */
	base: string;
	/** Compiled matcher for pattern entries; undefined for literal paths. */
	regex?: RegExp;
	/** Pattern without a slash: matches the basename at any depth. */
	basenameOnly?: boolean;
}

const GLOB_CHARS = /[*?[\]]/;

export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function globToRegexSource(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**/` matches zero or more directories; a trailing `**` matches anything.
				if (glob[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if (c === "[") {
			const close = glob.indexOf("]", i + 2);
			if (close === -1) {
				out += "\\[";
			} else {
				let body = glob.slice(i + 1, close);
				if (body.startsWith("!")) body = `^${body.slice(1)}`;
				out += `[${body.replace(/\\/g, "\\\\")}]`;
				i = close;
			}
		} else {
			out += c.replace(/[.+^${}()|\\]/g, "\\$&");
		}
	}
	return out;
}

/** Resolve symlinks for the longest existing prefix of `p`. */
export function realpathLoose(p: string): string {
	let existing = p;
	const rest: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return p;
		rest.unshift(basename(existing));
		existing = parent;
	}
	try {
		return join(realpathSync(existing), ...rest);
	} catch {
		return p;
	}
}

function compileEntry(entry: PathEntry, cwd: string): CompiledEntry[] {
	if (typeof entry === "object") {
		const abs = resolve(cwd, expandHome(entry.path));
		return withRealpath({ label: entry.path, base: abs });
	}

	const spelled = expandHome(entry).replace(/\/\*\*$/, ""); // `dir/**` means `dir`
	if (!GLOB_CHARS.test(spelled)) {
		return withRealpath({ label: entry, base: resolve(cwd, spelled) });
	}

	if (!spelled.includes("/")) {
		return [{ label: entry, base: cwd, regex: new RegExp(`^${globToRegexSource(spelled)}$`), basenameOnly: true }];
	}

	const abs = isAbsolute(spelled) ? spelled : join(cwd, spelled);
	// Literal directory prefix before the first glob character.
	const firstGlob = abs.search(GLOB_CHARS);
	const base = abs.slice(0, abs.lastIndexOf("/", firstGlob)) || "/";
	return [{ label: entry, base, regex: new RegExp(`^${globToRegexSource(abs)}(?:/.*)?$`) }];
}

function withRealpath(entry: CompiledEntry): CompiledEntry[] {
	const real = realpathLoose(entry.base);
	return real === entry.base ? [entry] : [entry, { ...entry, base: real }];
}

function isWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function entryMatches(entry: CompiledEntry, target: string): boolean {
	if (!entry.regex) return isWithin(target, entry.base);
	if (entry.basenameOnly) {
		// Like .gitignore: a slash-free pattern matches any path component.
		return target.split(sep).some((part) => entry.regex!.test(part));
	}
	return entry.regex.test(target);
}

/** True when a (literal) entry lies strictly inside `dir`, i.e. a recursive search of `dir` would reach it. */
function entryInside(entry: CompiledEntry, dir: string): boolean {
	return !entry.regex && entry.base !== dir && isWithin(entry.base, dir);
}

export class PathGuard {
	private readonly denyRead: CompiledEntry[];
	private readonly allowRead: CompiledEntry[];
	private readonly allowWrite: CompiledEntry[];
	private readonly denyWrite: CompiledEntry[];
	private readonly cwd: string;

	constructor(policy: FilesystemPolicy, cwd: string) {
		this.cwd = cwd;
		const compile = (list: PathEntry[] | undefined) => (list ?? []).flatMap((e) => compileEntry(e, cwd));
		this.denyRead = compile(policy.denyRead);
		this.allowRead = compile(policy.allowRead);
		this.allowWrite = compile(policy.allowWrite);
		this.denyWrite = compile(policy.denyWrite);
	}

	/**
	 * Check a tool's target path. Returns a human-readable reason when the
	 * access is not allowed, or undefined when it is.
	 */
	check(access: Access, rawPath: string | undefined): string | undefined {
		const spelled = expandHome((rawPath ?? ".").replace(/^@/, "")) || ".";
		const abs = resolve(this.cwd, spelled);
		const candidates = [...new Set([abs, realpathLoose(abs)])];

		if (access === "write") {
			for (const target of candidates) {
				const denied = this.denyWrite.find((e) => entryMatches(e, target));
				if (denied) return `writing ${rawPath} is blocked by sandbox denyWrite entry "${denied.label}"`;
				if (!this.allowWrite.some((e) => entryMatches(e, target))) {
					return `writing ${rawPath} is outside the sandbox allowWrite paths`;
				}
			}
			return undefined;
		}

		for (const target of candidates) {
			const denied = this.denyRead.find((e) => entryMatches(e, target));
			if (denied && !this.allowRead.some((e) => entryMatches(e, target))) {
				return `reading ${rawPath} is blocked by sandbox denyRead entry "${denied.label}"`;
			}
			if (access === "search") {
				// A recursive search of a parent directory would read the denied path too.
				const nested = this.denyRead.find(
					(e) => entryInside(e, target) && !this.allowRead.some((a) => entryMatches(a, e.base)),
				);
				if (nested) {
					return `searching ${rawPath} would reach sandbox denyRead entry "${nested.label}"; search a narrower path`;
				}
			}
		}
		return undefined;
	}
}
