// Live READ smoke test for the ProofBounty dApp against Bradbury production.
// Uses the same SDK (genlayer-js) and the same node RPC endpoint as the
// dApp's read path, and takes the contract address from the dApp's own
// src/lib/config.js so what is tested is what the app is configured with.
// No wallet, no writes. Run: npm run smoke
import { readFileSync } from "node:fs";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const configSrc = readFileSync(new URL("./src/lib/config.js", import.meta.url), "utf8");
const addrMatch = configSrc.match(/"0x[0-9a-fA-F]{40}"/);
if (!addrMatch) throw new Error("CONTRACT_ADDRESS not found in src/lib/config.js");
const ADDR = addrMatch[0].slice(1, -1);
console.log(`contract (from src/lib/config.js): ${ADDR}`);

const client = createClient({
  chain: testnetBradbury,
  endpoint: "https://rpc-bradbury.genlayer.com",
});

function parse(raw) {
  if (typeof raw !== "string") return raw;
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { s = JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  try { return JSON.parse(s); } catch { return s; }
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const config = parse(await client.readContract({ address: ADDR, functionName: "get_config", args: [] }));
console.log("\nget_config():");
console.log(JSON.stringify(config, null, 2));
check("get_config returns an object", !!config && typeof config === "object");
check("min_reward is 0.01 GEN (10000000000000000 wei)", config?.min_reward === "10000000000000000", config?.min_reward);
check("commit_bond is 0.001 GEN (1000000000000000 wei)", config?.commit_bond === "1000000000000000", config?.commit_bond);
check("reveal_window 86400 / assess_window 604800", config?.reveal_window === "86400" && config?.assess_window === "604800",
  `${config?.reveal_window}/${config?.assess_window}`);

const open = parse(await client.readContract({ address: ADDR, functionName: "list_bounties", args: ["OPEN", 0, 50] }));
console.log('\nlist_bounties("OPEN", 0, 50):');
console.log(JSON.stringify(open, null, 2));
check("OPEN list is an array", Array.isArray(open), `entries=${Array.isArray(open) ? open.length : "n/a"}`);
check("OPEN list is non-empty (bounty 1 is live)", Array.isArray(open) && open.length >= 1);
const b1 = Array.isArray(open) ? open[0] : null;
check("first OPEN bounty has state OPEN", b1?.state === "OPEN", b1?.state);
check("first OPEN bounty reward is 0.01 GEN (10000000000000000 wei)", b1?.reward === "10000000000000000", b1?.reward);
if (b1) {
  console.log(`\nbounty 1: title=${JSON.stringify(b1.title)} poster=${b1.poster} deadline=${b1.deadline} reveal_end=${b1.reveal_end} assess_deadline=${b1.assess_deadline} nsubs=${b1.nsubs}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
