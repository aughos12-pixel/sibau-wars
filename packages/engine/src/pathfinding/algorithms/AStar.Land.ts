import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { AStar, AStarAdapter } from "./AStar";

/**
 * Sibau Wars: land-only A* for tanks. Tanks drive over any passable land
 * (own, neutral or enemy) and never cross water.
 *
 * One search instance is shared per map: its scratch arrays are sized to the
 * whole map, so a copy per tank would cost megabytes each. The worker is
 * single-threaded and AStar resets its scratch with a stamp per search, so
 * sharing is safe. Paths depend on terrain only, so they are deterministic.
 */
const searches = new WeakMap<GameMap, AStar>();

/** Searches stop after this many expansions and report no path. */
const MAX_ITERATIONS = 400_000;

export function findLandPath(
  map: GameMap,
  from: TileRef,
  to: TileRef,
): TileRef[] | null {
  if (!isDrivable(map, from) || !isDrivable(map, to)) return null;
  let search = searches.get(map);
  if (search === undefined) {
    search = new AStar({
      adapter: new LandAdapter(map),
      maxIterations: MAX_ITERATIONS,
    });
    searches.set(map, search);
  }
  return search.findPath(from, to);
}

export function isDrivable(map: GameMap, tile: TileRef): boolean {
  return map.isLand(tile) && !map.isImpassable(tile);
}

class LandAdapter implements AStarAdapter {
  private readonly width: number;
  private readonly height: number;
  private readonly heuristicWeight = 1.5;

  constructor(private readonly map: GameMap) {
    this.width = map.width();
    this.height = map.height();
  }

  numNodes(): number {
    return this.width * this.height;
  }

  maxNeighbors(): number {
    return 4;
  }

  maxPriority(): number {
    return Math.ceil(this.heuristicWeight * (this.width + this.height) * 2);
  }

  neighbors(node: number, buffer: Int32Array): number {
    let count = 0;
    const x = node % this.width;
    const n = this.numNodes();
    if (node >= this.width && isDrivable(this.map, node - this.width)) {
      buffer[count++] = node - this.width;
    }
    if (node < n - this.width && isDrivable(this.map, node + this.width)) {
      buffer[count++] = node + this.width;
    }
    if (x !== 0 && isDrivable(this.map, node - 1)) {
      buffer[count++] = node - 1;
    }
    if (x !== this.width - 1 && isDrivable(this.map, node + 1)) {
      buffer[count++] = node + 1;
    }
    return count;
  }

  cost(): number {
    return 1;
  }

  heuristic(node: number, goal: number): number {
    const dx = Math.abs((node % this.width) - (goal % this.width));
    const dy = Math.abs(((node / this.width) | 0) - ((goal / this.width) | 0));
    return this.heuristicWeight * (dx + dy);
  }
}
