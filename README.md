# Smart Campus Wi-Fi Monitoring & Network Health Dashboard

A web application for a university campus. Students and staff run a built-in Wi-Fi speed test from where they are sitting and report connectivity problems. The IT team gets live campus-wide network health, outage detection, a complaint workflow, analytics, and local AI-style insights.

> **Flow:** User selects location → runs speed test → network metrics collected → health score calculated → result stored → dashboard updated → complaint submitted if needed → IT team reviews → analytics updated.

## Quick start

Requirements: **Node.js 20 or newer** (22 LTS recommended). No cloud services or accounts are needed, and nothing needs internet access after `npm install`.

```bash
npm run setup     # install → create database → seed demo data → build the web app
npm start         # serves the API and the web app on one port
```

Open **http://localhost:3000**. The terminal also prints LAN addresses (for example `http://192.168.1.20:3000`). Open one on a phone connected to the campus Wi-Fi to test that phone's connection. Admins can also show the address as a QR code under **Administration → Share on Wi-Fi**.

### Demo accounts

All demo accounts use the password `Passw0rd!demo`. **Change these before any real use.**

| Email | Role |
|---|---|
| `admin@campus.local` | Administrator |
| `manager@campus.local` | Network / IT Manager |
| `it1@campus.local`, `it2@campus.local` | IT Support Staff |
| `student01@campus.local` … `student12@campus.local` | Student / Staff user |

The sign-in page also has one-click demo-account buttons.

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Install, migrate, seed, build |
| `npm start` | Run the built app (`apps/server/dist/index.js`, serving `apps/web/dist`) |
| `npm run dev` | API with hot reload on :3000 plus the Vite dev server on :5173 (proxies `/api`) |
| `npm run build` | Build the server bundle and the web app |
| `npm run seed` | Demo data; skips if users exist (`npm run seed -- --force` to wipe and reseed) |
| `npm run reset` | Delete the database, migrate and seed again |
| `npm run simulate` | Post a realistic live speed test every 3 s, so the dashboard moves live |
| `npm run simulate:outage -- --location "Library Floor 2"` | 4 students report *No Internet* and 3 tests fail → an outage opens live |
| `npm run simulate:recover -- --location "Library Floor 2"` | 3 good tests → "Network returns to normal" |
| `npm test` | Unit and integration tests (Vitest): domain rules, API, speed-test engine |
| `npm run test:e2e` | Browser end-to-end flow (Playwright). Run `npm run build` first, and `npx playwright install chromium` once |
| `npm run lint` / `npm run typecheck` | ESLint (including the clean-architecture boundary rule) / TypeScript |

Copy `.env.example` to `.env` to change the port, timezone (`CAMPUS_TZ`), quick speed-test mode, or to enable optional local-LLM rewording of the AI summary (Ollama).

## Five-minute demo script

1. Sign in as **student01**, choose **Computer Lab 2** and select **Run speed test**. Watch ping, download, upload, packet loss, the health score and the status.
2. Choose **Library Floor 2**, run the test, then select **Report a problem**. The latest test is attached, and the category is suggested from what you type.
3. Sign out, then sign in as **it1**. The dashboard shows the KPIs, the campus heatmap, insights ("Possible network problem detected in Library Floor 2."), the 12 PM–2 PM summary, and the inspect-first ranking.
4. Open the complaint and move it through **Reviewed → Assigned (to yourself) → In Progress (add a note) → Resolved**. The student receives a notification.
5. Keep the dashboard open and run `npm run simulate:outage -- --location "Library Floor 2"`. The outage toast, the KPI change and the heatmap update arrive live. Then run `npm run simulate:recover -- --location "Library Floor 2"`.
6. Sign in as **manager** for **Analytics** (speed and ping by location, by hour and day, complaints by building, most problematic locations, peak periods, 24 h forecast) and **Compare & reports** (building comparison, recurring problems, IT activity, CSV downloads).
7. Sign in as **admin**: create an IT staff user, add a location (with live map preview), and change a health threshold to see the sample score update instantly.

## Documentation

- `docs/PROJECT_STRUCTURE.md` (also `.docx` and `.pdf`): the project explanation document required by the brief.
- `docs/ARCHITECTURE.html`: the build blueprint this implementation follows.

## What the speed test measures (and how to validate it)

The speed test has two modes, chosen with **Test against** on the speed-test page:

| Mode | Measures against | Use it for |
|---|---|---|
| **Campus network** | this app's own server | Campus Wi-Fi quality (the brief's purpose). Run the server on a wired machine and test from phones or laptops on Wi-Fi using the LAN address. |
| **Internet** | Cloudflare's public speed-test servers (the ones `speed.cloudflare.com` uses) | Results you can compare with speedtest.net or fast.com |

If you open the app on the same computer that runs the server (`localhost`), a campus test only measures the computer talking to itself and shows thousands of Mbps. The page warns about this and defaults to **Internet**.

**To validate against speedtest.net:** close downloads and streaming, run **Internet** mode three times, then run speedtest.net three times on the same device, and compare the medians. Expect them to agree within about 10–20%. They use different servers (Cloudflare's nearest location versus an Ookla server) and different methods. Ping here is an HTTP round-trip time, because browsers cannot send ICMP, so it usually reads a few ms higher than speedtest.net's ping.
