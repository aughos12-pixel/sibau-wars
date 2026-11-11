import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  Government,
  Tech,
  techInfo,
  techPrerequisite,
} from "@openfront/engine-api/game/Sibau";
import { renderNumber } from "@openfront/engine-lib/Format";
import { zInt, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { sibauWorld } from "./SibauWorldExecution";

/**
 * Sibau Wars: the one-shot player actions (government, research, oil
 * search, vassal demand and reply). Each does all its work in init().
 */
abstract class OneShot implements Execution {
  protected done = false;
  abstract init(mg: Game, ticks: number): void;
  tick(_ticks: number): void {}
  isActive(): boolean {
    return !this.done;
  }
  activeDuringSpawnPhase(): boolean {
    return true;
  }
  abstract snapshot(w: SnapshotWriter): ExecRecord;
}

function tell(
  mg: Game,
  player: Player,
  key: string,
  params?: Record<string, string | number>,
  focus?: Player,
) {
  mg.displayMessage(
    key,
    MessageType.SIBAU_EVENT,
    player.id(),
    undefined,
    params,
    undefined,
    focus?.id(),
  );
}

// --- Government ---------------------------------------------------------

/** Ticks after the spawn phase a player may still pick a government. */
export const GOVERNMENT_GRACE_TICKS = 300;

/** During the spawn phase (changeable), or once afterwards if none was picked. */
export function canPickGovernment(mg: Game, player: Player): boolean {
  return mg.inSpawnPhase() || player.sibauState().government() === null;
}

export class SetGovernmentExecution extends OneShot {
  constructor(
    private player: Player,
    private government: Government,
  ) {
    super();
  }

  init(mg: Game): void {
    this.done = true;
    if (!canPickGovernment(mg, this.player)) return;
    this.player.sibauState().setGovernment(this.government);
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return SetGovernmentSnapshot.write({
      player: w.player(this.player),
      government: this.government,
      done: this.done,
    });
  }

  restoreSnapshot(s: z.infer<typeof SetGovernmentSchema>, r: SnapshotReader) {
    this.player = r.player(s.player);
    this.government = s.government;
    this.done = s.done;
  }
}
const SetGovernmentSchema = z.object({
  player: zPlayerRef(),
  government: z.enum(Government),
  done: z.boolean(),
});
export const SetGovernmentSnapshot = execSnapshotType({
  name: "SetGovernment",
  version: 1,
  schema: SetGovernmentSchema,
  cls: () => SetGovernmentExecution,
});

// --- Research -----------------------------------------------------------

/** Whether `player` can learn `tech` right now (shared with the AI). */
export function canResearch(player: Player, tech: Tech): boolean {
  const state = player.sibauState();
  if (state.hasTech(tech)) return false;
  const pre = techPrerequisite(tech);
  if (pre !== null && !state.hasTech(pre)) return false;
  return state.research() >= techInfo(tech).cost;
}

export class ResearchExecution extends OneShot {
  constructor(
    private player: Player,
    private tech: Tech,
  ) {
    super();
  }

  init(_mg: Game): void {
    this.done = true;
    if (!this.player.isAlive() || !canResearch(this.player, this.tech)) return;
    this.player.sibauState().learn(this.tech);
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ResearchSnapshot.write({
      player: w.player(this.player),
      tech: this.tech,
      done: this.done,
    });
  }

  restoreSnapshot(s: z.infer<typeof ResearchSchema>, r: SnapshotReader) {
    this.player = r.player(s.player);
    this.tech = s.tech;
    this.done = s.done;
  }
}
const ResearchSchema = z.object({
  player: zPlayerRef(),
  tech: z.enum(Tech),
  done: z.boolean(),
});
export const ResearchSnapshot = execSnapshotType({
  name: "Research",
  version: 1,
  schema: ResearchSchema,
  cls: () => ResearchExecution,
});

// --- Oil ----------------------------------------------------------------

export type OilSearchProblem =
  | "not_your_land"
  | "not_enough_gold"
  | "already_found"
  | null;

/** Why `player` can't search at `tile` (null = it can). Shared with the client. */
export function oilSearchProblem(
  mg: Game,
  player: Player,
  tile: TileRef,
): OilSearchProblem {
  if (!mg.isValidRef(tile) || mg.owner(tile) !== player) return "not_your_land";
  if (player.gold() < mg.config().oilSearchCost()) return "not_enough_gold";
  if (foundFieldNear(mg, tile)) return "already_found";
  return null;
}

function foundFieldNear(mg: Game, tile: TileRef): boolean {
  return mg
    .nearbyUnits(tile, mg.config().oilSearchRadius(), UnitType.OilField)
    .some(({ unit }) => unit.isActive());
}

export class SearchOilExecution extends OneShot {
  constructor(
    private player: Player,
    private tile: TileRef,
  ) {
    super();
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.done = true;
    const player = this.player;
    if (!player.isAlive()) return;
    const problem = oilSearchProblem(mg, player, this.tile);
    if (problem !== null) {
      if (problem === "already_found") {
        tell(mg, player, "events_display.oil_already_found");
      }
      return;
    }
    const cost = mg.config().oilSearchCost();
    player.removeGold(cost);
    player.sibauState().addOilSearch();

    const radius = mg.config().oilSearchRadius();
    const found = sibauWorld(mg)
      .oilFields.filter(
        (f) => mg.euclideanDistSquared(f, this.tile) <= radius * radius,
      )
      .sort(
        (a, b) =>
          mg.euclideanDistSquared(a, this.tile) -
            mg.euclideanDistSquared(b, this.tile) || a - b,
      )[0];
    if (found === undefined) {
      tell(mg, player, "events_display.oil_not_found", {
        gold: renderNumber(cost),
      });
      return;
    }
    player.buildUnit(UnitType.OilField, found, {});
    tell(mg, player, "events_display.oil_found");
    for (const other of mg.players()) {
      if (other === player || other.type() !== PlayerType.Human) continue;
      tell(
        mg,
        other,
        "events_display.oil_found_other",
        {
          name: player.displayName(),
        },
        player,
      );
    }
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return SearchOilSnapshot.write({
      player: w.player(this.player),
      tile: this.tile,
      done: this.done,
    });
  }

  restoreSnapshot(s: z.infer<typeof SearchOilSchema>, r: SnapshotReader) {
    this.player = r.player(s.player);
    this.tile = s.tile;
    this.done = s.done;
  }
}
// tile is untrusted intent data (checked by oilSearchProblem).
const SearchOilSchema = z.object({
  player: zPlayerRef(),
  tile: zInt(),
  done: z.boolean(),
});
export const SearchOilSnapshot = execSnapshotType({
  name: "SearchOil",
  version: 1,
  schema: SearchOilSchema,
  cls: () => SearchOilExecution,
});

// --- Vassals ------------------------------------------------------------

/** Whether `overlord` may demand that `vassal` becomes its vassal. Shared with the client. */
export function canDemandVassal(overlord: Player, vassal: Player): boolean {
  if (overlord === vassal || !overlord.isAlive() || !vassal.isAlive()) {
    return false;
  }
  if (overlord.isVassalPartner(vassal)) return false;
  // A vassal can't take vassals of its own.
  if (overlord.sibauState().overlord() !== null) return false;
  if (vassal.sibauState().overlord() !== null) return false;
  return overlord.numTilesOwned() > vassal.numTilesOwned();
}

export function makeVassal(mg: Game, overlord: Player, vassal: Player) {
  vassal.sibauState().setOverlord(overlord);
  vassal.sibauState().removeVassalDemand(overlord);
  // Its own vassals go free.
  for (const p of mg.players()) {
    if (p.sibauState().overlord() === vassal) p.sibauState().setOverlord(null);
  }
  tell(
    mg,
    overlord,
    "events_display.vassal_gained",
    {
      name: vassal.displayName(),
    },
    vassal,
  );
  tell(
    mg,
    vassal,
    "events_display.vassal_became",
    {
      name: overlord.displayName(),
    },
    overlord,
  );
}

export class DemandVassalExecution extends OneShot {
  constructor(
    private overlord: Player,
    private targetID: string,
  ) {
    super();
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.done = true;
    if (!mg.hasPlayer(this.targetID)) return;
    const vassal = mg.player(this.targetID);
    if (!canDemandVassal(this.overlord, vassal)) return;

    if (vassal.type() === PlayerType.Human) {
      vassal
        .sibauState()
        .addVassalDemand(
          this.overlord,
          mg.ticks() + mg.config().vassalRequestTicks(),
        );
      mg.displayMessage(
        "events_display.vassal_demand",
        MessageType.VASSAL_REQUEST,
        vassal.id(),
        undefined,
        { name: this.overlord.displayName() },
        undefined,
        this.overlord.id(),
      );
      tell(
        mg,
        this.overlord,
        "events_display.vassal_demand_sent",
        {
          name: vassal.displayName(),
        },
        vassal,
      );
      return;
    }

    // AI players give in only to someone far stronger.
    const ratio = mg.config().vassalAcceptTroopRatio();
    if (this.overlord.troops() >= vassal.troops() * ratio) {
      makeVassal(mg, this.overlord, vassal);
    } else {
      tell(
        mg,
        this.overlord,
        "events_display.vassal_refused",
        {
          name: vassal.displayName(),
        },
        vassal,
      );
    }
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DemandVassalSnapshot.write({
      overlord: w.player(this.overlord),
      targetID: this.targetID,
      done: this.done,
    });
  }

  restoreSnapshot(s: z.infer<typeof DemandVassalSchema>, r: SnapshotReader) {
    this.overlord = r.player(s.overlord);
    this.targetID = s.targetID;
    this.done = s.done;
  }
}
const DemandVassalSchema = z.object({
  overlord: zPlayerRef(),
  targetID: z.string(),
  done: z.boolean(),
});
export const DemandVassalSnapshot = execSnapshotType({
  name: "DemandVassal",
  version: 1,
  schema: DemandVassalSchema,
  cls: () => DemandVassalExecution,
});

export class VassalReplyExecution extends OneShot {
  constructor(
    private vassal: Player,
    private overlordID: string,
    private accept: boolean,
  ) {
    super();
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.done = true;
    if (!mg.hasPlayer(this.overlordID)) return;
    const overlord = mg.player(this.overlordID);
    const state = this.vassal.sibauState();
    const pending = state
      .vassalDemands()
      .some((d) => d.from === overlord && d.expiresAt > mg.ticks());
    if (!pending) return;
    state.removeVassalDemand(overlord);
    if (this.accept && canDemandVassal(overlord, this.vassal)) {
      makeVassal(mg, overlord, this.vassal);
    } else {
      tell(
        mg,
        overlord,
        "events_display.vassal_refused",
        {
          name: this.vassal.displayName(),
        },
        this.vassal,
      );
    }
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return VassalReplySnapshot.write({
      vassal: w.player(this.vassal),
      overlordID: this.overlordID,
      accept: this.accept,
      done: this.done,
    });
  }

  restoreSnapshot(s: z.infer<typeof VassalReplySchema>, r: SnapshotReader) {
    this.vassal = r.player(s.vassal);
    this.overlordID = s.overlordID;
    this.accept = s.accept;
    this.done = s.done;
  }
}
const VassalReplySchema = z.object({
  vassal: zPlayerRef(),
  overlordID: z.string(),
  accept: z.boolean(),
  done: z.boolean(),
});
export const VassalReplySnapshot = execSnapshotType({
  name: "VassalReply",
  version: 1,
  schema: VassalReplySchema,
  cls: () => VassalReplyExecution,
});
