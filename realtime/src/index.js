const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const WIDTH = 1000;
const HEIGHT = 600;
const GAME_LENGTH = 5 * 60 * 1000;
const BODY_TYPES = {
  small: { radius: 16, speed: 255, tackleSpeed: 460, tackleForce: 300, cooldownMs: 1000 },
  medium: { radius: 19, speed: 220, tackleSpeed: 420, tackleForce: 390, cooldownMs: 2000 },
  large: { radius: 22, speed: 185, tackleSpeed: 370, tackleForce: 500, cooldownMs: 3000 },
};

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
        bodyType: "medium",
        input: { x: 0, y: 0, shot: false, heel: false },
        facingX: identity.playerId ? 1 : 0,
        facingY: 0,
        knockbackX: 0, knockbackY: 0, stunnedUntil: 0, tackleCooldownUntil: 0,
        tackleSlideUntil: 0, tackleDirX: 1, tackleDirY: 0, tackleHitPlayer: false, tackleHitBall: false,
        tackleRequested: false,
        disconnectedAt: null,
      });
      if (!this.game.hostId) this.game.hostId = identity.playerId;
    } else {
      existing.name = identity.name.slice(0, 60);
      existing.avatarUrl = typeof identity.avatarUrl === "string" && identity.avatarUrl.startsWith("/api/player-photo?id=") ? identity.avatarUrl : null;
      if (!BODY_TYPES[existing.bodyType]) existing.bodyType = "medium";
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
      player.input = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), shot: event.shot === true || event.kick === true, heel: event.heel === true };
      if (event.tackle === true) player.tackleRequested = true;
      if (player.input.x || player.input.y) {
        const length = Math.hypot(player.input.x, player.input.y) || 1;
        player.facingX = player.input.x / length;
        player.facingY = player.input.y / length;
      }
      return;
    }
    if (event.type === "bodyType" && this.game.phase === "lobby" && Object.hasOwn(BODY_TYPES, event.bodyType)) {
      player.bodyType = event.bodyType;
      await this.persist();
      this.broadcast();
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
      player.input = { x: 0, y: 0, shot: false, heel: false };
      player.tackleRequested = false;
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
      if (!player.tackleRequested) continue;
      player.tackleRequested = false;
      const stats = bodyStats(player);
      if (now < (player.tackleCooldownUntil || 0) || now < (player.stunnedUntil || 0)) continue;
      const moving = Math.hypot(player.input.x, player.input.y) > 0.05;
      const directionX = moving ? player.input.x : player.facingX || (player.team === 0 ? 1 : -1);
      const directionY = moving ? player.input.y : player.facingY || 0;
      const directionLength = Math.hypot(directionX, directionY) || 1;
      player.tackleDirX = directionX / directionLength;
      player.tackleDirY = directionY / directionLength;
      player.tackleSlideUntil = now + 300;
      player.stunnedUntil = now + 800;
      player.tackleCooldownUntil = now + stats.cooldownMs;
      player.tackleHitPlayer = false;
      player.tackleHitBall = false;
      player.knockbackX = 0;
      player.knockbackY = 0;
    }
    for (const player of players) {
      const stunned = now < (player.stunnedUntil || 0);
      const sliding = now < (player.tackleSlideUntil || 0);
      const length = Math.hypot(player.input.x, player.input.y) || 1;
      const inputScale = stunned ? 0 : Math.min(1, 1 / length);
      const stats = bodyStats(player);
      player.vx = player.input.x * inputScale * stats.speed + (sliding ? player.tackleDirX * stats.tackleSpeed : 0) + (player.knockbackX || 0);
      player.vy = player.input.y * inputScale * stats.speed + (sliding ? player.tackleDirY * stats.tackleSpeed : 0) + (player.knockbackY || 0);
      player.x = clamp(player.x + player.vx * dt, 24, WIDTH - 24);
      player.y = clamp(player.y + player.vy * dt, 24, HEIGHT - 24);
      player.knockbackX = (player.knockbackX || 0) * 0.88;
      player.knockbackY = (player.knockbackY || 0) * 0.88;
    }

    for (const attacker of players) {
      if (now >= (attacker.tackleSlideUntil || 0) || attacker.tackleHitPlayer) continue;
      for (const target of players) {
        if (target === attacker) continue;
        const targetStats = bodyStats(target);
        const dx = target.x - attacker.x; const dy = target.y - attacker.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const forwardDot = (dx * attacker.tackleDirX + dy * attacker.tackleDirY) / distance;
        if (forwardDot < 0.35 || distance >= bodyStats(attacker).radius + targetStats.radius + 5) continue;
        const angle = Math.atan2(attacker.tackleDirY, attacker.tackleDirX);
        const targetAngle = angle + Math.PI + (Math.random() - 0.5) * 0.85;
        const targetForce = bodyStats(attacker).tackleForce + Math.random() * 90;
        target.knockbackX = Math.cos(targetAngle) * targetForce;
        target.knockbackY = Math.sin(targetAngle) * targetForce;
        const attackerAngle = angle + (Math.random() < 0.2 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.55;
        attacker.knockbackX = Math.cos(attackerAngle) * 190;
        attacker.knockbackY = Math.sin(attackerAngle) * 190;
        attacker.tackleHitPlayer = true;
        attacker.tackleSlideUntil = now;
        attacker.stunnedUntil = now + 500;
        target.stunnedUntil = now + 500;
        break;
      }
    }

    // Cheap solver passes keep crowded groups from ending a tick overlapped.
    for (let pass = 0; pass < 12; pass++) {
      for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
        const one = players[a]; const two = players[b];
        const dx = two.x - one.x; const dy = two.y - one.y;
        const distance = Math.hypot(dx, dy);
        const minDistance = bodyStats(one).radius + bodyStats(two).radius;
        if (distance < minDistance) {
          const nx = distance > 0.001 ? dx / distance : (a + b) % 2 ? 1 : -1;
          const ny = distance > 0.001 ? dy / distance : 0;
          const shift = (minDistance - distance) / 2;
          one.x = clamp(one.x - nx * shift, 24, WIDTH - 24);
          one.y = clamp(one.y - ny * shift, 24, HEIGHT - 24);
          two.x = clamp(two.x + nx * shift, 24, WIDTH - 24);
          two.y = clamp(two.y + ny * shift, 24, HEIGHT - 24);
        }
      }
    }

    const ball = this.game.ball;
    for (const player of players) {
      if (now >= (player.tackleSlideUntil || 0) || player.tackleHitBall) continue;
      const along = (ball.x - player.x) * player.tackleDirX + (ball.y - player.y) * player.tackleDirY;
      const across = Math.abs((ball.x - player.x) * player.tackleDirY - (ball.y - player.y) * player.tackleDirX);
      if (along < -3 || along > 46 || across > bodyStats(player).radius + 10) continue;
      const angle = Math.atan2(-player.tackleDirY, -player.tackleDirX) + (Math.random() - 0.5) * 0.65;
      const speed = 250 + Math.random() * 130;
      ball.vx = Math.cos(angle) * speed;
      ball.vy = Math.sin(angle) * speed;
      const clearDistance = bodyStats(player).radius + 12;
      player.x = clamp(ball.x + player.tackleDirX * clearDistance, 24, WIDTH - 24);
      player.y = clamp(ball.y + player.tackleDirY * clearDistance, 24, HEIGHT - 24);
      player.tackleSlideUntil = now;
      player.stunnedUntil = now + 500;
      player.tackleHitBall = true;
    }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    for (const player of players) {
      const dx = ball.x - player.x; const dy = ball.y - player.y;
      const distance = Math.hypot(dx, dy);
      const contactDistance = bodyStats(player).radius + 10;
      if (distance < contactDistance) {
        const nx = distance > 0.001 ? dx / distance : (player.team === 0 ? 1 : -1);
        const ny = distance > 0.001 ? dy / distance : 0;
        const correction = contactDistance - distance + 0.01;
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
        const minDistance = bodyStats(one).radius + bodyStats(two).radius;
        if (distance < minDistance) {
          const nx = distance > 0.001 ? dx / distance : (a + b) % 2 ? 1 : -1;
          const ny = distance > 0.001 ? dy / distance : 0;
          const shift = (minDistance - distance) / 2;
          one.x = clamp(one.x - nx * shift, 24, WIDTH - 24);
          one.y = clamp(one.y - ny * shift, 24, HEIGHT - 24);
          two.x = clamp(two.x + nx * shift, 24, WIDTH - 24);
          two.y = clamp(two.y + ny * shift, 24, HEIGHT - 24);
        }
      }
      for (const player of players) {
        const dx = ball.x - player.x; const dy = ball.y - player.y;
        const distance = Math.hypot(dx, dy);
        const contactDistance = bodyStats(player).radius + 10;
        if (distance < contactDistance) {
          const nx = distance > 0.001 ? dx / distance : (player.team === 0 ? 1 : -1);
          const ny = distance > 0.001 ? dy / distance : 0;
          const correction = contactDistance - distance + 0.01;
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
      player.input = { x: 0, y: 0, shot: false, heel: false };
      player.knockbackX = 0; player.knockbackY = 0; player.stunnedUntil = 0;
      player.tackleCooldownUntil = 0; player.tackleSlideUntil = 0;
      player.tackleHitPlayer = false; player.tackleHitBall = false;
      player.tackleRequested = false;
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
      players: this.game.players.map(({ id, name, avatarUrl, team, bodyType, x, y, stunnedUntil, tackleCooldownUntil, tackleSlideUntil, tackleDirX, tackleDirY }) => ({ id, name, avatarUrl, team, bodyType: BODY_TYPES[bodyType] ? bodyType : "medium", x, y, knocked: (stunnedUntil || 0) > Date.now(), sliding: (tackleSlideUntil || 0) > Date.now(), slideX: tackleDirX || 0, slideY: tackleDirY || 0, tackleReadyAt: tackleCooldownUntil || 0, connected: connected.has(id) })),
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
function bodyStats(player) { return BODY_TYPES[player.bodyType] || BODY_TYPES.medium; }
