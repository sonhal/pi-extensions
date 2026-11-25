/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap + seccomp on Linux). pi's own file tools (read, write, edit,
 * grep, find, ls) run outside that sandbox, so a `tool_call` guard applies the
 * same filesystem policy to them (see path-guard.ts).
 *
 * Fails closed: if the sandbox is enabled but cannot be initialized, bash and
 * `!` commands are refused until the problem is fixed or pi is restarted with
 * `--no-sandbox`.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/extensions/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   },
 *   "adb": {
 *     "enabled": true,
 *     "port": 5037
 *   }
 * }
 * ```
 * Any other sandbox-runtime option (e.g. `allowNestedUserNamespaces`,
 * `ignoreViolations`, `enableWeakerNestedSandbox`) is passed through as-is.
 *
 * Linux caveat: bubblewrap only applies allowWrite/denyWrite entries that are
 * literal paths. Glob entries such as `*.pem` are skipped for bash (pi's own
 * write/edit tools still honour them via the guard). `/sandbox` lists the
 * affected entries.
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap (>= 0.8.0, not setuid), socat, ripgrep
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { GUARDED_TOOLS, PathGuard } from "./path-guard.js";

interface AdbConfig {
	/** Enable the ADB bridge to expose the host ADB server inside the sandbox */
	enabled?: boolean;
	/** ADB server port on the host (default: 5037) */
	port?: number;
}

type SandboxConfig = Partial<SandboxRuntimeConfig> & {
	enabled?: boolean;
	adb?: AdbConfig;
};

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"proxy.golang.org",
			"sum.golang.org",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
	adb: {
		enabled: false,
		port: 5037,
	},
};

function readJson(path: string): Partial<SandboxConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		// A broken config must not silently weaken the sandbox.
		throw new Error(`Could not parse ${path}: ${e instanceof Error ? e.message : e}`);
	}
}

function loadConfig(cwd: string): SandboxConfig {
	const globalConfig = readJson(join(getAgentDir(), "extensions", "sandbox.json"));
	const projectConfig = readJson(join(cwd, ".pi", "sandbox.json"));
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

/**
 * Top-level keys are replaced; `network`, `filesystem` and `adb` are merged
 * one level deep (so a project can replace `allowWrite` without restating
 * `network`). Arrays are replaced, not concatenated.
 */
function mergeConfig(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base, ...overrides };
	if (overrides.network) result.network = { ...base.network, ...overrides.network } as SandboxConfig["network"];
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem } as SandboxConfig["filesystem"];
	}
	if (overrides.adb) result.adb = { ...base.adb, ...overrides.adb };
	return result;
}

// ---------------------------------------------------------------------------
// ADB Bridge
// ---------------------------------------------------------------------------

interface AdbBridge {
	/** Path of the Unix socket the host-side socat creates */
	socketPath: string;
	/** The host-side socat process bridging the socket to tcp:localhost:ADB_PORT */
	process: ReturnType<typeof spawn>;
}

let adbBridge: AdbBridge | undefined;

/**
 * Start the host-side ADB bridge: a socat process that creates a Unix
 * socket and forwards connections to the host's ADB server (tcp:localhost:5037).
 *
 * Returns the bridge state, or undefined if socat failed to start.
 */
async function startAdbBridge(adbPort: number): Promise<AdbBridge | undefined> {
	const socketPath = join(tmpdir(), `adb-bridge-${randomBytes(4).toString("hex")}.sock`);

	// Remove any stale socket from a previous run
	try {
		unlinkSync(socketPath);
	} catch {
		/* didn't exist */
	}

	const proc = spawn("socat", [`UNIX-LISTEN:${socketPath},fork,reuseaddr`, `TCP:localhost:${adbPort}`], {
		stdio: "ignore",
		detached: false,
	});

	let spawnError: Error | undefined;
	proc.on("error", (err) => {
		spawnError = err;
	});

	// Poll for the socket file (up to 5 seconds). Awaiting between checks lets
	// the event loop deliver socat's `error`/`exit` events, so an early failure
	// is noticed immediately instead of after the timeout.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (spawnError || proc.exitCode !== null || proc.signalCode !== null) {
			console.error(
				`[sandbox] ADB bridge: socat failed (${spawnError?.message ?? `code=${proc.exitCode}, signal=${proc.signalCode}`})`,
			);
			removeSocket(socketPath);
			return undefined;
		}
		if (existsSync(socketPath)) {
			return { socketPath, process: proc };
		}
		await sleep(50);
	}

	console.error(`[sandbox] ADB bridge: timed out waiting for socket ${socketPath}`);
	try {
		proc.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	removeSocket(socketPath);
	return undefined;
}

function removeSocket(socketPath: string) {
	try {
		unlinkSync(socketPath);
	} catch {
		/* ignore */
	}
}

/**
 * Stop the host-side ADB bridge and remove its socket.
 */
function stopAdbBridge() {
	if (!adbBridge) return;

	try {
		if (adbBridge.process.pid && adbBridge.process.exitCode === null) {
			adbBridge.process.kill("SIGTERM");
		}
	} catch {
		// Process may have already exited
	}

	removeSocket(adbBridge.socketPath);
	adbBridge = undefined;
}

// ---------------------------------------------------------------------------
// Sandboxed bash ops with ADB env injection
// ---------------------------------------------------------------------------

/**
 * Tool caches (Go) default to $HOME, which is read-only in the sandbox, so
 * they are redirected into `<project>/.cache`. The directory gets its own
 * `.gitignore` (`*`) so auto-committing extensions never pick it up.
 */
function ensureProjectCache(projectRoot: string): string {
	const cacheDir = join(projectRoot, ".cache");
	const ignoreFile = join(cacheDir, ".gitignore");
	if (!existsSync(ignoreFile)) {
		try {
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(ignoreFile, "# Created by the pi sandbox extension: tool caches, never commit.\n*\n");
		} catch {
			// Best effort: the cache still works without the ignore file.
		}
	}
	return cacheDir;
}

/**
 * Create BashOperations that wrap commands with the sandbox.
 * If the ADB bridge is active, every command gets ADB_SERVER_SOCKET injected
 * so `adb` commands reach the host ADB server through the bridged Unix socket.
 */
function createSandboxedBashOps(projectRoot: string): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const cacheEnv: NodeJS.ProcessEnv = {};
			if (!env?.GOCACHE || !env?.GOMODCACHE) {
				const cacheDir = ensureProjectCache(projectRoot);
				if (!env?.GOCACHE) cacheEnv.GOCACHE = join(cacheDir, "go-build");
				if (!env?.GOMODCACHE) cacheEnv.GOMODCACHE = join(cacheDir, "go-mod");
			}

			// Inject ADB_SERVER_SOCKET so `adb` connects to the host's ADB server.
			// The Arch/Debian adb binary (android-tools) only supports the
			// tcp:<host>:<port> format — not Unix socket paths. So we:
			//   1. Start a socat inside the sandbox bridging TCP:5037 → Unix socket
			//   2. Set ADB_SERVER_SOCKET=tcp:localhost:5037 via spawn env
			// Both run inside bwrap's fresh netns where port 5037 is always free.
			let finalCommand = command;
			const spawnEnv: NodeJS.ProcessEnv = { ...cacheEnv, ...env };
			if (adbBridge && existsSync(adbBridge.socketPath)) {
				// The socat is cleaned up when bwrap exits. The brief sleep avoids a
				// race between socat binding and adb connecting.
				finalCommand =
					`socat TCP-LISTEN:5037,fork,reuseaddr UNIX-CONNECT:${adbBridge.socketPath} &>/dev/null & ` +
					`sleep 0.1; ${command}`;
				spawnEnv.ADB_SERVER_SOCKET = "tcp:localhost:5037";
			} else if (adbBridge) {
				console.error(`[sandbox] ADB bridge socket missing: ${adbBridge.socketPath}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(finalCommand);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: spawnEnv,
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				const killTree = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				signal?.addEventListener("abort", killTree, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", killTree);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

type SandboxState =
	| { kind: "pending" }
	| { kind: "disabled"; reason: string }
	| { kind: "active"; config: SandboxConfig; warnings: string[] }
	| { kind: "failed"; error: string };

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let state: SandboxState = { kind: "pending" };
	let guard: PathGuard | undefined;

	/** Error message when bash must be refused, or undefined when it may run. */
	const refusal = (): string | undefined => {
		if (state.kind === "failed") {
			return (
				`Sandbox is enabled but failed to initialize: ${state.error}\n` +
				"Commands are refused rather than run unsandboxed. Fix the sandbox config, " +
				'set "enabled": false in .pi/sandbox.json, or restart pi with --no-sandbox.'
			);
		}
		if (state.kind === "pending") return "Sandbox is still initializing; try again in a moment.";
		return undefined;
	};

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const refused = refusal();
			if (refused) throw new Error(refused);
			if (state.kind !== "active") {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(localCwd),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		const refused = refusal();
		if (refused) {
			return { result: { output: `${refused}\n`, exitCode: 1, cancelled: false, truncated: false } };
		}
		if (state.kind !== "active") return;
		return { operations: createSandboxedBashOps(localCwd) };
	});

	// pi's built-in file tools run outside the OS sandbox: apply the same
	// filesystem policy to them here.
	pi.on("tool_call", (event) => {
		const access = GUARDED_TOOLS[event.toolName];
		if (!access) return;
		if (state.kind === "failed" || state.kind === "pending") {
			return { block: true, reason: refusal() };
		}
		if (!guard) return;
		const input = event.input as { path?: unknown };
		const reason = guard.check(access, typeof input.path === "string" ? input.path : undefined);
		if (reason) return { block: true, reason: `Sandbox: ${reason}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		// session_start fires again on /new, /resume and /reload: tear down first.
		stopAdbBridge();
		guard = undefined;
		if (state.kind === "active") {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
		state = { kind: "pending" };

		if (pi.getFlag("no-sandbox") as boolean) {
			state = { kind: "disabled", reason: "--no-sandbox" };
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		let config: SandboxConfig;
		try {
			config = loadConfig(ctx.cwd);
		} catch (err) {
			state = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
			ctx.ui.notify(`Sandbox config error — bash is blocked: ${state.error}`, "error");
			return;
		}

		if (config.enabled === false) {
			state = { kind: "disabled", reason: "config" };
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			state = { kind: "failed", error: `not supported on ${platform}` };
			ctx.ui.notify(`Sandbox not supported on ${platform} — bash is blocked (use --no-sandbox)`, "error");
			return;
		}

		const warnings: string[] = [];
		try {
			// --- ADB Bridge setup ---
			if (config.adb?.enabled) {
				const adbPort = config.adb.port ?? 5037;
				adbBridge = await startAdbBridge(adbPort);

				if (adbBridge) {
					if (platform === "darwin") {
						// macOS Seatbelt: allow only this specific socket path
						const existing = config.network?.allowUnixSockets ?? [];
						config.network = {
							...config.network,
							allowUnixSockets: [...existing, adbBridge.socketPath],
						} as SandboxConfig["network"];
					} else {
						// Linux: seccomp can't filter sockets by path, so all Unix
						// sockets must be allowed. That removes the seccomp layer, and
						// with it the seccomp-based block on creating user namespaces;
						// sandbox-runtime then relies on bubblewrap's --disable-userns
						// (bubblewrap >= 0.8.0, not setuid).
						config.network = { ...config.network, allowAllUnixSockets: true } as SandboxConfig["network"];
						warnings.push(
							"ADB bridge on Linux sets allowAllUnixSockets, which disables the seccomp filter; " +
								"the user-namespace escape protection then depends on bubblewrap >= 0.8.0 (not setuid).",
						);
					}
				} else {
					warnings.push("ADB bridge failed to start — adb will not work inside the sandbox.");
				}
			}

			// --- Initialize the sandbox ---
			const { enabled: _enabled, adb: _adb, ...runtimeConfig } = config;
			await SandboxManager.initialize(runtimeConfig as SandboxRuntimeConfig);
			if (platform === "linux") warnings.push(...SandboxManager.getLinuxGlobPatternWarnings());

			guard = new PathGuard(config.filesystem ?? {}, ctx.cwd);
			state = { kind: "active", config, warnings };

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			const adbStatus = adbBridge ? " ADB" : "";
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths${adbStatus}`),
			);
			ctx.ui.notify(
				`Sandbox initialized${adbBridge ? " (ADB bridge active)" : ""}` +
					(warnings.length > 0 ? ` — ${warnings.length} warning(s), see /sandbox` : ""),
				warnings.length > 0 ? "warning" : "info",
			);
		} catch (err) {
			stopAdbBridge();
			state = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "🔓 Sandbox FAILED — bash blocked"));
			ctx.ui.notify(`Sandbox initialization failed — bash is blocked: ${state.error}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		stopAdbBridge();

		if (state.kind === "active") {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	pi.registerCommand("sandbox", {
		description: "Show sandbox configuration",
		handler: async (_args, ctx) => {
			if (state.kind !== "active") {
				const message =
					state.kind === "failed"
						? `Sandbox FAILED — bash and file tools are blocked: ${state.error}`
						: state.kind === "disabled"
							? `Sandbox is disabled (${state.reason})`
							: "Sandbox is initializing";
				ctx.ui.notify(message, state.kind === "failed" ? "error" : "info");
				return;
			}

			const { config, warnings } = state;
			const list = (entries: unknown[] | undefined) =>
				entries?.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(", ") || "(none)";
			const lines = [
				"Sandbox Configuration:",
				"",
				"Network:",
				`  Allowed: ${list(config.network?.allowedDomains)}`,
				`  Denied: ${list(config.network?.deniedDomains)}`,
				"",
				"Filesystem (bash via OS sandbox; read/write/edit/grep/find/ls via path guard):",
				`  Deny Read: ${list(config.filesystem?.denyRead)}`,
				`  Allow Read: ${list(config.filesystem?.allowRead)}`,
				`  Allow Write: ${list(config.filesystem?.allowWrite)}`,
				`  Deny Write: ${list(config.filesystem?.denyWrite)}`,
				"",
				"ADB Bridge:",
				adbBridge
					? `  Enabled — socket: ${adbBridge.socketPath} -> localhost:${config.adb?.port ?? 5037}`
					: `  Disabled${config.adb?.enabled ? " (failed to start)" : ""}`,
			];
			if (warnings.length > 0) {
				lines.push("", "Warnings:", ...warnings.map((w) => `  ⚠ ${w}`));
			}
			ctx.ui.notify(lines.join("\n"), warnings.length > 0 ? "warning" : "info");
		},
	});
}
