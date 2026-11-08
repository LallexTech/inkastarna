import abilities from "../../shared/arena-abilities.json";

const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const WIDTH = 1000;
const HEIGHT = 600;
const GAME_LENGTH = 5 * 60 * 1000;
const CHARGE_DURATION_MS = 4000;
const CHARGE_REST_MS = 4000;
const CONFUSION_DURATION_MS = 3000;
const ACTION_BUFFER_MS = 1200;
const TEST_PLAYER_ID = "__inkastarna_test_player__";
const ABILITY_IDS = new Set(abilities.map((ability) => ability.id));
const SUPER_COOLDOWN_MS = 60_000;
const DEFAULT_PROFILE = Object.freeze({ speed: 3, acceleration: 3, size: 3, tackling: 3, abilityId: null });

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
    const characterId = identity.characterId || identity.playerId;
    if (this.game.players.some((player) => player.id !== identity.playerId && (player.characterId || player.id) === characterId)) return new Response("Den spelaren är redan vald i rummet.", { status: 409 });
    if (existing && this.game.phase === "playing" && (existing.characterId || existing.id) !== characterId) return new Response("Spelarkaraktären är låst under matchen.", { status: 409 });
    if (!existing) this.game.players = this.game.players.filter((player) => player.id !== TEST_PLAYER_ID);
    if (!existing && this.game.players.length >= 10) return new Response("Rummet är fullt.", { status: 409 });
    if (!existing) {
      const teamCounts = [0, 0];
      this.game.players.forEach((player) => teamCounts[player.team]++);
      const team = teamCounts[0] <= teamCounts[1] ? 0 : 1;
      this.game.players.push({
        id: identity.playerId,
        characterId,
        name: identity.name.slice(0, 60),
        avatarUrl: typeof identity.avatarUrl === "string" && identity.avatarUrl.startsWith("/api/player-photo?id=") ? identity.avatarUrl : null,
        gameProfile: sanitizeProfile(identity.gameProfile),
        team,
        x: team === 0 ? 220 : WIDTH - 220,
        y: 150 + (teamCounts[team] % 4) * 100,
        vx: 0, vy: 0,
        input: { x: 0, y: 0 },
        facingX: identity.playerId ? 1 : 0,
        facingY: 0,
        knockbackX: 0, knockbackY: 0, stunnedUntil: 0, tackleCooldownUntil: 0,
        tackleSlideUntil: 0, tackleDirX: 1, tackleDirY: 0, tackleHitPlayer: false, tackleHitBall: false,
        tackleRequested: false,
        shotRequestedUntil: 0, heelRequestedUntil: 0,
        chargeRequested: false, chargeUntil: 0, chargeReadyAt: 0, slowedUntil: 0,
        abilityRequested: false, abilityReadyAt: 0, abilityUntil: 0, abilityState: null, afterEffectUntil: 0, afterEffectId: null,
        retreatUntil: 0, stickyRootId: null, stickyMembers: [], pantingUntil: 0,
        bonusTackleReady: false,
        disconnectedAt: null,
      });
      if (!this.game.hostId) this.game.hostId = identity.playerId;
    } else {
      if (this.game.phase !== "playing") {
        existing.characterId = characterId;
        existing.name = identity.name.slice(0, 60);
        existing.avatarUrl = typeof identity.avatarUrl === "string" && identity.avatarUrl.startsWith("/api/player-photo?id=") ? identity.avatarUrl : null;
        existing.gameProfile = sanitizeProfile(identity.gameProfile);
      }
      existing.abilityReadyAt ||= 0;
      existing.abilityUntil ||= 0;
      existing.abilityState ||= null;
      existing.stickyMembers ||= [];
      existing.chargeUntil ||= 0;
      existing.chargeReadyAt ||= 0;
      existing.slowedUntil ||= 0;
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
      player.input = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
      if (event.shot === true || event.kick === true) player.shotRequestedUntil = now + ACTION_BUFFER_MS;
      if (event.heel === true) player.heelRequestedUntil = now + ACTION_BUFFER_MS;
      if (event.tackle === true) player.tackleRequested = true;
      if (event.sprint === true || event.charge === true) player.chargeRequested = true;
      if (event.super === true) player.abilityRequested = true;
      if (player.input.x || player.input.y) {
        const length = Math.hypot(player.input.x, player.input.y) || 1;
        player.facingX = player.input.x / length;
        player.facingY = player.input.y / length;
      }
      return;
    }
    if (event.type === "start" && player.id === this.game.hostId && this.game.phase === "lobby") {
      const connectedCount = this.activeSockets().length;
      if (connectedCount < 1) return;
      if (connectedCount === 1 && !this.game.players.some((entry) => entry.id === TEST_PLAYER_ID)) {
        const realPlayer = this.game.players.find((entry) => entry.id !== TEST_PLAYER_ID);
        if (realPlayer) this.game.players.push(makeTestPlayer(realPlayer.team === 0 ? 1 : 0));
      }
      this.resetPositions(true);
      if (connectedCount === 1) {
        const realPlayer = this.game.players.find((entry) => entry.id !== TEST_PLAYER_ID);
        const testPlayer = this.game.players.find((entry) => entry.id === TEST_PLAYER_ID);
        if (realPlayer && testPlayer) {
          const direction = realPlayer.team === 0 ? 1 : -1;
          realPlayer.facingX = direction;
          realPlayer.facingY = 0;
          testPlayer.x = clamp(realPlayer.x + direction * 90, 24 + bodyStats(testPlayer).radius, WIDTH - 24 - bodyStats(testPlayer).radius);
          testPlayer.y = realPlayer.y;
        }
      }
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
      this.resetPositions(true);
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
      player.input = { x: 0, y: 0 };
      player.tackleRequested = false;
      player.chargeRequested = false;
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
      player.gameProfile = sanitizeProfile(player.gameProfile);
      player.stickyMembers ||= [];
      player.abilityReadyAt ||= 0;
      player.abilityUntil ||= 0;
      player.chargeUntil ||= 0;
      player.chargeReadyAt ||= 0;
      player.slowedUntil ||= 0;
      if (player.abilityRequested) {
        player.abilityRequested = false;
        const abilityId = player.gameProfile.abilityId;
        const mayWake = abilityId === "nyvaken";
        if (abilityId && now >= player.abilityReadyAt && (mayWake || now >= (player.stunnedUntil || 0))) activateAbility(this.game, player, now);
      }
      if (player.chargeRequested) {
        player.chargeRequested = false;
        const tireless = player.gameProfile.abilityId === "alltid-varm" && isAbilityActive(player, now);
        if ((tireless || now >= player.chargeReadyAt) && now >= player.stunnedUntil) {
          player.chargeUntil = now + CHARGE_DURATION_MS;
          player.chargeReadyAt = tireless ? now : now + CHARGE_DURATION_MS + CHARGE_REST_MS;
        }
      }
      if (player.shotRequestedUntil && now > player.shotRequestedUntil) player.shotRequestedUntil = 0;
      if (player.heelRequestedUntil && now > player.heelRequestedUntil) player.heelRequestedUntil = 0;
    }
    for (const player of players) {
      if (!player.tackleRequested) continue;
      player.tackleRequested = false;
      const muslimCrash = player.afterEffectId === "muslimen" && now >= (player.abilityStart || 0) + 7000 && now < player.afterEffectUntil;
      if (now < player.retreatUntil && !isOnOwnHalf(player) || isPanting(player, now) || muslimCrash) { player.shotRequestedUntil = 0; player.heelRequestedUntil = 0; continue; }
      const stats = bodyStats(player, now);
      if (now < (player.tackleCooldownUntil || 0) || now < (player.stunnedUntil || 0)) continue;
      const moving = Math.hypot(player.input.x, player.input.y) > 0.05;
      const directionX = moving ? player.input.x : player.facingX || (player.team === 0 ? 1 : -1);
      const directionY = moving ? player.input.y : player.facingY || 0;
      const directionLength = Math.hypot(directionX, directionY) || 1;
      player.tackleDirX = directionX / directionLength;
      player.tackleDirY = directionY / directionLength;
      player.tackleSlideUntil = now + 420;
      player.stunnedUntil = now + 800;
      player.tackleCooldownUntil = now + stats.cooldownMs;
      player.tackleHitPlayer = false;
      player.tackleHitBall = false;
      player.knockbackX = 0;
      player.knockbackY = 0;
    }
    for (const player of players) {
      const retreating = now < (player.retreatUntil || 0) && !isOnOwnHalf(player);
      player.retreating = retreating;
      if (!retreating && player.retreatUntil && now >= player.retreatUntil) player.retreatUntil = 0;
      const crashed = player.afterEffectId === "muslimen" && now >= (player.abilityStart || 0) + 7000 && now < (player.afterEffectUntil || 0);
      const stunned = now < (player.stunnedUntil || 0) || retreating || isPanting(player, now) || crashed;
      if (retreating || isPanting(player, now) || crashed) { player.shotRequestedUntil = 0; player.heelRequestedUntil = 0; player.tackleRequested = false; }
      player.panting = isPanting(player, now);
      const sliding = now < (player.tackleSlideUntil || 0);
      const length = Math.hypot(player.input.x, player.input.y) || 1;
      const inputScale = stunned ? 0 : Math.min(1, 1 / length);
      const stats = bodyStats(player, now);
      const speedMultiplier = abilitySpeedMultiplier(player, now, players, this.game.ball);
      const sprintMultiplier = now < player.chargeUntil ? 1.5 : 1;
      const confusionMultiplier = now < player.slowedUntil ? 0.62 : 1;
      const hangoverMultiplier = player.afterEffectId === "rom-och-cola" && now >= (player.abilityStart || 0) + 7000 && now < player.afterEffectUntil ? -1 : 1;
      let inputX = player.input.x * hangoverMultiplier;
      let inputY = player.input.y * hangoverMultiplier;
      if (retreating) { inputX = player.team === 0 ? -1 : 1; inputY = player.input.y; }
      const speedCap = activeSuper(player, "hoger-trafo", now) ? 410 : activeSuper(player, "vanster-langside-runkare", now) && inLeftLane(player) ? 395 : 380;
      const runningSpeed = Math.min(speedCap, stats.speed * speedMultiplier * sprintMultiplier * confusionMultiplier);
      player.vx = inputX * inputScale * runningSpeed + (sliding ? player.tackleDirX * stats.tackleSpeed : 0) + (player.knockbackX || 0);
      player.vy = inputY * inputScale * runningSpeed + (sliding ? player.tackleDirY * stats.tackleSpeed : 0) + (player.knockbackY || 0);
      if (isPanting(player, now) || crashed) player.vx = player.vy = 0;
      if (retreating && Math.abs(player.x - WIDTH / 2) < 10) player.retreatUntil = 0;
      player.x = clamp(player.x + player.vx * dt, 24 + supportRadius(player, 1, 0, now), WIDTH - 24 - supportRadius(player, 1, 0, now));
      player.y = clamp(player.y + player.vy * dt, 24 + supportRadius(player, 0, 1, now), HEIGHT - 24 - supportRadius(player, 0, 1, now));
      player.knockbackX = (player.knockbackX || 0) * 0.88;
      player.knockbackY = (player.knockbackY || 0) * 0.88;
    }

    for (const player of players) if (player.stickyRootId && !players.some((candidate) => candidate.id === player.stickyRootId)) player.stickyRootId = null;
    for (const root of players) if (root.stickyMembers?.length && isAbilityActive(root, now) && root.gameProfile.abilityId === "taljes-harigaste") {
      root.stickyMembers = root.stickyMembers.filter((id) => players.some((member) => member.id === id));
      const slowdown = Math.max(0.6, 1 - root.stickyMembers.length * 0.08);
      root.vx *= slowdown; root.vy *= slowdown;
      root.x = clamp(root.x, 24 + supportRadius(root, 1, 0, now), WIDTH - 24 - supportRadius(root, 1, 0, now));
      root.y = clamp(root.y, 24 + supportRadius(root, 0, 1, now), HEIGHT - 24 - supportRadius(root, 0, 1, now));
      root.stickyMembers.forEach((id, index) => {
        const member = players.find((candidate) => candidate.id === id);
        if (!member) return;
        member.stickyRootId = root.id;
        const angle = Math.atan2(root.facingY || 0, root.facingX || 1) + Math.PI + index * 0.58;
        const distance = supportRadius(root, Math.cos(angle), Math.sin(angle), now) + supportRadius(member, Math.cos(angle), Math.sin(angle), now) + 2;
        member.x = clamp(root.x + Math.cos(angle) * distance, 24, WIDTH - 24);
        member.y = clamp(root.y + Math.sin(angle) * distance, 24, HEIGHT - 24);
        member.vx = root.vx; member.vy = root.vy;
      });
    } else if (root.stickyMembers?.length && (!isAbilityActive(root, now) || root.gameProfile.abilityId !== "taljes-harigaste")) releaseStickyGroup(players, root);

    for (const attacker of players) {
      if (now >= (attacker.tackleSlideUntil || 0) || attacker.tackleHitPlayer) continue;
      for (const target of players) {
        if (target === attacker) continue;
        const dx = target.x - attacker.x; const dy = target.y - attacker.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const forwardDot = (dx * attacker.tackleDirX + dy * attacker.tackleDirY) / distance;
        const extraReach = (attacker.gameProfile?.abilityId === "stekare" && isAbilityActive(attacker, now) ? 22 : 0) + (attacker.bonusTackleReady ? 16 : 0);
        if (forwardDot < 0.35 || distance >= supportRadius(attacker, dx / distance, dy / distance, now) + supportRadius(target, -dx / distance, -dy / distance, now) + 5 + extraReach) continue;
        const angle = Math.atan2(attacker.tackleDirY, attacker.tackleDirX);
        const targetAngle = angle + Math.PI + (Math.random() - 0.5) * 0.85;
        const lightTarget = target.gameProfile?.abilityId === "frigolit" && isAbilityActive(target, now) ? 1.7 : 1;
        const stekareGuard = target.gameProfile?.abilityId === "stekare" && isAbilityActive(target, now) ? 0.5 : 1;
        const targetForce = Math.min(780, (bodyStats(attacker, now).tackleForce + Math.random() * 90) * lightTarget * stekareGuard);
        target.knockbackX = Math.cos(targetAngle) * targetForce;
        target.knockbackY = Math.sin(targetAngle) * targetForce;
        if (target.gameProfile?.abilityId !== "frigolit" || !isAbilityActive(target, now)) target.slowedUntil = now + tackleConfusionDuration(attacker, target);
        if (isAbilityActive(target, now) && target.gameProfile.abilityId === "storhetsvansinne") {
          attacker.knockbackX = -Math.cos(targetAngle) * Math.min(800, targetForce * 1.35);
          attacker.knockbackY = -Math.sin(targetAngle) * Math.min(800, targetForce * 1.35);
          attacker.stunnedUntil = now + 700;
        } else {
          const attackerAngle = angle + (Math.random() < 0.2 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.55;
          const selfForce = isAbilityActive(attacker, now) && attacker.gameProfile.abilityId === "storhetsvansinne" ? 55 : 190;
          attacker.knockbackX = Math.cos(attackerAngle) * selfForce;
          attacker.knockbackY = Math.sin(attackerAngle) * selfForce;
        }
        attacker.tackleHitPlayer = true;
        attacker.bonusTackleReady = false;
        attacker.stunnedUntil = now + 500;
        target.stunnedUntil = target.gameProfile?.abilityId === "frigolit" && isAbilityActive(target, now) ? 0 : now + 500;
        break;
      }
    }

    // Cheap solver passes keep crowded groups from ending a tick overlapped.
    for (let pass = 0; pass < 12; pass++) {
      for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
        const one = players[a]; const two = players[b];
        const dx = two.x - one.x; const dy = two.y - one.y;
        const distance = Math.hypot(dx, dy);
        if (sameStickyGroup(one, two)) continue;
        const minDistance = supportRadius(one, dx / (distance || 1), dy / (distance || 1), now) + supportRadius(two, -dx / (distance || 1), -dy / (distance || 1), now);
        if (distance < minDistance) {
          const nx = distance > 0.001 ? dx / distance : (a + b) % 2 ? 1 : -1;
          const ny = distance > 0.001 ? dy / distance : 0;
          applyContactAbility(one, two, nx, ny, now);
          applyContactAbility(two, one, -nx, -ny, now);
          const shift = (minDistance - distance) / 2;
          one.x -= nx * shift; one.y -= ny * shift;
          two.x += nx * shift; two.y += ny * shift;
          clampPlayerToField(one, now); clampPlayerToField(two, now);
          tryStick(this.game, one, two, now);
        }
      }
    }

    const ball = this.game.ball;
    for (const player of players) {
      if (now >= (player.tackleSlideUntil || 0) || player.tackleHitBall) continue;
      const along = (ball.x - player.x) * player.tackleDirX + (ball.y - player.y) * player.tackleDirY;
      const across = Math.abs((ball.x - player.x) * player.tackleDirY - (ball.y - player.y) * player.tackleDirX);
      if (along < -3 || along > 46 + (isAbilityActive(player, now) && player.gameProfile.abilityId === "stekare" ? 22 : 0) + (player.bonusTackleReady ? 16 : 0) || across > supportRadius(player, player.tackleDirY, -player.tackleDirX, now) + 10) continue;
      const angle = Math.atan2(-player.tackleDirY, -player.tackleDirX) + (Math.random() - 0.5) * 0.65;
      const speed = 250 + Math.random() * 130;
      ball.vx = Math.cos(angle) * speed;
      ball.vy = Math.sin(angle) * speed;
      const clearDistance = supportRadius(player, player.tackleDirX, player.tackleDirY, now) + 12;
      player.x = ball.x + player.tackleDirX * clearDistance;
      player.y = ball.y + player.tackleDirY * clearDistance;
      clampPlayerToField(player, now);
      player.stunnedUntil = now + 500;
      player.tackleHitBall = true;
      player.bonusTackleReady = false;
    }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    for (const player of players) {
      const dx = ball.x - player.x; const dy = ball.y - player.y;
      const distance = Math.hypot(dx, dy);
      const contactDistance = supportRadius(player, dx / (distance || 1), dy / (distance || 1), now) + 10 + (isAbilityActive(player, now) && player.gameProfile.abilityId === "stekare" ? 18 : 0);
      if (distance < contactDistance) {
        const nx = distance > 0.001 ? dx / distance : (player.team === 0 ? 1 : -1);
        const ny = distance > 0.001 ? dy / distance : 0;
        const correction = contactDistance - distance + 0.01;
        ball.x += nx * correction * 0.72;
        ball.y += ny * correction * 0.72;
        player.x -= nx * correction * 0.28; player.y -= ny * correction * 0.28;
        clampPlayerToField(player, now);
        const relativeSpeed = (ball.vx - player.vx) * nx + (ball.vy - player.vy) * ny;
        if (relativeSpeed < 0) {
          const impulse = -relativeSpeed * 1.35;
          ball.vx += impulse * nx;
          ball.vy += impulse * ny;
        }
        const actionLocked = player.retreating || isPanting(player, now) || player.afterEffectId === "muslimen" && now >= (player.abilityStart || 0) + 7000 && now < player.afterEffectUntil;
        const shooting = !actionLocked && (player.shotRequestedUntil || 0) >= now;
        const heeling = !actionLocked && (player.heelRequestedUntil || 0) >= now;
        if ((heeling || shooting) && !(player.retreating && now < player.retreatUntil)) {
          const direction = heeling ? -1 : 1;
          const moving = Math.hypot(player.input.x, player.input.y) > 0.05;
          const directionX = moving ? player.input.x : player.facingX || (player.team === 0 ? 1 : -1);
          const directionY = moving ? player.input.y : player.facingY || 0;
          const length = Math.hypot(directionX, directionY) || 1;
          const shotMultiplier = activeSuper(player, "stekare", now) ? (heeling ? 1.5 : 1.35) : activeSuper(player, "rom-och-cola", now) ? 1.2 : activeSuper(player, "muslimen", now) ? 1.25 : 1;
          ball.vx = directionX / length * 520 * direction * shotMultiplier;
          ball.vy = directionY / length * 520 * direction * shotMultiplier;
          this.game.lastKickBy = player.id;
          player.shotRequestedUntil = 0;
          player.heelRequestedUntil = 0;
        }
      }
    }

    // Resolve player and ball contacts together so a ball cannot get wedged between players.
    for (let pass = 0; pass < 12; pass++) {
      for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
        const one = players[a]; const two = players[b];
        const dx = two.x - one.x; const dy = two.y - one.y;
        const distance = Math.hypot(dx, dy);
        if (sameStickyGroup(one, two)) continue;
        const minDistance = supportRadius(one, dx / (distance || 1), dy / (distance || 1), now) + supportRadius(two, -dx / (distance || 1), -dy / (distance || 1), now);
        if (distance < minDistance) {
          const nx = distance > 0.001 ? dx / distance : (a + b) % 2 ? 1 : -1;
          const ny = distance > 0.001 ? dy / distance : 0;
          const shift = (minDistance - distance) / 2;
          one.x -= nx * shift; one.y -= ny * shift;
          two.x += nx * shift; two.y += ny * shift;
          clampPlayerToField(one, now); clampPlayerToField(two, now);
        }
      }
      for (const player of players) {
        const dx = ball.x - player.x; const dy = ball.y - player.y;
        const distance = Math.hypot(dx, dy);
        const contactDistance = supportRadius(player, dx / (distance || 1), dy / (distance || 1), now) + 10;
        if (distance < contactDistance) {
          const nx = distance > 0.001 ? dx / distance : (player.team === 0 ? 1 : -1);
          const ny = distance > 0.001 ? dy / distance : 0;
          const correction = contactDistance - distance + 0.01;
          ball.x += nx * correction * 0.72;
          ball.y += ny * correction * 0.72;
          player.x -= nx * correction * 0.28; player.y -= ny * correction * 0.28;
          clampPlayerToField(player, now);
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

  resetPositions(newMatch = false) {
    const teamIndex = [0, 0];
    for (const player of this.game.players) releaseStickyGroup(this.game.players, player);
    for (const player of this.game.players) {
      const index = teamIndex[player.team]++;
      const direction = player.team === 0 ? -1 : 1;
      player.x = WIDTH / 2 + direction * (150 + Math.floor(index / 3) * 80);
      player.y = 170 + (index % 3) * 130;
      player.vx = 0; player.vy = 0;
      player.input = { x: 0, y: 0 };
      player.knockbackX = 0; player.knockbackY = 0; player.stunnedUntil = 0;
      player.tackleCooldownUntil = 0; player.tackleSlideUntil = 0;
      player.tackleHitPlayer = false; player.tackleHitBall = false;
      player.tackleRequested = false;
      player.shotRequestedUntil = 0; player.heelRequestedUntil = 0;
      player.chargeRequested = false; player.chargeUntil = 0; player.chargeReadyAt = 0; player.slowedUntil = 0;
      player.abilityRequested = false; player.abilityUntil = 0; player.abilityState = null; player.retreatUntil = 0;
      player.pantingUntil = 0;
      player.bonusTackleReady = false;
      if (newMatch) { player.abilityReadyAt = 0; player.afterEffectUntil = 0; player.afterEffectId = null; }
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
      players: this.game.players.map((player) => {
        const { id, characterId, name, avatarUrl, team, x, y, stunnedUntil, tackleCooldownUntil, tackleSlideUntil, tackleDirX, tackleDirY, chargeUntil, chargeReadyAt, slowedUntil } = player;
        const now = Date.now();
        return { id, characterId: characterId || id, name, avatarUrl, team, gameProfile: sanitizeProfile(player.gameProfile), x, y, facingX: player.facingX || 0, facingY: player.facingY || 0,
          knocked: (stunnedUntil || 0) > now || player.afterEffectId === "muslimen" && now >= (player.abilityStart || 0) + 7000 && now < (player.afterEffectUntil || 0),
          sliding: (tackleSlideUntil || 0) > now, slideX: tackleDirX || 0, slideY: tackleDirY || 0, tackleReadyAt: tackleCooldownUntil || 0,
          charged: (chargeUntil || 0) > now, chargeUntil: chargeUntil || 0, chargeReadyAt: chargeReadyAt || 0, confused: (slowedUntil || 0) > now,
          abilityReadyAt: player.abilityReadyAt || 0, abilityUntil: player.abilityUntil || 0, abilityState: player.abilityState || null,
          afterEffectId: player.afterEffectId || null, afterEffectUntil: player.afterEffectUntil || 0,
          afterEffectActive: isAfterEffectActive(player, now),
          retreating: (player.retreatUntil || 0) > now && !isOnOwnHalf(player), sticky: Boolean(player.stickyRootId || player.stickyMembers?.length), panting: isPanting(player, now),
          testPlayer: id === TEST_PLAYER_ID, connected: connected.has(id) };
      }),
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
      players: this.game.players.filter((player) => player.id !== TEST_PLAYER_ID).length,
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
    if (!identity.characterId) identity.characterId = identity.playerId;
    if (!identity.gameProfile) identity.gameProfile = { ...DEFAULT_PROFILE };
    if (!ROOM_CODE.test(identity.roomId) || typeof identity.playerId !== "string" || !identity.playerId || typeof identity.characterId !== "string" || !identity.characterId || typeof identity.name !== "string" || identity.team !== "inkastarna" || !isValidProfile(identity.gameProfile) || !Number.isFinite(identity.exp) || identity.exp <= Date.now() / 1000 || identity.exp > Date.now() / 1000 + 60) return null;
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

function makeTestPlayer(team) {
  return {
    id: TEST_PLAYER_ID,
    characterId: TEST_PLAYER_ID,
    name: "Testspelare",
    avatarUrl: null,
    team,
    gameProfile: { ...DEFAULT_PROFILE },
    x: team === 0 ? 220 : WIDTH - 220,
    y: HEIGHT / 2,
    vx: 0,
    vy: 0,
    input: { x: 0, y: 0 },
    facingX: team === 0 ? 1 : -1,
    facingY: 0,
    knockbackX: 0,
    knockbackY: 0,
    stunnedUntil: 0,
    tackleCooldownUntil: 0,
    tackleSlideUntil: 0,
    tackleDirX: team === 0 ? 1 : -1,
    tackleDirY: 0,
    tackleHitPlayer: false,
    tackleHitBall: false,
    tackleRequested: false,
    shotRequestedUntil: 0,
    heelRequestedUntil: 0,
    chargeRequested: false,
    chargeUntil: 0,
    chargeReadyAt: 0,
    slowedUntil: 0,
    abilityRequested: false,
    abilityReadyAt: 0,
    abilityUntil: 0,
    abilityState: null,
    abilityStart: 0,
    afterEffectUntil: 0,
    afterEffectId: null,
    retreatUntil: 0,
    stickyRootId: null,
    stickyMembers: [],
    pantingUntil: 0,
    bonusTackleReady: false,
    disconnectedAt: null,
  };
}

function tackleConfusionDuration(attacker, target) {
  const difference = (target.gameProfile?.size ?? 3) - (attacker.gameProfile?.size ?? 3);
  if (difference > 0) return Math.min(1000, CONFUSION_DURATION_MS);
  if (difference === 0) return Math.min(2000, CONFUSION_DURATION_MS);
  return CONFUSION_DURATION_MS;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function sanitizeProfile(profile) {
  const value = profile && typeof profile === "object" ? profile : DEFAULT_PROFILE;
  const rating = (key) => Number.isInteger(value[key]) && value[key] >= 1 && value[key] <= 5 ? value[key] : 3;
  return { speed: rating("speed"), acceleration: rating("acceleration"), size: rating("size"), tackling: rating("tackling"), abilityId: ABILITY_IDS.has(value.abilityId) ? value.abilityId : null };
}
function isValidProfile(profile) {
  return profile && ["speed", "acceleration", "size", "tackling"].every((key) => Number.isInteger(profile[key]) && profile[key] >= 1 && profile[key] <= 5) && (profile.abilityId === null || ABILITY_IDS.has(profile.abilityId));
}
function bodyStats(player, now = Date.now()) {
  const profile = sanitizeProfile(player.gameProfile);
  const weight = 1 + (profile.size - 3) * 0.12;
  const tackle = 1 + (profile.tackling - 3) * 0.16;
  let tackleMultiplier = tackle + (profile.size - 3) * 0.06;
  let tackleSpeedMultiplier = 1;
  if (activeSuper(player, "muslimen", now)) { tackleMultiplier *= 1.25; tackleSpeedMultiplier = 1.15; }
  if (activeSuper(player, "storhetsvansinne", now)) { tackleMultiplier *= 1.45; tackleSpeedMultiplier = 1.2; }
  if (activeSuper(player, "rom-och-cola", now)) { tackleMultiplier *= 1.2; tackleSpeedMultiplier = 1.1; }
  if (activeSuper(player, "kaggen", now)) { tackleMultiplier *= 1.7; tackleSpeedMultiplier = 1.15; }
  if (activeSuper(player, "vanster-langside-runkare", now) && inLeftLane(player)) { tackleMultiplier *= 1.8; tackleSpeedMultiplier = 1.2; }
  return {
    radius: clamp(19 * weight, 13, 25),
    speed: clamp(220 * (1 + (profile.speed - 3) * 0.12) * (0.94 + profile.acceleration * 0.02) * (1 - (profile.size - 3) * 0.025), 150, 315),
    acceleration: 1 + (profile.acceleration - 3) * 0.18,
    tackleSpeed: clamp(420 * (0.895 + profile.tackling * 0.035) * tackleSpeedMultiplier, 300, 560),
    tackleForce: clamp(390 * tackleMultiplier, 270, 800),
    cooldownMs: clamp(2000 - (profile.tackling - 3) * 220, 1300, 3100),
  };
}
function isAbilityActive(player, now) { return Boolean(player.abilityState && player.abilityUntil > now); }
function activeSuper(player, id, now) { return isAbilityActive(player, now) && player.gameProfile?.abilityId === id; }
function abilitySpeedMultiplier(player, now, players, ball) {
  const id = player.gameProfile?.abilityId;
  if (player.afterEffectId === "kaggen" && !isAbilityActive(player, now) && now < player.afterEffectUntil) return 0.65;
  if (!isAbilityActive(player, now)) return 1;
  if (id === "muslimen" || id === "storhetsvansinne") return 1.35;
  if (id === "frigolit" || id === "stekare") return 1.25;
  if (id === "lang-som-fan") return 1.25;
  if (id === "rom-och-cola") return 1.3;
  if (id === "vanster-langside-runkare") return inLeftLane(player) ? 1.85 : 1;
  if (id === "taljes-harigaste") return Math.max(0.6, 1 - (player.stickyMembers?.length || 0) * 0.08);
  if (id === "alltid-tvaa") {
    const opponentAhead = players?.some((candidate) => candidate.team !== player.team && distance(candidate, ball) < distance(player, ball));
    return opponentAhead ? 1.65 : 1;
  }
  if (id === "nyvaken") return now < (player.abilityStart || 0) + 1500 ? 0.5 : 1.35;
  if (id === "hoger-trafo") return 1.95;
  if (id === "kaggen") return 1.05;
  if (id === "alltid-varm") return 1;
  return 1;
}
function inLeftLane(player) { return player.team === 0 ? player.y < 180 : player.y > HEIGHT - 180; }
function isOnOwnHalf(player) { return player.team === 0 ? player.x <= WIDTH / 2 : player.x >= WIDTH / 2; }
function isPanting(player, now) {
  if (!activeSuper(player, "hoger-trafo", now)) return false;
  const elapsed = now - (player.abilityStart || now);
  return elapsed >= 3000 && elapsed < 4000 || elapsed >= 7000 && elapsed < 8000;
}
function supportRadius(player, nx, ny, now = Date.now()) {
  const base = bodyStats(player, now).radius;
  if (activeSuper(player, "lang-som-fan", now)) {
    const fx = player.facingX || (player.team === 0 ? 1 : -1); const fy = player.facingY || 0;
    const dot = nx * fx + ny * fy;
    return base * (1 + Math.abs(dot));
  }
  if (activeSuper(player, "kaggen", now)) return base * (1 + Math.abs(nx));
  return base;
}
function clampPlayerToField(player, now) {
  player.x = clamp(player.x, 24 + supportRadius(player, 1, 0, now), WIDTH - 24 - supportRadius(player, 1, 0, now));
  player.y = clamp(player.y, 24 + supportRadius(player, 0, 1, now), HEIGHT - 24 - supportRadius(player, 0, 1, now));
}
function distance(one, two) { return two ? Math.hypot(one.x - two.x, one.y - two.y) : Infinity; }
function activateAbility(game, player, now) {
  const id = player.gameProfile?.abilityId;
  if (!id || !ABILITY_IDS.has(id)) return;
  const durations = { allahbakar: 4000, muslimen: 7000, storhetsvansinne: 6000, frigolit: 7000, "lang-som-fan": 6000, "rom-och-cola": 7000, "vanster-langside-runkare": 7000, "taljes-harigaste": 5000, stekare: 6000, kaggen: 6000, "alltid-varm": 8000, "alltid-tvaa": 7000, nyvaken: 7500, "hoger-trafo": 10000 };
  player.abilityStart = now;
  player.abilityUntil = now + durations[id];
  player.abilityReadyAt = now + SUPER_COOLDOWN_MS;
  player.abilityState = id;
  if (id === "allahbakar") for (const member of game.players) {
    member.retreatUntil = now + 4000;
    member.tackleSlideUntil = 0; member.tackleRequested = false; member.shotRequestedUntil = 0; member.heelRequestedUntil = 0;
    member.knockbackX = 0; member.knockbackY = 0;
  }
  if (id === "muslimen") { player.afterEffectId = id; player.afterEffectUntil = now + 12000; }
  if (id === "rom-och-cola") { player.afterEffectId = id; player.afterEffectUntil = now + 11000; }
  if (id === "kaggen") { player.afterEffectId = id; player.afterEffectUntil = now + 10000; }
  if (id === "nyvaken") { player.stunnedUntil = 0; player.slowedUntil = 0; }
  if (id === "alltid-tvaa") player.bonusTackleReady = true;
  if (id === "taljes-harigaste") player.stickyMembers = [];
}
function isAfterEffectActive(player, now) {
  if (!player.afterEffectId || now >= (player.afterEffectUntil || 0)) return false;
  if (player.afterEffectId === "muslimen" || player.afterEffectId === "rom-och-cola") return now >= (player.abilityStart || 0) + 7000;
  if (player.afterEffectId === "kaggen") return now >= (player.abilityUntil || 0);
  return false;
}
function tryStick(game, one, two, now) {
  for (const [contact, target] of [[one, two], [two, one]]) {
    const root = contact.stickyRootId ? game.players.find((player) => player.id === contact.stickyRootId) : contact;
    if (!root || !activeSuper(root, "taljes-harigaste", now) || target.id === root.id || target.stickyRootId === root.id || root.stickyRootId) continue;
    const attached = root.stickyMembers || [];
    if (attached.length >= 9 || attached.includes(target.id)) continue;
    const rootId = target.stickyRootId;
    if (rootId && rootId !== root.id) continue;
    root.stickyMembers = [...attached, target.id];
    target.stickyRootId = root.id;
  }
}
function applyContactAbility(attacker, target, nx, ny, now) {
  if (activeSuper(attacker, "storhetsvansinne", now) && now - (attacker.lastBerserkContact || 0) > 450) {
    const force = Math.min(650, bodyStats(attacker, now).tackleForce * 1.2);
    target.knockbackX = nx * force; target.knockbackY = ny * force;
    attacker.lastBerserkContact = now;
  }
  if (activeSuper(target, "frigolit", now) && now - (target.lastLightHitAt || 0) > 450) {
    target.knockbackX = nx * 380; target.knockbackY = ny * 380;
    target.lastLightHitAt = now;
  }
}
function sameStickyGroup(one, two) {
  const oneRoot = one.stickyRootId || one.id;
  const twoRoot = two.stickyRootId || two.id;
  return oneRoot === twoRoot && Boolean(one.stickyRootId || two.stickyRootId);
}
function releaseStickyGroup(players, root) {
  for (const id of root.stickyMembers || []) {
    const player = players.find((candidate) => candidate.id === id);
    if (player && player.stickyRootId === root.id) player.stickyRootId = null;
  }
  root.stickyMembers = [];
}
