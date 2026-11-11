/**
 * Sibau Wars: shared definitions for governments, the tech tree and the
 * per-player state the client shows. Used by the engine and the client.
 */

export enum Government {
  Monarchy = "Monarchy",
  Republic = "Republic",
  Junta = "Junta",
  Theocracy = "Theocracy",
}

export const GOVERNMENTS: readonly Government[] = [
  Government.Monarchy,
  Government.Republic,
  Government.Junta,
  Government.Theocracy,
];

export enum TechBranch {
  Economy = "economy",
  Military = "military",
  Defense = "defense",
}

export enum Tech {
  // Economy
  TradeRoutes = "trade_routes",
  Banking = "banking",
  Industry = "industry",
  // Military
  Drill = "drill",
  Armor = "armor",
  Blitz = "blitz",
  // Defense
  Fortify = "fortify",
  Militia = "militia",
  Bunkers = "bunkers",
}

export interface TechInfo {
  tech: Tech;
  branch: TechBranch;
  /** 1-3: a tech needs the one before it in its branch. */
  tier: 1 | 2 | 3;
  /** Research points. */
  cost: number;
  /** Bit in the player's tech mask. */
  bit: number;
}

export const TECHS: readonly TechInfo[] = [
  {
    tech: Tech.TradeRoutes,
    branch: TechBranch.Economy,
    tier: 1,
    cost: 10,
    bit: 0,
  },
  { tech: Tech.Banking, branch: TechBranch.Economy, tier: 2, cost: 25, bit: 1 },
  {
    tech: Tech.Industry,
    branch: TechBranch.Economy,
    tier: 3,
    cost: 50,
    bit: 2,
  },
  { tech: Tech.Drill, branch: TechBranch.Military, tier: 1, cost: 10, bit: 3 },
  { tech: Tech.Armor, branch: TechBranch.Military, tier: 2, cost: 25, bit: 4 },
  { tech: Tech.Blitz, branch: TechBranch.Military, tier: 3, cost: 50, bit: 5 },
  { tech: Tech.Fortify, branch: TechBranch.Defense, tier: 1, cost: 10, bit: 6 },
  { tech: Tech.Militia, branch: TechBranch.Defense, tier: 2, cost: 25, bit: 7 },
  { tech: Tech.Bunkers, branch: TechBranch.Defense, tier: 3, cost: 50, bit: 8 },
];

export function techInfo(tech: Tech): TechInfo {
  const info = TECHS.find((t) => t.tech === tech);
  if (info === undefined) throw new Error(`unknown tech ${tech}`);
  return info;
}

export function hasTechInMask(mask: number, tech: Tech): boolean {
  return (mask & (1 << techInfo(tech).bit)) !== 0;
}

/** The tech before `tech` in its branch, or null for a tier-1 tech. */
export function techPrerequisite(tech: Tech): Tech | null {
  const info = techInfo(tech);
  if (info.tier === 1) return null;
  const prev = TECHS.find(
    (t) => t.branch === info.branch && t.tier === info.tier - 1,
  );
  return prev?.tech ?? null;
}

/** What the client shows about a player's Sibau Wars state. */
export interface SibauPlayerView {
  government: Government | null;
  /** Unit id of the capital City, or null. */
  capitalUnitID: number | null;
  /** Lost the capital and hasn't built a new City since. */
  capitalLost: boolean;
  /** Whole research points available to spend. */
  research: number;
  /** Bit mask of researched techs (see TECHS). */
  techs: number;
  /** War exhaustion in percent (0-100). */
  exhaustion: number;
  /** smallID of the overlord, or null if not a vassal. */
  overlordID: number | null;
}

export function sibauViewEqual(
  a: SibauPlayerView | undefined,
  b: SibauPlayerView | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.government === b.government &&
    a.capitalUnitID === b.capitalUnitID &&
    a.capitalLost === b.capitalLost &&
    a.research === b.research &&
    a.techs === b.techs &&
    a.exhaustion === b.exhaustion &&
    a.overlordID === b.overlordID
  );
}

/** What a player with nothing Sibau-specific yet looks like. */
export const NO_SIBAU: SibauPlayerView = Object.freeze({
  government: null,
  capitalUnitID: null,
  capitalLost: false,
  research: 0,
  techs: 0,
  exhaustion: 0,
  overlordID: null,
});
