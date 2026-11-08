"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Gamepad2, LogOut, Play, RefreshCw, Users } from "lucide-react";

type BodyType = "small" | "medium" | "large";
type GamePlayer = { id: string; name: string; avatarUrl?: string | null; team: number; bodyType?: BodyType; x: number; y: number; knocked?: boolean; sliding?: boolean; slideX?: number; slideY?: number; tackleReadyAt?: number; charged?: boolean; chargeUntil?: number; chargeReadyAt?: number; confused?: boolean; testPlayer?: boolean; connected: boolean };
type GameState = {
  type: "state";
  phase: "lobby" | "playing" | "finished";
  roomId: string;
  hostId: string | null;
  score: [number, number];
  remainingMs: number;
  ball: { x: number; y: number; vx: number; vy: number };
  players: GamePlayer[];
};
type OpenRoom = { roomId: string; phase: "lobby" | "playing"; players: number; connected: number };
type InputState = { x: number; y: number };
type ActionRequests = { shot: boolean; heel: boolean; sprint: boolean; tackle: boolean };

const blankInput = (): InputState => ({ x: 0, y: 0 });
const blankActions = (): ActionRequests => ({ shot: false, heel: false, sprint: false, tackle: false });
const bodyTypes: { id: BodyType; label: string; detail: string }[] = [
  { id: "small", label: "Liten", detail: "Snabb · 1 s cooldown" },
  { id: "medium", label: "Mellan", detail: "Balanserad · 2 s" },
  { id: "large", label: "Stor", detail: "Tung tackling · 3 s" },
];
const roomPattern = /^[A-HJ-NP-Z2-9]{6}$/;

export default function FootballArena({ playerId }: { playerId: string | null }) {
  const [roomId, setRoomId] = useState("");
  const [roomDraft, setRoomDraft] = useState("");
  const [game, setGame] = useState<GameState | null>(null);
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);
  const [connection, setConnection] = useState<"idle" | "connecting" | "connected" | "reconnecting">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const gameRef = useRef<GameState | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<InputState>(blankInput());
  const touchRef = useRef<InputState>(blankInput());
  const actionRequestsRef = useRef<ActionRequests>(blankActions());
  const keySetRef = useRef(new Set<string>());

  useEffect(() => {
    const queryRoom = new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? "";
    if (roomPattern.test(queryRoom)) setRoomId(queryRoom);
  }, []);

  useEffect(() => {
    if (roomId) { setOpenRooms([]); return; }
    const workerUrl = process.env.NEXT_PUBLIC_GAME_WS_URL;
    if (!workerUrl) return;
    const roomsUrl = workerUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "") + "/rooms";
    let stopped = false;
    const loadRooms = async () => {
      try {
        const response = await fetch(roomsUrl, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { rooms?: OpenRoom[] };
        if (!stopped) setOpenRooms(Array.isArray(data.rooms) ? data.rooms : []);
      } catch { /* Room discovery is optional while the game server reconnects. */ }
    };
    void loadRooms();
    const timer = setInterval(loadRooms, 8_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [playerId, roomId]);

  const send = useCallback((event: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(event));
    return true;
  }, []);

  useEffect(() => {
    if (!roomId) {
      setConnection("idle");
      setGame(null);
      gameRef.current = null;
      return;
    }
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let activeSocket: WebSocket | null = null;
    const connect = async () => {
      if (stopped) return;
      setConnection(retry ? "reconnecting" : "connecting");
      try {
        const workerUrl = process.env.NEXT_PUBLIC_GAME_WS_URL;
        const allowedProtocol = workerUrl && (/^wss:\/\//.test(workerUrl) || (process.env.NODE_ENV !== "production" && /^ws:\/\//.test(workerUrl)));
        if (!workerUrl || !allowedProtocol) {
          setError("Spelservern är inte konfigurerad.");
          setConnection("idle");
          return;
        }
        const response = await fetch("/api/game-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId }),
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) {
          setError(data.error || "Spelet kunde inte öppnas.");
          setConnection("idle");
          return;
        }
        if (stopped) return;
        const socket = new WebSocket(`${workerUrl.replace(/\/$/, "")}/room/${roomId}/ws`, ["inkastarna.v1", `game-ticket.${data.ticket}`]);
        activeSocket = socket;
        socketRef.current = socket;
        socket.onopen = () => { retry = 0; setConnection("connected"); setError(""); };
        socket.onmessage = (message) => {
          try {
            const next = JSON.parse(String(message.data)) as GameState;
            if (next.type === "state") {
              gameRef.current = next;
              setGame(next);
            }
          } catch { setError("Spelservern skickade en ogiltig spelbild."); }
        };
        socket.onerror = () => socket.close();
        socket.onclose = (event) => {
          if (socketRef.current === socket) socketRef.current = null;
          if (stopped || event.code === 4000 || event.code === 4001) {
            if (event.code === 4000) setError("Rummet har gått ut. Skapa ett nytt rum för att spela vidare.");
            return;
          }
          if (retry >= 8) {
            setConnection("idle");
            setError("Anslutningen misslyckades. Lämna rummet och försök gå med igen.");
            return;
          }
          setConnection("reconnecting");
          retry++;
          retryTimer = setTimeout(connect, Math.min(15_000, 700 * 2 ** Math.min(retry, 5)));
        };
      } catch (cause) {
        if (stopped) return;
        setError(cause instanceof Error ? cause.message : "Kunde inte ansluta till spelrummet.");
        if (retry >= 8) { setConnection("idle"); return; }
        setConnection("reconnecting");
        retry++;
        retryTimer = setTimeout(connect, Math.min(15_000, 700 * 2 ** Math.min(retry, 5)));
      }
    };
    void connect();
    const inputs = setInterval(() => {
      const current = gameRef.current;
      if (!current || current.phase !== "playing") return;
      const input = inputRef.current;
      const actions = actionRequestsRef.current;
      if (send({
        type: "input",
        x: input.x,
        y: input.y,
        shot: actions.shot,
        heel: actions.heel,
        tackle: actions.tackle,
        sprint: actions.sprint,
      })) actionRequestsRef.current = blankActions();
    }, 100);
    return () => {
      stopped = true;
      clearInterval(inputs);
      if (retryTimer) clearTimeout(retryTimer);
      activeSocket?.close(1000, "View closed");
      if (socketRef.current === activeSocket) socketRef.current = null;
      inputRef.current = blankInput();
      keySetRef.current.clear();
      touchRef.current = blankInput();
      actionRequestsRef.current = blankActions();
    };
  }, [roomId, send]);

  useEffect(() => {
    const update = () => {
      const keys = keySetRef.current;
      const keyboardX = Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
      const keyboardY = Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
      inputRef.current = {
        x: touchRef.current.x || keyboardX,
        y: touchRef.current.y || keyboardY,
      };
    };
    const down = (event: KeyboardEvent) => {
      if (gameRef.current?.phase !== "playing") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "shift") {
        event.preventDefault();
        if (!event.repeat) actionRequestsRef.current.tackle = true;
        return;
      }
      if (key === "e") {
        event.preventDefault();
        if (!event.repeat) actionRequestsRef.current.sprint = true;
        return;
      }
      if (key === " " || key === "f") {
        event.preventDefault();
        if (!event.repeat) actionRequestsRef.current[key === " " ? "shot" : "heel"] = true;
        return;
      }
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault();
        keySetRef.current.add(key);
        update();
      }
    };
    const up = (event: KeyboardEvent) => { keySetRef.current.delete(event.key.toLowerCase()); update(); };
    const clear = () => { keySetRef.current.clear(); touchRef.current = blankInput(); update(); };
    const visibility = () => { if (document.hidden) clear(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#arena-canvas");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    const displayed = new Map<string, { x: number; y: number }>();
    const avatars = new Map<string, HTMLImageElement>();
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(1000 * ratio);
      canvas.height = Math.round(600 * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const render = () => {
      const current = gameRef.current;
      if (current) {
        context.clearRect(0, 0, 1000, 600);
        context.fillStyle = "#277343";
        context.fillRect(0, 0, 1000, 600);
        context.fillStyle = "#2b7d49";
        for (let x = 0; x < 1000; x += 200) context.fillRect(x, 0, 100, 600);
        context.strokeStyle = "rgba(255,255,255,.78)";
        context.lineWidth = 3;
        context.strokeRect(18, 18, 964, 564);
        context.beginPath(); context.moveTo(500, 18); context.lineTo(500, 582); context.stroke();
        context.beginPath(); context.arc(500, 300, 78, 0, Math.PI * 2); context.stroke();
        context.strokeRect(18, 208, 110, 184); context.strokeRect(872, 208, 110, 184);
        context.fillStyle = "rgba(245,245,245,.95)";
        context.fillRect(0, 238, 18, 124); context.fillRect(982, 238, 18, 124);
        for (const player of current.players) {
          const point = displayed.get(player.id) || { x: player.x, y: player.y };
          point.x += (player.x - point.x) * 0.28;
          point.y += (player.y - point.y) * 0.28;
          displayed.set(player.id, point);
          const radius = player.bodyType === "small" ? 16 : player.bodyType === "large" ? 22 : 19;
          if (player.sliding) drawTackleTrail(context, point.x, point.y, radius, player.slideX ?? 0, player.slideY ?? 0);
          let avatar = player.avatarUrl ? avatars.get(player.id) : undefined;
          if (player.avatarUrl && !avatar) {
            avatar = new Image(); avatar.src = player.avatarUrl; avatars.set(player.id, avatar);
          }
          context.save(); context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.clip();
          context.fillStyle = player.team === 0 ? "#f25a57" : "#4ba8ff"; context.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
          if (avatar?.complete && avatar.naturalWidth > 0) context.drawImage(avatar, point.x - radius, point.y - radius, radius * 2, radius * 2);
          else {
            const initials = player.testPlayer ? "BOT" : player.name.trim().split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();
            context.fillStyle = "#fff"; context.font = `700 ${player.testPlayer ? 10 : 13}px Arial`; context.textAlign = "center"; context.textBaseline = "middle";
            context.fillText(initials, point.x, point.y + 1);
          }
          context.restore();
          context.lineWidth = player.id === playerId ? 4 : 2;
          context.beginPath(); context.arc(point.x, point.y, radius + 1, 0, Math.PI * 2);
          context.strokeStyle = player.connected ? "#fff" : "#bbb"; context.stroke();
          if (player.knocked) {
            context.beginPath(); context.arc(point.x, point.y, radius + 7, 0, Math.PI * 2);
            context.lineWidth = 3; context.strokeStyle = "#ffe08a"; context.stroke();
            drawImpactBurst(context, point.x, point.y, radius);
          }
          if (player.charged) {
            context.beginPath(); context.arc(point.x, point.y, radius + 6, 0, Math.PI * 2);
            context.lineWidth = 2; context.strokeStyle = "#9cff71"; context.stroke();
            context.fillStyle = "#d7ff91"; context.font = "700 17px Arial"; context.textAlign = "center";
            context.fillText("⚡", point.x, point.y + radius + 17);
          }
          if (player.confused) {
            drawConfusionBadge(context, point.x + radius + 8, point.y - radius - 7);
          }
          context.fillStyle = "#fff"; context.font = "600 12px Arial"; context.textAlign = "center"; context.textBaseline = "alphabetic";
          context.fillText(player.name.slice(0, 15), point.x, point.y - radius - 9);
        }
        context.beginPath(); context.arc(current.ball.x, current.ball.y, 10, 0, Math.PI * 2);
        context.fillStyle = "#fff"; context.fill(); context.strokeStyle = "#252525"; context.lineWidth = 2; context.stroke();
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [playerId, game?.phase]);

  const makeRoom = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    enterRoom(code);
  };

  const enterRoom = (code: string) => {
    const normalized = code.trim().toUpperCase();
    if (!roomPattern.test(normalized)) { setError("Skriv en giltig rumskod med sex tecken."); return; }
    setError("");
    setRoomDraft(normalized);
    const url = new URL(window.location.href);
    url.searchParams.set("room", normalized);
    url.hash = "game";
    window.history.replaceState(null, "", url);
    setRoomId(normalized);
  };

  const leaveRoom = () => {
    socketRef.current?.close(1000, "Player left");
    setRoomId("");
    setRoomDraft("");
    setError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.hash = "game";
    window.history.replaceState(null, "", url);
  };

  const shareRoom = async () => {
    if (!roomId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    url.hash = "game";
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { setError("Kunde inte kopiera länken. Dela rumskoden " + roomId + " manuellt."); }
  };

  const press = (patch: Partial<InputState>) => {
    touchRef.current = { ...touchRef.current, ...patch };
    const keys = keySetRef.current;
    const keyboardX = Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
    const keyboardY = Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
    inputRef.current = {
      x: touchRef.current.x || keyboardX,
      y: touchRef.current.y || keyboardY,
    };
  };
  const requestAction = (action: keyof ActionRequests) => { actionRequestsRef.current[action] = true; };
  const sendStart = () => send({ type: "start" });
  const sendRematch = () => send({ type: "rematch" });
  const isHost = game?.hostId === playerId;
  const connectedPlayers = game?.players.filter((player) => player.connected).length ?? 0;
  const canStart = connectedPlayers >= 1;
  const localPlayer = game?.players.find((player) => player.id === playerId);
  const tackleRemainingMs = Math.max(0, (localPlayer?.tackleReadyAt ?? 0) - Date.now());
  const sprintRemainingMs = Math.max(0, (localPlayer?.chargeUntil ?? 0) - Date.now());
  const sprintRestMs = Math.max(0, (localPlayer?.chargeReadyAt ?? 0) - Date.now());

  return (
    <div className="arena-layout">
      <section className="panel arena-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">INKASTARNA · ARKAD</span><h2>Spela tillsammans</h2></div>
          <Gamepad2 size={23} />
        </div>
        {!playerId ? (
          <div className="arena-entry"><p>Logga in och koppla ditt konto till en spelarprofil för att spela. Öppna matcher visas här ändå:</p><OpenRoomsList rooms={openRooms} canJoin={false} onJoin={enterRoom} /></div>
        ) : !roomId ? (
          <div className="arena-entry">
            <p>Skapa ett rum och bjud in lagkamrater. Två till tio spelare kan vara med.</p>
            <button className="button dark" onClick={makeRoom}><Play size={15} /> Skapa spelrum</button>
            <form onSubmit={(event) => { event.preventDefault(); enterRoom(roomDraft); }}>
              <label htmlFor="arena-room-code">Gå med med rumskod</label>
              <div><input id="arena-room-code" value={roomDraft} maxLength={6} onChange={(event) => setRoomDraft(event.target.value.toUpperCase())} placeholder="ABC123" /><button className="button subtle">Gå med</button></div>
            </form>
            <OpenRoomsList rooms={openRooms} canJoin={Boolean(playerId)} onJoin={enterRoom} />
          </div>
        ) : (
          <>
            <div className="arena-toolbar">
              <span className={`arena-connection ${connection}`}><i />{connection === "connected" ? "Ansluten" : connection === "reconnecting" ? "Återansluter" : "Ansluter"}</span>
              <strong>Rum {roomId}</strong>
              <button className="icon-button" onClick={leaveRoom} aria-label="Lämna spelrummet"><LogOut size={17} /></button>
            </div>
            <div className="arena-room-banner">
              <div><small>SKICKA INBJUDAN TILL LAGET</small><strong>{roomId}</strong><span>{game?.players.filter((player) => player.connected).length ?? 0} anslutna · upp till 10 spelare</span></div>
              <button className="button dark" onClick={() => void shareRoom()}><Copy size={15} /> {copied ? "Länk kopierad" : "Kopiera inbjudan"}</button>
            </div>
            {error && <div className="arena-error" role="status">{error}</div>}
            {game?.phase === "playing" ? (
              <>
                <div className="arena-score"><span>RÖDA {game.score[0]}</span><strong>{Math.ceil(game.remainingMs / 60000)}:{String(Math.floor(game.remainingMs / 1000) % 60).padStart(2, "0")}</strong><span>{game.score[1]} BLÅA</span></div>
                <canvas id="arena-canvas" className="arena-canvas" aria-label="Fotbollsplan. Styr med joysticken eller WASD. Skjut med knappen eller mellanslag, klacka med knappen eller F och glidtackla med knappen eller Shift." />
                <div className="arena-controls"><span className="arena-keyboard-hint"><b>WASD / pilar</b> rör dig · <b>mellanslag</b> skjut · <b>F</b> klack · <b>E</b> sprint · <b>Shift</b> charge / glidtackla</span><MobileControls press={press} onAction={requestAction} tackleRemainingMs={tackleRemainingMs} sprintRemainingMs={sprintRemainingMs} sprintRestMs={sprintRestMs} /></div>
              </>
            ) : (
              <div className="arena-lobby">
                <div className="arena-lobby-title"><Users size={19} /><span>{game?.players.length ?? 0}/10 spelare</span><small>{game?.phase === "finished" ? "Matchen är slut" : "Dela länken så ansluter laget"}</small></div>
                <div className="arena-teams">
                  {[0, 1].map((side) => (
                    <div className={`arena-team team-${side}`} key={side}>
                      <strong>{side === 0 ? "Röda laget" : "Blå laget"}</strong>
                      {(game?.players ?? []).filter((player) => player.team === side).map((player) => <span key={player.id} className={!player.connected ? "offline" : ""}>{player.name}{player.testPlayer ? " · står still tills någon går med" : ` · ${bodyTypes.find((type) => type.id === player.bodyType)?.label.toLowerCase() ?? "mellan"}`}{player.id === game?.hostId ? " · värd" : ""}{!player.connected && !player.testPlayer ? " · återansluter" : ""}</span>)}
                    </div>
                  ))}
                </div>
                {game?.phase === "lobby" && localPlayer && <div className="arena-build-picker">
                  <strong>Välj kroppstyp</strong><span>Kan ändras fram till matchstart.</span>
                  <div>{bodyTypes.map((type) => <button type="button" key={type.id} className={localPlayer.bodyType === type.id ? "selected" : ""} aria-pressed={localPlayer.bodyType === type.id} onClick={() => send({ type: "bodyType", bodyType: type.id })}>
                    <b>{type.label}</b><small>{type.detail}</small>
                  </button>)}</div>
                </div>}
                {connection !== "connected" && <p className="arena-hint"><RefreshCw size={14} /> Väntar på anslutning till spelservern…</p>}
                {game?.phase === "finished" ? <div className="arena-finish">Slutresultat: {game.score[0]}–{game.score[1]}</div> : <p className="arena-hint">{connectedPlayers === 1 ? "Testa själv mot en stillastående testspelare. Den byts ut när en lagkamrat ansluter." : "Fem minuter · balanserade lag · första spelaren blir värd"}</p>}
                {isHost && game?.phase === "lobby" && <button className="button dark" disabled={!canStart || connection !== "connected"} onClick={sendStart}><Play size={15} /> {connectedPlayers === 1 ? "Starta testmatch" : "Starta match"}</button>}
                {isHost && game?.phase === "finished" && <button className="button dark" onClick={sendRematch}><RefreshCw size={15} /> Spela igen</button>}
                {!isHost && game?.phase === "lobby" && <p className="arena-hint">Väntar på att värden startar matchen.</p>}
              </div>
            )}
          </>
        )}
        {!roomId && error && <div className="arena-error" role="status">{error}</div>}
      </section>
      <section className="panel arena-help"><div className="panel-heading"><h2>Så spelar ni</h2><Gamepad2 size={21} /></div><ul><li>På mobil: styr med joysticken. SKJUT och KLACK registreras som separata tryck även om bollen inte är precis intill.</li><li><b>SPRINT</b> ger 4 sekunders fartökning följt av 4 sekunders vila. En sprintande spelare syns med grön ring och blixt.</li><li><b>CHARGE / GLIDTACKLA</b> kastar dig framåt i styrd riktning och knuffar spelare eller boll vid träff. En mindre spelare som tacklar en större kan förvirra den i högst 1 sekund; en större tacklare kan orsaka längre förvirring.</li><li>Starta själv med en stillastående testspelare; den försvinner när en lagkamrat går med.</li><li>Efter glidet låses rörelsen en halv sekund. Tacklingens cooldown beror på kroppstyp: 1, 2 eller 3 sekunder.</li><li><b>Liten</b> springer snabbt; <b>stor</b> är långsammare men tacklar hårdare; <b>mellan</b> är balanserad.</li><li>På dator: WASD eller pilar, mellanslag för skott, F för klack, E för sprint och Shift för charge / glidtackling.</li><li>Öppna rum syns direkt i listan här och kan anslutas med ett tryck.</li></ul></section>
    </div>
  );
}

function OpenRoomsList({ rooms, canJoin, onJoin }: { rooms: OpenRoom[]; canJoin: boolean; onJoin: (roomId: string) => void }) {
  if (rooms.length === 0) return null;
  return <div className="arena-open-rooms">
    <div className="arena-open-rooms-heading"><strong>Spelrum öppna nu</strong><span>{rooms.length}</span></div>
    {rooms.map((room) => <div className="arena-open-room" key={room.roomId}>
      <div><strong>{room.roomId}</strong><span>{room.phase === "playing" ? "Match pågår" : "Väntar på spelare"} · {room.connected}/10 anslutna</span></div>
      <button className="button subtle" disabled={!canJoin} onClick={() => onJoin(room.roomId)} title={canJoin ? undefined : "Logga in och koppla en spelarprofil för att gå med"}><Play size={13} /> {canJoin ? "Gå med" : "Logga in"}</button>
    </div>)}
  </div>;
}

function drawConfusionBadge(context: CanvasRenderingContext2D, x: number, y: number) {
  const outer = 11;
  const inner = 5;
  context.beginPath();
  for (let point = 0; point < 10; point++) {
    const angle = -Math.PI / 2 + point * Math.PI / 5;
    const radius = point % 2 === 0 ? outer : inner;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (point === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
  context.fillStyle = "#ffe08a";
  context.strokeStyle = "#523c13";
  context.lineWidth = 2;
  context.fill();
  context.stroke();
  context.fillStyle = "#523c13";
  context.font = "800 12px Arial";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("?", x, y + 1);
}

function drawTackleTrail(context: CanvasRenderingContext2D, x: number, y: number, radius: number, directionX: number, directionY: number) {
  const length = Math.hypot(directionX, directionY) || 1;
  const dx = directionX / length;
  const dy = directionY / length;
  const sideX = -dy;
  const sideY = dx;
  const tail = radius + 54;
  const head = radius * 0.45;

  context.save();
  context.globalAlpha = 0.85;
  context.beginPath();
  context.ellipse(x, y, radius + 14, radius * 0.78, Math.atan2(dy, dx), 0, Math.PI * 2);
  context.fillStyle = "rgba(255, 193, 82, .28)";
  context.fill();
  context.strokeStyle = "#fff0b1";
  context.lineWidth = 3;
  context.stroke();

  context.lineCap = "round";
  for (const offset of [-radius * 0.55, 0, radius * 0.55]) {
    context.beginPath();
    context.moveTo(x - dx * tail + sideX * offset, y - dy * tail + sideY * offset);
    context.lineTo(x - dx * head + sideX * offset, y - dy * head + sideY * offset);
    context.strokeStyle = offset === 0 ? "#fffef0" : "#ffe08a";
    context.lineWidth = offset === 0 ? 5 : 3;
    context.stroke();
  }
  const arrowX = x + dx * (radius + 13);
  const arrowY = y + dy * (radius + 13);
  context.beginPath();
  context.moveTo(arrowX + dx * 12, arrowY + dy * 12);
  context.lineTo(arrowX - dx * 7 + sideX * 8, arrowY - dy * 7 + sideY * 8);
  context.lineTo(arrowX - dx * 7 - sideX * 8, arrowY - dy * 7 - sideY * 8);
  context.closePath();
  context.fillStyle = "#fff8d7";
  context.fill();
  context.restore();
}

function drawImpactBurst(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  const pulse = 0.72 + Math.sin(performance.now() / 35) * 0.28;
  context.save();
  context.globalAlpha = pulse;
  context.strokeStyle = "#fff1b4";
  context.lineWidth = 3;
  context.lineCap = "round";
  for (let spoke = 0; spoke < 8; spoke++) {
    const angle = -Math.PI / 2 + spoke * Math.PI / 4;
    const inner = radius + 10;
    const outer = radius + 18 + (spoke % 2) * 4;
    context.beginPath();
    context.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    context.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    context.stroke();
  }
  context.restore();
}

function MobileControls({ press, onAction, tackleRemainingMs, sprintRemainingMs, sprintRestMs }: { press: (patch: Partial<InputState>) => void; onAction: (action: keyof ActionRequests) => void; tackleRemainingMs: number; sprintRemainingMs: number; sprintRestMs: number }) {
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const joystick = useRef<HTMLDivElement>(null);
  const updateStick = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const radius = Math.min(bounds.width, bounds.height) * 0.36;
    const dx = event.clientX - (bounds.left + bounds.width / 2);
    const dy = event.clientY - (bounds.top + bounds.height / 2);
    const length = Math.hypot(dx, dy);
    const scale = length > radius ? radius / length : 1;
    const x = dx * scale / radius;
    const y = dy * scale / radius;
    setStick({ x: dx * scale, y: dy * scale });
    press({ x, y });
  };
  const releaseStick = () => { setStick({ x: 0, y: 0 }); press({ x: 0, y: 0 }); };
  const action = (key: "shot" | "heel") => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => { event.preventDefault(); onAction(key); },
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.preventDefault(); if (event.detail === 0) onAction(key); },
  });
  return <div className="arena-touch" aria-label="Touchkontroller">
    <div ref={joystick} className="arena-joystick" role="application" aria-label="Rörelsejoystick"
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); updateStick(event); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateStick(event); }}
      onPointerUp={releaseStick} onPointerCancel={releaseStick} onLostPointerCapture={releaseStick}>
      <span className="arena-joystick-knob" style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }} />
    </div>
    <div className="arena-action-buttons">
      <button className="arena-heel" {...action("heel")}>KLACK</button>
      <button className="arena-kick" {...action("shot")}>SKJUT</button>
      <button className="arena-sprint" onPointerDown={(event) => { event.preventDefault(); if (sprintRemainingMs <= 0 && sprintRestMs <= 0) onAction("sprint"); }} onClick={(event) => { event.preventDefault(); if (event.detail === 0 && sprintRemainingMs <= 0 && sprintRestMs <= 0) onAction("sprint"); }} disabled={sprintRemainingMs > 0 || sprintRestMs > 0} aria-label={sprintRemainingMs > 0 ? `Sprint aktiv i ${Math.ceil(sprintRemainingMs / 1000)} sekunder` : sprintRestMs > 0 ? `Sprint vilar i ${Math.ceil(sprintRestMs / 1000)} sekunder` : "Öka farten med sprint"}>
        {sprintRemainingMs > 0 ? `SPRINT · ${Math.ceil(sprintRemainingMs / 1000)} s` : sprintRestMs > 0 ? `VILA · ${Math.ceil(sprintRestMs / 1000)} s` : "SPRINT · 4 s"}
      </button>
      <button className="arena-tackle" onPointerDown={(event) => { event.preventDefault(); if (tackleRemainingMs <= 0) onAction("tackle"); }} onClick={(event) => { event.preventDefault(); if (event.detail === 0 && tackleRemainingMs <= 0) onAction("tackle"); }} disabled={tackleRemainingMs > 0} aria-label={tackleRemainingMs > 0 ? `Charge laddar om i ${Math.ceil(tackleRemainingMs / 1000)} sekunder` : "Charge / glidtackla"}>
        {tackleRemainingMs > 0 ? `LADDAR · ${Math.ceil(tackleRemainingMs / 1000)} s` : "CHARGE / GLID"}
      </button>
    </div>
  </div>;
}
