// Wallet discovery for ProofBounty.
// Injected wallets are discovered via EIP-6963 (MetaMask, Rabby, Brave,
// OKX, …) plus the legacy window.ethereum fallback, and listed by name in
// the connect chooser — the user picks, the app never guesses.
// WalletConnect is not offered: there is no Reown Cloud project ID for
// this project, and shipping a dead or shared ID would be worse than a
// clear "use a browser wallet" message.
import { connectWallet, setWalletProvider } from "./genlayer.js";

/**
 * Discover injected wallets via EIP-6963. Returns [{ id, name, provider }].
 * Never throws: an empty list means "no injected wallet found".
 */
export function discoverInjectedWallets(timeoutMs = 700) {
  return new Promise((resolve) => {
    const found = new Map(); // provider object -> { id, name, provider }
    const guessName = (eth) => {
      if (!eth) return "Injected wallet";
      if (eth.isOkxWallet || eth.isOKExWallet) return "OKX Wallet";
      if (eth.isMetaMask) return "MetaMask";
      if (eth.isRabby) return "Rabby";
      if (eth.isBraveWallet) return "Brave Wallet";
      if (eth.isCoinbaseWallet) return "Coinbase Wallet";
      if (eth.isTrust) return "Trust Wallet";
      return "Browser wallet";
    };
    const add = (provider, name, id) => {
      if (!provider || typeof provider.request !== "function") return;
      if (found.has(provider)) return;
      found.set(provider, { id: id || `injected-${found.size}`, name, provider });
    };
    const onAnnounce = (event) => {
      const detail = event?.detail || {};
      if (detail.provider) add(detail.provider, detail.info?.name || "Injected wallet", detail.info?.rdns || detail.info?.uuid);
    };
    try {
      window.addEventListener("eip6963:announceProvider", onAnnounce);
      window.dispatchEvent(new window.Event("eip6963:requestProvider"));
    } catch {
      // EIP-6963 unsupported — the legacy fallback below still runs.
    }
    setTimeout(() => {
      try {
        window.removeEventListener("eip6963:announceProvider", onAnnounce);
      } catch {}
      if (typeof window !== "undefined" && window.ethereum) {
        add(window.ethereum, guessName(window.ethereum), "legacy-ethereum");
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/** Connect an injected provider: accounts first, then Bradbury switch. */
export async function connectInjected(provider) {
  setWalletProvider(provider);
  return connectWallet(provider);
}
