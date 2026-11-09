import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DisasterKind,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zRandom,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, isUnit, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

const KINDS: readonly DisasterKind[] = [
  "earthquake",
  "wildfire",
  "tsunami",
  "goldrush",
];

/** Zone radius per disaster, in tiles. */
export const DISASTER_RADIUS: Record<DisasterKind, number> = {
  earthquake: 22,
  wildfire: 25,
  tsunami: 25,
  goldrush: 30,
};

/** Message keys, written out so the translation check can find them. */
const WARNING_MESSAGE: Record<DisasterKind, string> = {
  earthquake: "events_display.disaster_earthquake_warning",
  wildfire: "events_display.disaster_wildfire_warning",
  tsunami: "events_display.disaster_tsunami_warning",
  goldrush: "events_display.disaster_goldrush_warning",
};
const HIT_MESSAGE: Partial<Record<DisasterKind, string>> = {
  earthquake: "events_display.disaster_earthquake_hit",
  wildfire: "events_display.disaster_wildfire_hit",
  tsunami: "events_display.disaster_tsunami_hit",
};

/** Gold a gold rush pays per owned tile in its zone, every second. */
export const GOLD_RUSH_GOLD_PER_TILE_PER_SECOND = 4n;

const SHIP_TYPES = [
  UnitType.TransportShip,
  UnitType.Warship,
  UnitType.TradeShip,
] as const;

interface ActiveDisaster {
  id: number;
  kind: DisasterKind;
  tile: TileRef;
  phase: "warning" | "active";
  /** Tick the current phase ends: the strike for "warning", the end for "active". */
  phaseEndsAt: number;
}

/**
 * Sibau Wars: natural disasters. One execution per game picks, at random
 * intervals, a disaster and a spot on someone's land, warns everyone, then
 * strikes:
 *
 * - earthquake: wrecks or downgrades buildings in the zone
 * - wildfire / plague: kills part of the troops of everyone with land there
 * - tsunami: on a coast; sinks ships and wrecks ports and shore buildings
 * - gold rush: for a minute, pays gold to whoever owns land in the zone
 *
 * Everything is driven by a PseudoRandom seeded from the game id, so every
 * client simulates the same disasters.
 */
export class DisasterExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private nextTick: number | null = null;
  private current: ActiveDisaster | null = null;
  private nextId = 1;

  /** `kinds` limits which disasters can happen (all of them by default). */
  constructor(
    seed: number,
    private kinds: readonly DisasterKind[] = KINDS,
  ) {
    this.random = new PseudoRandom(seed);
  }

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (this.mg.inSpawnPhase()) return;
    const config = this.mg.config();

    this.nextTick ??= ticks + config.disasterFirstDelayTicks();

    if (this.current !== null) {
      const d = this.current;
      if (d.phase === "active") {
        // Pay out once a second while a gold rush lasts.
        if ((ticks - d.phaseEndsAt) % 10 === 0) this.payGoldRush(d);
      }
      if (ticks < d.phaseEndsAt) return;
      if (d.phase === "warning") {
        this.strike(d, ticks);
      } else {
        this.end(d);
      }
      return;
    }

    if (ticks >= this.nextTick) {
      this.startNext(ticks);
      const { min, max } = config.disasterIntervalTicks();
      this.nextTick = ticks + this.random.nextInt(min, max + 1);
    }
  }

  private startNext(ticks: number) {
    let kind = this.kinds[this.random.nextInt(0, this.kinds.length)];
    let tile = this.pickTile(kind === "tsunami");
    if (tile === null && kind === "tsunami") {
      // No owned coast on this map (or none left): shake the land instead.
      kind = "earthquake";
      tile = this.pickTile(false);
    }
    if (tile === null) return; // nobody owns land worth hitting yet

    const d: ActiveDisaster = {
      id: this.nextId++,
      kind,
      tile,
      phase: "warning",
      phaseEndsAt: ticks + this.mg.config().disasterWarningTicks(),
    };
    this.current = d;
    this.emit(d, "warning");

    const owner = this.mg.owner(tile);
    if (owner.isPlayer()) {
      this.mg.displayMessage(
        WARNING_MESSAGE[kind],
        MessageType.NATURAL_DISASTER,
        null,
        undefined,
        { name: owner.displayName() },
        undefined,
        owner.id(),
      );
    }
  }

  /** A random tile of land owned by a living player (on a coast if asked). */
  private pickTile(shore: boolean): TileRef | null {
    const w = this.mg.width();
    const h = this.mg.height();
    for (let attempt = 0; attempt < 400; attempt++) {
      const tile = this.mg.ref(
        this.random.nextInt(0, w),
        this.random.nextInt(0, h),
      );
      if (!this.mg.isLand(tile)) continue;
      if (shore && !this.mg.isShore(tile)) continue;
      const owner = this.mg.owner(tile);
      if (owner.isPlayer() && owner.isAlive()) return tile;
    }
    return null;
  }

  private strike(d: ActiveDisaster, ticks: number) {
    switch (d.kind) {
      case "earthquake":
        this.earthquake(d);
        break;
      case "wildfire":
        this.wildfire(d);
        break;
      case "tsunami":
        this.tsunami(d);
        break;
      case "goldrush":
        d.phase = "active";
        d.phaseEndsAt = ticks + this.mg.config().goldRushTicks();
        this.emit(d, "active");
        this.payGoldRush(d);
        return;
    }
    this.end(d);
  }

  private end(d: ActiveDisaster) {
    this.emit(d, "end");
    this.current = null;
  }

  private radius(d: ActiveDisaster): number {
    return DISASTER_RADIUS[d.kind];
  }

  private structuresIn(d: ActiveDisaster): Unit[] {
    return this.mg
      .nearbyUnits(d.tile, this.radius(d), Structures.types, undefined, true)
      .map(({ unit }) => unit)
      .filter((u) => isUnit(u) && u.isActive());
  }

  /** Lose a level, or the whole building if it has only one. */
  private wreck(u: Unit, counts: Map<Player, number>) {
    const owner = u.owner();
    if (u.level() > 1) {
      u.decreaseLevel();
    } else {
      u.delete(true);
    }
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }

  private earthquake(d: ActiveDisaster) {
    const hit = new Map<Player, number>();
    for (const u of this.structuresIn(d)) {
      // About half the buildings ride it out.
      if (this.random.nextInt(0, 10) < 5) continue;
      this.wreck(u, hit);
    }
    this.notifyHit(d, hit);
  }

  private wildfire(d: ActiveDisaster) {
    const tilesIn = this.ownedTilesInZone(d);
    const hit = new Map<Player, number>();
    for (const [player, inZone] of tilesIn) {
      const share = inZone / Math.max(1, player.numTilesOwned());
      // Scales with how much of your land burns: a sliver costs ~2%.
      const fraction = Math.min(0.3, 0.02 + 0.5 * share);
      const lost = player.removeTroops(Math.floor(player.troops() * fraction));
      hit.set(player, Math.floor(lost));
    }
    this.notifyHit(d, hit);
  }

  private tsunami(d: ActiveDisaster) {
    for (const { unit } of this.mg.nearbyUnits(
      d.tile,
      this.radius(d),
      SHIP_TYPES,
    )) {
      if (isUnit(unit) && unit.isActive()) unit.delete(true);
    }
    const hit = new Map<Player, number>();
    for (const u of this.structuresIn(d)) {
      // Ports always take the wave; other buildings only on the shore.
      if (u.type() === UnitType.Port || this.mg.isShore(u.tile())) {
        this.wreck(u, hit);
      }
    }
    this.notifyHit(d, hit);
  }

  private payGoldRush(d: ActiveDisaster) {
    for (const [player, inZone] of this.ownedTilesInZone(d)) {
      player.addGold(BigInt(inZone) * GOLD_RUSH_GOLD_PER_TILE_PER_SECOND);
    }
  }

  /** Players owning land in the zone, with how many of its tiles they hold. */
  private ownedTilesInZone(d: ActiveDisaster): Map<Player, number> {
    const counts = new Map<Player, number>();
    const r = this.radius(d);
    const r2 = r * r;
    const cx = this.mg.x(d.tile);
    const cy = this.mg.y(d.tile);
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(this.mg.width() - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(this.mg.height() - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        const owner = this.mg.owner(this.mg.ref(x, y));
        if (owner.isPlayer()) counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
    }
    return counts;
  }

  private notifyHit(d: ActiveDisaster, hit: Map<Player, number>) {
    const message = HIT_MESSAGE[d.kind];
    if (message === undefined) return;
    for (const [player, count] of hit) {
      if (count <= 0) continue;
      this.mg.displayMessage(
        message,
        MessageType.NATURAL_DISASTER,
        player.id(),
        undefined,
        { count },
      );
    }
  }

  private emit(d: ActiveDisaster, phase: "warning" | "active" | "end") {
    this.mg.addUpdate({
      type: GameUpdateType.DisasterEvent,
      id: d.id,
      kind: d.kind,
      tile: d.tile,
      radius: this.radius(d),
      phase,
    });
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DisasterExecutionSnapshot.write({
      active: this.active,
      random: w.random(this.random),
      nextTick: this.nextTick,
      current: this.current === null ? null : { ...this.current },
      nextId: this.nextId,
      kinds: [...this.kinds],
    });
  }

  restoreSnapshot(s: DisasterState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = r.game;
    this.random = r.random(s.random);
    this.nextTick = s.nextTick;
    this.current = s.current === null ? null : { ...s.current };
    this.nextId = s.nextId;
    this.kinds = s.kinds;
  }
}

const DisasterStateSchema = z.object({
  active: z.boolean(),
  random: zRandom(),
  nextTick: zInt().nullable(),
  current: z
    .object({
      id: zInt(),
      kind: z.enum(["earthquake", "wildfire", "tsunami", "goldrush"]),
      tile: zTile(),
      phase: z.enum(["warning", "active"]),
      phaseEndsAt: zInt(),
    })
    .nullable(),
  nextId: zInt(),
  kinds: z.array(z.enum(["earthquake", "wildfire", "tsunami", "goldrush"])),
});
type DisasterState = z.infer<typeof DisasterStateSchema>;

export const DisasterExecutionSnapshot = execSnapshotType({
  name: "Disaster",
  version: 1,
  schema: DisasterStateSchema,
  cls: () => DisasterExecution,
});
