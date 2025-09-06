# wallet-tracker-extension
Wallet Tracker — Single-File Server (Base, Ethereum, BSC)  A robust, single-file Node.js backend that powers wallet activity alerts across Base, Ethereum (ETH), and BNB Smart Chain (BSC). Built for clarity, anti-spam resilience, and easy community hacking.
Highlights

Endpoints for health, network snapshot, native transfers, ERC-20 transfers, ERC-20 approvals

Anti-spam / dust filters (skip zero-value, min thresholds, whitelist/blacklist)

Token metadata cache (symbol / name / decimals)

Smart RPC selection with fallback + probe

Zero external DB by default (in-memory cache), easy to extend

Table of Contents

Quick Start

Environment Variables

Endpoints

Filtering & Anti-Spam

Examples

Run in Background

Extend / Contribute

Security Notes

Roadmap Ideas

Troubleshooting / FAQ

License

Quick Start

Requirements

Node.js ≥ 18 (LTS recommended)

NPM

Install & Run

# in the repo folder (where server.js lives)
npm install
npm start
# default: http://localhost:8787


Windows (PowerShell)

npm install
npm start
# or:
node .\server.js


If port 8787 is taken:

# Linux/macOS
PORT=8888 npm start
# Windows PowerShell
$env:PORT=8888; npm start

Environment Variables

All are optional; sensible defaults are provided.

Variable	Default	Description
PORT	8787	HTTP port.
WATCH_CHAINS	eth,base,bsc	Comma-sep list of chains to enable.
ETH_RPC	(empty)	Custom Ethereum RPC (overrides fallback list).
BSC_RPC	(empty)	Custom BSC RPC (overrides fallback list).
BASE_RPC	(empty)	Custom Base RPC (overrides fallback list).
ALLOW_ALL_TOKENS	false	If true, skip whitelist checks for ERC-20 alerts.
SKIP_ZERO_VALUE	true	If true, drop zero-value transfers (strongly recommended).
MIN_NATIVE_WEI	0	Minimum native value (in wei) to include.
MIN_ERC20_RAW	0	Minimum ERC-20 raw value (pre-decimals) to include.

Tip: On Windows PowerShell:

$env:ETH_RPC="https://your-eth-rpc"
$env:BSC_RPC="https://your-bsc-rpc"
$env:BASE_RPC="https://your-base-rpc"
$env:WATCH_CHAINS="eth,bsc,base"
npm start

Endpoints

Base URL: http://localhost:<PORT>

Health
GET /health


Returns server status, enabled chains, chosen RPCs, and current filter config.

Networks snapshot
GET /networks


Returns latest block, chainId, native symbol, and RPC health per chain.

Native transfers (recent blocks scan)
GET /address/:chain/:address/native?blocks=1200&limit=200


Scans the latest blocks blocks and returns native transfers involving :address.
Filters applied: SKIP_ZERO_VALUE, MIN_NATIVE_WEI.

ERC-20 transfers (token-scoped, efficient)
GET /address/:chain/:address/erc20?token=0x...&fromBlock=&toBlock=&limit=500


Returns Transfer logs for a specific token contract where :address is from or to.
Includes cached symbol, name, decimals.
Filters applied: zero-value skip, min raw value, whitelist/blacklist.

ERC-20 approvals
GET /address/:chain/:address/approvals?token=0x...&fromBlock=&toBlock=&limit=500


Returns Approval(owner, spender, value) logs where owner == :address for a given token.

Chains: :chain must be one of eth, base, bsc (enabled via WATCH_CHAINS).

Filtering & Anti-Spam

The server ships with pragmatic defaults, aimed at reducing address poisoning, dust, and spam airdrops:

Skip zero-value transfers (SKIP_ZERO_VALUE=true)

Min thresholds for native (MIN_NATIVE_WEI) and ERC-20 raw (MIN_ERC20_RAW)

Whitelist / Blacklist per chain (edit in server.js):

const TOKEN_WHITELIST = { eth: new Set([...]), bsc: new Set([...]), base: new Set([...]) };
const TOKEN_BLACKLIST = { eth: new Set([...]), bsc: new Set([...]), base: new Set([...]) };


NFT alerts are off by default unless you add contracts to NFT_WHITELIST

These filters do not change on-chain data; they only decide what the API surfaces.

Examples

Replace 0xYOUR_ADDRESS with your wallet.

Health

http://localhost:8787/health


Networks

http://localhost:8787/networks


Native transfers (Base)

http://localhost:8787/address/base/0xYOUR_ADDRESS/native?blocks=1200&limit=200


ERC-20 transfers (ETH, example USDC)

http://localhost:8787/address/eth/0xYOUR_ADDRESS/erc20?token=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&limit=200


ERC-20 transfers (BSC, example USDT)

http://localhost:8787/address/bsc/0xYOUR_ADDRESS/erc20?token=0x55d398326f99059fF775485246999027B3197955&limit=200


ERC-20 approvals (ETH, example USDC)

http://localhost:8787/address/eth/0xYOUR_ADDRESS/approvals?token=0xA0b8...6eB48&limit=200

Run in Background

Windows (keep running after closing PowerShell)

Start-Process "node" "server.js" -WorkingDirectory "C:\path\to\repo"


PM2 (Windows / macOS / Linux, recommended)

npm install -g pm2
pm2 start server.js --name wallet-tracker
pm2 save
pm2 startup

Extend / Contribute

Add chains:
Add entries to CHAINS, FALLBACK_RPCS, and follow the ETH-like RPC shape via ethers.js.

Improve token labeling:
Add price lookups (Coingecko/Dexscreener) with a short cache to show USD values.

Telegram/Discord bots:
This server is bot-friendly. Add a thin bot layer that:

calls /erc20 per token in a user’s watchlist

deduplicates by txHash (keep a short-lived in-memory set)

applies your own user-level thresholds and contract whitelists

PRs welcome:

New filters (e.g., “send only if counterparty is in address book”)

Bloom-filter cache for seen transactions

Persistent cache (sqlite/redis) — opt-in only

Security Notes

Never auto-interact with untrusted contracts.
The server only reads public logs; it does not sign or send transactions.

Treat RPC endpoints as sensitive if they include keys. Don’t commit secrets.

If you enable price or ABI fetching, rate-limit & cache responses.

Roadmap Ideas

/nft endpoint for ERC-721/1155 transfers (opt-in per contract)

Price aggregation + USD thresholds

WebSocket push / SSE for real-time clients

Per-user preferences & persistent storage (optional module)

Troubleshooting / FAQ

Port already in use (EADDRINUSE)
Another process is using your port.

# Windows PowerShell
netstat -ano | findstr :8787
taskkill /PID <PID> /F
# or just run on a different port:
$env:PORT=8888; npm start


node not found
Install Node.js LTS (v18+). Check:

node -v
npm -v


No ETH/BSC events showing

Verify /networks returns rpcOk: true for those chains.

Try larger windows:

/address/eth/0xYOUR/native?blocks=5000&limit=300


For tokens, call /erc20 with a specific token= (faster & cheaper).

Seeing spam “zero amount” transfers
Keep SKIP_ZERO_VALUE=true and use whitelists + min thresholds.

License

MIT — contribute freely, attribute kindly.
