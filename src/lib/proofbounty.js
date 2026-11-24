// ProofBounty contract wrappers — method names and argument shapes match
// ProofBounty.py EXACTLY (production 0xa6C34451…B769 on Bradbury):
//
//   post_bounty(title: str, criteria: str, deadline_ts: bigint)  payable
//   commit(bounty_id: bigint, commit_hash: str)                  payable (bond)
//   reveal(bounty_id: bigint, proof_url: str, nonce: str)
//   assess(bounty_id: bigint, submission_id: bigint)
//   mark_lapsed(bounty_id: bigint, submission_id: bigint)
//   expire(bounty_id: bigint)
//   cancel(bounty_id: bigint)
//   withdraw()
//   get_bounty(bounty_id) / list_bounties(state, offset, limit)
//   get_submission(bounty_id, submission_id) / list_submissions(bounty_id)
//   get_balance(addr) -> str wei / get_config() -> JSON str
//
// All view methods return JSON strings on-chain (jd(...)) except
// get_balance, which returns the wei amount as a plain string.
import {
  readJsonView,
  readView,
  parseResult,
  sendWrite,
  baseFees,
  payoutFees,
  ethBalance,
  balanceDelta,
} from "./genlayer.js";

// --- reads ------------------------------------------------------------------
export async function readConfig() {
  return readJsonView("get_config", []);
}

/**
 * Every bounty on the board, oldest first, each with its `id` attached.
 * NOTE: the contract's bounty records carry no id field — list_bounties
 * walks ids 1..next_id-1 in ascending order, so a record's id is its
 * position in the unfiltered ("ALL") list. We page through "ALL"
 * (the contract caps each call at 50) and number the results; the UI
 * filters by state client-side. Ids are append-only on-chain, so the
 * numbering is exact.
 */
export async function readAllBounties() {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await readJsonView("list_bounties", ["ALL", offset, 50]);
    const arr = Array.isArray(page) ? page : [];
    arr.forEach((b, i) => out.push({ ...b, id: String(offset + i + 1) }));
    if (arr.length < 50) break;
    offset += 50;
  }
  return out;
}

export async function readBounty(bountyId) {
  return readJsonView("get_bounty", [Number(bountyId)]);
}

export async function readSubmissions(bountyId) {
  const v = await readJsonView("list_submissions", [Number(bountyId)]);
  return Array.isArray(v) ? v : [];
}

/** The GEN the contract owes this address (winnings, refunds, returned bonds). */
export async function readBalance(address) {
  const raw = await readView("get_balance", [address]);
  try {
    return BigInt(parseResult(raw) ?? "0");
  } catch {
    return 0n;
  }
}

// --- writes -----------------------------------------------------------------
export function postBounty(account, { title, criteria, deadlineTs, rewardWei }, opts) {
  return sendWrite(account, "post_bounty", [title, criteria, Number(deadlineTs)], rewardWei, baseFees(), opts);
}

export function commitProof(account, bountyId, commitHash, bondWei, opts) {
  return sendWrite(account, "commit", [Number(bountyId), commitHash], bondWei, baseFees(), opts);
}

export function revealProof(account, bountyId, proofUrl, nonce, opts) {
  return sendWrite(account, "reveal", [Number(bountyId), proofUrl, nonce], 0n, baseFees(), opts);
}

export function assessSubmission(account, bountyId, submissionId, opts) {
  return sendWrite(account, "assess", [Number(bountyId), Number(submissionId)], 0n, baseFees(), opts);
}

export function markLapsed(account, bountyId, submissionId, opts) {
  return sendWrite(account, "mark_lapsed", [Number(bountyId), Number(submissionId)], 0n, baseFees(), opts);
}

export function expireBounty(account, bountyId, opts) {
  return sendWrite(account, "expire", [Number(bountyId)], 0n, baseFees(), opts);
}

export function cancelBounty(account, bountyId, opts) {
  return sendWrite(account, "cancel", [Number(bountyId)], 0n, baseFees(), opts);
}

/**
 * withdraw() is the only _pay-emitting call: it carries payoutFees(account)
 * and the result is proven by the caller's native balance delta, not by
 * the receipt. Resolves with { hash, receipt, before, after, deltaWei, landed }.
 */
export async function withdrawFunds(account, opts) {
  const before = await ethBalance(account);
  const fees = await payoutFees(account);
  const { hash, receipt } = await sendWrite(account, "withdraw", [], 0n, fees, opts);
  const delta = await balanceDelta(account, before);
  return { hash, receipt, ...delta };
}
