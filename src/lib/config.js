// ProofBounty — Bradbury configuration.
// Contract: ProofBounty on GenLayer Bradbury (chain 4221), production.

export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS ||
  "0xa6C34451EF9f78CC9CC00809cc2385729A62B769";

export const CHAIN_ID = 4221;
export const CHAIN_ID_HEX = "0x107d"; // 4221
export const CHAIN_NAME = "GenLayer Bradbury Testnet";
export const NODE_RPC_URL = "https://rpc-bradbury.genlayer.com"; // gen_call lives here
export const EXPLORER_URL = "https://explorer-bradbury.genlayer.com";
export const DOCS_URL = "https://docs.genlayer.com";

export const explorerAddressUrl = (addr) => `${EXPLORER_URL}/address/${addr}`;
export const explorerTxUrl = (hash) => `${EXPLORER_URL}/tx/${hash}`;
