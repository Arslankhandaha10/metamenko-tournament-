# Weekly Tournament Coordinator (GitHub Actions)

Free serverless coordinator. Runs every 5 minutes via GitHub Actions cron. Reads tournament configuration and live state from Firestore (Spark plan), drives the state machine through registration → Swiss → top-cut → finalize.

## Why GitHub Actions

- Completely free for public repos (and very generous free minutes for private).
- No credit card required.
- Same `firebase-admin` SDK Cloud Functions use, so migrating later is trivial.

## Setup

1. **Create a Firebase service account:**
   - Firebase Console → Project Settings → Service accounts → Generate new private key.
   - Download the JSON file. **Never commit it.**
2. **Add the JSON as a GitHub Actions secret:**
   - Repo → Settings → Secrets and variables → Actions → New secret.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: the entire JSON contents.
3. **Push this folder to your GitHub repo** at `coordinator/` (or wherever — adjust paths in workflow).
4. **Add the workflow** at `.github/workflows/tournament-tick.yml` (sample below).
5. **Push tournament config to Firestore** (pick ONE):

   **Option A — Automated (recommended)**
   1. In Unity, select your `WtConfig` asset.
   2. Menu: `Tools → Weekly Tournament → Save Selected Config JSON to Coordinator`.
      - Writes `Coordinator~/config.json` and `Coordinator~/config.docpath`.
   3. From a terminal:
      ```
      cd Assets/Scripts/Modules/WeeklyTournament/Tools/Coordinator~
      # PowerShell:
      $env:FIREBASE_SERVICE_ACCOUNT = Get-Content path\to\service-account.json -Raw
      # bash/zsh:
      # export FIREBASE_SERVICE_ACCOUNT="$(cat path/to/service-account.json)"
      npm install        # first time only
      npm run push-config
      ```
   4. Verify in Firebase Console → Firestore → the document path printed by the script.

   Add `--dry-run` to validate without writing, e.g. `node push-config.js --dry-run`.

   **Option B — Manual paste (legacy)**
   1. In Unity, select your `WtConfig` asset.
   2. Menu: `Tools → Weekly Tournament → Copy Selected Config JSON to Clipboard`.
   3. Firebase Console → Firestore → create document at `tournament_config/active`.
   4. Paste each field of the JSON manually.

## Sample Workflow YAML

Place at `.github/workflows/tournament-tick.yml` in your repo root:

```yaml
name: tournament-tick
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: coordinator
      - name: Run tick
        working-directory: coordinator
        env:
          FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
        run: npm run tick
```

## Local Test

```
cd coordinator
npm install
FIREBASE_SERVICE_ACCOUNT="$(cat ~/secret.json)" npm run tick
```

## Files

- `package.json` — dependencies and npm scripts (`tick`, `push-config`).
- `tick.js` — entry point for GitHub Actions. Reads config + meta, advances phase if appropriate.
- `push-config.js` — one-shot uploader for `WtConfig` JSON. See setup step 5 / Option A above.
- `lib/firebase.js` — admin SDK initialization.
- `lib/cycle.js` — phase/cycle math (mirror of `WtCycleHelper.cs`).
- `lib/swiss.js` — pairing helper for Swiss rounds (legacy / optional).
- `lib/elimination.js` — single-elimination bracket.
- `lib/registry.js` — multi-room registry helpers.
- `firestore.rules` — security rules. Deploy via `firebase deploy --only firestore:rules`
   or by pasting into Firebase Console → Firestore → Rules tab.

### Generated / git-ignored (created by `push-config` workflow)

- `config.json` — local snapshot of the WtConfig payload. Safe to commit if you
   want a versioned record, but typically regenerated per push so consider
   adding it to `.gitignore` if you bounce between testing and production values.
- `config.docpath` — single line, the Firestore document path the editor menu
   captured from `WtConfig.configDocumentPath`. Same git advice as above.

## Schema

```
tournament_config/active                                  ← config (pushed from Unity editor menu)
tournament_cycles/{cycleId}/meta/info                     ← phase, currentRound
tournament_cycles/{cycleId}/participants/{userId}         ← registration + swiss stats
tournament_cycles/{cycleId}/active_matches/{matchDocId}   ← R0_M0, R0_M1, ...
tournament_cycles/{cycleId}/final_results/info            ← champion, runner-up, top cut
tournament_cycles/{cycleId}/reward_claims/{userId}        ← marker doc for claim idempotency
```

`matchDocId` format: `R{roundIndex}_M{matchIndex}`.
