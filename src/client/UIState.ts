import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerBuildableUnitType } from "@openfront/engine-api/game/GameTypes";

export interface UIState {
  preventStacking?: boolean;
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
  /**
   * Sibau Wars: set by the unit selection controller. A left click on land
   * that selects or moves a tank returns true, and must not also attack.
   */
  claimLandClick?: (tile: TileRef) => boolean;
}
