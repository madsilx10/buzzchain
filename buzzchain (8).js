// buzzchain.js — Buzzchain testnet (Sepolia), FULL HTTP (tanpa Playwright)
// Flow per akun: konek X (OAuth via HTTP + cookies auth_token/ct0) ->
// konek wallet (sign + /wallet/link) -> validator: stake NFT + claim BUZZ.
// Faucet di-skip (sesuai request).
//
// File input (di folder yang sama):
//   wallet.txt : 1 private key per baris
//   akun.txt   : per akun X = 2 baris (auth_token, ct0), antar akun
//                dipisah baris kosong. Akun X ke-i dipasangkan wallet ke-i.
//
// Jalan: node buzzchain.js            (interaktif pilih akun)
//        node buzzchain.js all        (semua akun)
//        node buzzchain.js 2          (akun nomor 2 saja)
//        node buzzchain.js from2      (dari akun 2 sampai akhir)
//
// Catatan: endpoint & kontrak dari JS publik + docs resmi situsnya.
// Bagian OAuth X ditulis generik (OAuth 1.0a & 2.0) dan belum terverifikasi
// live — kalau nyangkut, skrip mencetak URL/status buat di-debug.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ethers } = require('ethers');

const DIR = __dirname;
const API = 'https://testnet.buzzchain.xyz'; // auth/wallet ada di domain situs (baseUrl=g.c), subdomain api cuma buat data relayer
const SITE = 'https://testnet.buzzchain.xyz';
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const VALIDATOR = '0xb5aAdd62fbC1e42bbEF02dDbBbcef053ff2acdf9';
const VAULT = '0x5263121Df28F91EC3c2773814a7c798c0849E148';
const BUZZ = '0xc8bdca3cFD13BcB2b1E5C4Aa3bc35C7196009e2b';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Safari/537.36';
// bearer publik web client X (dipakai frontend x.com sendiri)
const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const ERC721_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
];
const VAULT_ABI = [
  'function stake(uint256[])',
  'function claim(uint256[])',
  'function stakerOf(uint256) view returns (address)',
  'function pendingRewards(uint256) view returns (uint256)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// ── input ───────────────────────────────────────────────────────────────────
function readLines(file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) { console.log(`File ${file} tidak ada di ${DIR}`); process.exit(1); }
  return fs.readFileSync(p, 'utf8').split(/\r?\n/);
}
function loadWallets() {
  return readLines('wallet.txt').map(s => s.trim()).filter(Boolean);
}
function loadXAccounts() {
  const raw = readLines('akun.txt').join('\n');
  const blocks = raw.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map((b, i) => {
    const lines = b.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length < 2) console.log(`akun.txt blok ${i + 1}: kurang dari 2 baris (auth_token, ct0)`);
    return { authToken: lines[0] || '', ct0: lines[1] || '' };
  });
}
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

// ── cookie jar per domain ───────────────────────────────────────────────────
let jar = {}; // domain -> {name: value}
function jarSet(domain, name, value) {
  (jar[domain] ??= {})[name] = value;
}
function jarFromSetCookie(host, headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  for (const part of list) {
    const kv = part.split(';')[0].trim();
    const i = kv.indexOf('=');
    if (i > 0) jarSet(host, kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}
function jarHeader(host) {
  const out = {};
  for (const [d, kv] of Object.entries(jar)) {
    if (host === d || host.endsWith('.' + d) || d.endsWith('.' + host) || host.endsWith(d)) Object.assign(out, kv);
  }
  return Object.entries(out).map(([k, v]) => `${k}=${v}`).join('; ');
}

// fetch manual: tidak auto-follow, kembalikan status + location + body
async function req(url, { method = 'GET', body, headers = {}, form = false } = {}) {
  const host = new URL(url).hostname;
  const hasBody = body !== undefined || method !== 'GET';
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Cookie': jarHeader(host),
      ...(hasBody ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      ...headers,
    },
    body: hasBody ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body ?? {})) : undefined,
  });
  jarFromSetCookie(host, res.headers);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, location: res.headers.get('location'), text, data };
}

async function api(pathname, { method = 'GET', body } = {}) {
  const r = await req(API + pathname, {
    method, body,
    headers: { 'Origin': SITE, 'Referer': SITE + '/' },
  });
  return { status: r.status, data: r.data };
}

// ── sesi per akun ───────────────────────────────────────────────────────────
function sessionFile(idx) { return path.join(DIR, `session-akun${idx}.json`); }
function saveSession(idx) {
  try { fs.writeFileSync(sessionFile(idx), JSON.stringify(jar)); } catch {}
}
function loadSession(idx) {
  try {
    const p = sessionFile(idx);
    if (fs.existsSync(p)) { jar = JSON.parse(fs.readFileSync(p, 'utf8')); return true; }
  } catch {}
  return false;
}

// ── konek X (full HTTP) ─────────────────────────────────────────────────────
// 1) GET /auth/x/login -> redirect ke halaman authorize X
// 2) approve authorize pakai cookies auth_token+ct0 (OAuth 1.0a: form POST;
//    OAuth 2.0: POST internal API x.com)
// 3) ikuti redirect balik ke callback Buzzchain -> sesi tersimpan di jar
async function connectX(acct) {
  for (const d of ['x.com', 'twitter.com', 'api.twitter.com']) {
    jarSet(d, 'auth_token', acct.authToken);
    jarSet(d, 'ct0', acct.ct0);
  }
  let r = await req(`${API}/auth/x/login?return_to=${encodeURIComponent('/')}`);
  if (!r.location) { console.log(`[1] /auth/x/login: ${r.status}, tidak ada redirect`); return false; }
  const authUrl = new URL(r.location, API).href;
  console.log(`[1] Authorize: ${new URL(authUrl).hostname}${new URL(authUrl).pathname}`);

  // halaman authorize
  r = await req(authUrl);
  if (r.status >= 300 && r.status < 400 && r.location) {
    // kadang langsung redirect (sudah pernah authorize)
    return followToBuzzchain(new URL(r.location, authUrl).href);
  }
  if (r.status !== 200) { console.log(`[1] Halaman authorize: ${r.status}`); return false; }

  if (authUrl.includes('oauth2/authorize')) {
    // OAuth 2.0: GET internal API dulu buat ambil `code`, baru POST approve
    const qs = new URL(authUrl).search;
    const xHeaders = {
      'Authorization': `Bearer ${X_BEARER}`,
      'x-csrf-token': acct.ct0,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'Referer': authUrl,
    };
    const info = await req(`https://x.com/i/api/2/oauth2/authorize${qs}`, { headers: xHeaders });
    const code = info.data?.code ?? info.data?.auth_code;
    if (!code) {
      console.log(`[1] OAuth2 ambil code: ${info.status}`, (info.text || '').slice(0, 200));
      return false;
    }
    const post = await req('https://x.com/i/api/2/oauth2/authorize', {
      method: 'POST',
      body: { approval: true, code },
      headers: xHeaders,
    });
    const redir = post.data?.redirect_uri ?? post.location;
    if (redir) { console.log(`[1] Callback: ${new URL(redir).hostname}${new URL(redir).pathname}`); return followToBuzzchain(redir); }
    console.log(`[1] OAuth2 approve: ${post.status}`, (post.text || '').slice(0, 200));
    return false;
  }

  // OAuth 1.0a: form dengan authenticity_token
  const token = r.text.match(/name="authenticity_token"\s+value="([^"]+)"/)?.[1]
    ?? r.text.match(/value="([^"]+)"\s+name="authenticity_token"/)?.[1];
  const oauthToken = new URL(authUrl).searchParams.get('oauth_token')
    ?? r.text.match(/name="oauth_token"\s+value="([^"]+)"/)?.[1];
  if (!token || !oauthToken) {
    console.log('[1] authenticity_token/oauth_token tidak ketemu di halaman authorize');
    return false;
  }
  const post = await req('https://api.twitter.com/oauth/authorize', {
    method: 'POST', form: true,
    body: { authenticity_token: token, oauth_token: oauthToken },
    headers: { 'Referer': authUrl },
  });
  if (post.location) return followToBuzzchain(new URL(post.location, authUrl).href);
  console.log(`[1] OAuth1 approve: ${post.status}, tidak ada redirect`);
  return false;
}

async function followToBuzzchain(url) {
  let cur = url;
  for (let i = 0; i < 10; i++) {
    const r = await req(cur);
    const u = new URL(cur);
    console.log(`[1] -> ${r.status} ${u.hostname}${u.pathname}`);
    if (r.status >= 300 && r.status < 400 && r.location) {
      cur = new URL(r.location, cur).href;
      continue;
    }
    return u.hostname.includes('buzzchain.xyz');
  }
  return false;
}

// ── konek wallet ────────────────────────────────────────────────────────────
async function getMe() {
  const r = await api('/auth/me');
  return r.status === 200 ? (r.data?.data ?? r.data) : null;
}
function linkedWalletOf(me) {
  return me?.user?.address ?? me?.wallet ?? me?.wallet_address ?? me?.address ?? me?.linked_wallet ?? null;
}
// Bangun pesan SIWE (EIP-4361) dari komponen respons /auth/wallet/nonce
function buildSiwe(d, address) {
  let m = `${d.domain} wants you to sign in with your Ethereum account:\n${address}\n\n${d.statement}\n\nURI: ${d.uri}\nVersion: ${d.version}\nChain ID: ${d.chainId}\nNonce: ${d.nonce}\nIssued At: ${d.issuedAt}`;
  if (d.expirationTime) m += `\nExpiration Time: ${d.expirationTime}`;
  return m;
}

async function connectWallet(wallet) {
  const me = await getMe();
  const linked = linkedWalletOf(me);
  if (linked && linked.toLowerCase() === wallet.address.toLowerCase()) {
    console.log('[2] Konek wallet: sudah terhubung');
    return true;
  }
  const ch = await api('/auth/wallet/nonce', { method: 'POST' });
  const d = ch.data?.data ?? ch.data ?? {};
  const message = d.message ?? d.challenge ?? d.sign_message ?? ((d.nonce && d.domain) ? buildSiwe(d, wallet.address) : null);
  if (!message) {
    console.log(`[2] Konek wallet: respons /auth/wallet/nonce (${ch.status}) tidak ada field message:`);
    console.log('   ', JSON.stringify(ch.data).slice(0, 400));
    return false;
  }
  const signature = await wallet.signMessage(message);
  const r = await api('/auth/wallet/link', { method: 'POST', body: { message, signature } });
  if (r.status >= 200 && r.status < 300) { console.log('[2] Konek wallet: OK'); return true; }
  console.log(`[2] Konek wallet: gagal (${r.status})`, JSON.stringify(r.data).slice(0, 300));
  return false;
}

// ── on-chain (Sepolia) ──────────────────────────────────────────────────────
async function ownedTokenIds(nft, address, provider) {
  const bal = Number(await nft.balanceOf(address));
  if (bal === 0) return [];
  const ids = [];
  try {
    for (let i = 0; i < bal; i++) ids.push(await nft.tokenOfOwnerByIndex(address, i));
    return ids;
  } catch {
    const topic = ethers.id('Transfer(address,address,uint256)');
    const toTopic = ethers.zeroPadValue(address, 32);
    const latest = await provider.getBlockNumber();
    const seen = new Set();
    const CHUNK = 100000;
    for (let from = 0; from <= latest; from += CHUNK) {
      const logs = await provider.getLogs({
        address: VALIDATOR, topics: [topic, null, toTopic],
        fromBlock: from, toBlock: Math.min(from + CHUNK - 1, latest),
      });
      for (const l of logs) seen.add(BigInt(l.topics[3]));
    }
    for (const id of seen) {
      try { if ((await nft.ownerOf(id)).toLowerCase() === address.toLowerCase()) ids.push(id); } catch {}
    }
    return ids;
  }
}

async function doValidator(wallet) {
  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = wallet.connect(provider);
  const eth = await provider.getBalance(wallet.address);
  console.log(`[3] Sepolia ETH: ${ethers.formatEther(eth)}`);
  if (eth === 0n) { console.log('[3] ETH kosong, skip stake/claim (butuh gas)'); return; }

  const nft = new ethers.Contract(VALIDATOR, ERC721_ABI, signer);
  const vault = new ethers.Contract(VAULT, VAULT_ABI, signer);
  const buzz = new ethers.Contract(BUZZ, ERC20_ABI, provider);

  const ids = await ownedTokenIds(nft, wallet.address, provider);
  const staked = [];
  const unstaked = [];
  for (const id of ids) {
    const s = await vault.stakerOf(id).catch(() => null);
    if (s && s.toLowerCase() === wallet.address.toLowerCase()) staked.push(id);
    else unstaked.push(id);
  }
  console.log(`[3] NFT validator: ${ids.length} (staked ${staked.length}, belum ${unstaked.length})`);

  if (unstaked.length) {
    const approved = await nft.isApprovedForAll(wallet.address, VAULT);
    if (!approved) {
      console.log('[4] Approve vault...');
      await (await nft.setApprovalForAll(VAULT, true)).wait();
    }
    console.log(`[4] Stake ${unstaked.length} NFT...`);
    await (await vault.stake(unstaked)).wait();
    staked.push(...unstaked);
    console.log('[4] Stake: OK');
  }

  if (staked.length) {
    let pending = 0n;
    for (const id of staked) pending += await vault.pendingRewards(id).catch(() => 0n);
    console.log(`[5] Pending reward: ${ethers.formatEther(pending)} BUZZ`);
    if (pending > 0n) {
      const before = await buzz.balanceOf(wallet.address);
      await (await vault.claim(staked)).wait();
      const after = await buzz.balanceOf(wallet.address);
      console.log(`[5] Claim BUZZ: OK +${ethers.formatEther(after - before)} (total ${ethers.formatEther(after)})`);
    }
  } else {
    console.log('[5] Belum ada NFT ter-stake, tidak ada yang di-claim');
  }
}

// ── per akun ────────────────────────────────────────────────────────────────
async function processAccount(acct, privkey, idx, total) {
  jar = {};
  const wallet = new ethers.Wallet(privkey.trim());
  console.log(`\n===== Akun ${idx}/${total} : ${wallet.address} =====`);

  let me = null;
  if (loadSession(idx)) me = await getMe();
  if (!me) {
    jar = {};
    console.log('[1] Konek X...');
    const ok = await connectX(acct);
    me = ok ? await getMe() : null;
    if (!me) {
      const dbg = await api('/auth/me');
      console.log(`[1] /auth/me: ${dbg.status}`, JSON.stringify(dbg.data).slice(0, 200));
      console.log('[1] Konek X: gagal (cek auth_token/ct0)');
      return;
    }
    saveSession(idx);
  }
  const uname = me?.user?.username ?? me?.username ?? me?.x_username ?? me?.handle ?? me?.name ?? '';
  console.log(`[1] Konek X: OK${uname ? ' @' + uname : ''}`);

  const linked = await connectWallet(wallet);
  if (!linked) return;

  try {
    await doValidator(wallet);
  } catch (e) {
    console.log('[!] On-chain gagal:', e.shortMessage || e.message);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const wallets = loadWallets();
  const accounts = loadXAccounts();
  const n = Math.min(wallets.length, accounts.length);
  if (wallets.length !== accounts.length) {
    console.log(`wallet.txt: ${wallets.length} wallet, akun.txt: ${accounts.length} akun X — diproses ${n} pasangan pertama`);
  }
  if (n === 0) { console.log('Tidak ada pasangan akun/wallet'); return; }

  const arg = (process.argv[2] || '').toLowerCase();
  let selected = [];
  if (arg === 'all') selected = [...Array(n).keys()];
  else if (/^\d+$/.test(arg)) selected = [Number(arg) - 1];
  else if (/^from\d+$/.test(arg)) {
    const s = Number(arg.slice(4)) - 1;
    selected = [...Array(n - s).keys()].map(i => i + s);
  } else {
    console.log(`\nPilih akun (${n} pasangan):\n  1 satu akun\n  2 semua\n  3 dari akun ke-X sampai akhir`);
    const m = await ask('Pilihan (1-3): ');
    if (m === '2') selected = [...Array(n).keys()];
    else if (m === '3') {
      const s = Number(await ask('Dari akun nomor: ')) - 1;
      selected = [...Array(n - s).keys()].map(i => i + s);
    } else {
      selected = [Number(await ask('Akun nomor: ')) - 1];
    }
  }
  selected = selected.filter(i => i >= 0 && i < n);
  if (!selected.length) { console.log('Pilihan tidak valid'); return; }

  for (let k = 0; k < selected.length; k++) {
    const i = selected[k];
    try {
      await processAccount(accounts[i], wallets[i], i + 1, n);
    } catch (e) {
      console.log(`[!] Akun ${i + 1} gagal:`, e.message);
    }
  }
  console.log('\nSelesai.');
}

main().catch(e => { console.error(e); process.exit(1); });
