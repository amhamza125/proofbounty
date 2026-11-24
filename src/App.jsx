import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CONTRACT_ADDRESS,
  DOCS_URL,
  explorerAddressUrl,
  explorerTxUrl,
} from "./lib/config.js";
import {
  shortAddress,
  weiToGen,
  genToWei,
  formatDuration,
  formatTs,
  formatRelative,
  friendlyError,
  ethBalance,
} from "./lib/genlayer.js";
import { discoverInjectedWallets, connectInjected } from "./lib/wallet.js";
import {
  readConfig,
  readAllBounties,
  readBounty,
  readSubmissions,
  readBalance,
  postBounty,
  commitProof,
  revealProof,
  assessSubmission,
  markLapsed,
  expireBounty,
  cancelBounty,
  withdrawFunds,
} from "./lib/proofbounty.js";
import {
  computeCommitHash,
  makeNonce,
  saveCommit,
  findCommit,
  removeCommit,
} from "./lib/hunter.js";

const FILTERS = ["ALL", "OPEN", "PAID", "EXPIRED", "CANCELLED"];
const nowSeconds = () => Math.floor(Date.now() / 1000);

function Stamp({ state }) {
  return <span className={`stamp ${state}`}>{state.replace("_", " ")}</span>;
}

function TxNote({ note }) {
  if (!note) return null;
  return (
    <div className={`note ${note.kind}`}>
      {note.text}{" "}
      {note.hash && (
        <a className="mono" href={explorerTxUrl(note.hash)} target="_blank" rel="noreferrer">
          tx {note.hash.slice(0, 10)}…{note.hash.slice(-6)}
        </a>
      )}
    </div>
  );
}

function NoticeCard({ bounty, onOpen }) {
  return (
    <article className="notice" onClick={() => onOpen(bounty.id)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(bounty.id); }}>
      <div className="pin" />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span className="mono" style={{ color: "var(--ink-faint)" }}>Bounty #{bounty.id}</span>
        <Stamp state={bounty.state} />
      </div>
      <h3>{bounty.title}</h3>
      <div className="reward">
        {weiToGen(bounty.reward)} <small>GEN reward</small>
      </div>
      <dl>
        <dt>Poster</dt>
        <dd className="mono">{shortAddress(bounty.poster)}</dd>
        <dt>Deadline</dt>
        <dd>{formatTs(bounty.deadline)} ({formatRelative(bounty.deadline)})</dd>
        <dt>Reveal by</dt>
        <dd>{formatTs(bounty.reveal_end)}</dd>
        <dt>Assess by</dt>
        <dd>{formatTs(bounty.assess_deadline)}</dd>
        <dt>Submissions</dt>
        <dd>{bounty.nsubs}</dd>
        {bounty.state === "PAID" && bounty.winner && (
          <>
            <dt>Winner</dt>
            <dd className="mono">{shortAddress(bounty.winner)}</dd>
          </>
        )}
      </dl>
      <div className="foot">
        <span className="mono" style={{ fontSize: 12, color: "var(--ink-faint)" }}>
          posted {formatTs(bounty.created)}
        </span>
        <span className="open-link">Open notice →</span>
      </div>
    </article>
  );
}

function WalletChooser({ open, onClose, onConnected }) {
  const [wallets, setWallets] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setWallets(null);
    setErr("");
    discoverInjectedWallets().then(setWallets).catch(() => setWallets([]));
  }, [open ]);

  if (!open) return null;

  const pick = async (w) => {
    setBusy(w.id);
    setErr("");
    try {
      const account = await connectInjected(w.provider);
      onConnected(account, w.name);
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Connect a wallet</h3>
        <p>
          ProofBounty writes go through your browser wallet on the GenLayer
          Bradbury testnet (chain 4221). Pick a wallet to connect — you will
          approve the connection there.
        </p>
        {wallets === null && <p>Looking for wallets…</p>}
        {wallets !== null && wallets.length === 0 && (
          <p>
            No browser wallet was found on this device. Install MetaMask or
            Rabby, or open this page inside your wallet app's browser, then
            try again. You can still read the whole board without a wallet.
          </p>
        )}
        {wallets !== null &&
          wallets.map((w) => (
            <button key={w.id} className="wallet-option" disabled={!!busy} onClick={() => pick(w)}>
              {busy === w.id ? "Connecting…" : `Connect ${w.name}`}
            </button>
          ))}
        {err && <div className="note err">{err}</div>}
        <div className="row-actions">
          <button className="btn ghost small" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PostForm({ account, config, onPosted }) {
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [deadlineLocal, setDeadlineLocal] = useState("");
  const [rewardGen, setRewardGen] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const minRewardGen = config ? weiToGen(config.min_reward) : null;
  const minLeadSecs = config ? Number(config.min_lead) : 0;

  const submit = async (e) => {
    e.preventDefault();
    setNote(null);
    try {
      if (!title.trim() || !criteria.trim()) throw new Error("Give the bounty a title and written acceptance criteria.");
      const rewardWei = genToWei(rewardGen);
      if (config && rewardWei < BigInt(config.min_reward)) {
        throw new Error(`The reward must be at least ${minRewardGen} GEN.`);
      }
      if (!deadlineLocal) throw new Error("Pick a deadline.");
      const deadlineTs = Math.floor(new Date(deadlineLocal).getTime() / 1000);
      if (!Number.isFinite(deadlineTs)) throw new Error("That deadline is not a valid date/time.");
      if (deadlineTs - nowSeconds() < minLeadSecs) {
        throw new Error(`The deadline must be at least ${formatDuration(minLeadSecs)} from now.`);
      }
      setBusy(true);
      const { hash } = await postBounty(
        account,
        { title: title.trim(), criteria: criteria.trim(), deadlineTs, rewardWei },
        { onHash: (h) => setNote({ kind: "pending", text: "Bounty sent — waiting for consensus to finalize…", hash: h }) }
      );
      setNote({ kind: "ok", text: "Your bounty is pinned to the board.", hash });
      setTitle(""); setCriteria(""); setDeadlineLocal(""); setRewardGen("");
      onPosted();
    } catch (err) {
      setNote({ kind: "err", text: friendlyError(err), hash: note?.hash });
    } finally {
      setBusy(false);
    }
  };

  if (!account) {
    return (
      <div className="notice-form">
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 14 }}>
          Connect a wallet to pin a new bounty on the board. Reading the board
          needs no wallet.
        </p>
      </div>
    );
  }

  return (
    <form className="notice-form" onSubmit={submit}>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="pb-title">Bounty title</label>
          <input id="pb-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)}
            placeholder="What work needs proving?" />
          <div className="hint">{title.length}/120 characters</div>
        </div>
        <div className="field full">
          <label htmlFor="pb-criteria">Acceptance criteria</label>
          <textarea id="pb-criteria" value={criteria} maxLength={500} onChange={(e) => setCriteria(e.target.value)}
            placeholder="Write exactly what a proof page must show for the jury to pay. The poster cannot judge — these words are the whole contract with hunters." />
          <div className="hint">{criteria.length}/500 characters — the jury judges proofs against this text only.</div>
        </div>
        <div className="field">
          <label htmlFor="pb-reward">Reward (GEN)</label>
          <input id="pb-reward" inputMode="decimal" value={rewardGen} onChange={(e) => setRewardGen(e.target.value)}
            placeholder={minRewardGen ? `min ${minRewardGen}` : ""} />
          <div className="hint">Locked in the contract when you post{minRewardGen ? `; minimum ${minRewardGen} GEN` : ""}.</div>
        </div>
        <div className="field">
          <label htmlFor="pb-deadline">Deadline for commits</label>
          <input id="pb-deadline" type="datetime-local" value={deadlineLocal} onChange={(e) => setDeadlineLocal(e.target.value)} />
          <div className="hint">
            Hunters commit before this time{minLeadSecs ? ` (at least ${formatDuration(minLeadSecs)} from now)` : ""},
            then reveal within {config ? formatDuration(config.reveal_window) : "the reveal window"}.
          </div>
        </div>
      </div>
      <div className="form-actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Pinning…" : "Pin this bounty"}
        </button>
        <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
          If nobody proves it in time, the full reward comes back to your board balance.
        </span>
      </div>
      <TxNote note={note} />
    </form>
  );
}

function CommitReceipt({ record }) {
  if (!record) return null;
  const payload = JSON.stringify(
    {
      app: "ProofBounty",
      bountyId: String(record.bountyId),
      proof_url: record.url,
      nonce: record.nonce,
      commit_hash: record.commitHash,
      savedAt: new Date(record.createdAt || Date.now()).toISOString(),
    },
    null,
    2
  );
  const copy = () => navigator.clipboard?.writeText(payload);
  const download = () => {
    const blob = new Blob([payload], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `proofbounty-reveal-secret-bounty-${record.bountyId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
  };
  return (
    <div className="note pending">
      <strong>Save your reveal secret now.</strong> If the proof URL and nonce
      are lost, the bond cannot be recovered by reveal — the commit stays
      sealed and its bond goes to the poster when the reveal window closes.
      <div className="row-actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn ghost small" onClick={copy}>
          Copy my reveal secret
        </button>
        <button type="button" className="btn ghost small" onClick={download}>
          Download JSON receipt
        </button>
      </div>
    </div>
  );
}

function HunterPanel({ bounty, account, submissions, config, onChanged }) {
  const [url, setUrl] = useState("");
  const [nonce, setNonce] = useState(() => makeNonce());
  const [hashPreview, setHashPreview] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);
  const [showSecret, setShowSecret] = useState(false);
  const [lastCommit, setLastCommit] = useState(null);
  // Manual reveal recovery (no localStorage record for an on-chain commit).
  const [recUrl, setRecUrl] = useState("");
  const [recNonce, setRecNonce] = useState("");
  const [recCheck, setRecCheck] = useState(null);
  const [recVerified, setRecVerified] = useState(false);

  const isPoster = account && bounty.poster.toLowerCase() === account.toLowerCase();
  const mySub = useMemo(
    () => submissions.find((s) => account && s.hunter.toLowerCase() === account.toLowerCase()) || null,
    [submissions, account]
  );
  const stored = account ? findCommit(account, bounty.id) : null;
  const now = nowSeconds();
  const bondGen = config ? weiToGen(config.commit_bond) : null;

  // Live commit-hash preview, computed exactly as the contract will.
  useEffect(() => {
    let live = true;
    if (url.trim() && nonce.trim() && account) {
      computeCommitHash(url.trim(), account, nonce.trim()).then((h) => {
        if (live) setHashPreview(h);
      });
    } else {
      setHashPreview("");
    }
    return () => { live = false; };
  }, [url, nonce, account]);

  if (!account) {
    return (
      <div className="panel">
        <h4>Hunt this bounty</h4>
        <p>Connect a wallet to commit a proof. Commits are sealed: your proof URL stays secret until you reveal it.</p>
      </div>
    );
  }
  if (isPoster) {
    return (
      <div className="panel">
        <h4>Your bounty</h4>
        <p>
          You posted this notice, so you cannot hunt it, judge it, or pick a
          winner. The jury pays the first valid proof; if none arrives, the
          reward returns to your board balance automatically.
        </p>
      </div>
    );
  }

  const doCommit = async () => {
    setNote(null);
    try {
      const proofUrl = url.trim();
      const n = nonce.trim();
      if (!proofUrl.startsWith("https://")) throw new Error("The proof URL must start with https://");
      if (!n) throw new Error("A nonce is required — generate one.");
      const commitHash = await computeCommitHash(proofUrl, account, n);
      const record = {
        bountyId: String(bounty.id), url: proofUrl, nonce: n, commitHash, createdAt: Date.now(),
      };
      // Persist the reveal secret BEFORE the commit transaction is
      // dispatched: once the tx is sent the commit may land even if this
      // page closes, and without url + nonce it could never be revealed.
      saveCommit(account, record);
      setBusy("commit");
      const { hash } = await commitProof(account, bounty.id, commitHash, BigInt(config.commit_bond), {
        onHash: (h) => setNote({ kind: "pending", text: "Commit sent — waiting for consensus…", hash: h }),
      });
      setLastCommit(record);
      setNote({ kind: "ok", text: "Commit is on-chain and your URL is still secret. Come back and reveal it before the reveal deadline.", hash });
      onChanged();
    } catch (err) {
      setNote({ kind: "err", text: friendlyError(err) });
    } finally {
      setBusy("");
    }
  };

  const doReveal = async (urlArg, nonceArg) => {
    const revealUrl = urlArg !== undefined ? urlArg : stored?.url;
    const revealNonce = nonceArg !== undefined ? nonceArg : stored?.nonce;
    setNote(null);
    try {
      if (!revealUrl || !revealNonce) throw new Error("The saved proof URL and nonce are missing.");
      setBusy("reveal");
      const { hash } = await revealProof(account, bounty.id, revealUrl, revealNonce, {
        onHash: (h) => setNote({ kind: "pending", text: "Reveal sent — the contract is fetching your proof page…", hash: h }),
      });
      setNote({ kind: "ok", text: "Revealed. Your bond is back in your board balance; the submission can now be assessed.", hash });
      onChanged();
    } catch (err) {
      setNote({ kind: "err", text: friendlyError(err) });
    } finally {
      setBusy("");
    }
  };

  // Recovery check: the entered url + nonce must reproduce the commit hash
  // stored on-chain for this submission before Reveal is enabled.
  const verifyRecovery = async () => {
    const u = recUrl.trim();
    const n = recNonce.trim();
    setRecVerified(false);
    if (!u || !n) {
      setRecCheck({ ok: false, text: "Enter both the exact proof URL and the nonce used at commit time." });
      return;
    }
    const h = await computeCommitHash(u, account, n);
    const onChain = String(mySub?.commit_hash || "").toLowerCase();
    if (onChain && h.toLowerCase() === onChain) {
      saveCommit(account, {
        bountyId: String(bounty.id), url: u, nonce: n, commitHash: h, createdAt: Date.now(),
      });
      setRecVerified(true);
      setRecCheck({
        ok: true,
        text: "Match — SHA-256 of this URL + your wallet + this nonce equals the commit hash stored on-chain. The secret is now saved in this browser and you can reveal.",
      });
    } else {
      setRecCheck({
        ok: false,
        text: "Mismatch — SHA-256 of that URL + your wallet address + that nonce does not equal the commit hash stored on-chain for your submission. Check the exact URL (spelling, trailing slash) and the nonce, then try again.",
      });
    }
  };

  // Already revealed / judged / stale / shadowed — nothing left to do here.
  if (mySub && mySub.state !== "COMMITTED") {
    return (
      <div className="panel">
        <h4>Your submission #{mySub.sid}</h4>
        <p>
          State: <Stamp state={mySub.state} />
          {mySub.reason_text ? ` — ${mySub.reason_text}` : ""}
        </p>
        {mySub.state === "INVALID" && (
          <p>
            A submission judged INVALID bars further commits on this bounty —
            the contract marks your wallet barred here (HUNTER_BARRED), so no
            new commit from this wallet can be made on this bounty.
          </p>
        )}
        {mySub.state === "SHADOWED" && (
          <p>
            This submission is SHADOWED: an earlier hunter's reveal already
            stands on this bounty, so this submission cannot be assessed. Your
            bond was returned to your board balance when you revealed.
          </p>
        )}
        {mySub.proof_url && (
          <p className="url">
            Proof: <a href={mySub.proof_url} target="_blank" rel="noreferrer">{mySub.proof_url}</a>
          </p>
        )}
      </div>
    );
  }

  // Committed on-chain: reveal panel (needs the locally stored secrets).
  if (mySub && mySub.state === "COMMITTED") {
    if (!stored) {
      const revealOpen = bounty.state === "OPEN" || bounty.state === "PAID";
      const withinWindow = now <= Number(bounty.reveal_end);
      return (
        <div className="panel">
          <h4>Recover your reveal (submission #{mySub.sid})</h4>
          <p>
            Your commit is sealed on-chain, but this browser has no saved
            proof URL and nonce for it (different browser, cleared storage, or
            a commit made elsewhere). If you still know the exact URL and
            nonce used at commit time, enter them here — they are checked
            against the commit hash stored on-chain before Reveal unlocks.
            Without them the commit stays sealed and its bond goes to the
            poster when the reveal window closes.
          </p>
          <div className="field">
            <label htmlFor="pb-rec-url">Proof URL used at commit time</label>
            <input id="pb-rec-url" value={recUrl}
              onChange={(e) => { setRecUrl(e.target.value); setRecVerified(false); setRecCheck(null); }}
              placeholder="https://… exactly as committed" />
          </div>
          <div className="field">
            <label htmlFor="pb-rec-nonce">Nonce used at commit time</label>
            <input id="pb-rec-nonce" value={recNonce}
              onChange={(e) => { setRecNonce(e.target.value); setRecVerified(false); setRecCheck(null); }}
              placeholder="The secret nonce from commit time" />
          </div>
          <div className="field">
            <label>On-chain commit hash</label>
            <div className="mono">{mySub.commit_hash}</div>
          </div>
          {recCheck && <div className={`note ${recCheck.ok ? "ok" : "err"}`}>{recCheck.text}</div>}
          <div className="row-actions">
            <button type="button" className="btn ghost" disabled={!!busy} onClick={verifyRecovery}>
              Verify against on-chain hash
            </button>
            {revealOpen && withinWindow ? (
              <button type="button" className="btn" disabled={!!busy || !recVerified}
                onClick={() => doReveal(recUrl.trim(), recNonce.trim())}>
                {busy === "reveal" ? "Revealing…" : "Reveal proof"}
              </button>
            ) : (
              <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                The reveal window for this bounty has closed, so a recovered secret can no longer be revealed.
              </span>
            )}
          </div>
          <TxNote note={note} />
        </div>
      );
    }
    const revealOpen = bounty.state === "OPEN" || bounty.state === "PAID";
    const withinWindow = now <= Number(bounty.reveal_end);
    return (
      <div className="panel">
        <h4>Reveal your proof (submission #{mySub.sid})</h4>
        <p>
          Your commit is sealed on-chain. Revealing publishes the URL below,
          the contract fetches the page and binds its hash, and your{" "}
          {bondGen} GEN bond comes back to your board balance.
        </p>
        <div className="field">
          <label>Saved proof URL</label>
          <div className="mono">{stored.url}</div>
        </div>
        <div className="field">
          <label>Saved nonce</label>
          <div className="mono">{showSecret ? stored.nonce : "••••••••••••••••••••••••••••••••"}</div>
          <div className="row-actions">
            <button className="btn ghost small" onClick={() => setShowSecret((v) => !v)}>
              {showSecret ? "Hide" : "Show"}
            </button>
            <button className="btn ghost small" onClick={() => navigator.clipboard?.writeText(stored.nonce)}>
              Copy nonce
            </button>
            <button className="btn ghost small" onClick={() => { removeCommit(account, bounty.id); onChanged(); }}>
              Forget saved commit
            </button>
          </div>
        </div>
        {revealOpen && withinWindow ? (
          <div className="row-actions">
            <button className="btn" disabled={!!busy} onClick={() => doReveal()}>
              {busy === "reveal" ? "Revealing…" : "Reveal proof"}
            </button>
            <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              Reveal by {formatTs(bounty.reveal_end)} ({formatRelative(bounty.reveal_end)}).
            </span>
          </div>
        ) : (
          <p>The reveal window for this bounty has closed.</p>
        )}
        {lastCommit && String(lastCommit.bountyId) === String(bounty.id) && (
          <CommitReceipt record={lastCommit} />
        )}
        <TxNote note={note} />
      </div>
    );
  }

  // No submission yet: the commit form (only while commits are open).
  if (bounty.state !== "OPEN") {
    return (
      <div className="panel">
        <h4>Hunt this bounty</h4>
        <p>
          Commits are closed — this bounty is {bounty.state}
          {bounty.state === "PAID"
            ? ": a valid proof already took the reward, so no new proofs can be committed."
            : ", so no new proofs can be committed to it."}
        </p>
      </div>
    );
  }
  if (now >= Number(bounty.deadline)) {
    return (
      <div className="panel">
        <h4>Hunt this bounty</h4>
        <p>The commit deadline has passed — no new proofs can be committed to this bounty.</p>
      </div>
    );
  }
  const maxCommits = config ? Number(config.max_commits) : null;
  if (maxCommits && submissions.length >= maxCommits) {
    return (
      <div className="panel">
        <h4>Hunt this bounty</h4>
        <p>
          This bounty is at its commit cap — {submissions.length} of {maxCommits}{" "}
          allowed commits are already in, so no new proof can be committed.
        </p>
      </div>
    );
  }
  return (
    <div className="panel">
      <h4>Hunt this bounty</h4>
      <p>
        Commit first, reveal later. Your proof URL is hashed with your wallet
        address and a secret nonce, so nobody can copy it from the chain. The
        commit carries a {bondGen} GEN bond — back when you reveal, the
        poster's if you never do.
      </p>
      <div className="field">
        <label htmlFor="pb-proof-url">Proof URL (https)</label>
        <input id="pb-proof-url" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… the public page that proves the work" />
        <div className="hint">Keep this page unchanged between reveal and assessment — the jury re-fetches it and compares hashes.</div>
      </div>
      <div className="field">
        <label htmlFor="pb-nonce">Your secret nonce</label>
        <input id="pb-nonce" value={nonce} onChange={(e) => setNonce(e.target.value)} />
        <div className="row-actions">
          <button type="button" className="btn ghost small" onClick={() => setNonce(makeNonce())}>Regenerate</button>
          <button type="button" className="btn ghost small" onClick={() => navigator.clipboard?.writeText(nonce)}>Copy nonce</button>
        </div>
        <div className="hint">
          Stored only in this browser, together with the URL. Lose both and the
          commit can never be revealed.
        </div>
      </div>
      {hashPreview && (
        <div className="field">
          <label>Commit hash (computed in your browser)</label>
          <div className="mono">{hashPreview}</div>
        </div>
      )}
      <div>
        <p>
          <strong>Bond: exactly {bondGen ?? "…"} GEN</strong> — the commit bond
          from the contract's own config (get_config), charged together with
          this commit.
        </p>
        <p>
          The bond comes back to your board balance when you reveal —
          including when a reveal lands SHADOWED because another hunter's
          proof already won. It is lost to the poster only if you never
          reveal and the commit is marked lapsed after the reveal deadline.
        </p>
        <p>
          Use an immutable static URL — a permalink, a raw file link, or an
          IPFS link. The jury fetches this exact page at assessment, so a page
          that changes, moves, or disappears can fail your proof.
        </p>
      </div>
      <div className="row-actions">
        <button className="btn" disabled={!!busy || !url.trim() || !nonce.trim()} onClick={doCommit}>
          {busy === "commit" ? "Committing…" : `Commit proof · bond ${bondGen ?? "…"} GEN`}
        </button>
      </div>
      {lastCommit && String(lastCommit.bountyId) === String(bounty.id) && (
        <CommitReceipt record={lastCommit} />
      )}
      <TxNote note={note} />
    </div>
  );
}

function SubmissionRow({ bounty, sub, account, now, onChanged }) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);

  const canAssess =
    account && bounty.state === "OPEN" && sub.state === "REVEALED" && now <= Number(bounty.assess_deadline);
  const canMarkLapsed =
    account && sub.state === "COMMITTED" && now > Number(bounty.reveal_end);

  const run = async (kind, fn) => {
    setNote(null);
    setBusy(kind);
    try {
      const { hash } = await fn(account, bounty.id, sub.sid, {
        onHash: (h) => setNote({ kind: "pending", text: "Sent — waiting for consensus…", hash: h }),
      });
      setNote({ kind: "ok", text: "Done — the board has been refreshed from chain.", hash });
      onChanged();
    } catch (err) {
      setNote({ kind: "err", text: friendlyError(err) });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="sub">
      <div className="top">
        <span className="who">
          #{sub.sid} · {shortAddress(sub.hunter)}
          {account && sub.hunter.toLowerCase() === account.toLowerCase() ? " (you)" : ""}
        </span>
        <Stamp state={sub.state} />
      </div>
      {sub.proof_url && (
        <div className="url">
          Proof: <a href={sub.proof_url} target="_blank" rel="noreferrer">{sub.proof_url}</a>
        </div>
      )}
      {!sub.proof_url && sub.state === "COMMITTED" && (
        <div className="reason">Sealed commit — the proof URL is still secret.</div>
      )}
      {sub.state === "COMMITTED" && (
        <div className="reason">
          {now <= Number(bounty.reveal_end)
            ? `Reveal deadline: ${formatTs(bounty.reveal_end)} — ${formatRelative(bounty.reveal_end)} left to reveal.`
            : `Reveal window closed (${formatTs(bounty.reveal_end)}) — this commit can now be marked lapsed.`}
        </div>
      )}
      {sub.state === "SHADOWED" && (
        <div className="reason">
          Shadowed by an earlier reveal — this submission cannot be assessed;
          only a submission standing REVEALED can go to the jury.
        </div>
      )}
      {sub.reason_text && <div className="reason">{sub.reason_text}</div>}
      {(canAssess || canMarkLapsed) && (
        <div className="row-actions">
          {canAssess && (
            <button className="btn small" disabled={!!busy} onClick={() => run("assess", assessSubmission)}>
              {busy === "assess" ? "Asking the jury…" : "Assess with the jury"}
            </button>
          )}
          {canMarkLapsed && (
            <button className="btn ghost small" disabled={!!busy} onClick={() => run("lapse", markLapsed)}>
              {busy === "lapse" ? "Marking…" : "Mark lapsed (bond to poster)"}
            </button>
          )}
        </div>
      )}
      <TxNote note={note} />
    </div>
  );
}

function DetailSheet({ bountyId, account, config, onClose, onChanged }) {
  const [bounty, setBounty] = useState(null);
  const [subs, setSubs] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);
  const now = nowSeconds();

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([readBounty(bountyId), readSubmissions(bountyId)]);
      setBounty({ ...b, id: String(bountyId) });
      setSubs(s);
      setErr("");
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, [bountyId]);

  useEffect(() => { load(); }, [load]);

  const changed = useCallback(() => { load(); onChanged(); }, [load, onChanged]);

  if (!bounty) {
    return (
      <div className="scrim" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <button className="close-x" onClick={onClose} aria-label="Close">✕</button>
          {err ? <div className="note err">{err}</div> : <div className="loading">Reading the notice from chain…</div>}
        </div>
      </div>
    );
  }

  const isPoster = account && bounty.poster.toLowerCase() === account.toLowerCase();
  const canCancel = account && isPoster && bounty.state === "OPEN" && bounty.nsubs === "0";
  const canExpire = account && bounty.state === "OPEN" && now > Number(bounty.assess_deadline);

  const runBountyAction = async (kind, fn, okText) => {
    setNote(null);
    setBusy(kind);
    try {
      const { hash } = await fn(account, bounty.id, {
        onHash: (h) => setNote({ kind: "pending", text: "Sent — waiting for consensus…", hash: h }),
      });
      setNote({ kind: "ok", text: okText, hash });
      changed();
    } catch (e) {
      setNote({ kind: "err", text: friendlyError(e) });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <button className="close-x" onClick={onClose} aria-label="Close">✕</button>
        <span className="mono" style={{ color: "var(--ink-faint)" }}>Bounty #{bounty.id}</span>
        <h2>{bounty.title}</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="reward" style={{ fontFamily: "var(--serif)", fontSize: 26, color: "var(--amber-deep)" }}>
            {weiToGen(bounty.reward)} GEN
          </span>
          <Stamp state={bounty.state} />
        </div>
        <dl className="kv">
          <dt>Poster</dt>
          <dd>
            <a className="mono" href={explorerAddressUrl(bounty.poster)} target="_blank" rel="noreferrer">
              {bounty.poster}
            </a>
          </dd>
          <dt>Posted</dt><dd>{formatTs(bounty.created)}</dd>
          <dt>Commit deadline</dt><dd>{formatTs(bounty.deadline)} ({formatRelative(bounty.deadline)})</dd>
          <dt>Reveal by</dt><dd>{formatTs(bounty.reveal_end)} ({formatRelative(bounty.reveal_end)})</dd>
          <dt>Assess by</dt><dd>{formatTs(bounty.assess_deadline)} ({formatRelative(bounty.assess_deadline)})</dd>
          <dt>Submissions</dt><dd>{bounty.nsubs}</dd>
          {bounty.state === "PAID" && (
            <>
              <dt>Winner</dt>
              <dd className="mono">{bounty.winner} · submission #{bounty.win_sub}</dd>
            </>
          )}
        </dl>
        <h4 style={{ fontFamily: "var(--serif)", margin: "16px 0 8px" }}>Acceptance criteria</h4>
        <div className="criteria-box">{bounty.criteria}</div>

        {(canCancel || canExpire) && (
          <div className="row-actions">
            {canCancel && (
              <button className="btn danger small" disabled={!!busy}
                onClick={() => runBountyAction("cancel", cancelBounty, "Bounty cancelled — the full reward is back in your board balance.")}>
                {busy === "cancel" ? "Cancelling…" : "Cancel bounty & refund"}
              </button>
            )}
            {canExpire && (
              <button className="btn small" disabled={!!busy}
                onClick={() => runBountyAction("expire", expireBounty, "Bounty expired — the full reward is back in the poster's board balance.")}>
                {busy === "expire" ? "Expiring…" : "Expire bounty & refund poster"}
              </button>
            )}
          </div>
        )}
        {account && isPoster && bounty.state === "OPEN" && bounty.nsubs !== "0" && (
          <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "10px 0 0" }}>
            Cancel is unavailable: this bounty already has {bounty.nsubs}{" "}
            submission{Number(bounty.nsubs) === 1 ? "" : "s"} — a poster can
            only cancel and take the reward back while no hunter has committed.
          </p>
        )}
        <TxNote note={note} />

        <HunterPanel key={bounty.id} bounty={bounty} account={account} submissions={subs} config={config} onChanged={changed} />

        <h4 style={{ fontFamily: "var(--serif)", margin: "22px 0 4px", fontSize: 18 }}>
          Submissions ({subs.length})
        </h4>
        {subs.length === 0 && <p style={{ color: "var(--ink-soft)", fontSize: 14 }}>No hunter has committed a proof yet.</p>}
        {subs.map((s) => (
          <SubmissionRow key={s.sid} bounty={bounty} sub={s} account={account} now={now} onChanged={changed} />
        ))}
      </div>
    </div>
  );
}

// A withdraw receipt whose GEN has not landed in the wallet yet is kept in
// localStorage (per wallet): Bradbury settles the native transfer after the
// contract finalizes, so the board balance reading 0 must not make the
// receipt vanish. It stays until the wallet's native balance actually rises
// (the transfer landed) or the user dismisses it.
const withdrawReceiptKey = (wallet) =>
  `proofbounty:withdraw-receipt:${String(wallet).toLowerCase()}`;

function loadWithdrawReceipt(wallet) {
  if (!wallet) return null;
  try {
    const raw = localStorage.getItem(withdrawReceiptKey(wallet));
    const r = raw ? JSON.parse(raw) : null;
    return r && r.hash && r.amountGen ? r : null;
  } catch {
    return null;
  }
}

function saveWithdrawReceipt(wallet, r) {
  try {
    if (r) localStorage.setItem(withdrawReceiptKey(wallet), JSON.stringify(r));
    else localStorage.removeItem(withdrawReceiptKey(wallet));
  } catch {
    // Storage unavailable: the receipt still shows for this session.
  }
}

function BalanceSlip({ account, balance, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [receipt, setReceipt] = useState(() => loadWithdrawReceipt(account));

  // A pending (persisted) receipt clears itself once the wallet's native
  // GEN balance rises above what it was when the withdraw finalized — the
  // moment the delayed transfer has actually landed. Checked on board
  // refresh / balance updates and on a 30 s poll while it is showing.
  useEffect(() => {
    if (!receipt?.pending || receipt.nativeAtReceiptWei === undefined) return undefined;
    let live = true;
    const check = async () => {
      try {
        const nowBal = await ethBalance(account);
        if (live && nowBal > BigInt(receipt.nativeAtReceiptWei)) {
          saveWithdrawReceipt(account, null);
          setReceipt(null);
          setNote({
            kind: "ok",
            text: `The withdrawn ${receipt.amountGen} GEN has now landed in your wallet.`,
            hash: receipt.hash,
          });
        }
      } catch {
        // Keep the receipt; the next poll tries again.
      }
    };
    check();
    const t = setInterval(check, 30000);
    return () => { live = false; clearInterval(t); };
  }, [receipt, account, balance]);

  if (!account) return null;

  const doWithdraw = async () => {
    setNote(null);
    setReceipt(null);
    saveWithdrawReceipt(account, null);
    setBusy(true);
    const boardWei = balance;
    try {
      const res = await withdrawFunds(account, {
        onHash: (h) => setNote({ kind: "pending", text: "Withdraw sent — waiting for consensus…", hash: h }),
      });
      const amountWei = res.landed && res.deltaWei > 0n ? res.deltaWei : boardWei;
      if (amountWei !== null && amountWei !== undefined) {
        if (res.landed) {
          // Already reflected in the wallet — a session receipt is enough.
          setReceipt({ amountGen: weiToGen(amountWei), hash: res.hash, pending: false });
        } else {
          // Not landed yet: persist the receipt with the wallet's native
          // balance at finalization, so it survives reloads and only
          // clears when the balance actually rises (see the poll above).
          const r = {
            amountGen: weiToGen(amountWei),
            amountWei: amountWei.toString(),
            hash: res.hash,
            createdAt: Date.now(),
            pending: true,
          };
          if (typeof res.after === "bigint") r.nativeAtReceiptWei = res.after.toString();
          saveWithdrawReceipt(account, r);
          setReceipt(r);
        }
      }
      if (res.landed) {
        setNote({ kind: "ok", text: `Withdrawn — ${weiToGen(res.deltaWei)} GEN arrived in your wallet.`, hash: res.hash });
      } else {
        setNote({
          kind: "ok",
          text: "Withdraw finalized on-chain and your board balance is now zero. Bradbury settles the GEN transfer with a delay — check your wallet balance shortly.",
          hash: res.hash,
        });
      }
      onChanged();
    } catch (err) {
      setNote({ kind: "err", text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className="slip">
        <div>
          <div className="lbl">Your board balance</div>
          <div className="amt">
            {balance === null ? "…" : weiToGen(balance)} <small>GEN owed to you by the contract</small>
          </div>
        </div>
        {balance !== null && balance > 0n && (
          <button className="btn" disabled={busy} onClick={doWithdraw}>
            {busy ? "Withdrawing…" : `Withdraw ${weiToGen(balance)} GEN`}
          </button>
        )}
      </div>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "8px 0 0" }}>
        Winnings, poster refunds and returned bonds all collect here as your
        board balance — nothing is paid out automatically, so withdraw
        manually whenever you want it in your wallet.
      </p>
      {receipt && (
        <div className="note ok" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <span>
            <strong>Withdrawn: {receipt.amountGen} GEN.</strong> Transaction{" "}
            <a className="mono" href={explorerTxUrl(receipt.hash)} target="_blank" rel="noreferrer">
              {receipt.hash}
            </a>{" "}
            — Bradbury settles the native transfer with a delay, so the GEN
            can reach your wallet a little after the transaction finalizes.
            {receipt.pending &&
              " This receipt stays here until the GEN shows in your wallet balance — it does not disappear just because your board balance is now zero."}
          </span>
          <button
            className="btn ghost small"
            onClick={() => { saveWithdrawReceipt(account, null); setReceipt(null); }}
          >
            Dismiss
          </button>
        </div>
      )}
      <TxNote note={note} />
    </div>
  );
}

export default function App() {
  const [account, setAccount] = useState("");
  const [walletName, setWalletName] = useState("");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [bounties, setBounties] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [, setTick] = useState(0);

  // Keep relative times and time-based buttons honest while the board sits open.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const loadBoard = useCallback(async () => {
    try {
      const [cfg, all] = await Promise.all([readConfig(), readAllBounties()]);
      setConfig(cfg);
      setBounties(all);
      setLoadErr("");
    } catch (e) {
      setLoadErr(friendlyError(e));
    }
  }, []);

  const loadBalance = useCallback(async () => {
    if (!account) { setBalance(null); return; }
    try {
      setBalance(await readBalance(account));
    } catch {
      setBalance(null);
    }
  }, [account]);

  useEffect(() => { loadBoard(); }, [loadBoard]);
  useEffect(() => { loadBalance(); }, [loadBalance]);

  const refreshAll = useCallback(() => { loadBoard(); loadBalance(); }, [loadBoard, loadBalance]);

  const onConnected = (addr, name) => {
    setAccount(addr);
    setWalletName(name || "");
  };

  const disconnect = () => {
    setAccount("");
    setWalletName("");
    setBalance(null);
  };

  const visible = useMemo(() => {
    if (!bounties) return null;
    const list = filter === "ALL" ? bounties : bounties.filter((b) => b.state === filter);
    return [...list].reverse(); // newest notice on top of the board
  }, [bounties, filter]);

  const counts = useMemo(() => {
    const c = { ALL: 0, OPEN: 0, PAID: 0, EXPIRED: 0, CANCELLED: 0 };
    (bounties || []).forEach((b) => { c.ALL += 1; if (c[b.state] !== undefined) c[b.state] += 1; });
    return c;
  }, [bounties]);

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-top">
          <div className="brand">
            <div className="brand-pin">P</div>
            <div>
              <h1>Proof<span className="accent">Bounty</span></h1>
              <p className="tagline">
                The open bounty board that pays for proof, not promises. A poster
                locks a reward with written criteria; the first proof a GenLayer
                jury judges valid takes it — the poster cannot judge, pick a
                winner, or refuse to pay.
              </p>
            </div>
          </div>
          <div className="walletbox">
            {account ? (
              <div className="wallet-chip">
                <span className="live-dot" />
                <span>{shortAddress(account)}{walletName ? ` · ${walletName}` : ""}</span>
                <button className="btn ghost small" onClick={disconnect}>Disconnect</button>
              </div>
            ) : (
              <button className="btn" onClick={() => setChooserOpen(true)}>Connect wallet</button>
            )}
          </div>
        </div>
        <div className="contract-line">
          <span>
            Contract:{" "}
            <a href={explorerAddressUrl(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">
              {CONTRACT_ADDRESS}
            </a>
          </span>
          <span className="dot">•</span>
          <span>GenLayer Bradbury · chain 4221</span>
          <span className="dot">•</span>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">GenLayer docs</a>
        </div>
        {config && (
          <div className="stats">
            <div className="stat"><div className="k">Min reward</div><div className="v">{weiToGen(config.min_reward)} <small>GEN</small></div></div>
            <div className="stat"><div className="k">Commit bond</div><div className="v">{weiToGen(config.commit_bond)} <small>GEN</small></div></div>
            <div className="stat"><div className="k">Reveal window</div><div className="v">{formatDuration(config.reveal_window)}</div></div>
            <div className="stat"><div className="k">Assess window</div><div className="v">{formatDuration(config.assess_window)}</div></div>
            <div className="stat"><div className="k">Max commits</div><div className="v">{config.max_commits} <small>per bounty</small></div></div>
            <div className="stat"><div className="k">Locked in open bounties</div><div className="v">{weiToGen(config.open_locked_wei)} <small>GEN</small></div></div>
            <div className="stat"><div className="k">Bonds held</div><div className="v">{weiToGen(config.bonds_held_wei)} <small>GEN</small></div></div>
            <div className="stat"><div className="k">Credited balances</div><div className="v">{weiToGen(config.credited_wei)} <small>GEN</small></div></div>
          </div>
        )}
        {account && <BalanceSlip account={account} balance={balance} onChanged={refreshAll} />}
      </header>

      <h2 className="section-title">
        Pin a new bounty
        <span className="sub">Your reward is locked on-chain the moment the notice goes up.</span>
      </h2>
      <PostForm account={account} config={config} onPosted={refreshAll} />

      <h2 className="section-title">
        The board
        <span className="sub">Every notice below is read live from the contract.</span>
      </h2>
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f} className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {f} · {counts[f]}
          </button>
        ))}
        <button className="tab" onClick={refreshAll}>↻ Refresh</button>
      </div>

      {bounties !== null &&
        (counts.ALL > 500 ? (
          <div className="note pending" style={{ marginTop: 10 }}>
            This board is large — {counts.ALL} bounties. Every notice was
            loaded from the contract, nothing was truncated, but loading a
            board this size may be slow.
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "10px 0 0" }}>
            All {counts.ALL} {counts.ALL === 1 ? "bounty" : "bounties"} loaded
            from the contract.
          </p>
        ))}

      {loadErr && <div className="note err">Could not read the board: {loadErr}</div>}
      {visible === null && !loadErr && <div className="loading">Reading the board from chain…</div>}
      {visible !== null && visible.length === 0 && (
        <div className="empty">
          {filter === "ALL"
            ? "The board is empty — no bounties have been posted yet."
            : `No ${filter.toLowerCase()} bounties on the board right now.`}
        </div>
      )}
      {visible !== null && visible.length > 0 && (
        <div className="board">
          {visible.map((b) => (
            <NoticeCard key={b.id} bounty={b} onOpen={setSelectedId} />
          ))}
        </div>
      )}

      <p className="footer-note">
        ProofBounty runs on the GenLayer Bradbury testnet. Rewards, bonds and
        verdicts are enforced by the intelligent contract —{" "}
        <a className="mono" href={explorerAddressUrl(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">
          {CONTRACT_ADDRESS}
        </a>{" "}
        — open any notice to read its criteria and submissions exactly as stored
        on-chain.
      </p>

      <WalletChooser open={chooserOpen} onClose={() => setChooserOpen(false)} onConnected={onConnected} />
      {selectedId !== null && (
        <DetailSheet
          bountyId={selectedId}
          account={account}
          config={config}
          onClose={() => setSelectedId(null)}
          onChanged={refreshAll}
        />
      )}
    </div>
  );
}
