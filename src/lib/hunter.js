// Hunter-side commit–reveal helpers.
//
// The contract's commit_hash is SHA-256 over the UTF-8 bytes of
// (proof_url + hunter + nonce) — plain concatenation, no separators —
// where hunter is the committer's lowercase 0x address (ProofBounty.py:
// `_sha((str(proof_url) + hunter + str(nonce)).encode("utf-8"))`).
// The dApp computes it in the browser with Web Crypto and keeps the
// (bounty, url, nonce) triple in localStorage so the hunter can reveal
// later from the same browser. Nothing about the proof is sent anywhere
// before the reveal transaction itself.

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeCommitHash(proofUrl, hunterAddress, nonce) {
  return sha256Hex(String(proofUrl) + String(hunterAddress).toLowerCase() + String(nonce));
}

/** A fresh nonce: 16 random bytes as hex (32 chars). */
export function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- localStorage store: one record per (wallet, bounty) -------------------
const keyFor = (wallet) => `proofbounty:commits:${String(wallet).toLowerCase()}`;

export function loadCommits(wallet) {
  if (!wallet) return [];
  try {
    const raw = localStorage.getItem(keyFor(wallet));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(wallet, records) {
  try {
    localStorage.setItem(keyFor(wallet), JSON.stringify(records));
  } catch {
    // Storage full/blocked: the commit tx still lands on-chain, but the
    // hunter must keep their own copy of url + nonce. The UI says so.
  }
}

/** Record shape: { bountyId, url, nonce, commitHash, createdAt } */
export function saveCommit(wallet, record) {
  const records = loadCommits(wallet).filter((r) => String(r.bountyId) !== String(record.bountyId));
  records.push(record);
  saveAll(wallet, records);
}

export function findCommit(wallet, bountyId) {
  return loadCommits(wallet).find((r) => String(r.bountyId) === String(bountyId)) || null;
}

export function removeCommit(wallet, bountyId) {
  saveAll(
    wallet,
    loadCommits(wallet).filter((r) => String(r.bountyId) !== String(bountyId))
  );
}
