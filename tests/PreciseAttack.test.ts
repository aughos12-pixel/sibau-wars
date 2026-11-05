import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

let game: Game;
let attacker: Player;
let defender: Player;

function addPlayer(id: string, x: number, y: number): Player {
  game.addPlayer(new PlayerInfo(id, PlayerType.Human, null, id));
  game.addExecution(
    new SpawnExecution("g", game.player(id).info(), game.ref(x, y)),
  );
  return game.player(id);
}

/** Attacker holds x < 50, defender x >= 50, on the 200x200 plains. */
async function frontGame() {
  game = await setup("big_plains", { infiniteGold: true, instantBuild: true });
  attacker = addPlayer("attacker", 20, 100);
  defender = addPlayer("defender", 120, 100);
  executeTicks(game, 2);
  for (let x = 0; x < 200; x++) {
    for (let y = 0; y < 200; y++) {
      (x < 50 ? attacker : defender).conquer(game.ref(x, y));
    }
  }
  attacker.addTroops(2_000_000);
  defender.addTroops(50_000);
}

function attackerTilesIn(x0: number, x1: number, y0: number, y1: number) {
  let n = 0;
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      if (game.owner(game.ref(x, y)) === attacker) n++;
    }
  }
  return n;
}

function launch(path: TileRef[] | null) {
  game.addExecution(
    new AttackExecution(400_000, attacker, defender.id(), null, true, path),
  );
}

describe("precise attacks (Sibau Wars)", () => {
  test("a spearhead pushes toward the clicked point instead of the whole border", async () => {
    await frontGame();
    launch([game.ref(80, 20)]);
    executeTicks(game, 60);

    const nearAim = attackerTilesIn(50, 120, 0, 50);
    const farSide = attackerTilesIn(50, 120, 120, 200);
    // The test config takes one tile per tick.
    expect(nearAim).toBeGreaterThan(40);
    expect(farSide).toBe(0);
  });

  test("a classic attack spreads along the whole border", async () => {
    await frontGame();
    launch(null);
    executeTicks(game, 60);

    expect(attackerTilesIn(50, 120, 0, 50)).toBeGreaterThan(0);
    expect(attackerTilesIn(50, 120, 120, 200)).toBeGreaterThan(0);
  });

  test("a route is followed in order, around to its last point", async () => {
    await frontGame();
    // Down the defender's side: top, then middle, then bottom.
    launch([game.ref(58, 20), game.ref(62, 100), game.ref(58, 180)]);
    executeTicks(game, 600);

    expect(attackerTilesIn(55, 62, 15, 25)).toBeGreaterThan(0);
    expect(attackerTilesIn(59, 66, 95, 105)).toBeGreaterThan(0);
    expect(attackerTilesIn(55, 62, 175, 185)).toBeGreaterThan(0);
  });

  test("route points on your own side are skipped", async () => {
    await frontGame();
    // The first point is deep in the attacker's own land.
    launch([game.ref(10, 10), game.ref(80, 150)]);
    executeTicks(game, 60);
    expect(attackerTilesIn(50, 120, 110, 200)).toBeGreaterThan(30);
    expect(attackerTilesIn(50, 120, 0, 40)).toBe(0);
  });

  test("precise attacks are never merged with other attacks", async () => {
    await frontGame();
    launch(null);
    game.executeNextTick();
    launch([game.ref(80, 20)]);
    game.executeNextTick();
    launch(null);
    game.executeNextTick();

    const outgoing = attacker.outgoingAttacks();
    expect(outgoing.filter((a) => a.isDirectional())).toHaveLength(1);
    // The two classic attacks merged as before.
    expect(outgoing.filter((a) => !a.isDirectional())).toHaveLength(1);
  });

  test("a precise attack on a player you don't border doesn't happen", async () => {
    await frontGame();
    const before = attacker.troops();
    const stranger = addPlayer("stranger", 190, 190);
    executeTicks(game, 2);
    game.addExecution(
      new AttackExecution(100_000, attacker, stranger.id(), null, true, [
        game.ref(190, 190),
      ]),
    );
    executeTicks(game, 3);
    expect(attacker.outgoingAttacks()).toHaveLength(0);
    void before;
  });
});
