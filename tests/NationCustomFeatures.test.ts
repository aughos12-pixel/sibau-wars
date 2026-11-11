import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
/**
 * Sibau Wars: real nations (no scripting) use the custom features. A world
 * map game with every manifest nation at Impossible runs for a while, and
 * the test checks that nations built Schools, Banks and Barracks, sent tanks,
 * aimed precise attacks and threw Focus at enemy tanks.
 */
import { TECHS } from "@openfront/engine-api/game/Sibau";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { FocusTankExecution } from "@openfront/engine/execution/FocusTankExecution";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import {
  DemandVassalExecution,
  SearchOilExecution,
} from "@openfront/engine/execution/SibauExecutions";
import {
  SibauWorldExecution,
  sibauWorld,
} from "@openfront/engine/execution/SibauWorldExecution";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setup } from "./util/Setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKS_PER_MINUTE = 600;

function loadWorldNations(): Nation[] {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "testdata/maps/world/manifest.json"),
      "utf8",
    ),
  ) as { nations: { coordinates: [number, number]; name: string }[] };
  return manifest.nations.map(
    (n) =>
      new Nation(
        new Cell(n.coordinates[0], n.coordinates[1]),
        new PlayerInfo(n.name, PlayerType.Nation, null, n.name),
      ),
  );
}

test("nations use Schools, Banks, Barracks, tanks, precise attacks and Focus", async () => {
  const nations = loadWorldNations();
  const game = await setup(
    "world",
    { difficulty: Difficulty.Impossible },
    [],
    undefined,
    EngineConfig,
    false,
    nations,
  );
  for (const nation of nations) {
    game.addExecution(new NationExecution("nation-custom-features", nation));
  }
  for (
    let i = 0;
    i < 100 && game.allPlayers().some((p) => !p.hasSpawned());
    i++
  ) {
    game.executeNextTick();
  }
  game.addExecution(new SibauWorldExecution(7));
  game.endSpawnPhase();

  let focuses = 0;
  let oilSearches = 0;
  const realSearch = SearchOilExecution.prototype.init;
  SearchOilExecution.prototype.init = function (...args) {
    oilSearches++;
    return realSearch.apply(this, args);
  };
  let vassalDemands = 0;
  const realDemand = DemandVassalExecution.prototype.init;
  DemandVassalExecution.prototype.init = function (...args) {
    vassalDemands++;
    return realDemand.apply(this, args);
  };
  let coalitionSeen = false;
  let maxVassals = 0;
  const realInit = FocusTankExecution.prototype.init;
  FocusTankExecution.prototype.init = function (...args) {
    focuses++;
    return realInit.apply(this, args);
  };

  const seen = {
    School: new Set<number>(),
    Bank: new Set<number>(),
    Barracks: new Set<number>(),
    Tank: new Set<number>(),
  };
  let tanksOnEnemyLand = 0;
  const preciseAttacks = new Set<string>();
  try {
    for (let tick = 0; tick < 18 * TICKS_PER_MINUTE; tick++) {
      game.executeNextTick();
      if (tick % 50 !== 0) continue;
      for (const type of ["School", "Bank", "Barracks", "Tank"] as const) {
        for (const u of game.units(UnitType[type])) seen[type].add(u.id());
      }
      for (const t of game.units(UnitType.Tank)) {
        const owner = game.owner(t.tile());
        if (owner.isPlayer() && owner !== t.owner()) tanksOnEnemyLand++;
      }
      for (const p of game.players()) {
        for (const a of p.outgoingAttacks()) {
          if (a.isDirectional()) preciseAttacks.add(a.id());
        }
      }
      if (sibauWorld(game).coalitionTarget !== null) coalitionSeen = true;
      maxVassals = Math.max(
        maxVassals,
        game.players().filter((p) => p.sibauState().overlord() !== null).length,
      );
    }
  } finally {
    FocusTankExecution.prototype.init = realInit;
    SearchOilExecution.prototype.init = realSearch;
    DemandVassalExecution.prototype.init = realDemand;
  }
  const nationPlayers = game
    .players()
    .filter((p) => p.type() === PlayerType.Nation);

  const report = {
    schools: seen.School.size,
    banks: seen.Bank.size,
    barracks: seen.Barracks.size,
    tanks: seen.Tank.size,
    tanksOnEnemyLand,
    preciseAttacks: preciseAttacks.size,
    focuses,
    withGovernment: nationPlayers.filter((p) => p.sibau().government !== null)
      .length,
    nations: nationPlayers.length,
    techsLearned: nationPlayers.reduce(
      (n, p) => n + TECHS.filter((t) => p.sibauState().hasTech(t.tech)).length,
      0,
    ),
    capitals: nationPlayers.filter((p) => p.sibau().capitalUnitID !== null)
      .length,
    oilSearches,
    oilFieldsFound: game.units(UnitType.OilField).length,
    oilDrills: game.units(UnitType.OilDrill).length,
    vassalDemands,
    maxVassals,
    coalitionSeen,
    rebels: game.players().filter((p) => p.name().startsWith("Rebels of"))
      .length,
  };
  process.stderr.write(`\nnation custom features: ${JSON.stringify(report)}\n`);
  expect(report.schools).toBeGreaterThan(0);
  expect(report.banks).toBeGreaterThan(0);
  expect(report.barracks).toBeGreaterThan(0);
  expect(report.tanks).toBeGreaterThan(0);
  expect(report.tanksOnEnemyLand).toBeGreaterThan(0);
  expect(report.preciseAttacks).toBeGreaterThan(0);
  // Sibau Wars: governments, techs, capitals, oil and vassals.
  expect(report.withGovernment).toBe(report.nations);
  expect(report.techsLearned).toBeGreaterThan(report.nations);
  expect(report.capitals).toBeGreaterThan(0);
  expect(report.oilSearches).toBeGreaterThan(0);
  expect(report.vassalDemands).toBeGreaterThan(0);
}, 600_000);
