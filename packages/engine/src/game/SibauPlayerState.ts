import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Government,
  hasTechInMask,
  SibauPlayerView,
  Tech,
  techInfo,
} from "@openfront/engine-api/game/Sibau";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import type {
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import type { Player, Unit } from "./Game";

/** Most remembered conquests per player (oldest dropped first). */
/** Newest conquered tiles kept as a sample (where rebels can rise). */
const MAX_CONQUEST_SAMPLE = 4000;
/** Conquests are counted per bucket of this many ticks. */
const CONQUEST_BUCKET_TICKS = 100;

/**
 * Sibau Wars: everything a player has on top of OpenFront: government,
 * capital, research and techs, war exhaustion, overlord, pending vassal
 * demands and recent conquests (for rebellions).
 *
 * The view the rules read (`view()`) is cached and rebuilt only after a
 * change, since attacks read it for every tile they take.
 */
export class SibauPlayerState {
  private _government: Government | null = null;
  private _capital: Unit | null = null;
  private _capitalLost = false;
  private _research = 0;
  private _techs = 0;
  /** 0..1 */
  private _exhaustion = 0;
  private _overlord: Player | null = null;
  /** Players who demanded we become their vassal, with when it expires. */
  private _vassalDemands: { from: Player; expiresAt: number }[] = [];
  private _conquestTiles: TileRef[] = [];
  private _conquestTicks: number[] = [];
  /** [bucket start tick, tiles taken] pairs, oldest first. */
  private _conquestBuckets: number[] = [];
  private _lastRebellionTick = -1_000_000;
  private _oilSearches = 0;

  private viewMemo: SibauPlayerView | null = null;

  view(): SibauPlayerView {
    this.viewMemo ??= {
      government: this._government,
      capitalUnitID: this._capital?.id() ?? null,
      capitalLost: this._capitalLost,
      research: Math.floor(this._research),
      techs: this._techs,
      exhaustion: Math.round(this._exhaustion * 100),
      overlordID: this._overlord?.smallID() ?? null,
    };
    return this.viewMemo;
  }

  private changed() {
    this.viewMemo = null;
  }

  // --- government ---
  government(): Government | null {
    return this._government;
  }
  setGovernment(g: Government) {
    this._government = g;
    this.changed();
  }

  // --- capital ---
  capital(): Unit | null {
    return this._capital;
  }
  capitalLost(): boolean {
    return this._capitalLost;
  }
  setCapital(city: Unit) {
    this._capital = city;
    this._capitalLost = false;
    this.changed();
  }
  loseCapital() {
    this._capital = null;
    this._capitalLost = true;
    this.changed();
  }

  // --- research ---
  research(): number {
    return this._research;
  }
  addResearch(points: number) {
    const before = Math.floor(this._research);
    this._research += points;
    if (Math.floor(this._research) !== before) this.changed();
  }
  hasTech(tech: Tech): boolean {
    return hasTechInMask(this._techs, tech);
  }
  /** Pays for and learns `tech`; the caller checks it's allowed. */
  learn(tech: Tech) {
    const info = techInfo(tech);
    this._research -= info.cost;
    this._techs |= 1 << info.bit;
    this.changed();
  }

  // --- war exhaustion ---
  exhaustion(): number {
    return this._exhaustion;
  }
  setExhaustion(value: number) {
    const v = Math.min(1, Math.max(0, value));
    const changes = Math.round(v * 100) !== Math.round(this._exhaustion * 100);
    this._exhaustion = v;
    if (changes) this.changed();
  }

  // --- vassals ---
  overlord(): Player | null {
    return this._overlord;
  }
  setOverlord(p: Player | null) {
    this._overlord = p;
    this.changed();
  }
  vassalDemands(): readonly { from: Player; expiresAt: number }[] {
    return this._vassalDemands;
  }
  addVassalDemand(from: Player, expiresAt: number) {
    this._vassalDemands = this._vassalDemands.filter((d) => d.from !== from);
    this._vassalDemands.push({ from, expiresAt });
  }
  removeVassalDemand(from: Player) {
    this._vassalDemands = this._vassalDemands.filter((d) => d.from !== from);
  }
  dropExpiredDemands(now: number) {
    this._vassalDemands = this._vassalDemands.filter((d) => d.expiresAt > now);
  }

  // --- conquests (for rebellions) ---
  recordConquest(tile: TileRef, tick: number) {
    const bucket = tick - (tick % CONQUEST_BUCKET_TICKS);
    const n = this._conquestBuckets.length;
    if (n > 0 && this._conquestBuckets[n - 2] === bucket) {
      this._conquestBuckets[n - 1]++;
    } else {
      this._conquestBuckets.push(bucket, 1);
    }
    this._conquestTiles.push(tile);
    this._conquestTicks.push(tick);
    // Drop the older half at once so big attacks stay cheap.
    if (this._conquestTiles.length > MAX_CONQUEST_SAMPLE) {
      const drop = MAX_CONQUEST_SAMPLE / 2;
      this._conquestTiles.splice(0, drop);
      this._conquestTicks.splice(0, drop);
    }
  }
  /** Forgets conquests older than `since`. */
  pruneConquests(since: number) {
    let i = 0;
    while (i < this._conquestTicks.length && this._conquestTicks[i] < since)
      i++;
    if (i > 0) {
      this._conquestTiles.splice(0, i);
      this._conquestTicks.splice(0, i);
    }
    let b = 0;
    while (
      b < this._conquestBuckets.length &&
      this._conquestBuckets[b] + CONQUEST_BUCKET_TICKS <= since
    )
      b += 2;
    if (b > 0) this._conquestBuckets.splice(0, b);
  }
  /** How many tiles were taken since the last prune (not just the sample). */
  conquestCount(): number {
    let total = 0;
    for (let i = 1; i < this._conquestBuckets.length; i += 2)
      total += this._conquestBuckets[i];
    return total;
  }
  conquests(): readonly TileRef[] {
    return this._conquestTiles;
  }
  clearConquests() {
    this._conquestTiles = [];
    this._conquestTicks = [];
    this._conquestBuckets = [];
  }
  /** Test wells drilled so far (found or not). */
  oilSearches(): number {
    return this._oilSearches;
  }
  addOilSearch() {
    this._oilSearches++;
  }

  lastRebellionTick(): number {
    return this._lastRebellionTick;
  }
  setLastRebellionTick(tick: number) {
    this._lastRebellionTick = tick;
  }

  // --- snapshot ---
  snapshot(w: SnapshotWriter): SibauPlayerStateData {
    return {
      government: this._government,
      capital: w.unitOrNull(this._capital),
      capitalLost: this._capitalLost,
      research: this._research,
      techs: this._techs,
      exhaustion: this._exhaustion,
      overlord: w.playerOrNull(this._overlord),
      vassalDemands: this._vassalDemands.map((d) => ({
        from: w.player(d.from),
        expiresAt: d.expiresAt,
      })),
      conquestTiles: [...this._conquestTiles],
      conquestTicks: [...this._conquestTicks],
      conquestBuckets: [...this._conquestBuckets],
      lastRebellionTick: this._lastRebellionTick,
      oilSearches: this._oilSearches,
    };
  }

  static restore(s: SibauPlayerStateData, r: SnapshotReader): SibauPlayerState {
    const state = new SibauPlayerState();
    state._government = s.government;
    state._capital = r.unitOrNull(s.capital);
    state._capitalLost = s.capitalLost;
    state._research = s.research;
    state._techs = s.techs;
    state._exhaustion = s.exhaustion;
    state._overlord = r.playerOrNull(s.overlord);
    state._vassalDemands = s.vassalDemands.map((d) => ({
      from: r.player(d.from),
      expiresAt: d.expiresAt,
    }));
    state._conquestTiles = [...s.conquestTiles];
    state._conquestTicks = [...s.conquestTicks];
    state._conquestBuckets = [...s.conquestBuckets];
    state._lastRebellionTick = s.lastRebellionTick;
    state._oilSearches = s.oilSearches;
    return state;
  }
}

export const SibauPlayerStateSchema = z.object({
  government: z.enum(Government).nullable(),
  capital: zRef().nullable(),
  capitalLost: z.boolean(),
  research: zNum(),
  techs: zInt(),
  exhaustion: zNum(),
  overlord: zPlayerRef().nullable(),
  vassalDemands: z.array(z.object({ from: zPlayerRef(), expiresAt: zInt() })),
  conquestTiles: z.array(zTile()),
  conquestTicks: z.array(zInt()),
  conquestBuckets: z.array(zInt()),
  lastRebellionTick: zInt(),
  oilSearches: zInt(),
});
export type SibauPlayerStateData = z.infer<typeof SibauPlayerStateSchema>;
