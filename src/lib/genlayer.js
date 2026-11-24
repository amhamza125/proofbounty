// GenLayer client for ProofBounty on Bradbury (genlayer-js 2.0.0).
// Plumbing mirrors the proven GrantFlow dApp: reads are walletless against
// the node RPC (the only endpoint that serves gen_call); writes go through
// the user's injected wallet after switching it to Bradbury.
//
// FEE POLICY — ProofBounty has exactly ONE _pay-emitting method:
// withdraw() (it emits the transfer to the caller). Only withdraw carries
// the corrected external allocation (recipient = the payee, callKey =
// CALL_KEY_UNNAMED, budget = 0.0012 GEN = exactly 20x gasLimit 200000 x
// maxGasPrice 300000000, feeValue = roundFees + budget). Every other write
// (post_bounty, commit, reveal, assess, mark_lapsed, expire, cancel) only
// moves on-chain credits, so it uses baseFees() — and its effect is
// verified by reading state afterwards, never by the receipt alone.

import { createClient, encodeExternalMessageFeeParams, MessageType, CALL_KEY_UNNAMED } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { createPublicClient, http, parseAbi } from "viem";
import {
  CHAIN_ID_HEX,
  CHAIN_NAME,
  NODE_RPC_URL,
  EXPLORER_URL,
  CONTRACT_ADDRESS,
} from "./config.js";

// --- fee policy (same measured Bradbury constants as GrantFlow) ----------
const FEE_DISTRIBUTION = {
  leaderTimeunitsAllocation: 100n,
  validatorTimeunitsAllocation: 200n,
  appealRounds: 0n,
  executionBudgetPerRound: 25000000000000000n,
  executionConsumed: 0n,
  totalMessageFees: 0n,
  rotations: [3n],
  maxPriceGenPerTimeUnit: 2n,
  storageFeeMaxGasPrice: 300000000n,
  receiptFeeMaxGasPrice: 300000000n,
};
const BASE_FEE_VALUE = 100000000000010352n; // roundFees with zero message budget

const PAYOUT_GAS_LIMIT = 200000n;
const PAYOUT_MAX_GAS_PRICE = 300000000n;
export const PAYOUT_BUDGET = 1200000000000000n; // 0.0012 GEN = exactly 20x gasLimit*maxGasPrice

const FEE_MANAGER_ABI = parseAbi([
  "function calculateRoundFees((uint256 leaderTimeunitsAllocation, uint256 validatorTimeunitsAllocation, uint256 appealRounds, uint256 executionBudgetPerRound, uint256 executionConsumed, uint256 totalMessageFees, uint256[] rotations, uint256 maxPriceGenPerTimeUnit, uint256 storageFeeMaxGasPrice, uint256 receiptFeeMaxGasPrice) _feesDistribution, uint256 _numOfValidators, uint256 round) view returns (uint256 totalFeesToPay)",
]);

/** Plain fees for calls that never emit a transfer (credits only). */
export function baseFees() {
  return {
    distribution: { ...FEE_DISTRIBUTION, rotations: [...FEE_DISTRIBUTION.rotations] },
    messageAllocations: [],
    feeValue: BASE_FEE_VALUE,
  };
}

/** Live roundFees from the FeeManager; falls back to the measured constant. */
async function liveRoundFees(totalMessageFees) {
  try {
    const pc = createPublicClient({ chain: testnetBradbury, transport: http(NODE_RPC_URL) });
    const distribution = {
      ...FEE_DISTRIBUTION,
      rotations: [...FEE_DISTRIBUTION.rotations],
      totalMessageFees,
    };
    const roundFees = await pc.readContract({
      address: testnetBradbury.feeManagerContract.address,
      abi: FEE_MANAGER_ABI,
      functionName: "calculateRoundFees",
      args: [distribution, 5n, 0n],
    });
    return BigInt(roundFees);
  } catch {
    return BASE_FEE_VALUE;
  }
}

/** Fees for the one _pay-emitting call: withdraw() -> the caller. */
export async function payoutFees(payee) {
  const roundFees = await liveRoundFees(PAYOUT_BUDGET);
  const feeParams = encodeExternalMessageFeeParams({
    gasLimit: PAYOUT_GAS_LIMIT,
    maxGasPrice: PAYOUT_MAX_GAS_PRICE,
  });
  return {
    distribution: {
      ...FEE_DISTRIBUTION,
      rotations: [...FEE_DISTRIBUTION.rotations],
      totalMessageFees: PAYOUT_BUDGET,
    },
    messageAllocations: [
      {
        messageType: MessageType.External,
        onAcceptance: false,
        parentIndex: (1n << 256n) - 1n, // root
        recipient: payee,
        callKey: CALL_KEY_UNNAMED, // bare transfer: empty calldata -> zero key
        budget: PAYOUT_BUDGET,
        feeParams,
      },
    ],
    feeValue: roundFees + PAYOUT_BUDGET,
  };
}

// --- wallet ---------------------------------------------------------------
let activeProvider = null;
export function setWalletProvider(p) {
  activeProvider = p || null;
}
export function walletProvider() {
  return activeProvider || (typeof window !== "undefined" ? window.ethereum : null);
}

export async function connectWallet(provider) {
  const eth = provider || walletProvider();
  if (!eth) {
    throw new Error("No EVM wallet detected. Install MetaMask or Rabby first.");
  }
  // ORDER MATTERS — accounts FIRST, chain switch second. Some wallet apps
  // (OKX in-app browser) silently drop a chain-switch call from a site that
  // is not connected yet; the promise never settles and the user sees a
  // spinner forever. (Lesson carried over from the GrantFlow dApp.)
  const accounts = await requestWithTimeout(eth, "eth_requestAccounts", null, "accounts");
  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts authorized in wallet.");
  }
  try {
    await requestWithTimeout(eth, "wallet_switchEthereumChain", [{ chainId: CHAIN_ID_HEX }], "chain switch");
  } catch (err) {
    const code = err && err.code;
    const nestedCode = err && err.data && err.data.originalError && err.data.originalError.code;
    const msg = (err && err.message) || "";
    const chainNotAdded =
      code === 4902 ||
      code === -32603 ||
      nestedCode === 4902 ||
      /unrecognized chain|chain.*not added|4902/i.test(msg);
    if (chainNotAdded) {
      await requestWithTimeout(
        eth,
        "wallet_addEthereumChain",
        [
          {
            chainId: CHAIN_ID_HEX,
            chainName: CHAIN_NAME,
            rpcUrls: [NODE_RPC_URL],
            nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
            blockExplorerUrls: [EXPLORER_URL],
          },
        ],
        "add chain"
      );
    } else {
      throw err;
    }
  }
  return accounts[0];
}

// A hung provider request must surface, never hang the tap.
function requestWithTimeout(provider, method, params, stepLabel, timeoutMs = 12000) {
  return Promise.race([
    provider.request(params ? { method, params } : { method }),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `The wallet did not answer the ${stepLabel} request. No approval appeared — the wallet may be locked, or the request was blocked. Try again.`
            )
          ),
        timeoutMs
      )
    ),
  ]);
}

// --- clients --------------------------------------------------------------
export function readClient() {
  return createClient({ chain: testnetBradbury, endpoint: NODE_RPC_URL });
}

export function writeClient(account) {
  return createClient({ chain: testnetBradbury, account, provider: walletProvider() });
}

// --- reads ----------------------------------------------------------------
export function parseResult(raw) {
  if (typeof raw !== "string") return raw;
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function parseJson(raw) {
  const s = parseResult(raw);
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function readView(functionName, args = []) {
  const client = readClient();
  return client.readContract({ address: CONTRACT_ADDRESS, functionName, args });
}

export async function readJsonView(functionName, args = []) {
  return parseJson(await readView(functionName, args));
}

export async function ethBalance(address) {
  const r = await fetch(NODE_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  const j = await r.json();
  if (typeof j.result !== "string") throw new Error("eth_getBalance failed");
  return BigInt(j.result);
}

// --- writes ---------------------------------------------------------------
/**
 * Send a write and wait for FINALIZED consensus.
 * `fees` must be payoutFees(payee) for withdraw(), baseFees() otherwise.
 * `opts.onHash` fires with the tx hash as soon as the wallet returns it.
 * Resolves with { hash, receipt }. Throws on a FINISHED_WITH_ERROR receipt
 * (the contract rejected the call — e.g. POSTER_COMMIT, BAD_BOND).
 */
export async function sendWrite(account, functionName, args = [], value = 0n, fees = null, opts = {}) {
  const client = writeClient(account);
  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value,
    fees: fees || baseFees(),
  });
  if (typeof opts.onHash === "function") {
    try {
      opts.onHash(hash);
    } catch {
      // A progress hook must never break the write.
    }
  }
  let receipt = null;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash,
      waitUntil: "finalized",
      retries: 360,
      interval: 5000,
    });
  } catch {
    // Receipt polling can time out on slow consensus; the tx hash is still
    // usable in the explorer, so don't fail the whole flow here.
  }
  if (receipt) {
    receipt.execName = receipt.txExecutionResultName || receipt.execName || null;
    receipt.statusName = receipt.statusName || receipt.status_name || null;
    if (receipt.execName === "FINISHED_WITH_ERROR") {
      throw new Error(
        `The contract rejected this call (tx ${hash}). Open it in the explorer to see the exact reason.`
      );
    }
  }
  return { hash, receipt };
}

/**
 * A FINISHED_WITH_RETURN receipt does NOT prove a payout landed.
 * Only the recipient's balance delta does.
 */
export async function balanceDelta(address, beforeWei) {
  const after = await ethBalance(address);
  const delta = after - beforeWei;
  return { before: beforeWei, after, deltaWei: delta, landed: delta !== 0n };
}

// --- formatting helpers ---------------------------------------------------
export function shortAddress(addr) {
  if (!addr || addr.length < 12) return addr || "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export function genToWei(gen) {
  const s = String(gen).trim();
  if (!s || Number.isNaN(Number(s)) || Number(s) <= 0) {
    throw new Error("Enter a GEN amount greater than 0.");
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 18) throw new Error("Too many decimal places (max 18).");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded || "0");
}

export function weiToGen(wei) {
  try {
    const w = BigInt(wei);
    const whole = w / 10n ** 18n;
    const frac = w % 10n ** 18n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "").slice(0, 6);
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return "0";
  }
}

/** Seconds -> "24 h", "7 d", "45 min", "30 s" for board display. */
export function formatDuration(secs) {
  const n = Number(secs);
  if (!Number.isFinite(n)) return "—";
  if (n % 86400 === 0) return `${n / 86400} d`;
  if (n % 3600 === 0) return `${n / 3600} h`;
  if (n % 60 === 0) return `${n / 60} min`;
  return `${n} s`;
}

/** Unix seconds -> readable local date/time. */
export function formatTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Unix seconds -> "in 3 d 4 h" / "2 h ago". */
export function formatRelative(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const diff = n - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diff);
  const parts = [];
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (!d && m) parts.push(`${m} min`);
  if (!parts.length) parts.push("under a minute");
  return diff >= 0 ? `in ${parts.join(" ")}` : `${parts.join(" ")} ago`;
}

export function friendlyError(err) {
  const msg = (err && (err.shortMessage || err.message)) || "Transaction failed.";
  return msg.length > 260 ? msg.slice(0, 260) + "…" : msg;
}

export { CONTRACT_ADDRESS, TransactionStatus };
