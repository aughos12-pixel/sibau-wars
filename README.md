<p align="center">
  <img src="resources/images/SibauWarsLogo.svg" alt="Sibau Wars" width="420">
</p>

**Sibau Wars** is a free, online real-time strategy game in the browser. Start as a tiny nation, grow your land, build cities, ports, defenses and nukes, make (and break) alliances, and take over the map. Play against other people online or against bots.

Sibau Wars is a fork of [OpenFront](https://github.com/openfrontio/OpenFrontIO), the open-source game that FrontWars is also built on, so the gameplay is the same. It runs as **one self-hosted server**, with no accounts, store, ads or tracking.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-red.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Assets: CC BY-SA 4.0](https://img.shields.io/badge/Assets-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)

## Features

- Real-time territory war on 130+ maps based on real geography (World, Europe, Asia, rivers, islands…)
- Online multiplayer: public lobbies, plus private lobbies your friends join with a code
- Solo vs bots, and a tutorial
- Cities, ports, factories, SAMs, missile silos, warships, trade, nukes and MIRVs
- Alliances, betrayal, emojis and quick chat
- **Sibau Wars only:** **natural disasters** (earthquakes, wildfires, tsunamis and gold rushes) with a warning circle before each one hits; on by default, and there's a switch in the lobby settings
- **Sibau Wars only:** bots get Sibau names like "Grand Sibau Horde"
- **Sibau Wars only:** **precise attacks**: Shift+click aims a spearhead at a point, and Shift+drag draws a route for your army to follow (toggle in Settings). They cost 25% more troops per tile than a normal attack
- **Sibau Wars only:** **Schools** (hotkey I): each one makes your troops fight 2% better and regrow 2% faster, up to 5 Schools
- **Sibau Wars only:** **Banks** (hotkey O): each one pays 0.25% of the gold you're holding every 10 seconds (max 10k per Bank, up to 5 Banks). An enemy who captures your Bank steals 15% of your gold (max 1M)
- **Sibau Wars only:** **Barracks and tanks** (hotkeys J and Z). Tanks drive over any land, shoot enemy tanks, wreck enemy buildings and make your attacks nearby about 15% cheaper and faster. Defense posts shoot them, and you can right-click an enemy tank near your land and pick **Focus** to throw troops at it
- **Sibau Wars only:** AI nations use all of it: they build Schools, Banks and Barracks, send tanks, Focus enemy tanks and aim precise attacks
- **Sibau Wars only:** **General Albin**, an advisor in the bottom-left corner who gives a tip when something important happens (enemy tank in your land, gold piling up, an attack running dry...). Players can turn him off in Settings
- **Sibau Wars only: governments.** At the start you pick Monarchy (+10% troops), Republic (+25% gold), Military Junta (cheaper tanks and warships, cheaper attacks) or Theocracy (stronger defence). You pick once
- **Sibau Wars only: tech tree.** 9 techs in 3 branches (Economy, Military, Defense). Research points trickle in, faster with Schools and Oil Drills. Open it with the Nation button on the left
- **Sibau Wars only: capitals.** Your first City is your capital (crown icon). Lose it and troop growth halves until you build a new City
- **Sibau Wars only: oil.** Right-click your land and search for oil for 5M gold. Oil hides mostly in plains; if none is within 20 tiles, the money is gone. On a hit, build an Oil Drill (1M) that pays 20k gold a second forever and speeds up research
- **Sibau Wars only: vassals.** Right-click a smaller player and demand they become your vassal. Humans get Accept/Refuse; AI nations accept only if you have 3x their troops. Vassals pay 20% of their income and go free if they grow bigger than you. Either side can end it (Nation panel or right-click menu: Break free / Release); you are enemies again afterwards
- **Sibau Wars only: slower invasions.** Every attack takes about 1.5x as long as in OpenFront (the setting is `attackSlowdown()` in `packages/engine/src/configuration/EngineConfig.ts`), for more strategic wars. Troop losses are unchanged
- **Sibau Wars only: war exhaustion, rebels and coalitions.** Long wars slowly lower troop growth. Land taken too fast can rebel and break away as a rebel bot. If one player gets far ahead, AI nations team up against them
- Free-for-all, teams and other game modes

## Changing General Albin's picture

Albin's picture is one file: `resources/images/albin.png`.

1. Pick a square picture (about 256×256 pixels works best; it's shown small).
2. Name it exactly `albin.png`.
3. Replace `resources/images/albin.png` with it. The easiest way is on
   GitHub: open the `resources/images` folder, click **Add file → Upload
   files**, drag your `albin.png` in, and click **Commit changes**.
4. Render redeploys by itself; the new picture shows in a few minutes.

If the file is ever missing, Albin shows a blue "A" instead.

Albin sits in the bottom-left corner as a small portrait during a game. He opens up when he has a tip; click his portrait to hear his last tip again.

## Play locally

You need **Node.js 24** and **npm 12** (the versions OpenFront targets).

```bash
npm ci
npm run dev
```

Then open http://localhost:9000. To test multiplayer, open a second browser window (or an incognito window), click **Create lobby** in one and **Join lobby** with the code in the other.

## Put it online

See **[DEPLOY.md](DEPLOY.md)**. In short: it's a single Docker container that you can run on Fly.io, Railway, Render or any VPS.

## How it differs from OpenFront

Sibau Wars sets `SELF_HOSTED=true` (the default in the Docker image), so the server runs without OpenFront's account and API backend:

- Players join anonymously; there is no sign-in. OpenFront's local name filter still runs.
- Store, inventory, cosmetics, clans, leaderboards, ranked and Steam features are hidden.
- All of OpenFront's ad, analytics and tracking scripts (Google, Playwire/RAMP, AdShield, CrazyGames, Cloudflare Insights, Turnstile) are removed.
- The client and server send their API calls to the server's own `/sibau-api` stub, which answers `404` right away.
- The OpenFront-only `proprietary/` assets (logos, display font, music, one sound effect) are removed. In their place are an original Sibau Wars logo and favicon, the open Overpass font, and simple placeholder music and a game-start chime made for this fork.
- The theme is Sibau blue and white, and every text says "Sibau Wars".

The changes are kept small (see `SELF_HOSTED` in `src/server/ServerEnv.ts` and the "Sibau Wars" block at the end of `src/client/styles.css`), so pulling in later OpenFront updates stays manageable.

## License and credits

**Notice (AGPL-3.0 §5a):** this is a modified version of OpenFront, changed by aughos12-pixel on 2026-11-04 and after. It was forked from OpenFrontIO commit `4ae6e3e4c277166a457cfa5e84fb43d3ffc94fd9` (2026-11-03).

- **Code:** GNU Affero General Public License v3.0, see [LICENSE](LICENSE). If you run a modified Sibau Wars server for other people, you must offer them its source code. The footer's **Source code** link does that, so keep it pointing at your public repo.
- **Assets** in `resources/`: Creative Commons BY-SA 4.0, see [LICENSE-ASSETS](LICENSE-ASSETS). Attribution: "OpenFront" / "OpenFront Inc.". New Sibau Wars assets are released under the same CC BY-SA 4.0 license.
- The footer and loading screen keep the required notice **"© OpenFront and Contributors"** (AGPL §7(b) additional term). Don't remove it.
- Sibau Wars is **not affiliated with or endorsed by** OpenFront, OpenFront Inc., FrontWars or VexxusArts.
- Map data credits: see [CREDITS.md](CREDITS.md). Licensing history: see [LICENSING.md](LICENSING.md).

Original game © OpenFront and Contributors, itself a fork/rewrite of [WarFront.io](https://github.com/WarFrontIO).
