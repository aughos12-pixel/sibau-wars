import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DisasterEventUpdate,
  DisasterKind,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import {
  DISASTER_RADIUS,
  DisasterExecution,
  GOLD_RUSH_GOLD_PER_TILE_PER_SECOND,
} from "@openfront/engine/execution/DisasterExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { TestConfig } from "./util/TestConfig";
import { constructionExecution, executeTicks } from "./util/utils";

/** Disasters start almost at once and come back to back. */
class FastDisasterConfig extends TestConfig {
  disasterFirstDelayTicks(): number {
    return 5;
  }
  disasterIntervalTicks(): { min: number; max: number } {
    return { min: 40, max: 40 };
  }
  disasterWarningTicks(): number {
    return 10;
  }
  goldRushTicks(): number {
    return 50;
  }
}

let game: Game;
let player: Player;

async function newGame(map: string, config: Partial<GameConfig> = {}) {
  game = await setup(
    map,
    { infiniteGold: true, instantBuild: true, ...config },
    [],
    undefined,
    FastDisasterConfig,
  );
  const info = new PlayerInfo("p", PlayerType.Human, null, "p");
  game.addPlayer(info);
  player = game.player("p");
}

function finishSpawnPhase() {
  // Let the SpawnExecution run, then leave the spawn phase.
  executeTicks(game, 2);
  for (let i = 0; i < 500 && game.inSpawnPhase(); i++) game.executeNextTick();
  expect(game.inSpawnPhase()).toBe(false);
}

/** Run ticks, collecting disaster events. */
function runCollecting(ticks: number): DisasterEventUpdate[] {
  const events: DisasterEventUpdate[] = [];
  for (let i = 0; i < ticks; i++) {
    const updates = game.executeNextTick();
    events.push(...(updates[GameUpdateType.DisasterEvent] ?? []));
  }
  return events;
}

/** Run until the first disaster ends; return its warning and end events. */
function runFirstDisaster(): DisasterEventUpdate[] {
  const events: DisasterEventUpdate[] = [];
  for (let i = 0; i < 400; i++) {
    const updates = game.executeNextTick();
    events.push(...(updates[GameUpdateType.DisasterEvent] ?? []));
    if (events.some((e) => e.phase === "end")) return events;
  }
  throw new Error("no disaster happened");
}

async function landGame() {
  await newGame("big_plains");
  game.addExecution(new SpawnExecution("g", player.info(), game.ref(100, 100)));
  finishSpawnPhase();
  // A 30x30 territory, so the zone always lands on or near the buildings.
  for (let x = 85; x < 115; x++) {
    for (let y = 85; y < 115; y++) player.conquer(game.ref(x, y));
  }
}

/** Disasters start only now, so earlier setup isn't hit while it's built. */
function startDisasters(kinds: DisasterKind[], seed = 42) {
  game.addExecution(new DisasterExecution(seed, kinds));
}

describe("natural disasters (Sibau Wars)", () => {
  test("are on by default, can be turned off, and never run in the tutorial", () => {
    const base = {} as GameConfig;
    expect(new EngineConfig(base, false).naturalDisasters()).toBe(true);
    expect(
      new EngineConfig(
        { ...base, naturalDisasters: false },
        false,
      ).naturalDisasters(),
    ).toBe(false);
    expect(
      new EngineConfig(
        { ...base, naturalDisasters: null },
        false,
      ).naturalDisasters(),
    ).toBe(true);
    expect(
      new EngineConfig({ ...base, tutorial: true }, false).naturalDisasters(),
    ).toBe(false);
  });

  test("warn before they strike, on land someone owns", async () => {
    await landGame();
    startDisasters(["earthquake"]);
    const events = runFirstDisaster();
    const warning = events.find((e) => e.phase === "warning")!;
    expect(warning).toBeDefined();
    expect(warning.kind).toBe("earthquake");
    expect(warning.radius).toBe(DISASTER_RADIUS.earthquake);
    expect(game.owner(warning.tile)).toBe(player);
    expect(events.findIndex((e) => e.phase === "warning")).toBeLessThan(
      events.findIndex((e) => e.phase === "end"),
    );
  });

  test("earthquakes wreck buildings in the zone and leave the rest alone", async () => {
    await landGame();
    for (const [x, y] of [
      [92, 92],
      [108, 92],
      [92, 108],
      [108, 108],
    ]) {
      constructionExecution(game, player, x, y, UnitType.City);
    }
    const cities = player.units(UnitType.City);
    expect(cities).toHaveLength(4);
    startDisasters(["earthquake"]);

    const warning = runFirstDisaster().find((e) => e.phase === "warning")!;
    const r2 = DISASTER_RADIUS.earthquake ** 2;
    const inZone = cities.filter(
      (c) => game.euclideanDistSquared(c.tile(), warning.tile) <= r2,
    );
    const outside = cities.filter((c) => !inZone.includes(c));

    for (const c of outside) expect(c.isActive()).toBe(true);
    expect(inZone.length).toBeGreaterThan(0);
    // Some ride it out, but not all of this seed's buildings did.
    expect(inZone.filter((c) => !c.isActive()).length).toBeGreaterThan(0);
  });

  test("wildfires kill troops but take no land or buildings", async () => {
    await landGame();
    constructionExecution(game, player, 100, 100, UnitType.City);
    startDisasters(["wildfire"]);
    player.addTroops(500_000);
    const tilesBefore = player.numTilesOwned();
    const before = player.troops();

    runFirstDisaster();

    expect(player.troops()).toBeLessThan(before * 0.95);
    expect(player.numTilesOwned()).toBe(tilesBefore);
    expect(player.units(UnitType.City)).toHaveLength(1);
  });

  test("gold rushes pay whoever owns the zone, for a while, then stop", async () => {
    await landGame();
    startDisasters(["goldrush"]);
    const events: DisasterEventUpdate[] = [];
    let goldAtActive: bigint | null = null;
    for (let i = 0; i < 400; i++) {
      const updates = game.executeNextTick();
      const evs = updates[GameUpdateType.DisasterEvent] ?? [];
      events.push(...evs);
      if (goldAtActive === null && evs.some((e) => e.phase === "active")) {
        goldAtActive = player.gold();
      }
      if (evs.some((e) => e.phase === "end")) break;
    }
    expect(goldAtActive).not.toBeNull();
    // 50 ticks = 5 payouts of at least a few hundred owned tiles each.
    const earned = player.gold() - goldAtActive!;
    expect(earned).toBeGreaterThanOrEqual(
      GOLD_RUSH_GOLD_PER_TILE_PER_SECOND * 100n * 4n,
    );
  });

  test("tsunamis sink ships and wreck ports on the coast", async () => {
    // 16x16: land at x=0-7, ocean at x=8-15.
    await newGame("half_land_half_ocean");
    game.addExecution(new SpawnExecution("g", player.info(), game.ref(3, 8)));
    finishSpawnPhase();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 16; y++) {
        const t = game.ref(x, y);
        if (game.isLand(t)) player.conquer(t);
      }
    }
    constructionExecution(game, player, 7, 8, UnitType.Port);
    expect(player.units(UnitType.Port)).toHaveLength(1);
    constructionExecution(game, player, 10, 8, UnitType.Warship);
    expect(player.units(UnitType.Warship)).toHaveLength(1);

    game.addExecution(new DisasterExecution(7, ["tsunami"]));
    const warning = runFirstDisaster().find((e) => e.phase === "warning")!;

    expect(warning.kind).toBe("tsunami");
    expect(game.isShore(warning.tile)).toBe(true);
    expect(player.units(UnitType.Port)).toHaveLength(0);
    expect(player.units(UnitType.Warship)).toHaveLength(0);
  });

  test("a tsunami on a map with no owned coast becomes an earthquake", async () => {
    await landGame();
    startDisasters(["tsunami"]);
    const warning = runFirstDisaster().find((e) => e.phase === "warning")!;
    expect(warning.kind).toBe("earthquake");
  });

  test("the same seed gives every client the same disasters", async () => {
    const run = async () => {
      await landGame();
      startDisasters(["earthquake", "wildfire", "goldrush", "tsunami"]);
      return runCollecting(300)
        .filter((e) => e.phase === "warning")
        .map((e) => `${e.kind}@${e.tile}`);
    };
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(2);
    expect(b).toEqual(a);
  });
});
