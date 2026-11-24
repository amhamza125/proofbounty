# ProofBounty

**Post a bounty, lock the reward, and let proof do the talking — the first hunter whose proof a GenLayer jury validates takes the pot.**

ProofBounty is an open bounty market built on a GenLayer Intelligent Contract (Bradbury testnet, chain 4221). A poster describes a deliverable, writes the acceptance criteria, and locks a GEN reward in the contract. Hunters race to deliver — but nobody can copy anybody else's work, because submissions are **commit–reveal**: a hunter first commits a hash of their proof, and only reveals the proof itself inside the reveal window. A validator jury fetches the revealed page and judges it against the poster's criteria. The first `VALID` proof wins the reward; if nobody delivers, the poster is refunded in full.

## Live app

**https://proofbounty-ameer-hamza-s-projects2.vercel.app**

## Contracts

| | Address |
|---|---|
| Production | `0xa6C34451EF9f78CC9CC00809cc2385729A62B769` |
| Proof twin | `0xd6d899cc4df4747A1A1c39ecE3C9a0438a8B62b3` |

## How it works

1. **Post** — `post_bounty(title, criteria, deadline_ts)` with the reward attached (minimum 0.01 GEN on production). The full reward is locked in the contract; the poster's criteria are the exact text the jury will judge against.
2. **Commit** — a hunter calls `commit(bounty_id, commit_hash)` with a small bond (0.001 GEN on production). The hash is `SHA-256(proof_url + hunter address + nonce)`, computed in the hunter's own browser — the proof stays secret, so a rival can't lift a finished deliverable and re-file it.
3. **Reveal** — after the bounty deadline, hunters reveal with `reveal(bounty_id, proof_url, nonce)`. The contract re-computes the hash: a reveal that doesn't match its commit is rejected, and a proof that turns out to be an earlier commit's copy is marked `SHADOWED` and can't win. A revealed hunter gets their bond credited back.
4. **Judge** — anyone calls `assess(bounty_id, submission_id)`. The jury fetches the proof page and checks it against the criteria. A `VALID` verdict pays the hunter the reward on the spot and closes the bounty; an `INVALID` verdict leaves the bounty open for the next reveal.
5. **Settle the rest** — a commit that is never revealed can be marked lapsed after the reveal window, and its bond goes to the poster. A bounty that expires with no valid proof refunds the poster in full. Winnings, refunds and returned bonds collect as on-chain balances and are paid out with `withdraw()`.

## Features

- **Commit–reveal submissions** — proofs stay hidden until the reveal window, so original work can't be copied for the win.
- **Commit bond** — every commit stakes a small bond, returned on reveal; a hunter who commits and never reveals forfeits it to the poster.
- **First valid proof wins** — the jury judges against the poster's own criteria, and payment is immediate on a `VALID` verdict.
- **Full poster refund** — if no valid proof arrives before expiry, the locked reward comes back whole.
- **Shadow protection** — a revealed proof identical to an earlier commit is flagged and can never take the pot.
- **Pull-pattern payouts** — all credits land in per-account balances, withdrawn in one call.

## Contract methods

Writes: `post_bounty`, `commit`, `reveal`, `assess`, `mark_lapsed`, `expire`, `cancel`, `withdraw`

Reads: `get_config`, `get_bounty`, `list_bounties`, `list_submissions`, `get_balance`

## The dApp

The board in this repo (`src/`) is a Vite + React app that talks to the production contract through genlayer-js: open bounties as pinned notices, a post-a-bounty form, the hunter's commit–reveal panel (the hash is computed locally in the browser with Web Crypto and the reveal secret kept in the hunter's own browser storage), submission states, and a balance slip for winnings and refunds. Every number on the page is read from the chain, and every action calls the contract method of the same name.

## Run it locally

```bash
npm install
npm run dev      # local board
npm run build    # production build to dist/
```

The contract address defaults to production; set `VITE_CONTRACT_ADDRESS` to point the board at another deployment.
