import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  MessageType,
  PlayerID,
  PlayerType,
  Relation,
  TerrainType,
  TerraNullius,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { assertNever } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { AttackLogicInput } from "../configuration/EngineConfig";
import { Attack, Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { FlatBinaryHeap } from "./utils/FlatBinaryHeap"; // adjust path if needed

const malusForRetreat = 25;

/**
 * Sibau Wars precise attacks: extra queue delay per tile of distance from
 * the current aim point. Tiles toward the aim are taken first; the sides of
 * the front follow later, so it widens slowly instead of all at once.
 */
const DIRECTIONAL_PULL = 1.5;
/**
 * Precise attacks move as if their front were at least this wide: the army
 * is concentrated, so it pushes forward faster than a broad attack (attack
 * speed otherwise grows with the width of the front).
 */
const DIRECTIONAL_MIN_FRONT = 30;
/**
 * Precise attacks only take land in a corridor around their route: this
 * many tiles either side at first, one more every CORRIDOR_WIDEN_TICKS, up
 * to CORRIDOR_MAX_HALF_WIDTH. A full corridor waits to widen; at full width
 * the attack is over and its troops go home.
 */
const CORRIDOR_START_HALF_WIDTH = 5;
const CORRIDOR_WIDEN_TICKS = 25;
const CORRIDOR_MAX_HALF_WIDTH = 30;
/** Within this many tiles of a route point, the army moves on to the next. */
const WAYPOINT_REACHED = 4;
/** Squared distance from point p to the segment a-b. */
function segmentDistSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

export class AttackExecution implements Execution {
  private active: boolean = true;
  private toConquer = new FlatBinaryHeap();

  private random = new PseudoRandom(123);

  private target: Player | TerraNullius;

  private mg: Game;
  // Direct GameMap reference to skip the Game delegation hop in hot loops.
  private map: GameMap;

  private attack: Attack | null = null;

  // Cached smallIDs for integer owner comparisons in hot loops.
  private ownerSmallID: number;
  private targetSmallID: number;
  // Reusable neighbor buffers to avoid closures/allocation in hot loops.
  private nbuf: TileRef[] = [0, 0, 0, 0];
  private nbuf2: TileRef[] = [0, 0, 0, 0];

  constructor(
    private startTroops: number | null = null,
    private _owner: Player,
    private _targetID: PlayerID | null,
    private sourceTile: TileRef | null = null,
    private removeTroops: boolean = true,
    // Sibau Wars: aim point(s) of a precise attack; null = classic attack.
    private waypoints: TileRef[] | null = null,
  ) {}

  // Sibau Wars: which waypoint the attack is heading for.
  private waypointIndex = 0;
  // Sibau Wars: tiles this precise attack took, to re-aim from them.
  private conquered: TileRef[] = [];
  // Sibau Wars: where the route starts (our border) and when it began.
  private routeStart: TileRef | null = null;
  private startTick = 0;

  public targetID(): PlayerID | null {
    return this._targetID;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!this.active) {
      return;
    }
    this.mg = mg;
    this.map = mg.map();

    if (this._targetID !== null && !mg.hasPlayer(this._targetID)) {
      console.warn(`target ${this._targetID} not found`);
      this.active = false;
      return;
    }

    this.target =
      this._targetID === this.mg.terraNullius().id()
        ? mg.terraNullius()
        : mg.player(this._targetID);
    this.ownerSmallID = this._owner.smallID();
    this.targetSmallID = this.target.smallID();

    if (this._owner === this.target) {
      console.error(`Player ${this._owner} cannot attack itself`);
      this.active = false;
      return;
    }

    // ALLIANCE CHECK — block attacks on friendly (ally or same team)
    if (this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (this._owner.isFriendly(targetPlayer)) {
        console.warn(
          `${this._owner.displayName()} cannot attack ${targetPlayer.displayName()} because they are friendly (allied or same team)`,
        );
        this.active = false;
        return;
      }
    }

    if (this.target && this.target.isPlayer()) {
      const targetPlayer = this.target as Player;
      if (
        targetPlayer.type() !== PlayerType.Bot &&
        this._owner.type() !== PlayerType.Bot
      ) {
        // Don't let bots embargo since they can't trade anyway.
        targetPlayer.addEmbargo(this._owner, true);
        this.rejectIncomingAllianceRequests(targetPlayer);
      }
    }

    if (this.target.isPlayer() && !this._owner.canAttackPlayer(this.target)) {
      this.active = false;
      return;
    }

    this.startTroops ??= this.mg
      .config()
      .attackAmount(this._owner, this.target);
    if (this.removeTroops) {
      this.startTroops = Math.min(this._owner.troops(), this.startTroops);
      // Take the amount that was actually deducted, not the amount asked for.
      // removeTroops() floors, so a fractional request leaves the attack
      // holding troops the owner never paid for — and retreat refunds the
      // combined total, turning the leftover fractions into free troops.
      this.startTroops = this._owner.removeTroops(this.startTroops);
    }
    this.attack = this._owner.createAttack(
      this.target,
      this.startTroops,
      this.sourceTile,
      new Set<TileRef>(),
    );

    if (this.waypoints !== null && this.waypoints.length > 0) {
      this.attack.setDirectional(true);
      this.startTick = ticks;
      this.skipReachedWaypoints();
      this.routeStart = this.directionalStart();
      if (this.routeStart !== null) this.addNeighbors(this.routeStart);
    } else if (this.sourceTile !== null) {
      this.addNeighbors(this.sourceTile);
    } else {
      this.refreshToConquer();
    }

    // Record stats
    this.mg.stats().attack(this._owner, this.target, this.startTroops);

    for (const incoming of this._owner.incomingAttacks()) {
      if (incoming.attacker() === this.target) {
        // Target has opposing attack, cancel them out
        if (incoming.troops() > this.attack.troops()) {
          incoming.setTroops(incoming.troops() - this.attack.troops());
          this.attack.delete();
          this.active = false;
          return;
        } else {
          this.attack.setTroops(this.attack.troops() - incoming.troops());
          incoming.delete();
        }
      }
    }
    for (const outgoing of this._owner.outgoingAttacks()) {
      if (
        outgoing !== this.attack &&
        outgoing.target() === this.attack.target() &&
        // Boat attacks (sourceTile is not null) are not combined with other attacks
        this.attack.sourceTile() === null &&
        // Sibau Wars: precise attacks are steered, so they never merge.
        !this.attack.isDirectional() &&
        !outgoing.isDirectional()
      ) {
        this.attack.setTroops(this.attack.troops() + outgoing.troops());
        outgoing.delete();
      }
    }

    // Nothing next to the owner to conquer (no wilderness around them, or a
    // target they don't border): the attack doesn't happen. Held until the
    // next tick, the troops would sit out the regen step and come back free,
    // so one such attack per tick kept regen at its peak rate and refunded
    // past maxTroops.
    if (this.toConquer.size() === 0) {
      this.retreat();
      return;
    }

    // Only now is it known how large the attack the defender actually faces
    // is: a big assault is built by clicking repeatedly, and each click's
    // execution absorbs the earlier ones above. Recorded before the loops it
    // would measure one click, and would count an attack that cancelled out
    // and never landed.
    this.mg.stats().attackMaxIncoming(this.target, this.attack.troops());

    if (!this.target.isPlayer()) return;
    const difficulty = this.mg.config().gameConfig().difficulty;
    // Hitting back at whoever just attacked us doesn't anger them, except on Easy
    if (
      difficulty !== Difficulty.Easy &&
      this._owner.relation(this.target) === Relation.Hostile
    ) {
      return;
    }
    let relationChange: number;
    switch (difficulty) {
      case Difficulty.Easy:
        relationChange = -60;
        break;
      case Difficulty.Medium:
        relationChange = -70;
        break;
      case Difficulty.Hard:
        relationChange = -80;
        break;
      case Difficulty.Impossible:
        relationChange = -100;
        break;
      default:
        assertNever(difficulty);
    }
    this.target.updateRelation(this._owner, relationChange);
  }

  /** The aim point a precise attack is heading for. */
  private aim(): TileRef | null {
    if (this.waypoints === null || this.waypoints.length === 0) return null;
    return this.waypoints[this.waypointIndex];
  }

  /**
   * Route points that are no longer the target's land (already taken, or
   * never were, like points drawn on your own side) are passed by.
   */
  private skipReachedWaypoints(): boolean {
    if (this.waypoints === null) return false;
    let moved = false;
    while (
      this.waypointIndex < this.waypoints.length - 1 &&
      this.map.ownerID(this.waypoints[this.waypointIndex]) !==
        this.targetSmallID
    ) {
      this.waypointIndex++;
      moved = true;
    }
    return moved;
  }

  /** Our border tile next to the target that is closest to the first aim. */
  private directionalStart(): TileRef | null {
    const aim = this.aim();
    if (aim === null) return null;
    let best: TileRef | null = null;
    let bestDist = Infinity;
    this._owner.borderTiles().forEach((tile) => {
      const n = this.map.neighbors4(tile, this.nbuf);
      let touchesTarget = false;
      for (let i = 0; i < n; i++) {
        const nb = this.nbuf[i];
        if (
          this.map.ownerID(nb) === this.targetSmallID &&
          this.map.isLand(nb) &&
          !this.map.isImpassable(nb)
        ) {
          touchesTarget = true;
          break;
        }
      }
      if (!touchesTarget) return;
      const d = this.map.euclideanDistSquared(tile, aim);
      if (d < bestDist) {
        bestDist = d;
        best = tile;
      }
    });
    return best;
  }

  /** After taking `tile`, move on along the route if a point was reached. */
  private advanceRoute(tile: TileRef) {
    if (this.waypoints === null || this.attack === null) return;
    this.conquered.push(tile);
    let moved = false;
    const aim = this.aim();
    if (
      aim !== null &&
      this.waypointIndex < this.waypoints.length - 1 &&
      this.map.euclideanDistSquared(tile, aim) <=
        WAYPOINT_REACHED * WAYPOINT_REACHED
    ) {
      this.waypointIndex++;
      moved = true;
    }
    if (this.skipReachedWaypoints()) moved = true;
    // Re-aim: queued tiles carry priorities biased toward the old point,
    // and the corridor now includes the next leg.
    if (moved) this.reseedFromConquered();
  }

  private reseedFromConquered() {
    if (this.attack === null) return;
    this.toConquer.clear();
    this.attack.clearBorder();
    if (this.routeStart !== null) this.addNeighbors(this.routeStart);
    for (const t of this.conquered) {
      if (this.map.ownerID(t) === this.ownerSmallID) this.addNeighbors(t);
    }
  }

  private corridorHalfWidth(): number {
    const grown = Math.floor(
      (this.mg.ticks() - this.startTick) / CORRIDOR_WIDEN_TICKS,
    );
    return Math.min(CORRIDOR_MAX_HALF_WIDTH, CORRIDOR_START_HALF_WIDTH + grown);
  }

  /** Is `tile` within the corridor around the route legs reached so far? */
  private inCorridor(tile: TileRef): boolean {
    if (this.waypoints === null || this.routeStart === null) return true;
    const w = this.corridorHalfWidth();
    const w2 = w * w;
    const px = this.map.x(tile);
    const py = this.map.y(tile);
    let ax = this.map.x(this.routeStart);
    let ay = this.map.y(this.routeStart);
    for (let i = 0; i <= this.waypointIndex; i++) {
      const bx = this.map.x(this.waypoints[i]);
      const by = this.map.y(this.waypoints[i]);
      if (segmentDistSquared(px, py, ax, ay, bx, by) <= w2) return true;
      ax = bx;
      ay = by;
    }
    return false;
  }

  private refreshToConquer() {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    this.toConquer.clear();
    this.attack.clearBorder();
    // forEach over the dense storage — the values() generator showed up in long-game profiles
    this._owner.borderTiles().forEach((tile) => this.addNeighbors(tile));
  }

  private retreat(malusPercent = 0) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const deaths = this.attack.troops() * (malusPercent / 100);
    if (deaths) {
      this.mg.displayMessage(
        "events_display.attack_cancelled_retreat",
        MessageType.ATTACK_CANCELLED,
        this._owner.id(),
        undefined,
        { troops: renderTroops(deaths) },
      );
    }
    if (this.removeTroops === false && this.sourceTile === null) {
      // startTroops are always added to attack troops at init but not always removed from owner troops
      // subtract startTroops from attack troops so we don't give back startTroops to owner that were never removed
      // boat attacks (sourceTile !== null) are the exception: troops were removed at departure and must be returned after attack still
      this.attack.setTroops(this.attack.troops() - (this.startTroops ?? 0));
    }

    const survivors = this.attack.troops() - deaths;
    this._owner.addTroops(survivors);
    this.attack.delete();
    this.active = false;

    // Not all retreats are canceled attacks
    if (this.attack.retreated()) {
      // Record stats
      this.mg.stats().attackCancel(this._owner, this.target, survivors);
    }
  }

  tick(ticks: number) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }
    let troopCount = this.attack.troops(); // cache troop count
    const targetIsPlayer = this.target.isPlayer(); // cache target type
    const targetPlayer = targetIsPlayer ? (this.target as Player) : null; // cache target player

    // Must come before the retreat refund: another attack's init can absorb or
    // cancel this one on the tick its retreat completes, and refunding troops
    // that were already handed over duplicates them.
    if (!this.attack.isActive()) {
      this.active = false;
      return;
    }

    if (this.attack.retreated()) {
      if (targetIsPlayer) {
        this.retreat(malusForRetreat);
      } else {
        this.retreat();
      }
      this.active = false;
      return;
    }

    if (this.attack.retreating()) {
      return;
    }

    if (targetPlayer && this._owner.isFriendly(targetPlayer)) {
      // In this case a new alliance was created AFTER the attack started.
      this.retreat();
      return;
    }

    if (
      this.attack.isDirectional() &&
      ticks > this.startTick &&
      (ticks - this.startTick) % CORRIDOR_WIDEN_TICKS === 0 &&
      this.corridorHalfWidth() <= CORRIDOR_MAX_HALF_WIDTH
    ) {
      this.reseedFromConquered();
    }
    let borderSize = this.attack.borderSize() + this.random.nextInt(0, 5);
    if (this.attack.isDirectional()) {
      borderSize = Math.max(borderSize, DIRECTIONAL_MIN_FRONT);
    }
    // Each tile consumes a fraction of the tick; conquer until it is spent.
    let tickBudget = 1;

    while (tickBudget > 0) {
      if (troopCount < 1) {
        this.attack.delete();
        this.active = false;
        return;
      }

      if (this.toConquer.size() === 0) {
        if (
          this.attack.isDirectional() &&
          this.corridorHalfWidth() < CORRIDOR_MAX_HALF_WIDTH
        ) {
          // Corridor taken: hold position until it widens.
          return;
        }
        this.refreshToConquer();
        this.retreat();
        return;
      }

      const tileToConquer = this.toConquer.dequeue();
      this.attack.removeBorderTile(tileToConquer);

      let onBorder = false;
      const numNeighbors = this.map.neighbors4(tileToConquer, this.nbuf);
      for (let i = 0; i < numNeighbors; i++) {
        if (this.map.ownerID(this.nbuf[i]) === this.ownerSmallID) {
          onBorder = true;
          break;
        }
      }
      if (this.map.ownerID(tileToConquer) !== this.targetSmallID || !onBorder) {
        continue;
      }
      if (
        !this.map.isLand(tileToConquer) ||
        this.map.isImpassable(tileToConquer)
      ) {
        continue;
      }
      this.addNeighbors(tileToConquer);
      const { attackerTroopLoss, defenderTroopLoss, tickFraction } = this.mg
        .config()
        .attackLogic(
          this.attackLogicInput(troopCount, tileToConquer, borderSize),
        );
      tickBudget -= tickFraction;
      troopCount -= attackerTroopLoss;
      this.attack.setTroops(troopCount);
      if (targetPlayer) {
        targetPlayer.removeTroops(defenderTroopLoss);
      }
      this._owner.conquer(tileToConquer);
      this.advanceRoute(tileToConquer);
      this.handleDeadDefender();
    }
  }

  private attackLogicInput(
    attackTroops: number,
    tile: TileRef,
    borderSize: number,
  ): AttackLogicInput {
    const defender = this.target.isPlayer() ? this.target : null;
    // Same test as scanning nearbyUnits() for a post owned by the defender
    // (active, not under construction, within range), without building a
    // result array per conquered tile — this runs for every tile of every
    // attack on the map.
    const defenderHasDefensePost =
      defender !== null &&
      this.mg.hasUnitNearby(
        tile,
        this.mg.config().defensePostRange(),
        UnitType.DefensePost,
        defender.id(),
      ) &&
      // Sibau Wars: posts switched off give no bonus. The cheap
      // check above stays first; this predicate scan only runs near a post.
      this.mg.anyUnitNearby(
        tile,
        this.mg.config().defensePostRange(),
        [UnitType.DefensePost],
        (post) => !post.isDisabled(),
        defender.id(),
      );
    // Sibau Wars: one of the attacker's tanks nearby speeds the attack up.
    const attackerHasTank =
      this._owner.unitCount(UnitType.Tank) > 0 &&
      this.mg.hasUnitNearby(
        tile,
        this.mg.config().tankAttackBoostRange(),
        UnitType.Tank,
        this._owner.id(),
      );
    const config = this.mg.config();
    return {
      attackerHasTank,
      attackerSchools: config.effectiveSchools(this._owner),
      defenderSchools: this.target.isPlayer()
        ? config.effectiveSchools(this.target)
        : 0,
      terrain: this.map.terrainType(tile),
      attackTroops,
      attacker: {
        type: this._owner.type(),
        numTiles: this._owner.numTilesOwned(),
      },
      defender:
        defender === null
          ? null
          : {
              type: defender.type(),
              numTiles: defender.numTilesOwned(),
              troops: defender.troops(),
              isTraitor: defender.isTraitor(),
              isDisconnectedTeammate:
                defender.isDisconnected() && this._owner.isOnSameTeam(defender),
            },
      defenderHasDefensePost,
      falloutRatio: this.mg.hasFallout(tile)
        ? this.mg.numTilesWithFallout() / this.mg.numLandTiles()
        : null,
      borderSize,
    };
  }

  private rejectIncomingAllianceRequests(target: Player) {
    const request = this._owner
      .incomingAllianceRequests()
      .find((ar) => ar.requestor() === target);
    if (request !== undefined) {
      request.reject();
    }
  }

  private addNeighbors(tile: TileRef) {
    if (this.attack === null) {
      throw new Error("Attack not initialized");
    }

    const tickNow = this.mg.ticks(); // cache tick

    const numNeighbors = this.map.neighbors4(tile, this.nbuf);
    for (let i = 0; i < numNeighbors; i++) {
      const neighbor = this.nbuf[i];
      if (
        this.map.isWater(neighbor) ||
        this.map.isImpassable(neighbor) ||
        this.map.ownerID(neighbor) !== this.targetSmallID ||
        !this.inCorridor(neighbor)
      ) {
        continue;
      }
      this.attack.addBorderTile(neighbor);
      let numOwnedByMe = 0;
      const numInner = this.map.neighbors4(neighbor, this.nbuf2);
      for (let j = 0; j < numInner; j++) {
        if (this.map.ownerID(this.nbuf2[j]) === this.ownerSmallID) {
          numOwnedByMe++;
        }
      }

      let mag: number;
      switch (this.map.terrainType(neighbor)) {
        case TerrainType.Plains:
          mag = 1;
          break;
        case TerrainType.Highland:
          mag = 1.5;
          break;
        case TerrainType.Mountain:
          mag = 2;
          break;
        default:
          mag = 0;
          break;
      }

      const aim = this.aim();
      const pull =
        aim === null
          ? 0
          : Math.sqrt(this.map.euclideanDistSquared(neighbor, aim)) *
            DIRECTIONAL_PULL;
      const priority =
        (this.random.nextInt(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) +
        tickNow +
        pull;

      this.toConquer.enqueue(neighbor, priority);
    }
  }

  private handleDeadDefender() {
    if (!(this.target.isPlayer() && this.target.numTilesOwned() < 100)) return;
    const target: Player = this.target;

    this.mg.conquerPlayer(this._owner, target);

    const MAX_PASSES = 100;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let progressed = false;
      for (const tile of target.tiles()) {
        let borders = false;
        this.mg.forEachNeighbor(tile, (t) => {
          if (!borders && this.mg.owner(t) === this._owner) {
            borders = true;
          }
        });
        if (borders) {
          this._owner.conquer(tile);
          progressed = true;
        } else {
          let captured = false;
          this.mg.forEachNeighbor(tile, (neighbor) => {
            if (captured) return;
            const no = this.mg.owner(neighbor);
            if (no.isPlayer() && no !== target && !no.isFriendly(target)) {
              this.mg.player(no.id()).conquer(tile);
              captured = true;
            }
          });
          if (captured) progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  owner(): Player {
    return this._owner;
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AttackExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      toConquer: this.toConquer.getState(),
      random: w.random(this.random),
      target: this.target === undefined ? null : w.owner(this.target),
      attack: this.attack === null ? null : w.attack(this.attack),
      startTroops: this.startTroops,
      owner: w.player(this._owner),
      targetID: this._targetID,
      sourceTile: this.sourceTile,
      removeTroops: this.removeTroops,
      waypoints: this.waypoints,
      waypointIndex: this.waypointIndex,
      conquered: this.conquered,
      routeStart: this.routeStart,
      startTick: this.startTick,
    });
  }

  restoreSnapshot(s: AttackExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    this.toConquer = FlatBinaryHeap.fromState(s.toConquer);
    this.random = r.random(s.random);
    if (s.initialized) {
      this.mg = r.game;
      this.map = r.game.map();
    }
    if (s.target !== null) {
      this.target = r.owner(s.target);
      // Set together with target in init(); small ids are the stored refs.
      this.ownerSmallID = s.owner;
      this.targetSmallID = s.target;
    }
    this.attack = s.attack === null ? null : r.attack(s.attack);
    // Scratch buffers, overwritten before every read.
    this.nbuf = [0, 0, 0, 0];
    this.nbuf2 = [0, 0, 0, 0];
    this.startTroops = s.startTroops;
    this._owner = r.player(s.owner);
    this._targetID = s.targetID;
    this.sourceTile = s.sourceTile;
    this.removeTroops = s.removeTroops;
    this.waypoints = s.waypoints;
    this.waypointIndex = s.waypointIndex;
    this.conquered = s.conquered;
    this.routeStart = s.routeStart;
    this.startTick = s.startTick;
  }
}

const AttackExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  // Exact heap layout: ties between equal priorities dequeue by position.
  toConquer: z.object({
    pri: z.custom<Float32Array>(
      (v) => v instanceof Float32Array,
      "expected float32s",
    ),
    tiles: zTiles(),
    capacity: zInt(),
  }),
  random: zRandom(),
  /** Null until init() resolves the target. */
  target: zPlayerRef().nullable(),
  attack: zRef().nullable(),
  startTroops: zNum().nullable(),
  owner: zPlayerRef(),
  targetID: z.string().nullable(),
  sourceTile: zTile().nullable(),
  removeTroops: z.boolean(),
  waypoints: z.array(zTile()).nullable(),
  waypointIndex: zInt(),
  conquered: z.array(zTile()),
  routeStart: zTile().nullable(),
  startTick: zInt(),
});
type AttackExecutionState = z.infer<typeof AttackExecutionStateSchema>;

export const AttackExecutionSnapshot = execSnapshotType({
  name: "Attack",
  version: 2,
  // v1 attacks predate Sibau Wars' precise attacks.
  migrations: {
    1: (d) => ({
      ...d,
      waypoints: null,
      waypointIndex: 0,
      conquered: [],
      routeStart: null,
      startTick: 0,
    }),
  },
  schema: AttackExecutionStateSchema,
  cls: () => AttackExecution,
});
