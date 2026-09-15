// mcp/channel-peers.mjs
import { open, constants } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join } from "node:path";
import { homedir } from "node:os";

// mcp/channel.mjs
import { isAbsolute } from "node:path";
function validateForwardTo(forwardTo) {
  if (forwardTo === void 0) return void 0;
  if (!forwardTo || typeof forwardTo !== "object" || Array.isArray(forwardTo)) throw Error("Invalid forward destination");
  if (Object.keys(forwardTo).some((k) => !["name", "sessionId", "cwd"].includes(k))) throw Error("Invalid forward destination");
  const { name, sessionId, cwd } = forwardTo;
  if (typeof name !== "string" || !name.trim() || typeof sessionId !== "string" || !sessionId.trim()) throw Error("Forward destination requires name and sessionId");
  if (cwd !== void 0 && (typeof cwd !== "string" || !isAbsolute(cwd))) throw Error("Forward destination cwd must be absolute");
  return { name, sessionId, ...cwd ? { cwd } : {} };
}

// mcp/channel-peers.mjs
var defaultPeersFile = join(homedir(), ".config", "bridge", "peers.json");
async function loadChannelPeers(path = process.env.BRIDGE_CHANNEL_PEERS_FILE) {
  const explicit = path !== void 0;
  if (!explicit) path = defaultPeersFile;
  if (!path) return [];
  if (!isAbsolute2(path)) throw Error("Channel peers file must use an absolute path");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!explicit && error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.mode & 63 || process.getuid && info.uid !== process.getuid()) throw Error("Channel peers file must be private and owned by this user");
    if (info.size > 131072) throw Error("Channel peers configuration too large");
    let peers;
    try {
      peers = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw Error("Invalid channel peers JSON");
    }
    return validateChannelPeers(peers);
  } finally {
    await handle.close();
  }
}
function validateChannelPeers(peers) {
  if (!Array.isArray(peers) || peers.length > 32) throw Error("Expected at most 32 channel peers");
  const ids = /* @__PURE__ */ new Set();
  for (const p of peers) {
    if (!p || typeof p.id !== "string" || !p.id || ids.has(p.id) || typeof p.sessionId !== "string" || !p.sessionId) throw Error("Invalid or duplicate channel peer");
    ids.add(p.id);
    let url;
    try {
      url = new URL(p.url);
    } catch {
      throw Error("Invalid channel peer URL");
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("Channel peer must use a loopback HTTP origin");
    if (typeof p.token !== "string" || Buffer.byteLength(p.token) < 32) throw Error("Invalid channel credential");
    if (p.title !== void 0 && typeof p.title !== "string") throw Error("Invalid peer title");
  }
  return peers;
}
var ChannelPeers = class {
  constructor(load = loadChannelPeers) {
    this.load = load;
  }
  async identity(peer, timeoutMs = 3e3) {
    const response = await fetch(new URL("/identity", peer.url), {
      headers: { Authorization: `Bearer ${peer.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw Error(`Channel identity HTTP ${response.status}`);
    const identity = await response.json();
    if (identity.sessionId !== peer.sessionId || identity.transport !== "claude-channel") throw Error("Channel identity mismatch");
    return {
      peerId: peer.id,
      sessionId: peer.sessionId,
      title: peer.title ?? peer.sessionId,
      app: "claude",
      ...identity.asyncReplies === true ? { asyncReplies: true } : {},
      uiVerified: false
    };
  }
  async discover() {
    const peers = (await this.load()).filter((p) => p.protocol !== "bridge-codex-inbox-v1");
    const results = await Promise.allSettled(peers.map((p) => this.identity(p)));
    return {
      candidates: results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []),
      unavailable: results.flatMap((r, i) => r.status === "rejected" ? [{ peerId: peers[i].id, error: r.reason.message }] : []),
      selectionRequired: true,
      configured: peers.length > 0
    };
  }
  // forwardTo asks the receiving relay session to hand the body to another
  // existing Claude session through its official SendMessage tool.
  async send({ peerId, sessionId, body, forwardTo, timeoutMs = 18e4 }) {
    const peers = await this.load();
    const peer = peers.find((p) => p.id === peerId);
    if (!peer || peer.sessionId !== sessionId) throw Error("Unknown or changed destination");
    if (typeof body !== "string" || !body.trim()) throw Error("Empty message");
    const target = validateForwardTo(forwardTo);
    await this.identity(peer, Math.min(timeoutMs, 3e3));
    const echo = { peerId, sessionId, ...target ? { forwardTo: target } : {} };
    try {
      const response = await fetch(new URL("/messages", peer.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        // The receiver waits for its reply tool up to the same deadline, so a
        // long relay round trip is not cut short by the server-side default.
        body: JSON.stringify({ sessionId, body, timeoutMs, ...target ? { forwardTo: target } : {} }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs + 5e3)
      });
      const result = await response.json();
      if (response.status === 400 || response.status === 403 || response.status === 413) {
        return { status: "failed", ...echo, error: result.error ?? "Channel rejected request" };
      }
      if (result.sessionId !== sessionId || typeof result.messageId !== "string") throw Error("Invalid channel response");
      if (response.status === 422 && result.status === "failed" && typeof result.error === "string") {
        return { status: "failed", ...echo, messageId: result.messageId, error: result.error };
      }
      if (response.status === 202 && ["delivered", "queued"].includes(result.status) && target) return { ...result, ...echo, uiVerified: false };
      if (response.ok && result.status === "replied" && typeof result.reply === "string") return { ...result, ...echo, uiVerified: false };
      return { status: "unknown", ...echo, messageId: result.messageId, error: "No confirmed reply. Do not automatically resend." };
    } catch {
      return { status: "unknown", ...echo, error: "Channel response lost or invalid. Do not automatically resend." };
    }
  }
  // Submit once even when the target may be busy. This returns a receiver ID,
  // not evidence that the target received or answered the message.
  async submit({ peerId, sessionId, body, forwardTo, timeoutMs = 18e5 }) {
    const peers = await this.load();
    const peer = peers.find((p) => p.id === peerId);
    if (!peer || peer.sessionId !== sessionId) throw Error("Unknown or changed destination");
    if (typeof body !== "string" || !body.trim()) throw Error("Empty message");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 36e5) throw Error("Invalid timeout");
    const target = validateForwardTo(forwardTo);
    const identity = await this.identity(peer);
    if (identity.asyncReplies !== true) throw Error("This receiver must be reconnected with the updated bridge before async submission. No submission sent.");
    const echo = { peerId, sessionId, ...target ? { forwardTo: target } : {} };
    try {
      const response = await fetch(new URL("/submissions", peer.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, body, timeoutMs, ...target ? { forwardTo: target } : {} }),
        redirect: "error",
        signal: AbortSignal.timeout(1e4)
      });
      const result = await response.json();
      if ([400, 403, 413, 429].includes(response.status))
        return { status: "failed", ...echo, final: true, error: result.error ?? "Channel rejected submission" };
      if (response.status !== 202 || result.status !== "accepted" || result.final !== false || result.sessionId !== sessionId || typeof result.messageId !== "string" || !result.messageId.trim()) throw Error("Invalid submission response");
      return { ...result, ...echo, uiVerified: false };
    } catch {
      return {
        status: "unknown",
        ...echo,
        final: true,
        error: "Submission response lost or invalid; acceptance is unknown and no receipt ID is confirmed. Do not resubmit."
      };
    }
  }
  // Re-observation uses only authenticated GET for the same known message ID.
  // Connection failures are not evidence that the original request ended.
  async wait({ peerId, sessionId, messageId, timeoutMs = 1e3 }) {
    const peers = await this.load();
    const peer = peers.find((p) => p.id === peerId);
    if (!peer || peer.sessionId !== sessionId) throw Error("Unknown or changed destination");
    if (typeof messageId !== "string" || !messageId.trim()) throw Error("messageId required");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6e4) throw Error("Invalid observation timeout");
    const echo = { peerId, sessionId, messageId };
    try {
      await this.identity(peer);
      const url = new URL("/messages/" + encodeURIComponent(messageId), peer.url);
      url.searchParams.set("waitMs", String(timeoutMs));
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${peer.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs + 5e3)
      });
      const result = await response.json();
      const validFinal = result.final === true && ["replied", "delivered", "queued", "failed", "unknown"].includes(result.status);
      const validPending = result.final === false && result.status === "pending";
      if (!response.ok || result.sessionId !== sessionId || result.messageId !== messageId || !validFinal && !validPending || result.status === "replied" && typeof result.reply !== "string") throw Error("Invalid observation response");
      return { ...result, ...echo, uiVerified: false };
    } catch {
      return {
        status: "unknown",
        ...echo,
        final: false,
        error: "Observation response lost or invalid. The original request may still be pending; observe this same messageId again. Do not resubmit."
      };
    }
  }
  // Called from the session that received a relayed message: hands its answer
  // to the relay receiver, which completes the sender's waiting bridge_claude_send.
  async reply({ peerId, sessionId, messageId, body, timeoutMs = 1e4 }) {
    const peers = await this.load();
    const peer = peers.find((p) => p.id === peerId);
    if (!peer || peer.sessionId !== sessionId) throw Error("Unknown or changed destination");
    if (typeof messageId !== "string" || !messageId.trim()) throw Error("messageId required");
    if (typeof body !== "string" || !body.trim()) throw Error("Empty reply");
    await this.identity(peer, Math.min(timeoutMs, 3e3));
    try {
      const response = await fetch(new URL("/replies", peer.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messageId, body }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
      const result = await response.json();
      if (response.status === 200 && result.status === "replied" && result.messageId === messageId) return { status: "replied", peerId, sessionId, messageId };
      return { status: "failed", peerId, sessionId, messageId, error: result.error ?? "Relay rejected the reply" };
    } catch {
      return { status: "unknown", peerId, sessionId, messageId, error: "Reply response lost or invalid. Do not automatically resend." };
    }
  }
};
export {
  ChannelPeers,
  defaultPeersFile,
  loadChannelPeers,
  validateChannelPeers
};
