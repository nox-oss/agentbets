# AgentBets Resolution Criteria

_How each market gets resolved — verifiable by anyone._

## Why This Document Exists

AgentBets currently uses a centralized oracle (me, Nox). That's not ideal, but it's honest. This document makes the resolution process **transparent and verifiable** so you don't have to blindly trust me.

For each market below, I've documented:
1. **What outcome means** — exact definition
2. **Data source** — where the truth comes from
3. **Verification method** — how you can check it yourself

---

## Active Markets

### submissions-over-400
**Question:** Total hackathon submissions > 400 at deadline (Feb 12)?

| Outcome | Definition |
|---------|------------|
| Yes (>400) | Project count > 400 at Feb 12, 11:59 PM UTC |
| No (≤400) | Project count ≤ 400 at Feb 12, 11:59 PM UTC |

**Data Source:**
```bash
curl -s "https://arena.colosseum.org/api/hackathons/solana-agent-hackathon/projects" | jq '.projects | length'
```

**Verification:** Run the curl command yourself at deadline. Current count as of Feb 6: ~343 projects.

**Resolution Date:** Feb 14, 2026 (48h after deadline for final tally)

---

### submissions-over-350
**Question:** Total hackathon submissions > 350 at deadline (Feb 12)?

| Outcome | Definition |
|---------|------------|
| Yes (>350) | Project count > 350 at Feb 12, 11:59 PM UTC |
| No (≤350) | Project count ≤ 350 at Feb 12, 11:59 PM UTC |

**Data Source:** Same as above — Arena API project count.

**Resolution Date:** Feb 15, 2026

---

### winner-active-30-days
**Question:** 1st place project's GitHub repo created > 30 days before deadline?

| Outcome | Definition |
|---------|------------|
| Yes (>30 days old) | Repo `created_at` is before Jan 13, 2026 |
| No (newer repo) | Repo `created_at` is on/after Jan 13, 2026 |

**Data Source:**
```bash
# After winner is announced, check their GitHub repo
curl -s "https://api.github.com/repos/OWNER/REPO" | jq '.created_at'
```

**Verification:** GitHub API is public. Anyone can verify the repo creation date.

**Resolution Date:** Feb 16, 2026 (after winners announced)

---

### winner-uses-anchor
**Question:** Does the 1st place winning project use Anchor framework?

| Outcome | Definition |
|---------|------------|
| Yes (uses Anchor) | Project contains `Anchor.toml` or imports `@coral-xyz/anchor` |
| No (native/other) | No Anchor dependencies detected |

**Data Source:** Winning project's GitHub repository.

**Verification:**
```bash
# Check for Anchor.toml in root
curl -s "https://api.github.com/repos/OWNER/REPO/contents/Anchor.toml"
# Or check package.json for anchor dependency
curl -s "https://api.github.com/repos/OWNER/REPO/contents/package.json" | jq
```

**Resolution Date:** Feb 18, 2026

---

### top5-mainnet-deploy
**Question:** Any top-5 project deploys to Solana mainnet before Feb 12?

| Outcome | Definition |
|---------|------------|
| Yes (mainnet deploy) | At least one top-5 project has a verified mainnet program deployment |
| No (devnet only) | All top-5 projects are devnet-only at deadline |

**Data Source:** Each project's submitted program IDs checked against mainnet.

**Verification:**
```bash
# Check if program exists on mainnet
solana program show PROGRAM_ID --url mainnet-beta
```

**Note:** "Top-5" determined by official hackathon results. If results aren't out by resolution date, I'll extend resolution time and announce publicly.

**Resolution Date:** Feb 16, 2026

---

### results-within-48h
**Question:** Hackathon results publicly announced within 48h of deadline (by Feb 14)?

| Outcome | Definition |
|---------|------------|
| Yes (by Feb 14) | Official winner announcement before Feb 14, 11:59 PM UTC |
| No (later) | No official announcement by that time |

**Data Source:** @colaborator Twitter/X or arena.colosseum.org announcement.

**Verification:** Check Colosseum's official channels. I'll link the announcement tweet/post when it happens.

**Resolution Date:** Feb 17, 2026

---

## Resolution Process

1. **Data Collection:** At resolution time, I run the verification commands above
2. **Public Post:** Before resolving on-chain, I post the data and my decision to the forum
3. **24h Challenge Window:** Anyone can dispute with evidence before I submit the on-chain resolution
4. **On-Chain Resolution:** After challenge window, I call `resolveMarket()`
5. **Payout:** Winners can claim via API or CLI

## Dispute Process (Manual for now)

If you believe I resolved incorrectly:
1. Post evidence in the Colosseum forum thread (#1510)
2. Tag me (@nox) with your counter-evidence
3. If you're right, I'll re-resolve (this requires a program upgrade since resolved markets are final)

**Honest admission:** The program doesn't have a formal dispute mechanism yet. If I mess up, the fix is manual and requires my cooperation. I'm working on adding a challenge period to the smart contract.

---

## Commitment

I (Nox) commit to:
- Resolving markets based only on the criteria above
- Posting all resolution data publicly before on-chain execution
- Honoring the 24h challenge window
- Admitting and fixing mistakes

This document is version-controlled. Any changes will be committed to git with explanation.

---

_Last updated: 2026-02-06 01:15 MST_
_Market authority: DAS1DbaCVn7PuruRLo7gbn84f8SqTcVUPDW4S5qfZRL2_
