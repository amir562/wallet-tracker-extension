/**
 * Wallet Tracker — Single-File Server (Base, Ethereum, BSC)
 * ---------------------------------------------------------
 * A robust Express.js backend with:
 *  - /health, /networks
 *  - /address/:chain/:address/native      -> scan recent native transfers
 *  - /address/:chain/:address/erc20       -> ERC-20 Transfer logs (+ token metadata cache)
 *  - /address/:chain/:address/approvals   -> ERC-20 Approval logs
 *  - Anti-spam filters: skip zero-value, min thresholds, whitelist/blacklist
 *  - Smart RPC selection with fallback + probe
 *
 * Requirements: Node.js >= 18, deps: express, cors, morgan, ethers@6
 *
 * NOTE: This file uses CommonJS `require`. If your package.json has `"type": "module"`,
 * remove that line or convert imports to ESM.
 *
 * Quick start:
 *   npm install express cors morgan ethers
 *   node server.js
 *   # default: http://localhost:8787
 *
 * ENV (all optional):
 *   PORT=8787
 *   WATCH_CHAINS=eth,base,bsc
 *   ETH_RPC=...   BSC_RPC=...   BASE_RPC=...
 *   ALLOW_ALL_TOKENS=false
 *   SKIP_ZERO_VALUE=true
 *   MIN_NATIVE_WEI=0
 *   MIN_ERC20_RAW=0
 */

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { ethers } = require("ethers");

// ---------- CONFIG ----------
const CONFIG = {
  PORT: Number(process.env.PORT || 8787),
  WATCH_CHAINS: (process.env.WATCH_CHAINS || "eth,base,bsc")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),

  // Anti-spam / dust filters
  ALLOW_ALL_TOKENS: (process.env.ALLOW_ALL_TOKENS || "false").toLowerCase() === "true",
  SKIP_ZERO_VALUE: (process.env.SKIP_ZERO_VALUE || "true").toLowerCase() !== "false",
  MIN_NATIVE_WEI: BigInt(process.env.MIN_NATIVE_WEI || "0"), // e.g. "1000000000000000" = 0.001 native
  MIN_ERC20_RAW: BigInt(process.env.MIN_ERC20_RAW || "0"),   // raw (pre-decimals)

  // Optional RPC overrides
  ETH_RPC: process.env.ETH_RPC || "",
  BSC_RPC: process.env.BSC_RPC || "",
  BASE_RPC: process.env.BASE_RPC || "",
};

// Whitelists / Blacklists (edit as you like)
const TOKEN_WHITELIST = {
  eth: new Set([
    // Example: USDC
    // "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  ]),
  bsc: new Set([
    // Example: USDT
    // "0x55d398326f99059ff775485246999027B3197955".toLowerCase(),
  ]),
  base: new Set([
    // Add Base tokens here
  ]),
};

const TOKEN_BLACKLIST = {
  eth: new Set([]),
  bsc: new Set([]),
  base: new Set([]),
};

// NFT alerts are off by default unless added here (not used by endpoints below)
const NFT_WHITELIST = {
  eth: new Set([]),
  bsc: new Set([]),
  base: new Set([]),
};

const CHAINS = {
  eth:  { chainId: 1,    nativeSymbol: "ETH", blockHint: "≈12s" },
  bsc:  { chainId: 56,   nativeSymbol: "BNB", blockHint: "≈3s"  },
  base: { chainId: 8453, nativeSymbol: "ETH", blockHint: "≈2s"  },
};

const FALLBACK_RPCS = {
  eth: [
    CONFIG.ETH_RPC,
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
    "https://1rpc.io/eth",
  ].filter(Boolean),
  bsc: [
    CONFIG.BSC_RPC,
    "https://rpc.ankr.com/bsc",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
  ].filter(Boolean),
  base: [
    CONFIG.BASE_RPC,
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
  ].filter(Boolean),
};

// ---------- RPC selection with probe ----------
const PROVIDERS = {};   // { chain: ethers.Provider }
const CHOSEN_RPC = {};  // { chain: "url" }

async function probeRpc(url) {
  const provider = new ethers.JsonRpcProvider(url);
  const timeoutMs = 4000;
  const got = await Promise.race([
    provider.getBlockNumber(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
  ]);
  if (typeof got === "number" || typeof got === "bigint") return provider;
  throw new Error("probe failed");
}

async function initProviders() {
  for (const chain of CONFIG.WATCH_CHAINS) {
    const candidates = FALLBACK_RPCS[chain];
    if (!candidates?.length) {
      console.log(`[${chain}] no RPC candidates; skipping`);
      continue;
    }
    let ok = false;
    for (const url of candidates) {
      try {
        const p = await probeRpc(url);
        PROVIDERS[chain] = p;
        CHOSEN_RPC[chain] = url;
        console.log(`[${chain}] using RPC: ${url}`);
        ok = true;
        break;
      } catch {
        console.log(`[${chain}] RPC failed probe: ${url}`);
      }
    }
    if (!ok) console.log(`[${chain}] ERROR: could not initialize any RPC`);
  }
}

// ---------- App ----------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// ---------- Helpers ----------
function getProvider(chain) {
  const c = String(chain || "").toLowerCase();
  const p = PROVIDERS[c];
  if (!p) {
    const available = Object.keys(PROVIDERS).join(", ") || "(none)";
    const err = new Error(`Unsupported or unavailable chain "${chain}". Available: ${available}`);
    err.status = 400;
    throw err;
  }
  return p;
}

function ensureAddress(addr) {
  if (!ethers.isAddress(addr)) {
    const err = new Error(`Invalid address: ${addr}`);
    err.status = 400;
    throw err;
  }
}

// Async route wrapper
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Token metadata cache (symbol/name/decimals)
const erc20MetaCache = new Map(); // key: `${chain}:${token}`, val: {symbol,name,decimals,ts}
function cacheKey(chain, token) {
  return `${String(chain).toLowerCase()}:${String(token).toLowerCase()}`;
}
function getCachedMeta(chain, token) {
  return erc20MetaCache.get(cacheKey(chain, token));
}
function setCachedMeta(chain, token, meta) {
  erc20MetaCache.set(cacheKey(chain, token), { ...meta, ts: Date.now() });
}

async function getErc20Meta(chain, token) {
  const hit = getCachedMeta(chain, token);
  if (hit && Date.now() - hit.ts < 6 * 60 * 60 * 1000) return hit; // 6h cache

  const provider = getProvider(chain);
  const erc20 = new ethers.Contract(
    token,
    [
      "function symbol() view returns (string)",
      "function name() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    provider
  );
  const [symbol, name, decimals] = await Promise.all([
    erc20.symbol().catch(() => "UNK"),
    erc20.name().catch(() => "Unknown Token"),
    erc20.decimals().catch(() => 18),
  ]);
  const meta = { symbol, name, decimals: Number(decimals) || 18 };
  setCachedMeta(chain, token, meta);
  return meta;
}

function passTokenFilters(chain, token, rawValue) {
  // blacklist
  if (TOKEN_BLACKLIST[chain]?.has(String(token).toLowerCase())) return false;

  // zero-value skip
  if (CONFIG.SKIP_ZERO_VALUE && rawValue === 0n) return false;

  // min raw threshold
  if (rawValue < CONFIG.MIN_ERC20_RAW) return false;

  // allow all?
  if (CONFIG.ALLOW_ALL_TOKENS) return true;

  // else must be in whitelist (if provided)
  const wl = TOKEN_WHITELIST[chain];
  if (wl && wl.size > 0) return wl.has(String(token).toLowerCase());

  // if no whitelist defined, allow by default
  return true;
}

function passNativeFilters(valueWei) {
  if (CONFIG.SKIP_ZERO_VALUE && valueWei === 0n) return false;
  if (valueWei < CONFIG.MIN_NATIVE_WEI) return false;
  return true;
}

// ---------- Routes ----------

// Health
app.get("/health", a(async (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    chains: Object.keys(PROVIDERS),
    rpc: CHOSEN_RPC,
    config: {
      WATCH_CHAINS: CONFIG.WATCH_CHAINS,
      SKIP_ZERO_VALUE: CONFIG.SKIP_ZERO_VALUE,
      MIN_NATIVE_WEI: CONFIG.MIN_NATIVE_WEI.toString(),
      MIN_ERC20_RAW: CONFIG.MIN_ERC20_RAW.toString(),
      ALLOW_ALL_TOKENS: CONFIG.ALLOW_ALL_TOKENS,
    },
  });
}));

// Networks snapshot
app.get("/networks", a(async (req, res) => {
  const out = {};
  await Promise.all(
    Object.entries(PROVIDERS).map(async ([name, provider]) => {
      try {
        const [latest, net] = await Promise.all([
          provider.getBlockNumber(),
          provider.getNetwork(),
        ]);
        out[name] = {
          chainId: Number(net.chainId),
          latestBlock: Number(latest),
          nativeSymbol: CHAINS[name]?.nativeSymbol || "ETH",
          blockTimeHint: CHAINS[name]?.blockHint || "n/a",
          rpcOk: true,
          rpcUrl: CHOSEN_RPC[name],
        };
      } catch (e) {
        out[name] = { rpcOk: false, error: String(e?.message || e) };
      }
    })
  );
  res.json(out);
}));

// Native transfers (recent blocks scan)
// GET /address/:chain/:address/native?blocks=1200&limit=200
app.get("/address/:chain/:address/native", a(async (req, res) => {
  const { chain, address } = req.params;
  ensureAddress(address);

  const provider = getProvider(chain);
  const blocksToScan = Math.min(Number(req.query.blocks || 800), 5000);
  const limit = Math.min(Number(req.query.limit || 200), 1000);

  const latest = await provider.getBlockNumber();
  const start = Math.max(0, latest - blocksToScan + 1);

  const who = address.toLowerCase();
  const items = [];

  for (let bn = latest; bn >= start; bn--) {
    const block = await provider.getBlockWithTransactions(bn);
    if (!block?.transactions?.length) continue;

    for (const tx of block.transactions) {
      const from = (tx.from || "").toLowerCase();
      const to = (tx.to || "").toLowerCase();
      const val = BigInt(tx.value?.toString?.() || "0");

      const touches = (from === who || to === who);
      const passes = touches && passNativeFilters(val);
      if (!passes) continue;

      items.push({
        chain: chain.toLowerCase(),
        hash: tx.hash,
        blockNumber: Number(tx.blockNumber),
        timestamp: Number(block.timestamp),
        from: tx.from,
        to: tx.to,
        valueWei: val.toString(),
        valueFormatted: ethers.formatEther(val), // string
        isSender: from === who,
        isReceiver: to === who,
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  res.json({
    chain: chain.toLowerCase(),
    address,
    scanned: { from: start, to: latest, blocks: (latest - start + 1) },
    count: items.length,
    items,
  });
}));

// ERC-20 Transfer logs (token-scoped, efficient)
// GET /address/:chain/:address/erc20?token=0x..&fromBlock=&toBlock=&limit=500
app.get("/address/:chain/:address/erc20", a(async (req, res) => {
  const { chain, address } = req.params;
  ensureAddress(address);
  const provider = getProvider(chain);

  const token = String(req.query.token || "");
  if (!ethers.isAddress(token)) {
    const err = new Error("Query param 'token' is required and must be a valid ERC-20 contract address.");
    err.status = 400;
    throw err;
  }
  const { symbol, decimals, name } = await getErc20Meta(chain, token);

  const latest = await provider.getBlockNumber();
  const fromBlock = req.query.fromBlock ? Number(req.query.fromBlock) : Math.max(0, latest - 200_000);
  const toBlock = req.query.toBlock ? Number(req.query.toBlock) : latest;
  if (fromBlock > toBlock) {
    const err = new Error("'fromBlock' must be <= 'toBlock'");
    err.status = 400;
    throw err;
  }
  const limit = Math.min(Number(req.query.limit || 500), 2000);

  // Topics
  const TRANSFER = ethers.id("Transfer(address,address,uint256)");
  const addrTopic = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const topicsFrom = [TRANSFER, addrTopic(address), null];
  const topicsTo = [TRANSFER, null, addrTopic(address)];

  // Chunked scan
  const chunk = 10_000;
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    ranges.push({ fromBlock: start, toBlock: Math.min(start + chunk - 1, toBlock) });
  }

  const items = [];
  for (const r of ranges) {
    const [logsFrom, logsTo] = await Promise.all([
      provider.getLogs({ address: token, fromBlock: r.fromBlock, toBlock: r.toBlock, topics: topicsFrom }),
      provider.getLogs({ address: token, fromBlock: r.fromBlock, toBlock: r.toBlock, topics: topicsTo }),
    ]);

    for (const log of [...logsFrom, ...logsTo]) {
      const raw = BigInt(log.data || "0x0");
      if (!passTokenFilters(chain, token, raw)) continue;

      const from = "0x" + log.topics[1].slice(26);
      const to = "0x" + log.topics[2].slice(26);

      items.push({
        chain: chain.toLowerCase(),
        txHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        contract: token,
        tokenSymbol: symbol,
        tokenName: name,
        tokenDecimals: decimals,
        from,
        to,
        valueRaw: raw.toString(),
        valueFormatted: ethers.formatUnits(raw, decimals), // string
        isSender: from.toLowerCase() === address.toLowerCase(),
        isReceiver: to.toLowerCase() === address.toLowerCase(),
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  // newest first
  items.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));

  res.json({
    chain: chain.toLowerCase(),
    address,
    token,
    tokenMeta: { symbol, name, decimals },
    scanned: { fromBlock, toBlock },
    count: items.length,
    items,
  });
}));

// ERC-20 Approvals (owner = :address)
// GET /address/:chain/:address/approvals?token=0x..&fromBlock=&toBlock=&limit=
app.get("/address/:chain/:address/approvals", a(async (req, res) => {
  const { chain, address } = req.params;
  ensureAddress(address);
  const provider = getProvider(chain);

  const token = String(req.query.token || "");
  if (!ethers.isAddress(token)) {
    const err = new Error("Query param 'token' is required and must be a valid ERC-20 contract address.");
    err.status = 400;
    throw err;
  }
  const { symbol, decimals, name } = await getErc20Meta(chain, token);

  const latest = await provider.getBlockNumber();
  const fromBlock = req.query.fromBlock ? Number(req.query.fromBlock) : Math.max(0, latest - 200_000);
  const toBlock = req.query.toBlock ? Number(req.query.toBlock) : latest;
  const limit = Math.min(Number(req.query.limit || 500), 2000);

  // Approval(address indexed owner, address indexed spender, uint256 value)
  const APPROVAL = ethers.id("Approval(address,address,uint256)");
  const addrTopic = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const topicsOwner = [APPROVAL, addrTopic(address), null];

  const chunk = 10_000;
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    ranges.push({ fromBlock: start, toBlock: Math.min(start + chunk - 1, toBlock) });
  }

  const items = [];
  for (const r of ranges) {
    const logs = await provider.getLogs({ address: token, fromBlock: r.fromBlock, toBlock: r.toBlock, topics: topicsOwner });
    for (const log of logs) {
      const spender = "0x" + log.topics[2].slice(26);
      const value = BigInt(log.data || "0x0");

      items.push({
        chain: chain.toLowerCase(),
        txHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        contract: token,
        tokenSymbol: symbol,
        tokenName: name,
        tokenDecimals: decimals,
        owner: address,
        spender,
        valueRaw: value.toString(),
        valueFormatted: ethers.formatUnits(value, decimals), // string
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  items.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));

  res.json({
    chain: chain.toLowerCase(),
    address,
    token,
    tokenMeta: { symbol, name, decimals },
    scanned: { fromBlock, toBlock },
    count: items.length,
    items,
  });
}));

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const payload = {
    ok: false,
    status,
    error: err.message || "Unknown error",
  };
  if (process.env.NODE_ENV !== "production") {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
});

// ---------- Boot ----------
(async () => {
  for (const chain of Object.keys(FALLBACK_RPCS)) {
    if (!FALLBACK_RPCS[chain]?.length) {
      console.log(`[${chain}] no RPC candidates configured`);
    }
  }
  await initProviders();

  app.listen(CONFIG.PORT, () => {
    console.log(`Server on http://localhost:${CONFIG.PORT}`);
  });
})();
