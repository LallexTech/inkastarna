const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const WIDTH = 1000;
const HEIGHT = 600;
const GAME_LENGTH = 5 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{6})\/ws$/);
    if (!match || request.method !== "GET") return new Response("Not found", { status: 404 });
    if (!originAllowed(request.headers.get("Origin"), env.APP_ORIGINS)) return new Response("Forbidden", { status: 403 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });

    const protocol = request.headers.get("Sec-WebSocket-Protocol") || "";
    const ticket = protocol.split(",").map((part) => part.trim()).find((part) => part.startsWith("game-ticket."))?.slice("game-ticket.".length);
    const identity = await verifyTicket(ticket, env.GAME_TICKET_SECRET);
    if (!identity || identity.roomId !== match[1]) return new Response("Invalid or expired ticket", { status: 401 });

    const id = env.GAME_ROOMS.idFromName(match[1]);
    return env.GAME_ROOMS.get(id).fetch(request);
  },
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = emptyGame();
    this.timer = null;
    this.accumulator = 0;
    this.lastTick = 0;
    this.lastPersist = 0;
    this.tickCount = 0;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.game = await state.storage.get("game") || emptyGame();
    });
  }

  async fetch(request) {
    await this.ready;
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((part) => part.trim());
    const ticket = protocols.find((part) => part.startsWith("game-ticket."))?.slice("game-ticket.".length);
    const identity = await verifyTicket(ticket, this.env.GAME_TICKET_SECRET);
    if (!identity || identity.roomId !== this.game.roomId && this.game.roomId) return new Response("Invalid ticket", { status: 401 });
    if (!this.game.roomId) this.game.roomId = identity.roomId;

    const existing = this.game.players.find((player) => player.id === identity.playerId);
    if (!existing && this.game.players.length >= 10) return new Response("Rummet är fullt.", { status: 409 });
    if (!existing) {
      const teamCounts = [0, 0];
      this.game.players.forEach((player) => teamCounts[player.team]++);
      const team = teamCounts[0] <= teamCounts[1] ? 0 : 1;
      this.game.players.push({
        id: identity.playerId,
        name: identity.name.slice(0, 60),
        team,
        x: team === 0 ? 220 : WIDTH - 220,
        y: 150 + (teamCounts[team] % 4) * 100,
        vx: 0, vy: 0,
        input: { x: 0, y: 0, kick: false },
        facingX: identity.playerId ? 1 : 0,
        facingY: 0,
        disconnectedAt: null,
      });
      if (!this.game.hostId) this.game.hostId = identity.playerId;
    } else {
      existing.name = identity.name.slice(0, 60);
      existing.disconnectedAt = null;
    }
    if (!this.game.hostId) this.game.hostId = identity.playerId;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    for (const old of this.activeSockets()) {
      if (old.deserializeAttachment()?.playerId === identity.playerId) old.close(4001, "Reconnected elsewhere");
    }
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ playerId: identity.playerId, messageWindow: Date.now(), messageCount: 0 });
    await this.persist();
    this.scheduleExpiry();
    this.startLoop();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "inkastarna.v1" } });
  }

  async webSocketMessage(socket, message) {
    await this.ready;
    if (typeof message !== "string" || message.length > 512) return;
    const attachment = socket.deserializeAttachment() || {};
    const now = Date.now();
    if (now - (attachment.messageWindow || 0) > 1000) {
      attachment.messageWindow = now;
      attachment.messageCount = 0;
    }
    attachment.messageCount = (attachment.messageCount || 0) + 1;
    if (attachment.messageCount > 30) {
      socket.close(4008, "Input rate too high");
      return;
    }
    socket.serializeAttachment(attachment);
    let event;
    try { event = JSON.parse(message); } catch { return; }
    const playerId = socket.deserializeAttachment()?.playerId;
    const player = this.game.players.find((entry) => entry.id === playerId);
    if (!player) return;

    if (event.type === "input") {
      const x = Number(event.x);
      const y = Number(event.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      player.input = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), kick: event.kick === true };
      if (player.input.x || player.input.y) {
        const length = Math.hypot(player.input.x, player.input.y) || 1;
        player.facingX = player.input.x / length;
        player.facingY = player.input.y / length;
      }
      return;
    }
    if (event.type === "start" && player.id === this.game.hostId && this.game.phase === "lobby") {
      if (this.activeSockets().length < 2) return;
      this.resetPositions();
      this.game.phase = "playing";
      this.game.remainingMs = GAME_LENGTH;
      this.game.lastKickBy = null;
      this.startLoop();
      await this.persist();
      this.broadcast();
    } else if (event.type === "rematch" && player.id === this.game.hostId && this.game.phase === "finished") {
      this.game.score = [0, 0];
      this.game.phase = "lobby";
      this.game.remainingMs = GAME_LENGTH;
      this.resetPositions();
      await this.persist();
      this.broadcast();
    }
  }

  async webSocketClose(socket) {
    await this.disconnect(socket);
  }

  async webSocketError(socket) {
    await this.disconnect(socket);
  }

  async disconnect(socket) {
    await this.ready;
    const playerId = socket.deserializeAttachment()?.playerId;
    const player = this.game.players.find((entry) => entry.id === playerId);
    const stillConnected = this.activeSockets().some((candidate) => candidate !== socket && candidate.deserializeAttachment()?.playerId === playerId);
    if (player && !stillConnected) {
      player.input = { x: 0, y: 0, kick: false };
      player.disconnectedAt = Date.now();
      if (player.id === this.game.hostId) {
        const online = new Set(this.activeSockets().filter((candidate) => candidate !== socket).map((candidate) => candidate.deserializeAttachment()?.playerId));
        this.game.hostId = this.game.players.find((entry) => entry.id !== player.id && online.has(entry.id))?.id || null;
      }
      if (this.game.phase !== "playing") {
        this.game.players = this.game.players.filter((entry) => entry.id !== player.id);
      }
    }
    if (!this.activeSockets().length) this.stopLoop();
    await this.persist();
    this.broadcast();
  }

  startLoop() {
    if (this.timer || this.game.phase !== "playing" || !this.activeSockets().length) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), 1000 / 30);
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = Date.now();
    const elapsed = Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    this.accumulator = Math.min(this.accumulator + elapsed, 0.1);
    const step = 1 / 30;
    let steps = 0;
    while (this.accumulator >= step && steps < 3) {
      this.simulate(step);
      this.accumulator -= step;
      steps++;
    }
    this.game.remainingMs = Math.max(0, this.game.remainingMs - elapsed * 1000);
    let finished = false;
    if (!this.game.remainingMs) {
      this.game.phase = "finished";
      this.stopLoop();
      finished = true;
    }
    this.tickCount++;
    if (finished || this.tickCount % 3 === 0) this.broadcast();
    if (now - this.lastPersist > 1000) {
      this.lastPersist = now;
      this.persist();
    }
  }

  simulate(dt) {
    const online = new Set(this.activeSockets().map((socket) => socket.deserializeAttachment()?.playerId));
    const removedHost = this.game.players.some((player) => player.id === this.game.hostId && player.disconnectedAt && Date.now() - player.disconnectedAt > 60_000);
    this.game.players = this.game.players.filter((player) => !(player.disconnectedAt && Date.now() - player.disconnectedAt > 60_000));
    if (removedHost) this.game.hostId = this.game.players.find((player) => online.has(player.id))?.id || null;
    const players = this.game.players;
    for (const player of players) {
      const length = Math.hypot(player.input.x, player.input.y) || 1;
      const inputScale = Math.min(1, 1 / length);
      player.vx = player.input.x * inputScale * 220;
      player.vy = player.input.y * inputScale * 220;
      player.x = clamp(player.x + player.vx * dt, 24, WIDTH - 24);
      player.y = clamp(player.y + player.vy * dt, 24, HEIGHT - 24);
    }

    for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
      const one = players[a]; const two = players[b];
      const dx = two.x - one.x; const dy = two.y - one.y;
      const distance = Math.hypot(dx, dy) || 0.001;
      if (distance < 34) {
        const shift = (34 - distance) / 2;
        one.x = clamp(one.x - dx / distance * shift, 24, WIDTH - 24);
        one.y = clamp(one.y - dy / distance * shift, 24, HEIGHT - 24);
        two.x = clamp(two.x + dx / distance * shift, 24, WIDTH - 24);
        two.y = clamp(two.y + dy / distance * shift, 24, HEIGHT - 24);
      }
    }

    const ball = this.game.ball;
    for (const player of players) {
      const dx = ball.x - player.x; const dy = ball.y - player.y;
      if (dx * dx + dy * dy < 30 * 30) {
        ball.vx += player.vx * dt * 1.1;
        ball.vy += player.vy * dt * 1.1;
        if (player.input.kick && !player.wasKicking) {
          const directionX = player.input.x || player.facingX || (player.team === 0 ? 1 : -1);
          const directionY = player.input.y || player.facingY;
          const length = Math.hypot(directionX, directionY) || 1;
          ball.vx = directionX / length * 520;
          ball.vy = directionY / length * 520;
          this.game.lastKickBy = player.id;
        }
      }
      player.wasKicking = player.input.kick;
    }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    const friction = Math.pow(0.982, dt * 30);
    ball.vx *= friction; ball.vy *= friction;
    if (ball.y < 14 || ball.y > HEIGHT - 14) {
      ball.y = clamp(ball.y, 14, HEIGHT - 14);
      ball.vy *= -0.7;
    }
    if (ball.x < 0 || ball.x > WIDTH) {
      if (ball.y >= 235 && ball.y <= 365) {
        this.game.score[ball.x > WIDTH ? 0 : 1]++;
        this.resetPositions();
      } else {
        ball.x = clamp(ball.x, 14, WIDTH - 14);
        ball.vx *= -0.7;
      }
    }
    ball.x = clamp(ball.x, -8, WIDTH + 8);
  }

  resetPositions() {
    const teamIndex = [0, 0];
    for (const player of this.game.players) {
      const index = teamIndex[player.team]++;
      const direction = player.team === 0 ? -1 : 1;
      player.x = WIDTH / 2 + direction * (150 + Math.floor(index / 3) * 80);
      player.y = 170 + (index % 3) * 130;
      player.vx = 0; player.vy = 0;
      player.input = { x: 0, y: 0, kick: false };
      player.wasKicking = false;
    }
    this.game.ball = { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0 };
  }

  snapshot() {
    const connected = new Set(this.activeSockets().map((socket) => socket.deserializeAttachment()?.playerId));
    return {
      type: "state",
      phase: this.game.phase,
      hostId: this.game.hostId,
      roomId: this.game.roomId,
      score: this.game.score,
      remainingMs: this.game.remainingMs,
      ball: this.game.ball,
      players: this.game.players.map(({ id, name, team, x, y }) => ({ id, name, team, x, y, connected: connected.has(id) })),
    };
  }

  broadcast() {
    const message = JSON.stringify(this.snapshot());
    for (const socket of this.activeSockets()) {
      try { socket.send(message); } catch { socket.close(1011, "Send failed"); }
    }
  }

  activeSockets() {
    return this.state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  async persist() {
    await this.state.storage.put("game", this.game);
  }

  scheduleExpiry() {
    this.state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }

  async alarm() {
    this.stopLoop();
    for (const socket of this.activeSockets()) socket.close(4000, "Rummet har gått ut.");
    await this.state.storage.deleteAll();
  }
}

async function verifyTicket(ticket, secret) {
  if (typeof ticket !== "string" || !secret || secret.length < 32) return null;
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, decodeBase64Url(signature), new TextEncoder().encode(payload));
    if (!valid) return null;
    const identity = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    if (!ROOM_CODE.test(identity.roomId) || typeof identity.playerId !== "string" || !identity.playerId || typeof identity.name !== "string" || identity.team !== "inkastarna" || !Number.isFinite(identity.exp) || identity.exp <= Date.now() / 1000 || identity.exp > Date.now() / 1000 + 60) return null;
    return identity;
  } catch { return null; }
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function originAllowed(origin, configuredOrigins) {
  if (!origin) return false;
  const allowed = (configuredOrigins || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && (parsed.hostname === "inkastarna.netlify.app" || parsed.hostname.endsWith(".inkastarna.netlify.app"));
  } catch { return false; }
}

function emptyGame() {
  return { roomId: null, phase: "lobby", hostId: null, players: [], score: [0, 0], remainingMs: GAME_LENGTH, ball: { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0 }, lastKickBy: null };
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
