export type Match = {
  id: number;
  startsAt: string;
  location: string;
  finished: boolean;
  home: string;
  away: string;
  homeId: number;
  awayId: number;
  homeScore: number | null;
  awayScore: number | null;
};
export type Standing = {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  difference: number;
  points: number;
};
export type League = {
  name: string;
  season: string;
  divisionId: number;
  teamId: number;
  fetchedAt: string;
  matches: Match[];
  standings: Standing[];
  scorers: { name: string; team: string; goals: number }[];
  scorersAvailable: boolean;
};
export type Player = {
  id: string;
  name: string;
  number: number | null;
  position: string;
  hasAccount?: boolean;
  goals: number;
  assists: number;
  appearances: number;
};
export type Attendance = {
  matchId: number;
  userId: string;
  name: string;
  status: "yes" | "maybe" | "no";
};
export type Formation = "1-2-1" | "2-2";
export type Lineup = { matchId: number; slots: (string | null)[]; formation: Formation };
export type TeamData = {
  inviteCode?: string;
  players: Player[];
  attendance: Attendance[];
  lineups: Lineup[];
  teamLeads: string[];
  admin: boolean;
  userId: string;
  playerId: string | null;
};
