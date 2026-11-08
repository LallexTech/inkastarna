"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Gamepad2, LogOut, Play, RefreshCw, Users } from "lucide-react";

type GamePlayer = { id: string; name: string; team: number; x: number; y: number; connected: boolean };
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
type InputState = { up: boolean; down: boolean; left: boolean; right: boolean; kick: boolean };

const blankInput = (): InputState => ({ up: false, down: false, left: false, right: false, kick: false });
const roomPattern = /^[A-HJ-NP-Z2-9]{6}$/;

export default function FootballArena({ playerId }: { playerId: string | null }) {
  const [roomId, setRoomId] = useState("");
  const [roomDraft, setRoomDraft] = useState("");
  const [game, setGame] = useState<GameState | null>(null);
  const [connection, setConnection] = useState<"idle" | "connecting" | "connected" | "reconnecting">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const gameRef = useRef<GameState | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<InputState>(blankInput());
  const touchRef = useRef<InputState>(blankInput());
  const keySetRef = useRef(new Set<string>());

  useEffect(() => {
    const queryRoom = new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? "";
    if (roomPattern.test(queryRoom)) setRoomId(queryRoom);
  }, []);

  const send = useCallback((event: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
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
      send({
        type: "input",
        x: Number(input.right) - Number(input.left),
        y: Number(input.down) - Number(input.up),
        kick: input.kick,
      });
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
    };
  }, [roomId, send]);

  useEffect(() => {
    const update = () => {
      const keys = keySetRef.current;
      inputRef.current = {
        up: touchRef.current.up || keys.has("w") || keys.has("arrowup"),
        down: touchRef.current.down || keys.has("s") || keys.has("arrowdown"),
        left: touchRef.current.left || keys.has("a") || keys.has("arrowleft"),
        right: touchRef.current.right || keys.has("d") || keys.has("arrowright"),
        kick: touchRef.current.kick || keys.has(" "),
      };
    };
    const down = (event: KeyboardEvent) => {
      if (gameRef.current?.phase !== "playing") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) {
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
          context.beginPath(); context.arc(point.x, point.y, 20, 0, Math.PI * 2);
          context.fillStyle = player.team === 0 ? "#f25a57" : "#4ba8ff"; context.fill();
          context.lineWidth = player.id === playerId ? 4 : 2;
          context.strokeStyle = player.connected ? "#fff" : "#bbb"; context.stroke();
          context.fillStyle = "#fff"; context.font = "600 12px Arial"; context.textAlign = "center";
          context.fillText(player.name.slice(0, 15), point.x, point.y - 28);
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

  const press = (key: keyof InputState, down: boolean) => {
    touchRef.current = { ...touchRef.current, [key]: down };
    const keys = keySetRef.current;
    inputRef.current = {
      up: touchRef.current.up || keys.has("w") || keys.has("arrowup"),
      down: touchRef.current.down || keys.has("s") || keys.has("arrowdown"),
      left: touchRef.current.left || keys.has("a") || keys.has("arrowleft"),
      right: touchRef.current.right || keys.has("d") || keys.has("arrowright"),
      kick: touchRef.current.kick || keys.has(" "),
    };
  };
  const sendStart = () => send({ type: "start" });
  const sendRematch = () => send({ type: "rematch" });
  const isHost = game?.hostId === playerId;
  const canStart = (game?.players.filter((player) => player.connected).length ?? 0) >= 2;

  return (
    <div className="arena-layout">
      <section className="panel arena-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">INKASTARNA · ARKAD</span><h2>Spela tillsammans</h2></div>
          <Gamepad2 size={23} />
        </div>
        {!playerId ? (
          <div className="arena-message">Koppla ditt konto till en spelarprofil för att gå med i spelet.</div>
        ) : !roomId ? (
          <div className="arena-entry">
            <p>Skapa ett rum och bjud in lagkamrater. Två till tio spelare kan vara med.</p>
            <button className="button dark" onClick={makeRoom}><Play size={15} /> Skapa spelrum</button>
            <form onSubmit={(event) => { event.preventDefault(); enterRoom(roomDraft); }}>
              <label htmlFor="arena-room-code">Gå med med rumskod</label>
              <div><input id="arena-room-code" value={roomDraft} maxLength={6} onChange={(event) => setRoomDraft(event.target.value.toUpperCase())} placeholder="ABC123" /><button className="button subtle">Gå med</button></div>
            </form>
          </div>
        ) : (
          <>
            <div className="arena-toolbar">
              <span className={`arena-connection ${connection}`}><i />{connection === "connected" ? "Ansluten" : connection === "reconnecting" ? "Återansluter" : "Ansluter"}</span>
              <strong>Rum {roomId}</strong>
              <button className="button subtle" onClick={() => void shareRoom()}><Copy size={14} /> {copied ? "Kopierad" : "Dela rum"}</button>
              <button className="icon-button" onClick={leaveRoom} aria-label="Lämna spelrummet"><LogOut size={17} /></button>
            </div>
            {error && <div className="arena-error" role="status">{error}</div>}
            {game?.phase === "playing" ? (
              <>
                <div className="arena-score"><span>RÖDA {game.score[0]}</span><strong>{Math.ceil(game.remainingMs / 60000)}:{String(Math.floor(game.remainingMs / 1000) % 60).padStart(2, "0")}</strong><span>{game.score[1]} BLÅA</span></div>
                <canvas id="arena-canvas" className="arena-canvas" aria-label="Fotbollsplan. Styr med WASD eller piltangenter och skjut med mellanslag." />
                <div className="arena-controls"><span><b>WASD / pilar</b> rör dig</span><span><b>Mellanslag</b> skjut</span><MobileControls press={press} /></div>
              </>
            ) : (
              <div className="arena-lobby">
                <div className="arena-lobby-title"><Users size={19} /><span>{game?.players.length ?? 0}/10 spelare</span><small>{game?.phase === "finished" ? "Matchen är slut" : "Dela länken så ansluter laget"}</small></div>
                <div className="arena-teams">
                  {[0, 1].map((side) => (
                    <div className={`arena-team team-${side}`} key={side}>
                      <strong>{side === 0 ? "Röda laget" : "Blå laget"}</strong>
                      {(game?.players ?? []).filter((player) => player.team === side).map((player) => <span key={player.id} className={!player.connected ? "offline" : ""}>{player.name}{player.id === game?.hostId ? " · värd" : ""}{!player.connected ? " · återansluter" : ""}</span>)}
                    </div>
                  ))}
                </div>
                {connection !== "connected" && <p className="arena-hint"><RefreshCw size={14} /> Väntar på anslutning till spelservern…</p>}
                {game?.phase === "finished" ? <div className="arena-finish">Slutresultat: {game.score[0]}–{game.score[1]}</div> : <p className="arena-hint">Fem minuter · balanserade lag · första spelaren blir värd</p>}
                {isHost && game?.phase === "lobby" && <button className="button dark" disabled={!canStart || connection !== "connected"} onClick={sendStart}><Play size={15} /> Starta match</button>}
                {isHost && game?.phase === "finished" && <button className="button dark" onClick={sendRematch}><RefreshCw size={15} /> Spela igen</button>}
                {!isHost && game?.phase === "lobby" && <p className="arena-hint">Väntar på att värden startar matchen.</p>}
              </div>
            )}
          </>
        )}
        {!roomId && error && <div className="arena-error" role="status">{error}</div>}
      </section>
      <section className="panel arena-help"><div className="panel-heading"><h2>Så spelar ni</h2><Gamepad2 size={21} /></div><ul><li>Rör dig med <b>WASD</b> eller piltangenterna.</li><li>Tryck <b>mellanslag</b> nära bollen för att skjuta.</li><li>På mobil använder du riktningsknapparna och skjutknappen.</li><li>Lagbalansen sköts automatiskt när spelare går med.</li></ul></section>
    </div>
  );
}

function MobileControls({ press }: { press: (key: keyof InputState, down: boolean) => void }) {
  const bind = (key: keyof InputState) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); press(key, true); },
    onPointerUp: () => press(key, false),
    onPointerCancel: () => press(key, false),
    onLostPointerCapture: () => press(key, false),
  });
  return <div className="arena-touch" aria-label="Pekskärmskontroller"><div><button {...bind("up")} aria-label="Framåt">↑</button></div><div><button {...bind("left")} aria-label="Vänster">←</button><button {...bind("down")} aria-label="Bakåt">↓</button><button {...bind("right")} aria-label="Höger">→</button></div><button className="arena-kick" {...bind("kick")}>SKJUT</button></div>;
}
