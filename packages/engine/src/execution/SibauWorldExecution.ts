import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerType,
  TerrainType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/** Fields at least this far apart. */
const OIL_FIELD_SPACING = 36;
const MIN_OIL_FIELDS = 3;
const MAX_OIL_FIELDS = 250;
/** Coalitions are re-checked this often. */
const COALITION_CHECK_TICKS = 100;
/** A coalition breaks up when the leader's lead drops below this. */
const COALITION_END_RATIO = 1.5;

/**
 * Sibau Wars: game-wide state. Everything here is derived from the seed and
 * the game, so it is rebuilt (not stored) when a snapshot loads, except the
 * coalition, which the execution stores.
 */
export interface SibauWorld {
  oilFields: readonly TileRef[];
  coalitionTarget: Player | null;
  coalitionMembers: ReadonlySet<Player>;
}

const worlds = new WeakMap<Game, SibauWorld>();

/** The game's Sibau state; games without the execution (tests) get fields from seed 0. */
export function sibauWorld(game: Game): SibauWorld {
  let world = worlds.get(game);
  if (world === undefined) {
    world = {
      oilFields: generateOilFields(game, 0),
      coalitionTarget: null,
      coalitionMembers: new Set(),
    };
    worlds.set(game, world);
  }
  return world;
}

/** Hidden oil fields: on plains or highlands (never mountains), spread out. */
export function generateOilFields(game: Game, seed: number): TileRef[] {
  const map = game.map();
  const random = new PseudoRandom(seed * 7919 + 17);
  const wanted = Math.max(
    MIN_OIL_FIELDS,
    Math.min(
      MAX_OIL_FIELDS,
      Math.round(map.numLandTiles() / game.config().landTilesPerOilField()),
    ),
  );
  const fields: TileRef[] = [];
  const w = map.width();
  const h = map.height();
  for (let attempt = 0; attempt < 30_000 && fields.length < wanted; attempt++) {
    const x = random.nextInt(0, w);
    const y = random.nextInt(0, h);
    const tile = map.ref(x, y);
    if (!map.isLand(tile) || map.isImpassable(tile)) continue;
    const terrain = map.terrainType(tile);
    if (terrain === TerrainType.Mountain) continue;
    // Highlands hold oil less often than plains.
    if (terrain === TerrainType.Highland && random.nextInt(0, 3) !== 0)
      continue;
    if (fields.some((f) => map.manhattanDist(f, tile) < OIL_FIELD_SPACING)) {
      continue;
    }
    fields.push(tile);
  }
  return fields;
}

/**
 * Sibau Wars: runs the game-wide systems: places the hidden oil fields and
 * forms and breaks coalitions of AI nations against a runaway leader.
 */
export class SibauWorldExecution implements Execution {
  private mg: Game;
  private world: SibauWorld & {
    coalitionTarget: Player | null;
    coalitionMembers: Set<Player>;
  };

  constructor(private seed: number) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    this.world = {
      oilFields: generateOilFields(mg, this.seed),
      coalitionTarget: null,
      coalitionMembers: new Set(),
    };
    worlds.set(mg, this.world);
  }

  tick(ticks: number): void {
    if (this.mg.inSpawnPhase() || ticks % COALITION_CHECK_TICKS !== 0) return;
    this.updateCoalition();
  }

  private updateCoalition() {
    const world = this.world;
    const contenders = this.mg
      .players()
      .filter((p) => p.isAlive() && p.type() !== PlayerType.Bot)
      .sort(
        (a, b) =>
          b.numTilesOwned() - a.numTilesOwned() || a.smallID() - b.smallID(),
      );
    const leader = contenders[0];
    const second = contenders[1];
    const target = world.coalitionTarget;

    if (target !== null) {
      const runnerUp = contenders.find((p) => p !== target);
      const lead =
        target.numTilesOwned() / Math.max(1, runnerUp?.numTilesOwned() ?? 0);
      if (!target.isAlive() || lead < COALITION_END_RATIO) {
        this.announce(
          "events_display.coalition_ended",
          "events_display.coalition_ended_you",
          target,
        );
        world.coalitionTarget = null;
        world.coalitionMembers = new Set();
      }
      return;
    }

    if (leader === undefined || second === undefined) return;
    const config = this.mg.config();
    const share = leader.numTilesOwned() / Math.max(1, this.mg.numLandTiles());
    const lead = leader.numTilesOwned() / Math.max(1, second.numTilesOwned());
    if (
      share < config.coalitionLandShare() ||
      lead < config.coalitionLeadRatio()
    ) {
      return;
    }
    const members = new Set(
      this.mg
        .players()
        .filter(
          (p) =>
            p.isAlive() &&
            p !== leader &&
            p.type() === PlayerType.Nation &&
            !p.isFriendly(leader),
        ),
    );
    if (members.size < 2) return;
    world.coalitionTarget = leader;
    world.coalitionMembers = members;
    this.announce(
      "events_display.coalition_formed",
      "events_display.coalition_formed_you",
      leader,
      members.size,
    );
  }

  /** Tells every human; the target gets the `youKey` version. */
  private announce(key: string, youKey: string, target: Player, count = 0) {
    for (const p of this.mg.players()) {
      if (p.type() !== PlayerType.Human) continue;
      this.mg.displayMessage(
        p === target ? youKey : key,
        MessageType.SIBAU_EVENT,
        p.id(),
        undefined,
        { name: target.displayName(), count },
        undefined,
        target.id(),
      );
    }
  }

  isActive(): boolean {
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return SibauWorldExecutionSnapshot.write({
      seed: this.seed,
      initialized: this.mg !== undefined,
      coalitionTarget: this.mg
        ? w.playerOrNull(this.world.coalitionTarget)
        : null,
      coalitionMembers: this.mg
        ? [...this.world.coalitionMembers].map((p) => w.player(p))
        : [],
    });
  }

  restoreSnapshot(s: SibauWorldState, r: SnapshotReader): void {
    this.seed = s.seed;
    if (!s.initialized) return;
    this.mg = r.game;
    this.world = {
      oilFields: generateOilFields(r.game, s.seed),
      coalitionTarget: r.playerOrNull(s.coalitionTarget),
      coalitionMembers: new Set(s.coalitionMembers.map((p) => r.player(p))),
    };
    worlds.set(r.game, this.world);
  }
}

const SibauWorldStateSchema = z.object({
  seed: zInt(),
  initialized: z.boolean(),
  coalitionTarget: zPlayerRef().nullable(),
  coalitionMembers: z.array(zPlayerRef()),
});
type SibauWorldState = z.infer<typeof SibauWorldStateSchema>;

export const SibauWorldExecutionSnapshot = execSnapshotType({
  name: "SibauWorld",
  version: 1,
  schema: SibauWorldStateSchema,
  cls: () => SibauWorldExecution,
});
