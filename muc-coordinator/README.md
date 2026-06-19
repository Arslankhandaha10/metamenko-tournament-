# Most Used Card — Coordinator (GitHub Actions)

Free serverless coordinator. Runs on GitHub Actions cron. Reads MUC config from
Firestore, finalizes cycles, picks winners, and processes reward claims.

## How it works

| Workflow | Schedule | Script | What it does |
|---|---|---|---|
| `muc-tick.yml` | Every 10 min | `tick.js` | Finalizes completed cycles, picks winners, writes `muc_top_winners` |
| `muc-claims.yml` | Every 5 min | `claims-tick.js` | Verifies pending claims via on-chain ownership, grants/rejects rewards |

## Setup

### 1. Add GitHub Secret

Go to: **Repo → Settings → Secrets and variables → Actions → New repository secret**

```
Name:  FIREBASE_SERVICE_ACCOUNT
Value: <entire contents of your Firebase service account JSON>
```

Get the JSON from: **Firebase Console → Project Settings → Service Accounts → Generate new private key**

### 2. Push to main branch

Workflows only run automatically from the **default branch (main)**.

### 3. Test manually

GitHub → **Actions** tab → select a workflow → **Run workflow** button.

## File structure

```
muc-coordinator/
├── tick.js           — cycle finalizer entry point
├── claims-tick.js    — claim processor entry point
├── push-config.js    — pushes Unity MucConfig JSON to Firestore
├── package.json
├── .gitignore
└── lib/
    ├── firebase.js        — firebase-admin init (reads FIREBASE_SERVICE_ACCOUNT env)
    ├── cycle.js           — pure cycle math (mirrors MucCycleHelper.cs)
    ├── aggregate.js       — pure event aggregation
    ├── pickWinners.js     — pure winner selection with tie handling
    ├── claims.js          — claim verification + atomic grant pipeline
    └── verifyOwnership.js — on-chain NFT ownership check via Movement Indexer
```

## Push config to Firestore

```bash
export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
node push-config.js path/to/MucConfig.json
```
