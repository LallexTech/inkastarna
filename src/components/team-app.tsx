"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  Flag,
  Home,
  LayoutDashboard,
  ListOrdered,
  LoaderCircle,
  LogIn,
  LogOut,
  MapPin,
  Menu,
  RefreshCw,
  Shield,
  Shirt,
  Smartphone,
  Target,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { calendarEvent } from "@/lib/calendar";
import type { Formation, League, Match, Standing, TeamData } from "@/lib/types";

type Tab =
  | "overview"
  | "upcoming"
  | "played"
  | "statistics"
  | "scorers"
  | "table"
  | "lineup"
  | "squad";
const tabs = [
  { id: "overview", label: "Översikt", icon: LayoutDashboard },
  { id: "upcoming", label: "Kommande matcher", icon: CalendarDays },
  { id: "played", label: "Spelade matcher", icon: Flag },
  { id: "statistics", label: "Statistik", icon: Activity },
  { id: "scorers", label: "Skytteliga", icon: Target },
  { id: "table", label: "Tabell", icon: ListOrdered },
  { id: "lineup", label: "Laguppställning", icon: Shirt },
  { id: "squad", label: "Truppen", icon: Users },
] as const;
const date = (value: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    ...options,
  }).format(new Date(value));
const time = (value: string) =>
  date(value, { hour: "2-digit", minute: "2-digit" });
const day = (value: string) => date(value, { day: "numeric", month: "long" });
const mine = (m: Match) => m.homeId === 27757 || m.awayId === 27757;
const opponent = (m: Match) => (m.homeId === 27757 ? m.away : m.home);
const short = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .map((x) => x[0])
    .slice(0, 2)
    .join("");
const labels = { yes: "Kommer", maybe: "Kanske", no: "Kan inte" };

function Badge({
  name = "Inkastarna",
  large = false,
}: {
  name?: string;
  large?: boolean;
}) {
  const isInkastarna = name === "Inkastarna";
  return (
    <div
      className={`club-badge ${isInkastarna ? "ours" : "other"} ${large ? "large" : ""}`}
      aria-label={name}
    >
      {isInkastarna ? (
        <Image src="/icons/inkastarna-192.png" alt="" width={192} height={192} unoptimized />
      ) : (
        <>
          <Shield aria-hidden="true" />
          <span>{short(name)}</span>
        </>
      )}
    </div>
  );
}
function TeamShirt({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8 3H16L22.5 6.5L21 12L17.5 11V21H6.5V11L3 12L1.5 6.5Z"
        fill="#191919"
        stroke="#424242"
        strokeLinejoin="round"
      />
      <path d="M8.5 3L12 7L15.5 3" fill="none" stroke="#626262" />
      <path d="M7.5 11V20.5" stroke="#e1393e" />
      <path d="M16.5 11V20.5" stroke="#3679cf" />
    </svg>
  );
}
function Empty({
  icon: Icon = Flag,
  title,
  children,
}: {
  icon?: typeof Flag;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={25} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Stäng">
          <X size={21} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export default function TeamApp() {
  const [active, setActive] = useState<Tab>("overview");
  const [league, setLeague] = useState<League | null>(null),
    [stale, setStale] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [team, setTeam] = useState<TeamData | null>(null),
    [teamError, setTeamError] = useState("");
  const { data: session } = authClient.useSession();
  const [authOpen, setAuthOpen] = useState(false),
    [installOpen, setInstallOpen] = useState(false),
    [profileOpen, setProfileOpen] = useState(false),
    [mobileOpen, setMobileOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [showInstallOffer, setShowInstallOffer] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [selected, setSelected] = useState<Match | null>(null),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false);
  const [lineupMatch, setLineupMatch] = useState<number>(0),
    [slots, setSlots] = useState<(string | null)[]>(Array(5).fill(null)),
    [formation, setFormation] = useState<Formation>("1-2-1"),
    [lineupDirty, setLineupDirty] = useState(false);
  const [installPlatform, setInstallPlatform] = useState<"ios" | "android" | "desktop">("desktop");
  const [deferredInstall, setDeferredInstall] = useState<
    | (Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: string }>;
      })
    | null
  >(null);

  const notify = useCallback((message: string) => {
    setToast(message);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const loadLeague = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/league");
      const data = await res.json();
      if (!res.ok || !data.league)
        throw new Error(data.error || "Korpen kan inte nås just nu.");
      setLeague(data.league);
      setStale(data.stale);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Något gick fel.");
    } finally {
      setLoading(false);
    }
  }, []);
  const loadTeam = useCallback(async () => {
    try {
      const r = await fetch("/api/team");
      if (!r.ok) throw new Error("Truppen kunde inte laddas. Försök igen.");
      setTeam(await r.json());
      setTeamError("");
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : "Laget kunde inte laddas.");
    }
  }, []);
  useEffect(() => {
    void loadLeague();
  }, [loadLeague]);
  useEffect(() => {
    if (session) void loadTeam();
    else setTeam(null);
  }, [session, loadTeam]);
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash.startsWith("join=")) {
        const code = new URLSearchParams(hash).get("join") ?? "";
        if (/^[a-zA-Z0-9_-]{10,100}$/.test(code)) {
          setInviteCode(code);
          setAuthOpen(true);
          window.history.replaceState(null, "", window.location.pathname);
        }
        return;
      }
      if (tabs.some((t) => t.id === hash)) setActive(hash as Tab);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    const install = (event: Event) => {
      event.preventDefault();
      setDeferredInstall(event as typeof deferredInstall & Event);
    };
    window.addEventListener("beforeinstallprompt", install);
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(isStandalone);
    const ua = navigator.userAgent;
    setInstallPlatform(
      /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
        ? "ios"
        : /Android/i.test(ua)
          ? "android"
          : "desktop",
    );
    if (!isStandalone) {
      let dismissed = false;
      try {
        dismissed =
          localStorage.getItem("inkastarna:hide-install-offer") === "1";
      } catch {
        // Installation help also works when browser storage is unavailable.
      }
      setShowInstallOffer(!dismissed);
    }
    const onInstalled = () => {
      setInstalled(true);
      setInstallOpen(false);
      setDeferredInstall(null);
    };
    window.addEventListener("appinstalled", onInstalled);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("beforeinstallprompt", install);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const startInstall = async () => {
    if (!deferredInstall) {
      setInstallOpen(true);
      return;
    }
    setDeferredInstall(null);
    try {
      await deferredInstall.prompt();
      if ((await deferredInstall.userChoice).outcome === "accepted") {
        setInstalled(true);
        setInstallOpen(false);
      }
    } catch {
      setInstallOpen(true);
    }
  };
  const go = (tab: Tab) => {
    setActive(tab);
    window.location.hash = tab;
    setMobileOpen(false);
  };
  const matches = league?.matches.filter(mine) ?? [],
    upcoming = matches.filter(
      (m) => !m.finished && new Date(m.startsAt).getTime() > Date.now(),
    ),
    played = matches.filter((m) => m.finished).reverse();
  const next = upcoming[0],
    standing = league?.standings.find((s) => s.team === "Inkastarna");
  const points = standing?.points ?? 0,
    scored = standing?.goalsFor ?? 0;
  const totalPlayed = standing?.played ?? 0;
  const currentMatch = upcoming.find((m) => m.id === lineupMatch) ?? next;
  useEffect(() => {
    if (!currentMatch) return;
    setSlots(
      team?.lineups.find((l) => l.matchId === currentMatch.id)?.slots ??
        Array(5).fill(null),
    );
    setFormation(
      team?.lineups.find((l) => l.matchId === currentMatch.id)?.formation ??
        "1-2-1",
    );
    setLineupDirty(false);
  }, [currentMatch?.id, team]);

  async function save(data: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Kunde inte spara.");
      await loadTeam();
      notify("Sparat för laget.");
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : "Kunde inte spara.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function download(m: Match) {
    const url = URL.createObjectURL(
      new Blob([calendarEvent(m)], { type: "text/calendar;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `inkastarna-${m.id}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyCall(m: Match) {
    try {
      await navigator.clipboard.writeText(
        `⚽ ${m.home} – ${m.away}\n${date(m.startsAt, { weekday: "long", day: "numeric", month: "long" })} kl. ${time(m.startsAt)}\n📍 ${m.location}\nSamling 20 minuter före avspark. 2 × 15 min.\nSvara på kallelsen: ${window.location.origin}/#upcoming`,
      );
      notify("Kallelsen är kopierad. Klistra in den i Messenger!");
    } catch {
      notify("Kopiering blockerades av webbläsaren.");
    }
  }
  function authGate() {
    return (
      <div className="member-gate">
        <div className="gate-icon">
          <Users size={27} />
        </div>
        <div>
          <h3>Här samlas laget.</h3>
          <p>
            Logga in för att svara på kallelser, se truppen och planera nästa
            match.
          </p>
        </div>
        <button className="button dark" onClick={() => setAuthOpen(true)}>
          Logga in <ArrowRight size={16} />
        </button>
      </div>
    );
  }
  function matchRow(m: Match) {
    const status = team?.attendance.find(
      (a) => a.matchId === m.id && a.userId === team.userId,
    )?.status;
    return (
      <button className="match-row" key={m.id} onClick={() => setSelected(m)}>
        <div className="date-tile">
          <strong>{date(m.startsAt, { day: "2-digit" })}</strong>
          <span>{date(m.startsAt, { month: "short" }).replace(".", "")}</span>
        </div>
        <div className="match-row-main">
          <strong>
            {m.home} <span className="muted">–</span> {m.away}
          </strong>
          <span>
            {m.location} <i>·</i> {time(m.startsAt)}
          </span>
        </div>
        {m.finished ? (
          <b className="result">
            {m.homeScore ?? "–"} : {m.awayScore ?? "–"}
          </b>
        ) : status ? (
          <span className={`status ${status}`}>{labels[status]}</span>
        ) : (
          <span className="match-tag">
            {m.homeId === 27757 ? "Hemma" : "Borta"}
          </span>
        )}
        <ChevronRight size={17} />
      </button>
    );
  }
  function table(rows: Standing[], compact = false) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Lag</th>
              <th title="Spelade matcher">M</th>
              {!compact && (
                <>
                  <th title="Vinster">V</th>
                  <th title="Oavgjorda">O</th>
                  <th title="Förluster">F</th>
                  <th>Mål</th>
                </>
              )}
              <th>+/−</th>
              <th>P</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.team}
                className={s.team === "Inkastarna" ? "highlight" : ""}
              >
                <td>{s.position}</td>
                <td>
                  <span className="table-club">
                    <span
                      className={`tiny-crest ${s.team === "Inkastarna" ? "is-ours" : ""}`}
                    >
                      {s.team === "Inkastarna" ? "I" : short(s.team)}
                    </span>
                    {s.team}
                  </span>
                </td>
                <td>{s.played}</td>
                {!compact && (
                  <>
                    <td>{s.won}</td>
                    <td>{s.drawn}</td>
                    <td>{s.lost}</td>
                    <td>
                      {s.goalsFor}:{s.goalsAgainst}
                    </td>
                  </>
                )}
                <td>
                  {s.difference > 0 ? "+" : ""}
                  {s.difference}
                </td>
                <td>
                  <b>{s.points}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  function statCards() {
    return (
      <div className="stat-grid">
        <div>
          <span>
            Spelade matcher <Flag size={16} />
          </span>
          <strong>
            {totalPlayed}
            <small>/ {matches.length}</small>
          </strong>
          <p>
            {totalPlayed === 0
              ? "Säsongen väntar på avspark"
              : `${standing?.won ?? 0} vinster · ${standing?.drawn ?? 0} oavgjorda`}
          </p>
        </div>
        <div>
          <span>
            Poäng <Trophy size={17} />
          </span>
          <strong>
            {points}
            <small>p</small>
          </strong>
          <p>
            {totalPlayed
              ? `${(points / totalPlayed).toFixed(1)} poäng per match`
              : "Nya matcher. Nya möjligheter."}
          </p>
        </div>
        <div>
          <span>
            Gjorda mål <Target size={17} />
          </span>
          <strong>
            {scored}
            <small>mål</small>
          </strong>
          <p>{standing?.goalsAgainst ?? 0} insläppta mål</p>
        </div>
        <div>
          <span>
            Truppen <Users size={17} />
          </span>
          <strong>
            {team?.players.length ?? 10}
            <small>spelare</small>
          </strong>
          <p>En för alla. Alla för Inkastarna.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
        <a className="brand" href="#overview" onClick={() => go("overview")}>
          <Badge />
          <div>
            <strong>
              INKASTARNA<span>FOTBOLLSKLUBB</span>
            </strong>
          </div>
        </a>
        <div className="sidebar-season">
          <span className="live-dot" /> SÄSONG 26/27 <span>INOMHUS</span>
        </div>
        <p className="nav-caption">LAGETS HEMMAPLAN</p>
        <nav aria-label="Huvudmeny">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              className={active === t.id ? "active" : ""}
              aria-current={active === t.id ? "page" : undefined}
            >
              <t.icon size={19} />
              {t.label}
              {t.id === "upcoming" && upcoming.length > 0 && (
                <span className="nav-count">{upcoming.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="home-ground">
            <MapPin size={18} />
            <div>
              <strong>Stora Mossen</strong>
              <span>Vår hemmaplan. Vårt lag.</span>
            </div>
            <ArrowUpRight size={15} />
          </div>
          {!installed && (
            <button className="install-nav" onClick={startInstall}>
              <Smartphone size={18} /> Installera appen{" "}
              <ArrowDownToLine size={16} />
            </button>
          )}
          {session ? (
            <button className="user-menu" onClick={() => setProfileOpen(true)}>
              <span className="avatar">{short(session.user.name)}</span>
              <span>
                <strong>{session.user.name}</strong>
                <small>{team?.admin ? "Lagadministratör" : "Spelare"}</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ) : (
            <button className="user-menu" onClick={() => setAuthOpen(true)}>
              <span className="avatar">
                <LogIn size={18} />
              </span>
              <span>
                <strong>Du hör hemma här</strong>
                <small>Logga in i laget</small>
              </span>
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Stäng menyn"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Öppna menyn"
            onClick={() => setMobileOpen(true)}
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            <Home size={15} />
            <span>/</span>
            {tabs.find((t) => t.id === active)?.label}
          </div>
          <div className="topbar-right">
            <span className="season-label">
              KORPEN STOCKHOLM <i>·</i> 2026/27
            </span>
            <button
              className="top-login"
              onClick={() =>
                session ? setProfileOpen(true) : setAuthOpen(true)
              }
            >
              {session ? (
                <>
                  <span className="avatar small">
                    {short(session.user.name)}
                  </span>
                  {session.user.name}
                </>
              ) : (
                <>
                  Logga in <ArrowUpRight size={15} />
                </>
              )}
            </button>
          </div>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {active === "overview"
                  ? "LAGET FÖRE ALLT"
                  : "INKASTARNA · 2026/27"}
              </p>
              <h1>
                {active === "overview"
                  ? "Vår hemmaplan"
                  : tabs.find((t) => t.id === active)?.label}
                <span className="accent-dot">.</span>
              </h1>
              <p>
                {active === "overview"
                  ? "Allt som händer mellan avspark och slutsignal."
                  : active === "upcoming"
                    ? "Nästa avspark börjar här. Håll koll och svara på kallelsen."
                    : active === "table"
                      ? "Samma serie. Samma mål. Följ vägen genom säsongen."
                      : active === "lineup"
                        ? "Fem på planen. Ett lag bakom."
                        : active === "squad"
                          ? "Människorna som gör Inkastarna."
                          : "Säsongen, match för match."}
              </p>
            </div>
          </div>
          {active === "overview" && showInstallOffer && !installed && (
            <aside className="install-offer" aria-label="Installera Inkastarna">
              <div>
                <strong>Vill du installera Inkastarna?</strong>
                <p>Öppna lagappen direkt från skrivbordet eller hemskärmen.</p>
              </div>
              <button className="button dark" onClick={startInstall}>
                <ArrowDownToLine size={16} /> Installera appen
              </button>
              <button
                className="icon-button"
                aria-label="Dölj installationsfrågan"
                onClick={() => {
                  setShowInstallOffer(false);
                  try {
                    localStorage.setItem("inkastarna:hide-install-offer", "1");
                  } catch {}
                }}
              >
                <X size={16} />
              </button>
            </aside>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button onClick={() => void loadLeague()}>Försök igen</button>
            </div>
          )}
          {stale && (
            <div className="notice">
              Korpen kunde inte nås. Visar senast sparade uppgifter från{" "}
              {league && day(league.fetchedAt)} kl.{" "}
              {league && time(league.fetchedAt)}.
            </div>
          )}
          {teamError && (
            <div className="notice error" role="alert">
              {teamError}
              <button onClick={() => void loadTeam()}>Försök igen</button>
            </div>
          )}
          {loading && !league ? (
            <div className="loading">
              <LoaderCircle className="spin" /> Hämtar lagets säsong…
            </div>
          ) : (
            <>
              {active === "overview" && (
                <>
                  <section className="match-hero">
                    <div className="hero-content">
                      <div className="hero-kicker">
                        <span className="live-dot" />
                        {next ? "NÄSTA MATCH" : "INKASTARNA 2026/27"}
                        <span>2 × 15 MIN</span>
                      </div>
                      <p className="hero-pretitle">
                        {next
                          ? date(next.startsAt, {
                              weekday: "long",
                              day: "numeric",
                              month: "long",
                            })
                          : "Innefotboll på Stora Mossen"}
                      </p>
                      <h2>
                        {next ? (
                          <>
                            Dags för
                            <br />
                            nästa <em>inkast.</em>
                          </>
                        ) : (
                          <>
                            Laget före
                            <br />
                            <em>allt.</em>
                          </>
                        )}
                      </h2>
                      {next && (
                        <div className="hero-fixture">
                          <Badge />
                          <strong>Inkastarna</strong>
                          <span>vs</span>
                          <strong>{opponent(next)}</strong>
                        </div>
                      )}
                      <div className="hero-meta">
                        <span>
                          <Clock3 size={15} />
                          {next ? time(next.startsAt) : "2 × 15 minuter"}
                        </span>
                        <span>
                          <MapPin size={15} />
                          {next?.location ?? "Stora Mossen"}
                        </span>
                      </div>
                      <div className="hero-actions">
                        <button
                          className="button primary"
                          onClick={() =>
                            next ? setSelected(next) : go("upcoming")
                          }
                        >
                          {session ? "Svara på kallelsen" : "Visa matchen"}{" "}
                          <ArrowUpRight size={17} />
                        </button>
                        {next && (
                          <button
                            className="hero-calendar"
                            onClick={() => download(next)}
                            aria-label="Lägg nästa match i kalendern"
                          >
                            <CalendarDays size={18} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="hero-art" aria-hidden="true">
                      <span className="art-label">
                        STORA MOSSEN · STOCKHOLM
                      </span>
                      <div className="pitch-art">
                        <div className="pitch-half" />
                        <div className="pitch-circle" />
                        <div className="pitch-box top" />
                        <div className="pitch-box bottom" />
                        <div className="pitch-dot one" />
                        <div className="pitch-dot two" />
                        <div className="pitch-dot three" />
                        <div className="pitch-dot four" />
                        <div className="pitch-dot five" />
                      </div>
                      <div className="art-number">
                        IK<span>EST. LAGANDA</span>
                      </div>
                      <span className="art-bottom">SÖNDAGAR ÄR VÅRA.</span>
                    </div>
                  </section>
                  {statCards()}
                  <div className="dashboard-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <span className="section-kicker">KALENDERN</span>
                          <h2>Snart på planen</h2>
                        </div>
                        <button
                          className="text-link"
                          onClick={() => go("upcoming")}
                        >
                          Alla matcher <ArrowRight size={16} />
                        </button>
                      </div>
                      <div>
                        {upcoming.length ? (
                          upcoming.slice(0, 3).map(matchRow)
                        ) : (
                          <Empty title="Inga kommande matcher">
                            Nya matcher dyker upp här när Korpen publicerar dem.
                          </Empty>
                        )}
                      </div>
                      <div className="panel-foot">
                        <MapPin size={14} /> Stora Mossen-hallen 2{" "}
                        <span>·</span> Innefotboll
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <span className="section-kicker">DIVISION 2</span>
                          <h2>Tabelläget</h2>
                        </div>
                        <button
                          className="circle-link"
                          aria-label="Visa hela tabellen"
                          onClick={() => go("table")}
                        >
                          <ArrowUpRight size={18} />
                        </button>
                      </div>
                      {league && table(league.standings.slice(0, 4), true)}
                      <div className="panel-foot">
                        {totalPlayed === 0
                          ? "Säsongen har inte börjat. Placeringarna är preliminära."
                          : "Officiell tabell från Korpen Stockholm."}
                      </div>
                    </section>
                  </div>
                  <div className="team-banner">
                    <div className="banner-icon">
                      <Shirt size={31} />
                    </div>
                    <div>
                      <p className="section-kicker">TIO SPELARE. ETT LAG.</p>
                      <h3>Det börjar med att dyka upp.</h3>
                      <p>
                        Samling 20 minuter före avspark. Svart tröja och gott
                        humör.
                      </p>
                    </div>
                    <button
                      className="button subtle"
                      onClick={() => go("squad")}
                    >
                      Möt truppen <ArrowRight size={16} />
                    </button>
                  </div>
                </>
              )}
              {(active === "upcoming" || active === "played") && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <span className="section-kicker">{league?.name}</span>
                      <h2>
                        {active === "upcoming"
                          ? `${upcoming.length} matcher att se fram emot`
                          : `${played.length} spelade matcher`}
                      </h2>
                    </div>
                    <CalendarDays size={21} />
                  </div>
                  {(active === "upcoming" ? upcoming : played).length ? (
                    (active === "upcoming" ? upcoming : played).map(matchRow)
                  ) : (
                    <Empty
                      title={
                        active === "played"
                          ? "Historien skriver vi tillsammans."
                          : "Spelschemat är tomt just nu."
                      }
                    >
                      {active === "played"
                        ? "Säsongen har inte börjat. Resultat visas här när matcherna är färdigspelade hos Korpen."
                        : "Publicerade matcher hämtas automatiskt från Korpen."}
                    </Empty>
                  )}
                </section>
              )}
              {active === "table" && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <span className="section-kicker">
                        OFFICIELL SERIETABELL
                      </span>
                      <h2>{league?.name}</h2>
                    </div>
                    <span className="pill">7 lag</span>
                  </div>
                  {league && table(league.standings)}
                  <div className="table-legend">
                    <span>
                      <i className="legend-dot" /> Inkastarna
                    </span>
                    <span>
                      M = matcher · V = vinster · O = oavgjorda · F = förluster
                      · P = poäng
                    </span>
                  </div>
                  {!totalPlayed && (
                    <div className="notice inset">
                      Serien har inte startat. Ordningen bland lag med 0 matcher
                      är ingen sportslig placering.
                    </div>
                  )}
                  <a
                    className="source-link"
                    href="https://korpenstockholm.zoezi.se/serie/9266"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Visa tabellen hos Korpen <ExternalLink size={14} />
                  </a>
                </section>
              )}
              {active === "statistics" && (
                <>
                  {statCards()}
                  <div className="dashboard-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Säsongen i siffror</h2>
                        <Activity size={20} />
                      </div>
                      <div className="season-breakdown">
                        {[
                          ["Vinster", standing?.won ?? 0],
                          ["Oavgjorda", standing?.drawn ?? 0],
                          ["Förluster", standing?.lost ?? 0],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <span>{label}</span>
                            <div className="stat-track">
                              <i
                                style={{
                                  width: `${totalPlayed ? (Number(value) / totalPlayed) * 100 : 0}%`,
                                }}
                              />
                            </div>
                            <b>{value}</b>
                          </div>
                        ))}
                      </div>
                      <div className="panel-foot">
                        {totalPlayed
                          ? "Baserat på Korpens officiella resultat."
                          : "Statistiken fylls på efter säsongens första match."}
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Senaste formen</h2>
                        <Flag size={20} />
                      </div>
                      {played.length ? (
                        <div className="form-run">
                          {played
                            .slice(0, 5)
                            .reverse()
                            .map((m) => {
                              const a =
                                  m.homeId === 27757
                                    ? m.homeScore
                                    : m.awayScore,
                                b =
                                  m.homeId === 27757
                                    ? m.awayScore
                                    : m.homeScore;
                              return (
                                <button
                                  key={m.id}
                                  onClick={() => setSelected(m)}
                                  className={`form-badge ${a != null && b != null ? (a > b ? "win" : a === b ? "draw" : "loss") : ""}`}
                                >
                                  {a == null || b == null
                                    ? "–"
                                    : a > b
                                      ? "V"
                                      : a === b
                                        ? "O"
                                        : "F"}
                                </button>
                              );
                            })}
                        </div>
                      ) : (
                        <Empty
                          icon={Activity}
                          title="Formen börjar vid första avspark."
                        >
                          De fem senaste resultaten kommer att visas här.
                        </Empty>
                      )}
                    </section>
                  </div>
                </>
              )}
              {active === "scorers" && (
                <>
                  {!session ? (
                    authGate()
                  ) : (
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <span className="section-kicker">
                            INKASTARNAS INTERNA SKYTTELIGA
                          </span>
                          <h2>Vem hittar nätet?</h2>
                        </div>
                        <Target size={22} />
                      </div>
                      {team?.players.some((p) => p.goals > 0) ? (
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Spelare</th>
                                <th>Matcher</th>
                                <th>Assist</th>
                                <th>Mål</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...team.players]
                                .sort(
                                  (a, b) =>
                                    b.goals - a.goals ||
                                    b.assists - a.assists ||
                                    a.name.localeCompare(b.name),
                                )
                                .map((p, i) => (
                                  <tr key={p.id}>
                                    <td>{i + 1}</td>
                                    <td>
                                      <span className="player-name">
                                        <span className="avatar small">
                                          {short(p.name)}
                                        </span>
                                        {p.name}
                                      </span>
                                    </td>
                                    <td>{p.appearances}</td>
                                    <td>{p.assists}</td>
                                    <td>
                                      <b>{p.goals}</b>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <Empty
                          icon={Target}
                          title="Första målet väntar på sin målskytt."
                        >
                          Öppna en match under Spelade matcher och välj
                          Registrera spelarstatistik för att lägga in mål,
                          assist och deltagande. Inga mål är registrerade än.
                        </Empty>
                      )}
                      <div className="panel-foot">
                        Matchstatistik registreras från detaljvyn för en spelad
                        match. Resultat hämtas från Korpen.
                      </div>
                    </section>
                  )}
                </>
              )}
              {active === "squad" && (
                <>
                  {session ? (
                    <>
                      <div className="section-toolbar">
                        <span>
                          {team?.players.length ?? 10} spelare · Inkastarna
                        </span>
                        <button
                          className="button subtle"
                          onClick={() => setProfileOpen(true)}
                        >
                          Min spelarprofil <ArrowUpRight size={15} />
                        </button>
                      </div>
                      <div className="player-grid">
                        {(team?.players ?? []).map((p, i) => (
                          <article className="player-card" key={p.id}>
                            <div className="player-jersey">
                              <TeamShirt />
                              <span>{p.number ?? "–"}</span>
                              <i>{String(i + 1).padStart(2, "0")}</i>
                            </div>
                            <div className="player-card-name">
                              <h3>{p.name}</h3>
                              <span>{p.position}</span>
                            </div>
                            <div className="player-card-stats">
                              <span>
                                <b>{p.appearances}</b>matcher
                              </span>
                              <span>
                                <b>{p.goals}</b>mål
                              </span>
                              <span>
                                <b>{p.assists}</b>assist
                              </span>
                            </div>
                          </article>
                        ))}
                      </div>
                      {team?.admin && (
                        <section className="panel leaders-panel">
                          <div className="panel-heading">
                            <div>
                              <span className="section-kicker">LAGANSVAR</span>
                              <h2>Lagledare</h2>
                            </div>
                            <Shield size={21} />
                          </div>
                          <p className="panel-foot">
                            Välj vilka konton i truppen som får hantera laguppställning,
                            matchstatistik och lagledare.
                          </p>
                          <div className="leader-list">
                            {(team?.players ?? []).map((p) => {
                              const isLeader = team?.teamLeads.includes(p.id) ?? false;
                              return (
                                <div key={p.id}>
                                  <span>
                                    {p.name}
                                    {!p.hasAccount && <small> · behöver skapa konto</small>}
                                  </span>
                                  <button
                                    className={`button ${isLeader ? "subtle" : "dark"}`}
                                    disabled={busy || !p.hasAccount}
                                    onClick={() =>
                                      void save({
                                        type: "teamLeader",
                                        playerId: p.id,
                                        enabled: !isLeader,
                                      })
                                    }
                                  >
                                    {isLeader ? "Ta bort lagledare" : "Gör till lagledare"}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </section>
                      )}
                    </>
                  ) : (
                    authGate()
                  )}
                </>
              )}
              {active === "lineup" && (
                <>
                  {!session ? (
                    authGate()
                  ) : (
                    <div className="lineup-grid">
                      <section className="panel">
                        <div className="panel-heading">
                          <div>
                            <span className="section-kicker">
                              FEMMANNALAG · {formation}
                            </span>
                            <h2>Vårt lag på planen</h2>
                          </div>
                          <Shirt size={22} />
                        </div>
                        {currentMatch ? (
                          <>
                            <div className="lineup-select">
                              <label htmlFor="lineup-match">Välj match</label>
                              <select
                                id="lineup-match"
                                value={currentMatch.id}
                                onChange={(e) =>
                                  setLineupMatch(Number(e.target.value))
                                }
                              >
                                {upcoming.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {day(m.startsAt)} · {opponent(m)}
                                  </option>
                                ))}
                              </select>
                              {team?.admin && (
                                <>
                                  <label htmlFor="lineup-formation">Formation</label>
                                  <select
                                    id="lineup-formation"
                                    value={formation}
                                    onChange={(e) => {
                                      setFormation(e.target.value as Formation);
                                      setLineupDirty(true);
                                    }}
                                  >
                                    <option value="1-2-1">1–2–1</option>
                                    <option value="2-2">2–2</option>
                                  </select>
                                </>
                              )}
                            </div>
                            <div className={`formation ${formation === "2-2" ? "two-two" : ""}`}>
                              <div className="field-lines">
                                <div />
                                <i />
                              </div>
                              {(formation === "2-2"
                                ? ["Anfallare vänster", "Anfallare höger", "Back vänster", "Back höger", "Målvakt"]
                                : ["Anfallare", "Vänster", "Höger", "Back", "Målvakt"]
                              ).map((label, i) => (
                                <div
                                  className={`formation-player slot-${i}`}
                                  key={label}
                                >
                                  <span className="shirt-token">
                                    <TeamShirt size={38} />
                                    <b>
                                      {team?.players.find(
                                        (p) => p.id === slots[i],
                                      )?.number ?? "+"}
                                    </b>
                                  </span>
                                  {team?.admin ? (
                                    <select
                                      aria-label={`Spelare: ${label}`}
                                      value={slots[i] ?? ""}
                                      onChange={(e) => {
                                        setSlots((s) =>
                                          s.map((v, j) =>
                                            j === i
                                              ? e.target.value || null
                                              : v,
                                          ),
                                        );
                                        setLineupDirty(true);
                                      }}
                                    >
                                      <option value="">{label}</option>
                                      {team.players.map((p) => (
                                        <option
                                          key={p.id}
                                          value={p.id}
                                          disabled={
                                            slots.includes(p.id) &&
                                            slots[i] !== p.id
                                          }
                                        >
                                          {p.name}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span>
                                      {team?.players.find(
                                        (p) => p.id === slots[i],
                                      )?.name ?? label}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                            <div className="lineup-footer">
                              <span>
                                {slots.filter(Boolean).length}/5 platser
                                tillsatta
                              </span>
                              {team?.admin && (
                                <button
                                  className="button dark"
                                  disabled={busy || !lineupDirty}
                                  onClick={() =>
                                    void save({
                                      type: "lineup",
                                      matchId: currentMatch.id,
                                      slots,
                                      formation,
                                    })
                                  }
                                >
                                  {busy ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <Check size={16} />
                                  )}{" "}
                                  Spara laget
                                </button>
                              )}
                            </div>
                            <div className="notice inset">
                              Lagets planering här ersätter inte den officiella
                              laguppställningen i Korpen. Lagledaren registrerar
                              den där inför match.
                            </div>
                          </>
                        ) : (
                          <Empty title="Ingen kommande match">
                            Laguppställningen öppnar när nästa match är
                            schemalagd.
                          </Empty>
                        )}
                      </section>
                      <section className="panel">
                        <div className="panel-heading">
                          <h2>Matchtruppen</h2>
                          <Users size={21} />
                        </div>
                        {currentMatch && (
                          <div className="attendance-list">
                            {(team?.players ?? []).map(({ name }) => {
                              const a = team?.attendance.find(
                                (a) =>
                                  a.matchId === currentMatch.id &&
                                  a.name.toLowerCase() === name.toLowerCase(),
                              );
                              return (
                                <div key={name}>
                                  <span className="avatar small">
                                    {short(name)}
                                  </span>
                                  <strong>{name}</strong>
                                  <span
                                    className={`status ${a?.status ?? "pending"}`}
                                  >
                                    {a ? labels[a.status] : "Ej svarat"}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="panel-foot">
                          Svaren uppdateras när spelarna svarar i appen.
                        </div>
                      </section>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <span className="live-dot" />{" "}
              {league
                ? `Korpen · uppdaterad ${day(league.fetchedAt)} ${time(league.fetchedAt)}`
                : "Korpen Stockholm"}
            </span>
            <button
              onClick={() => void loadLeague()}
              disabled={loading}
              aria-label="Uppdatera matchdata"
            >
              <RefreshCw size={13} className={loading ? "spin" : ""} />{" "}
              Uppdatera
            </button>
            <span className="footer-motto">
              LAGET FÖRE ALLT. <span>↗</span>
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {authOpen && (
        <AuthModal
          initialCode={inviteCode}
          onClose={() => setAuthOpen(false)}
          onDone={() => {
            setAuthOpen(false);
            void loadTeam();
          }}
        />
      )}
      {installOpen && (
        <Modal
          title="Installera Inkastarna"
          onClose={() => setInstallOpen(false)}
        >
          <div className="install-intro">
            <Badge large />
            <p>Öppna appen från skrivbordet eller hemskärmen.</p>
          </div>
          {deferredInstall && (
            <button className="button dark full" onClick={startInstall}>
              Installera Inkastarna <ArrowDownToLine size={18} />
            </button>
          )}
          {installPlatform === "ios" ? (
            <div className="install-step">
              <strong>iPhone eller iPad</strong>
              <p>
                Öppna sidan i Safari, tryck på <b>Dela</b> och välj{" "}
                <b>Lägg till på hemskärmen</b>. Slå på{" "}
                <b>Öppna som webbapp</b> och tryck på <b>Lägg till</b>. Starta
                sedan Inkastarna från den nya ikonen. iOS kräver de här stegen
                manuellt.
              </p>
            </div>
          ) : installPlatform === "android" ? (
            <div className="install-step">
              <strong>Android</strong>
              <p>
                Tryck på installationsknappen ovan och godkänn i Chromes
                installationsruta. Om den inte visas, öppna menyn ⋮ och välj{" "}
                <b>Installera app</b>.
              </p>
            </div>
          ) : (
            <div className="install-step">
              <strong>Dator · Chrome eller Edge</strong>
              <p>
                Tryck på installationsknappen ovan eller välj
                installationsikonen i adressfältet.
              </p>
            </div>
          )}
          <p className="form-note">
            Du behöver internet för aktuella matcher och kallelsesvar. Vid
            avbrott visar appen en tydlig offlinesida.
          </p>
        </Modal>
      )}
      {profileOpen && session && (
        <ProfileModal
          team={team}
          session={session}
          busy={busy}
          onClose={() => setProfileOpen(false)}
          onSave={save}
        />
      )}
      {selected && (
        <Modal
          title={selected.finished ? "Matchresultat" : "Match & kallelse"}
          onClose={() => setSelected(null)}
        >
          <p className="modal-kicker">
            {date(selected.startsAt, {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}{" "}
            · {time(selected.startsAt)}
          </p>
          <div className="match-detail-clubs">
            <div>
              <Badge name={selected.home} large />
              <strong>{selected.home}</strong>
            </div>
            <b>
              {selected.finished
                ? `${selected.homeScore ?? "–"} : ${selected.awayScore ?? "–"}`
                : "VS"}
            </b>
            <div>
              <Badge name={selected.away} large />
              <strong>{selected.away}</strong>
            </div>
          </div>
          <div className="detail-meta">
            <p>
              <MapPin size={17} />
              {selected.location}
            </p>
            <p>
              <Clock3 size={17} />2 × 15 minuter · samling{" "}
              {time(
                new Date(
                  new Date(selected.startsAt).getTime() - 20 * 60000,
                ).toISOString(),
              )}
            </p>
          </div>
          {!selected.finished &&
            new Date(selected.startsAt).getTime() > Date.now() && (
              <>
                {session ? (
                  <>
                    <h3 className="rsvp-title">
                      Är du med, {session.user.name}?
                    </h3>
                    <div className="rsvp-options">
                      {(["yes", "maybe", "no"] as const).map((s) => (
                        <button
                          key={s}
                          disabled={busy}
                          className={
                            team?.attendance.find(
                              (a) =>
                                a.userId === team.userId &&
                                a.matchId === selected.id,
                            )?.status === s
                              ? "selected " + s
                              : ""
                          }
                          onClick={() =>
                            void save({
                              type: "attendance",
                              matchId: selected.id,
                              status: s,
                            })
                          }
                        >
                          {s === "yes" ? (
                            <Check size={18} />
                          ) : s === "maybe" ? (
                            <CircleHelp size={18} />
                          ) : (
                            <X size={18} />
                          )}{" "}
                          {labels[s]}
                        </button>
                      ))}
                    </div>
                    <div className="response-summary">
                      {(["yes", "maybe", "no"] as const).map((s) => (
                        <div key={s}>
                          <strong>
                            {team?.attendance.filter(
                              (a) =>
                                a.matchId === selected.id && a.status === s,
                            ).length ?? 0}
                          </strong>
                          <span>{labels[s]}</span>
                        </div>
                      ))}
                    </div>
                    <div className="response-names">
                      {team?.attendance
                        .filter((a) => a.matchId === selected.id)
                        .map((a) => (
                          <span key={a.userId} className={`status ${a.status}`}>
                            {a.name} · {labels[a.status]}
                          </span>
                        ))}
                    </div>
                  </>
                ) : (
                  <button
                    className="button dark full"
                    onClick={() => {
                      setSelected(null);
                      setAuthOpen(true);
                    }}
                  >
                    Logga in för att svara <LogIn size={16} />
                  </button>
                )}
                <div className="detail-actions">
                  <button
                    className="button subtle"
                    onClick={() => download(selected)}
                  >
                    <CalendarDays size={16} /> Kalender
                  </button>
                  <button
                    className="button subtle"
                    onClick={() => void copyCall(selected)}
                  >
                    <Copy size={16} /> Kopiera kallelse
                  </button>
                </div>
              </>
            )}
          {selected.finished && team?.admin && (
            <MatchStats match={selected} team={team} save={save} busy={busy} />
          )}
          <a
            className="source-link"
            href={`https://korpenstockholm.zoezi.se/match/${selected.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Matchen hos Korpen <ExternalLink size={14} />
          </a>
        </Modal>
      )}
    </div>
  );
}

function AuthModal({
  onClose,
  onDone,
  initialCode,
}: {
  onClose: () => void;
  onDone: () => void;
  initialCode: string;
}) {
  const [register, setRegister] = useState(Boolean(initialCode)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(event.currentTarget);
    try {
      const response = await fetch(
        `/api/auth/${register ? "sign-up" : "sign-in"}/email`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(register ? { "x-team-code": String(f.get("code")) } : {}),
          },
          body: JSON.stringify({
            email: String(f.get("email")).trim().toLowerCase(),
            password: f.get("password"),
            ...(register ? { name: f.get("name") } : {}),
          }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.message || "Inloggningen misslyckades.");
      await authClient.getSession({ fetchOptions: { cache: "no-store" } });
      window.location.reload();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Något gick fel.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={register ? "Välkommen till laget." : "Tillbaka på hemmaplan."}
      onClose={onClose}
    >
      <p className="auth-description">
        {register
          ? "Skapa ditt spelarkonto med lagkoden från lagledaren."
          : "Logga in för kallelser, trupp och laguppställning."}
      </p>
      <form onSubmit={submit} className="auth-form">
        {register && (
          <label>
            Vem är du?
            <input
              name="name"
              autoComplete="given-name"
              placeholder="Ditt förnamn i truppen"
              required
              maxLength={80}
            />
          </label>
        )}
        <label>
          E-post
          <input
            autoComplete="email"
            type="email"
            name="email"
            placeholder="din@epost.se"
            required
            maxLength={254}
          />
        </label>
        <label>
          Lösenord
          <input
            autoComplete={register ? "new-password" : "current-password"}
            name="password"
            type="password"
            minLength={register ? 10 : 1}
            maxLength={128}
            placeholder={register ? "Minst 10 tecken" : "Ditt lösenord"}
            required
          />
        </label>
        {register && (
          <label>
            Lagkod
            <input
              name="code"
              defaultValue={initialCode}
              autoComplete="off"
              placeholder="Koden från lagledaren"
              required
              maxLength={100}
            />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button dark full" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <>
              {register ? "Skapa konto" : "Logga in"}
              <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
      <button
        className="auth-switch"
        onClick={() => {
          setRegister(!register);
          setError("");
        }}
      >
        {register
          ? "Har du redan ett konto? Logga in"
          : "Ny i appen? Skapa ditt konto"}{" "}
        <ArrowRight size={14} />
      </button>
      <p className="form-note">
        {register
          ? "Kontot kopplas till ditt namn i truppen. Använd bara ditt eget namn."
          : "Glömt lösenord? Kontakta lagledaren. Automatisk återställning via e-post är ännu inte ansluten."}
      </p>
    </Modal>
  );
}

function ProfileModal({
  team,
  session,
  busy,
  onClose,
  onSave,
}: {
  team: TeamData | null;
  session: { user: { name: string; email: string } };
  busy: boolean;
  onClose: () => void;
  onSave: (d: Record<string, unknown>) => Promise<boolean>;
}) {
  const player = team?.players.find((p) => p.id === team.playerId);
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Min spelarprofil" onClose={onClose}>
      <div className="profile-intro">
        <span className="avatar">{short(session.user.name)}</span>
        <div>
          <h3>{session.user.name}</h3>
          <p>{session.user.email}</p>
        </div>
      </div>
      <form
        className="auth-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (
            await onSave({
              type: "profile",
              number: f.get("number") ? Number(f.get("number")) : null,
              position: f.get("position"),
            })
          )
            onClose();
        }}
      >
        <label>
          Tröjnummer
          <input
            name="number"
            type="number"
            min="1"
            max="99"
            defaultValue={player?.number ?? ""}
            placeholder="1–99"
          />
        </label>
        <label>
          Position
          <select name="position" defaultValue={player?.position ?? "Allround"}>
            {["Allround", "Målvakt", "Back", "Mittfältare", "Anfallare"].map(
              (x) => (
                <option key={x}>{x}</option>
              ),
            )}
          </select>
        </label>
        <button className="button dark full" disabled={busy}>
          Spara profil <Check size={16} />
        </button>
      </form>
      {team?.admin && team.inviteCode && (
        <button
          className="auth-switch"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                `${window.location.origin}/#join=${team.inviteCode}`,
              );
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy size={15} />
          {copied
            ? "Inbjudan kopierad – dela den med laget"
            : "Kopiera inbjudan till laget"}
        </button>
      )}
      <button
        className="auth-switch logout"
        onClick={async () => {
          await authClient.signOut();
          onClose();
        }}
      >
        <LogOut size={16} />
        Logga ut
      </button>
    </Modal>
  );
}

function MatchStats({
  match,
  team,
  save,
  busy,
}: {
  match: Match;
  team: TeamData;
  save: (d: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
}) {
  return (
    <details className="admin-stats">
      <summary>Registrera spelarstatistik</summary>
      <p>
        Välj en spelare. Uppgifterna ersätter tidigare registrering för samma
        spelare och match.
      </p>
      <form
        className="auth-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          await save({
            type: "stats",
            matchId: match.id,
            playerId: f.get("playerId"),
            goals: Number(f.get("goals")),
            assists: Number(f.get("assists")),
            played: f.get("played") === "on",
          });
        }}
      >
        <label>
          Spelare
          <select name="playerId">
            {team.players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-columns">
          <label>
            Mål
            <input
              name="goals"
              type="number"
              defaultValue={0}
              min={0}
              max={100}
              required
            />
          </label>
          <label>
            Assist
            <input
              name="assists"
              type="number"
              defaultValue={0}
              min={0}
              max={100}
              required
            />
          </label>
        </div>
        <label className="checkbox-label">
          <input type="checkbox" name="played" defaultChecked />
          Deltog i matchen
        </label>
        <button className="button dark" disabled={busy}>
          Spara statistik
        </button>
      </form>
    </details>
  );
}
