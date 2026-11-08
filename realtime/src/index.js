const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const WIDTH = 1000;
const HEIGHT = 600;
const GAME_LENGTH = 5 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/rooms" && request.method === "GET") {
      const origin = request.headers.get("Origin");
      if (!originAllowed(origin, env.APP_ORIGINS)) return new Response("Forbidden", { status: 403 });
      const directory = env.ROOM_DIRECTORY.get(env.ROOM_DIRECTORY.idFromName("global"));
      const response = await directory.fetch("https://directory.internal/rooms");
      return new Response(response.body, { status: response.status, headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
      } });
    }
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
    this.lastDirectoryPublish = 0;
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
        avatarUrl: typeof identity.avatarUrl === "string" && identity.avatarUrl.startsWith("/api/player-photo?id=") ? identity.avatarUrl : null,
        team,
        x: team === 0 ? 220 : WIDTH - 220,
        y: 150 + (teamCounts[team] % 4) * 100,
        vx: 0, vy: 0,
        input: { x: 0, y: 0, shot: false, heel: false, charge: false },
        facingX: identity.playerId ? 1 : 0,
        facingY: 0,
        knockbackX: 0, knockbackY: 0, stunnedUntil: 0, tackleCooldownUntil: 0, tackleReady: true,
        disconnectedAt: null,
      });
      if (!this.game.hostId) this.game.hostId = identity.playerId;
    } else {
      existing.name = identity.name.slice(0, 60);
      existing.avatarUrl = typeof identity.avatarUrl === "string" && identity.avatarUrl.startsWith("/api/player-photo?id=") ? identity.avatarUrl : null;
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
    await this.publishRoom(true);
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
      player.input = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), shot: event.shot === true || event.kick === true, heel: event.heel === true, charge: event.charge === true };
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
      await this.publishRoom(true);
      this.broadcast();
    } else if (event.type === "rematch" && player.id === this.game.hostId && this.game.phase === "finished") {
      this.game.score = [0, 0];
      this.game.phase = "lobby";
      this.game.remainingMs = GAME_LENGTH;
      this.resetPositions();
      await this.persist();
      await this.publishRoom(true);
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
      player.input = { x: 0, y: 0, shot: false, heel: false, charge: false };
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
    await this.publishRoom(true);
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
      void this.publishRoom(true);
    }
    else if (now - this.lastDirectoryPublish > 5000) void this.publishRoom();
    this.tickCount++;
    if (finished || this.tickCount % 3 === 0) this.broadcast();
    if (now - this.lastPersist > 1000) {
      this.lastPersist = now;
      this.persist();
    }
  }

  simulate(dt) {
    const now = Date.now();
    const online = new Set(this.activeSockets().map((socket) => socket.deserializeAttachment()?.playerId));
    const removedHost = this.game.players.some((player) => player.id === this.game.hostId && player.disconnectedAt && now - player.disconnectedAt > 60_000);
    this.game.players = this.game.players.filter((player) => !(player.disconnectedAt && now - player.disconnectedAt > 60_000));
    if (removedHost) this.game.hostId = this.game.players.find((player) => online.has(player.id))?.id || null;
    const players = this.game.players;
    for (const player of players) {
      if (!player.input.charge) player.tackleReady = true;
      const stunned = now < (player.stunnedUntil || 0);
      const length = Math.hypot(player.input.x, player.input.y) || 1;
      const inputScale = stunned ? 0 : Math.min(1, 1 / length);
      const speed = player.input.charge && !stunned ? 300 : 220;
      player.vx = player.input.x * inputScale * speed + (player.knockbackX || 0);
      player.vy = player.input.y * inputScale * speed + (player.knockbackY || 0);
      player.x = clamp(player.x + player.vx * dt, 24, WIDTH - 24);
      player.y = clamp(player.y + player.vy * dt, 24, HEIGHT - 24);
      player.knockbackX = (player.knockbackX || 0) * 0.88;
      player.knockbackY = (player.knockbackY || 0) * 0.88;
    }

    for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
      const one = players[a]; const two = players[b];
      const dx = two.x - one.x; const dy = two.y - one.y;
      if (Math.hypot(dx, dy) >= 46) continue;
      const nx = dx / (Math.hypot(dx, dy) || 1); const ny = dy / (Math.hypot(dx, dy) || 1);
      const canTackle = (player, towardX, towardY) => {
        if (!player.input.charge || player.tackleReady === false || now < (player.tackleCooldownUntil || 0) || Math.hypot(player.vx, player.vy) < 130) return false;
        const moving = Math.hypot(player.input.x, player.input.y) > 0.05;
        const moveX = moving ? player.input.x : player.facingX || 0;
        const moveY = moving ? player.input.y : player.facingY || 0;
        return (moveX * towardX + moveY * towardY) / (Math.hypot(moveX, moveY) || 1) > 0.25;
      };
      const oneCanTackle = canTackle(one, nx, ny);
      const twoCanTackle = canTackle(two, -nx, -ny);
      if (!oneCanTackle && !twoCanTackle) continue;
      const attacker = oneCanTackle && twoCanTackle ? (Math.random() < 0.5 ? one : two) : oneCanTackle ? one : two;
      const target = attacker === one ? two : one;
      const moving = Math.hypot(attacker.input.x, attacker.input.y) > 0.05;
      const moveX = moving ? attacker.input.x : attacker.facingX || 1;
      const moveY = moving ? attacker.input.y : attacker.facingY || 0;
      const moveLength = Math.hypot(moveX, moveY) || 1;
      const angle = Math.atan2(moveY / moveLength, moveX / moveLength);
      const targetAngle = angle + (Math.random() - 0.5) * 0.75;
      const targetForce = 330 + Math.random() * 100;
      target.knockbackX = Math.cos(targetAngle) * targetForce;
      target.knockbackY = Math.sin(targetAngle) * targetForce;
      const stumbleForward = Math.random() < 0.22;
      const attackerAngle = angle + (stumbleForward ? 0 : Math.PI) + (Math.random() - 0.5) * 0.5;
      const attackerForce = stumbleForward ? 150 : 220;
      attacker.knockbackX = Math.cos(attackerAngle) * attackerForce;
      attacker.knockbackY = Math.sin(attackerAngle) * attackerForce;
      attacker.stunnedUntil = now + 420;
      target.stunnedUntil = now + 520;
      attacker.tackleCooldownUntil = now + 900;
      target.tackleCooldownUntil = now + 900;
      attacker.tackleReady = false;
      target.tackleReady = false;
    }

    // Cheap solver passes keep crowded groups from ending a tick overlapped.
    for (let pass = 0; pass < 12; pass++) {
      for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
        const one = players[a]; const two = players[b];
        const dx = two.x - one.x; const dy = two.y - one.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 38) {
          const nx = distance > 0.001 ? dx / distance : (a + b) % 2 ? 1 : -1;
          const ny = distance > 0.001 ? dy / distance : 0;
          const shift = (38 - distance) / 2;
          one.x = clamp(one.x - nx * shift, 24, WIDTH - 24);
          one.y = clamp(one.y - ny * shift, 24, HEIGHT - 24);
          two.x = clamp(two.x + nx * shift, 24, WIDTH - 24);
          two.y = clamp(two.y + ny * shift, 24, HEIGHT - 24);
        }
      }
    }

    const ball = this.game.ball;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    for (const player of players) {
      const dx = ball.x - player.x; const dy = ball.y - player.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 30) {
        const nx = distance > 0.001 ? dx / distance : (player.team === 0 ? 1 : -1);
        const ny = distance > 0.001 ? dy / distance : 0;
        const correction = 30 - distance + 0.01;
        ball.x += nx * correction * 0.72;
        ball.y += ny * correction * 0.72;
        player.x = clamp(player.x - nx * correction * 0.28, 24, WIDTH - 24);
        player.y = clamp(player.y - ny * correction * 0.28, 24, HEIGHT - 24);
        const relativeSpeed = (ball.vx - player.vx) * nx + (ball.vy - player.vy) * ny;
        if (relativeSpeed < 0) {
          const impulse = -relativeSpeed * 1.35;
          ball.vx += impulse * nx;
          ball.vy += impulse * ny;
        }
        const shooting = player.input.shot && !player.wasShooting;
        const heeling = player.input.heel && !player.wasHeeling;
        if (heeling || shooting) {
          const direction = heeling ? -1 : 1;
          const moving = Math.hypot(player.input.x, player.input.y) > 0.05;
          const directionX = moving ? player.input.x : player.facingX || (player.team === 0 ? 1 : -1);
          const directionY = moving ? player.input.y : player.facingY || 0;
          const length = Math.hypot(directionX, directionY) || 1;
          ball.vx = directionX / length * 520 * direction;
          ball.vy = directionY / length * 520 * direction;
          this.game.lastKickBy = player.id;
        }
      }
      player.wasShooting = player.input.shot;
      player.wasHeeling = player.input.heel;
    }

    // Resolve player and ball contacts together so a ball cannot get wedged between players.
    for (let pass = 0; pass < 12; pass++) {
      for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
        const one = players[a]; const two = players[b];
        const dx = two.x - one.x; const dy = two.y - one.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 38) {
          const nx = distance > 0.001 ? dx / distance : (a + b) % 2 ? 1 : -1;
          const ny = distance > 0.001 ? dy / distance : 0;
          const shift = (38 - distance) / 2;
          one.x = clamp(one.x - nx * shift, 24, WIDTH - 24);
          one.y = clamp(one.y - ny * shift, 24, HEIGHT - 24);
          two.x = clamp(two.x + nx * shift, 24, WIDTH - 24);
          two.y = clamp(two.y + ny * shift, 24, HEIGHT - 24);
        }
      }
      for (const player of players) {
        const dx = ball.x - player.x; const dy = ball.y - player.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 30) {
          const nx = distance > 0.001 ? dx / distance : (player.team === 0 ? 1 : -1);
          const ny = distance > 0.001 ? dy / distance : 0;
          const correction = 30 - distance + 0.01;
          ball.x += nx * correction * 0.72;
          ball.y += ny * correction * 0.72;
          player.x = clamp(player.x - nx * correction * 0.28, 24, WIDTH - 24);
          player.y = clamp(player.y - ny * correction * 0.28, 24, HEIGHT - 24);
        }
      }
    }

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
      player.input = { x: 0, y: 0, shot: false, heel: false, charge: false };
      player.knockbackX = 0; player.knockbackY = 0; player.stunnedUntil = 0;
      player.tackleCooldownUntil = 0; player.tackleReady = true;
      player.wasShooting = false;
      player.wasHeeling = false;
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
      players: this.game.players.map(({ id, name, avatarUrl, team, x, y, stunnedUntil }) => ({ id, name, avatarUrl, team, x, y, knocked: (stunnedUntil || 0) > Date.now(), connected: connected.has(id) })),
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
    const directory = this.env.ROOM_DIRECTORY.get(this.env.ROOM_DIRECTORY.idFromName("global"));
    await directory.fetch("https://directory.internal/update", { method: "POST", body: JSON.stringify({ roomId: this.game.roomId, remove: true }) });
  }

  async publishRoom(force = false) {
    const now = Date.now();
    if (!this.game.roomId || (!force && now - this.lastDirectoryPublish < 5000)) return;
    this.lastDirectoryPublish = now;
    const connected = new Set(this.activeSockets().map((socket) => socket.deserializeAttachment()?.playerId));
    const room = {
      roomId: this.game.roomId,
      phase: this.game.phase,
      players: this.game.players.length,
      connected: connected.size,
      updatedAt: now,
    };
    const directory = this.env.ROOM_DIRECTORY.get(this.env.ROOM_DIRECTORY.idFromName("global"));
    await directory.fetch("https://directory.internal/update", { method: "POST", body: JSON.stringify({ room }) });
  }
}

export class RoomDirectory {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/update" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.roomId !== "string" || !ROOM_CODE.test(body.roomId)) return new Response("Bad room", { status: 400 });
      const key = `room:${body.roomId}`;
      if (body.remove || !body.room || body.room.connected < 1 || body.room.players >= 10 || body.room.phase === "finished") {
        await this.state.storage.delete(key);
      } else {
        await this.state.storage.put(key, {
          roomId: body.roomId,
          phase: body.room.phase === "playing" ? "playing" : "lobby",
          players: Math.max(0, Math.min(10, Number(body.room.players) || 0)),
          connected: Math.max(0, Math.min(10, Number(body.room.connected) || 0)),
          updatedAt: Date.now(),
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rooms" && request.method === "GET") {
      const rooms = await this.state.storage.list({ prefix: "room:", limit: 200 });
      const cutoff = Date.now() - 60 * 60 * 1000;
      const result = [];
      for (const [key, room] of rooms) {
        if (room.updatedAt < cutoff) await this.state.storage.delete(key);
        else if (room.connected > 0 && room.players < 10 && room.phase !== "finished") result.push(room);
      }
      result.sort((a, b) => b.updatedAt - a.updatedAt);
      return Response.json({ rooms: result });
    }
    return new Response("Not found", { status: 404 });
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
