# Putting Sibau Wars online

Sibau Wars runs as **one Docker container** (nginx + the Node game server). It needs:

- **Memory:** about 300–600 MB. With `NUM_WORKERS=1` (the default) it's about 300 MB idle and more while big matches run, so **1 GB RAM is the safe size.**
- **WebSockets:** every host below supports them.
- **No database** and no other services.

Once it's running, share the URL. Players open it, pick a name and play: public lobbies show up on the home page, and **Create lobby → copy the code → Join lobby** works for private games with friends.

> Checked November 2026. Prices and free tiers change, so check the host's pricing page before you pay.

---

## Option A: Fly.io (recommended)

At the time of checking, a `shared-cpu-1x` machine with 1 GB RAM cost about $5.70–7/month depending on region. You pay only while it runs. It's always on and has no sleep delay.

1. Install the CLI: https://fly.io/docs/flyctl/install/ and run `fly auth signup` (or `fly auth login`).
2. In this repo folder:
   ```bash
   fly launch --no-deploy --copy-config --name sibau-wars-yourname
   ```
   (`fly.toml` is already in the repo. Pick a region close to you, e.g. `arn` Stockholm.)
3. Deploy:
   ```bash
   fly deploy
   ```
   The first build takes several minutes, because the map files are big (~650 MB).
4. Open `https://sibau-wars-yourname.fly.dev`.

To stop paying, run `fly scale count 0` (it stops the server) or `fly apps destroy sibau-wars-yourname`.

## Option B: Render (free tier, with limits)

Render's free web service costs nothing, but:
- it **falls asleep after 15 minutes** with no visitors, and the first visitor then waits about 1 minute while it wakes up;
- free instances have little RAM (512 MB at the time of checking), which is fine for a few friends but can crash in a big match.

Steps:
1. Push this repo to GitHub (already done if you're reading this there).
2. On https://render.com: **New → Web Service → connect the `sibau-wars` repo**.
3. Language/Runtime: **Docker**. Instance type: **Free** (or Starter for no sleep).
4. Deploy. Render sets `$PORT` and the container listens on it automatically.

## Option C: Railway

The Hobby plan was $5/month at the time of checking, and that includes $5 of usage. RAM is metered (around $10 per GB per month), so this game will likely cost a bit more than the $5.

1. https://railway.com → **New Project → Deploy from GitHub repo → `sibau-wars`**.
2. Railway detects the `Dockerfile`. Under **Settings → Networking**, click **Generate Domain**.
3. Set a spend limit in your workspace settings so you never get a surprise bill.

## Option D: Any Linux VPS (Hetzner, DigitalOcean, a home server…)

```bash
git clone https://github.com/aughos12-pixel/sibau-wars.git
cd sibau-wars
docker build -t sibau-wars .
docker run -d --restart unless-stopped -p 80:80 --name sibau-wars sibau-wars
```

For HTTPS, put Caddy or a Cloudflare Tunnel in front. Browsers need HTTPS for secure WebSockets (`wss://`) when the page is served over HTTPS.

---

## Settings (environment variables)

All have working defaults in the Dockerfile:

| Variable | Default | What it does |
| --- | --- | --- |
| `SELF_HOSTED` | `true` | Runs without the OpenFront account/API backend. Keep it `true`. |
| `GAME_ENV` | `prod` | Production mode (anti-multi-account and IP limits on). |
| `NUM_WORKERS` | `1` | Game worker processes. Use `2`+ only with 1 GB+ RAM and lots of players. |
| `DOMAIN` | `localhost` | Used only for login tokens, which self-hosting doesn't use. No need to change it. |
| `PORT` | `80` | Port nginx listens on. Hosts set this for you. |

## Updating

Push to GitHub, then run `fly deploy` again (Fly) or let Render/Railway auto-deploy on push.

## Troubleshooting

- **"WebGL2 unavailable / hardware acceleration" screen:** the player's browser has GPU acceleration turned off. In Chrome: Settings → System → "Use graphics acceleration when available". Some school-managed Chromebooks block this.
- **The game crashes during big matches:** the host ran out of memory. Give it 1 GB RAM, or keep `NUM_WORKERS=1`.
- **Keep the footer's "Source code" link pointing at your public repo.** The AGPL license requires it when other people play on your server.
