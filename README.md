# mp-ff-app
⚠️ **Your four ADP snapshots agree far too closely to use raw** — median spread is 5.5 picks overall and only 5.0 picks past ADP 120, which would say a pick-200 player is nearly certain to land within a few picks of his ADP. That's not true. The app floors the spread at `1.15 × √ADP`, so pick 12 ≈ ±4, pick 60 ≈ ±9, pick 150 ≈ ±14. **This is modeled, not measured.** Treat the percentages as directional.
 
**Cost to wait** — VORP now minus the probability-weighted best VORP at that position when your next pick comes around. This is the take-now-or-wait number.
 
**Tiers** — the FantasyPros tiers that were imported into `Paste!E` and never used. Sort by "ADP + tiers" to see the break lines.
 
**News** — the `Change driver` notes (39 players have them) now show as an amber dot on the row and full text in the detail sheet, instead of living on a tab you'd never open mid-draft.
 
## Keeping the data fresh
 
A browser can't fetch FantasyPros directly — their tables are JS-rendered and CORS-blocked. So the refresh happens server-side and the app reads the result from its own origin.
 
```
.github/workflows/refresh-data.yml   daily 6am Central cron
        └─ scripts/fetch-fantasypros.mjs
                └─ writes data/players.json  →  app fetches it on launch
```
 
If `data/players.json` is missing, stale, or you're offline, the app falls back to the snapshot baked into `index.html`. Nothing breaks; you just get older numbers. Setup tab always shows which source is live and how old it is.
 
### Two ways the fetch can work
 
**Official API (preferred).** FantasyPros sells API access. Get a key, add it as a repo secret named `FP_API_KEY` (Settings → Secrets and variables → Actions), and the script uses it. Supported and stable.
 
**Page scrape (fallback).** With no key, the script parses the JSON blob the rankings page embeds for its own table. This is unofficial, probably against their terms, and **I could not test it from here** — their pages are JS-rendered, so I couldn't confirm the blob's current shape. Assume the first run needs a debug pass. The script prints exactly which strategy failed and why.
 
The script refuses to write a file with fewer than 150 players, so a bad scrape can never replace good data with garbage.
 
### The path that always works
 
Setup tab → paste any FantasyPros CSV export → **Update players**. It auto-detects columns (`PLAYER NAME`, `AVG`/`ADP`, `RK`, `TIERS`, `FPTS`, `BYE WEEK`, `POS`, `TEAM`), matches on normalized names so suffixes don't break the join, adds anyone new, and tells you how many matched.
 
This is the same export you built the sheet from, it needs no key, and it works from your phone. If the cron is broken the morning of the draft, this is your thirty-second fix.
 
**Bye weeks** now come in through import — the rankings export has a `BYE WEEK` column. Still no K or DST projections anywhere; add those manually by searching a name.
 
## Editing your rankings
 
**Ranks tab.** Position chips, then ▲▼ to move a player one spot. Order persists to the phone and **survives every data refresh** — rankings are stored against player names, separate from the projection layer. ADP and projections update daily underneath; your order stays put.
 
Reset to the sheet's original order any time from Setup.
 
## Comparing players
 
Tap **Compare** (Draft or Ranks tab), then tap up to three players. A tray shows who's selected; hit Compare to open the head-to-head.
 
Fourteen rows — VORP, projected PPG and points, last year and last-8 PPG, ADP, tier, your rank, games, target share, carries, O-line, age, bye — with the best value in each row in green. Any injury or depth-chart notes appear underneath.
 
If all three are the same position, **Rank them in this order** writes that order straight into your manual rankings, leaving everyone else untouched. That's the loop: compare, decide, commit, without leaving the app.
 
## Data sources
 
nflverse 2025 (CC BY 4.0) · FantasyPros consensus · FTN O-line rankings · your own rankings from the sheet as the starting order.
 
## Config
 
Setup tab. Teams, slot, rounds, and every roster slot. Change any of them and replacement level, snake math, and the pick clock all recalculate. Nothing is hardcoded.
 
Defaults: 12 teams, slot 5, 15 rounds, QB1/RB2/WR2/TE1/FLEX1/SUPERFLEX1. **Confirm these** — they were inferred from sheet formulas, never stated anywhere.
 
## Known limits
 
- Picks record *that* a player is gone, not which team took him. Positional-run detection works from the log; "which rival still needs a QB" does not.
- Availability model assumes independence between players and ignores that a run just happened.
- Projections come from one source. The derived target-share model from the sheet (`Data!AB`) isn't ported yet — that's the highest-value next addition, since disagreement between two projections is where the edge is.
 
