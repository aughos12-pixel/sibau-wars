import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  packB,
  unpackBDisabled,
} from "@openfront/engine-lib/game/PackedUnitUpdates";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { constructionExecution, executeTicks } from "./util/utils";

const gameID: GameID = "game_id";
let game: Game;
let attacker: Player;
let defender: Player;

function addPlayer(id: string, x: number, y: number): Player {
  const info = new PlayerInfo(id, PlayerType.Human, null, id);
  game.addPlayer(info);
  game.addExecution(
    new SpawnExecution(gameID, game.player(id).info(), game.ref(x, y)),
  );
  return game.player(id);
}

function conquerRect(
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) p.conquer(game.ref(x, y));
  }
}

/** Launch an EMP from the attacker's silo and run until it has landed. */
function launchEmpAndLand(targetX: number, targetY: number) {
  game.addExecution(
    new NukeExecution(UnitType.EMP, attacker, game.ref(targetX, targetY), null),
  );
  game.executeNextTick();
  game.executeNextTick();
  expect(attacker.units(UnitType.EMP)).toHaveLength(1);
  for (let i = 0; i < 1000 && attacker.units(UnitType.EMP).length > 0; i++) {
    game.executeNextTick();
  }
  expect(attacker.units(UnitType.EMP)).toHaveLength(0);
}

function structure(p: Player, type: UnitType): Unit {
  const u = p.units(type)[0];
  expect(u).toBeDefined();
  return u;
}

describe("EMP (Sibau Wars)", () => {
  beforeEach(async () => {
    game = await setup("big_plains", {
      infiniteGold: true,
      instantBuild: true,
    });
    attacker = addPlayer("attacker", 10, 10);
    defender = addPlayer("defender", 150, 150);
    executeTicks(game, 2);
    conquerRect(attacker, 0, 0, 30, 30);
    conquerRect(defender, 120, 120, 190, 190);

    constructionExecution(game, attacker, 10, 10, UnitType.MissileSilo);
    constructionExecution(game, defender, 150, 150, UnitType.City);
    constructionExecution(game, defender, 160, 150, UnitType.MissileSilo);
    constructionExecution(game, defender, 150, 160, UnitType.DefensePost);
  });

  test("switches structures in range off without taking land or buildings", () => {
    const tilesBefore = defender.numTilesOwned();
    const unitsBefore = defender.units().length;

    launchEmpAndLand(152, 152);

    expect(structure(defender, UnitType.City).isDisabled()).toBe(true);
    expect(structure(defender, UnitType.MissileSilo).isDisabled()).toBe(true);
    expect(structure(defender, UnitType.DefensePost).isDisabled()).toBe(true);
    expect(defender.numTilesOwned()).toBe(tilesBefore);
    expect(defender.units()).toHaveLength(unitsBefore);
    // The attacker's own silo, far away, is untouched.
    expect(structure(attacker, UnitType.MissileSilo).isDisabled()).toBe(false);
  });

  test("structures come back on after the EMP wears off", () => {
    launchEmpAndLand(152, 152);
    const city = structure(defender, UnitType.City);
    expect(city.isDisabled()).toBe(true);

    executeTicks(game, game.config().empDisableTicks() + 1);

    expect(city.isDisabled()).toBe(false);
    expect(structure(defender, UnitType.MissileSilo).isDisabled()).toBe(false);
  });

  test("a disabled silo can't launch, and can again once it recovers", () => {
    launchEmpAndLand(152, 152);
    const target = game.ref(20, 20);
    expect(defender.canBuild(UnitType.AtomBomb, target)).toBe(false);

    executeTicks(game, game.config().empDisableTicks() + 1);

    expect(defender.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
  });

  test("structures outside the radius are not affected", () => {
    const radius = game.config().empRadius();
    launchEmpAndLand(150, 150 - radius - 10);
    expect(structure(defender, UnitType.City).isDisabled()).toBe(false);
  });

  test("clients are told when a structure switches off and back on", () => {
    const city = structure(defender, UnitType.City);
    const disabledFlags: boolean[] = [];
    const collect = () => {
      const updates = game.executeNextTick();
      for (const u of updates[GameUpdateType.Unit] ?? []) {
        if (u.id === city.id()) disabledFlags.push(u.disabled ?? false);
      }
    };
    game.addExecution(
      new NukeExecution(UnitType.EMP, attacker, game.ref(152, 152), null),
    );
    for (let i = 0; i < 1000 + game.config().empDisableTicks(); i++) collect();

    expect(disabledFlags).toContain(true);
    expect(disabledFlags[disabledFlags.length - 1]).toBe(false);
  });

  test("a SAM in range shoots the EMP down", () => {
    constructionExecution(game, defender, 135, 135, UnitType.SAMLauncher);
    expect(defender.units(UnitType.SAMLauncher)).toHaveLength(1);
    launchEmpAndLand(140, 140);
    expect(structure(defender, UnitType.City).isDisabled()).toBe(false);
    expect(structure(defender, UnitType.SAMLauncher).isDisabled()).toBe(false);
  });

  test("the disabled flag survives the packed wire format", () => {
    const base = {
      level: 1,
      isActive: true,
      reachedTarget: false,
      targetable: true,
      hasTrainStation: false,
    } as Parameters<typeof packB>[0];
    expect(unpackBDisabled(packB({ ...base, disabled: true }))).toBe(true);
    expect(unpackBDisabled(packB({ ...base, disabled: false }))).toBe(false);
    // Bit 28 still means "retreating" for transport ships.
    expect(
      unpackBDisabled(
        packB({
          ...base,
          transportShipState: { isRetreating: true, troops: 1 },
        } as Parameters<typeof packB>[0]),
      ),
    ).toBe(false);
  });
});
