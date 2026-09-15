// Adapted from OpenAI codex-plugin-cc 1.0.6, db52e28f4d9ded852ab3942cea316258ae4ef346
// https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/app-server.mjs
// Apache-2.0; see LICENSE and NOTICE. Changes: direct/explicit CLI proxy; remove
// broker/manifest/generated-type dependencies; bridge identity; visible stderr;
// stdin errors and bounded child cleanup. Original client identifiers retained.
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";

const DEFAULT_CLIENT_INFO = { title: "bridge", name: "bridge", version: "0.1.0" };

const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = new Error(message);
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.closed = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

export class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
    // Codex CLI `app-server proxy --help`, checked 2026-09-09. Reuse the
    // upstream JSONL client; the official CLI owns the socket wire protocol.
    // Explicit opt-in only: do not create a daemon or fall back after failure.
    this.proxySocket = options.proxySocket ?? (options.env ?? process.env).BRIDGE_CODEX_PROXY_SOCKET;
    if (this.proxySocket !== undefined) this.transport = "proxy";
  }

  async initialize() {
    const args = ["app-server"];
    if (this.transport === "proxy") {
      if (!this.proxySocket || !isAbsolute(this.proxySocket)) throw Error('BRIDGE_CODEX_PROXY_SOCKET must be an absolute socket path');
      if (!(await stat(this.proxySocket)).isSocket()) throw Error('BRIDGE_CODEX_PROXY_SOCKET is not a socket');
      args.push("proxy", "--sock", this.proxySocket);
    }
    if (this.closed) throw Error('codex app-server client is closed.');
    this.proc = spawn("codex", args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdin.on("error", (error) => this.handleExit(error));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      (this.options.onStderr ?? ((text) => process.stderr.write(text)))(chunk);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    this.closed = true;
    this.readline?.close();
    if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode) return;
    const exited = new Promise((resolve) => this.proc.once("exit", resolve));
    this.proc.stdin.end();
    const terminate = setTimeout(() => this.proc.kill("SIGTERM"), 50);
    const kill = setTimeout(() => this.proc.kill("SIGKILL"), 1000);
    try { await exited; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}
