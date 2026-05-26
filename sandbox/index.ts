/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Note: this example intentionally overrides the built-in `bash` tool to show
 * how built-in tools can be replaced. Alternatively, you could sandbox `bash`
 * via `tool_call` input mutation without replacing the tool.
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
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";

interface AdbConfig {
	/** Enable the ADB bridge to expose the host ADB server inside the sandbox */
	enabled?: boolean;
	/** ADB server port on the host (default: 5037) */
	port?: number;
}

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
	adb?: AdbConfig;
}

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

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}
	if (overrides.adb) {
		result.adb = { ...base.adb, ...overrides.adb };
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

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
 * Returns the bridge state, or undefined if socat is not available.
 */
function startAdbBridge(adbPort: number): AdbBridge | undefined {
	const socatPath = "socat";

	// socat is a required sandbox dependency on Linux — skip the version
	// check and rely on the spawn error handler instead.

	const socketPath = join(tmpdir(), `adb-bridge-${randomBytes(4).toString("hex")}.sock`);

	// Remove any stale socket from a previous run
	try { unlinkSync(socketPath); } catch { /* didn't exist */ }

	const proc = spawn(socatPath, [
		`UNIX-LISTEN:${socketPath},fork,reuseaddr`,
		`TCP:localhost:${adbPort}`,
	], {
		stdio: "ignore",
		detached: false,
	});

	let spawnFailed = false;
	proc.on("error", (err) => {
		spawnFailed = true;
		console.error(`[sandbox] ADB bridge: spawn failed — ${err.message}`);
	});

	// Poll for the socket file to appear (up to 5 seconds).
	// Use a spin-wait with fs.existsSync rather than spawnSync("sleep")
	// so we don't block the event loop — that way proc error/exit handlers
	// can fire and update proc.exitCode.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (spawnFailed || proc.exitCode !== null || proc.killed) {
			console.error(
				"[sandbox] ADB bridge: socat exited early (code=" +
					proc.exitCode +
					", signal=" +
					proc.signalCode +
					")",
			);
			try { unlinkSync(socketPath); } catch { /* ignore */ }
			return undefined;
		}
		if (existsSync(socketPath)) {
			console.error(
				`[sandbox] ADB bridge ready: ${socketPath} -> localhost:${adbPort}`,
			);
			return { socketPath, process: proc };
		}
		// Busy-wait 50ms — let the event loop process pending callbacks
		const waitUntil = Date.now() + 50;
		while (Date.now() < waitUntil) {
			// spin (Node.js processes pending I/O in between turns)
		}
	}

	console.error(
		`[sandbox] ADB bridge: timed out waiting for socket ${socketPath}`,
	);
	try { proc.kill("SIGTERM"); } catch { /* ignore */ }
	try { unlinkSync(socketPath); } catch { /* ignore */ }
	return undefined;
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

	try { unlinkSync(adbBridge.socketPath); } catch { /* already removed */ }

	adbBridge = undefined;
}

// ---------------------------------------------------------------------------
// Sandboxed bash ops with ADB env injection
// ---------------------------------------------------------------------------

/**
 * Create BashOperations that wrap commands with the sandbox.
 * If the ADB bridge is active, every command gets ADB_SERVER_SOCKET injected
 * so `adb` commands reach the host ADB server through the bridged Unix socket.
 */
function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			// Inject ADB_SERVER_SOCKET so `adb` connects to the host's ADB server.
			// The Arch/Debian adb binary (android-tools) only supports the
			// tcp:<host>:<port> format — not Unix socket paths. So we:
			//   1. Start a socat inside the sandbox bridging TCP:5037 → Unix socket
			//   2. Set ADB_SERVER_SOCKET=tcp:localhost:5037 via spawn env
			// Both run inside bwrap's fresh netns where port 5037 is always free.
			let finalCommand = command;
			const spawnEnv: NodeJS.ProcessEnv = { ...env };
			if (adbBridge && existsSync(adbBridge.socketPath)) {
				// Start a TCP→Unix bridge on port 5037 (inside the sandbox).
				// The socat will be cleaned up when bwrap exits. Brief sleep
				// avoids a race between socat binding and adb connecting.
				finalCommand =
					`socat TCP-LISTEN:5037,fork,reuseaddr UNIX-CONNECT:${adbBridge.socketPath} &>/dev/null & ` +
					`sleep 0.1; ${command}`;
				// Set via spawn env so it propagates through bwrap into the
				// sandbox — inherited by all commands without shell quoting issues.
				spawnEnv.ADB_SERVER_SOCKET = "tcp:localhost:5037";
			} else if (adbBridge) {
				console.error(
					"[sandbox] ADB bridge socket missing: " + adbBridge.socketPath,
				);
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

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

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

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			// --- ADB Bridge setup ---
			const adbEnabled = config.adb?.enabled ?? false;
			if (adbEnabled) {
				const adbPort = config.adb?.port ?? 5037;

				adbBridge = startAdbBridge(adbPort);

				if (adbBridge) {
					// Inject Unix socket permissions so the sandboxed ADB client
					// can connect to the bridged socket.
					if (platform === "darwin") {
						// macOS Seatbelt: allow only this specific socket path
						const existing = config.network?.allowUnixSockets ?? [];
						config.network = {
							...config.network,
							allowUnixSockets: [...existing, adbBridge.socketPath],
						};
					} else {
						// Linux seccomp: path-based allowlisting isn't supported —
						// seccomp-bpf can't inspect user-space memory for paths.
						// We must allow ALL Unix sockets so ADB can call socket(AF_UNIX).
						// The existing proxy socat commands run BEFORE seccomp and
						// are unaffected. The tradeoff is that sandboxed code can
						// create arbitrary Unix sockets, but cannot reach host
						// sockets outside the bind-mounted filesystem.
						config.network = {
							...config.network,
							allowAllUnixSockets: true,
						};
					}

					console.error(`[sandbox] ADB bridge active: ${adbBridge.socketPath} -> localhost:${adbPort}`);
				} else {
					console.error("[sandbox] ADB bridge failed to start — ADB commands will not work inside the sandbox");
				}
			}

			// --- Initialize the sandbox ---
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			const adbStatus = adbBridge ? " ADB" : "";
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths${adbStatus}`),
			);
			ctx.ui.notify("Sandbox initialized" + (adbBridge ? " (ADB bridge active)" : ""), "info");
		} catch (err) {
			stopAdbBridge(); // clean up on failure
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		stopAdbBridge();

		if (sandboxInitialized) {
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
			if (!sandboxEnabled) {
				ctx.ui.notify("Sandbox is disabled", "info");
				return;
			}

			const config = loadConfig(ctx.cwd);
			const lines = [
				"Sandbox Configuration:",
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
				"",
				"ADB Bridge:",
				adbBridge
					? `  Enabled — socket: ${adbBridge.socketPath} -> localhost:${config.adb?.port ?? 5037}`
					: `  Disabled${config.adb?.enabled ? " (socat not available)" : ""}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
