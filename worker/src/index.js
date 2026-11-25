/**
 * PDF 線上編輯器 — 後端（Cloudflare Workers）
 *
 *  - Google 登入驗證（Firebase ID token，用 Google 公開金鑰驗簽）
 *  - 試用次數 / 付費方案判斷（一定要在後端判斷，前端無法竄改）
 *  - 批次線上簽名：上傳報名表、產生每位學生專屬簽名網址（網頁上匯出名單，不寄信）、簽名回傳後鎖定、退回重簽
 *  - 綠界 ECPay 付款建立與付款結果通知（驗證 CheckMacValue）
 *  - 每日排程：刪除過期批次
 *  - 網頁（web 資料夾）也由這個 Worker 一起提供，網頁和後端同一個網址
 *
 * 綁定：DB (D1)、ASSETS（網頁）；FILES (R2) 可有可無——有 R2 就存 R2，沒有 R2 時 PDF 切塊存進 D1。
 *       從 D1 改成 R2 後，舊檔案照樣讀得到，排程會自動把它們搬到 R2。設定值見 wrangler.toml 的 [vars] 與 README。
 * 資料表會在第一次有人連線時自動建立，不用另外執行 schema.sql。
 */

/* ============================== 基本工具 ============================== */
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }
const now = () => Date.now();
const DAY = 86400000;
const enc = new TextEncoder();

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allow = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (origin && (allow.includes(origin) || allow.includes('*'))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-File-Name, X-Meta';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function json(data, status, req, env) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req, env) } });
}
async function body(req) { try { return await req.json(); } catch (e) { throw new HttpError(400, '資料格式錯誤'); } }
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
const randId = (n = 12) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256hex(str) { const d = await crypto.subtle.digest('SHA-256', enc.encode(str)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
const intVar = (env, k, d) => { const v = parseInt(env[k], 10); return Number.isFinite(v) ? v : d; };
const jsonVar = (env, k, d) => { try { return env[k] ? (typeof env[k] === 'string' ? JSON.parse(env[k]) : env[k]) : d; } catch (e) { return d; } };
const twNow = () => new Date(now() + 8 * 3600000);              // 台灣時間（UTC+8）
const twDayStart = () => { const d = twNow(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600000; };
const twMonthStart = () => { const d = twNow(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 8 * 3600000; };
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normEmail = e => String(e || '').trim().toLowerCase();
const maskEmail = e => { const [u, d] = String(e || '').split('@'); if (!d) return ''; return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d; };

/* ============================== Firebase 登入驗證 ============================== */
let JWKS = null, JWKS_EXP = 0;
async function googleKeys() {
  if (JWKS && JWKS_EXP > now()) return JWKS;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com', { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new HttpError(503, '暫時無法驗證登入，請稍後再試');
  const m = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') || '');
  JWKS = (await r.json()).keys; JWKS_EXP = now() + (m ? +m[1] * 1000 : 3600000);
  return JWKS;
}
async function verifyIdToken(token, env) {
  if (env.DEV_AUTH === 'on' && token.startsWith('dev:')) {      // 只給本機測試用，正式環境絕對不要打開
    const email = normEmail(token.slice(4)); return { uid: 'dev-' + email, email, name: email.split('@')[0], email_verified: true };
  }
  const parts = token.split('.'); if (parts.length !== 3) throw new HttpError(401, '登入資訊無效，請重新登入');
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))); }
  catch (e) { throw new HttpError(401, '登入資訊無效，請重新登入'); }
  if (header.alg !== 'RS256') throw new HttpError(401, '登入資訊無效，請重新登入');
  let jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) { JWKS_EXP = 0; jwk = (await googleKeys()).find(k => k.kid === header.kid); }
  if (!jwk) throw new HttpError(401, '登入已過期，請重新登入');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new HttpError(401, '登入資訊無效，請重新登入');
  const pid = env.FIREBASE_PROJECT_ID; const t = Math.floor(now() / 1000);
  if (payload.aud !== pid || payload.iss !== 'https://securetoken.google.com/' + pid) throw new HttpError(401, '登入資訊不屬於本網站');
  if (!(payload.exp > t - 30) || !(payload.iat < t + 300) || !payload.sub) throw new HttpError(401, '登入已過期，請重新登入');
  return { uid: payload.sub, email: normEmail(payload.email), name: payload.name || '', email_verified: !!payload.email_verified };
}
async function authUser(req, env, required = true) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) { if (required) throw new HttpError(401, '請先用 Google 帳號登入', { need_login: true }); return null; }
  const u = await verifyIdToken(token, env);
  const ins = await env.DB.prepare('INSERT INTO users (uid, email, name, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(uid) DO NOTHING')
    .bind(u.uid, u.email, u.name, now()).run();
  if (ins.meta.changes && u.email) await applyPendingGrants(env, u);   // 第一次登入：把管理者事先開通給這個 Email 的權限加上去
  return u;
}
async function applyPendingGrants(env, u) {
  const { results } = await env.DB.prepare('SELECT * FROM pending_grants WHERE email = ? AND applied_at IS NULL').bind(u.email).all();
  for (const g of results) {
    const r = await env.DB.prepare('UPDATE pending_grants SET applied_at = ?, uid = ? WHERE id = ? AND applied_at IS NULL').bind(now(), u.uid, g.id).run();
    if (r.meta.changes) await env.DB.batch(grantStmts(env, u.uid, { pro_days: g.pro_days, credits: g.credits, credit_days: g.credit_days }, g.reason, g.note));
  }
}
const adminList = env => [env.SITE_ADMINS, env.OWNER_EMAILS].join(',').split(',').map(normEmail).filter(Boolean);
const isSiteAdmin = (u, env) => !!u && !!u.email && u.email_verified !== false && adminList(env).includes(u.email);

/* ============================== 方案、簽名份數與試用 ==============================
 * 兩種商品：
 *  1. 進階版（pro_days）：批次轉檔不限檔案數；批次簽名的檔案在進階版期間不限保存天數
 *     （進階版到期 PRO_GRACE_DAYS 天後才刪除）。掃描文字辨識、Office 轉檔免費版也不限次數（FREE_QUOTA 填 0 = 不限）。
 *  2. 批次簽名份數（credits）：「有簽名才算份數」——上傳時先預留 1 份，學生簽好才真正算掉；
 *     沒簽就刪除、或批次到期自動刪除，預留的份數會退回。退回重簽不另外算。
 *     免費試用 FREE_DOC_CREDITS 份（每個帳號一次），試用批次最多保存 FREE_RETAIN_DAYS 天。
 */
const DEFAULT_PLANS = {
  pro_m: { name: '進階版 1 個月', price: 49, pro_days: 31, pay: 'Credit' },
  pro_y: { name: '進階版 1 年', price: 390, pro_days: 366 },
  sign300: { name: '批次簽名 300 份', price: 190, credits: 300, credit_days: 365, pay: 'Credit' },
  sign1000: { name: '批次簽名 1,000 份＋進階版 1 年', price: 490, credits: 1000, credit_days: 365, pro_days: 366 },
  sign3000: { name: '批次簽名 3,000 份＋進階版 1 年', price: 990, credits: 3000, credit_days: 365, pro_days: 366 }
};
const freeBatchFiles = env => intVar(env, 'FREE_BATCH_FILES', 10);   // 批次轉檔：免費版一次最多幾個檔案，超過要進階版
function plans(env) { return jsonVar(env, 'PLANS', DEFAULT_PLANS); }
function freeQuota(env) { return jsonVar(env, 'FREE_QUOTA', { ocr: 0, convert: 0 }); }   // 每個月重新計算；0 = 不限次數
const proGraceDays = env => intVar(env, 'PRO_GRACE_DAYS', 30);
async function account(u, env) {
  const row = (await env.DB.prepare('SELECT * FROM users WHERE uid = ?').bind(u.uid).first()) || {};
  const paidUntil = row.paid_until || 0; const pro = paidUntil > now();
  const creditsLive = (row.credits_until || 0) > now();
  const trialLimit = intVar(env, 'FREE_DOC_CREDITS', 30);
  const used = {}; const q = freeQuota(env);
  const { results } = await env.DB.prepare('SELECT feature, COUNT(*) AS n FROM usage WHERE uid = ? AND trial = 1 AND created_at >= ? GROUP BY feature').bind(u.uid, twMonthStart()).all();
  for (const r of results) used[r.feature] = r.n;
  const quota = {}; for (const f of Object.keys(q)) quota[f] = q[f] > 0 ? { limit: q[f], used: used[f] || 0, remaining: Math.max(0, q[f] - (used[f] || 0)), monthly: true }
    : { limit: null, used: used[f] || 0, remaining: null, unlimited: true };
  // 預留中的份數：已上傳、學生還沒簽的文件（沒簽就會退回）
  const held = { trial: 0, paid: 0 };
  const hr = await env.DB.prepare('SELECT credit, COUNT(*) AS n FROM docs WHERE owner_uid = ? AND COALESCE(charged, 0) = 0 AND credit IS NOT NULL GROUP BY credit').bind(u.uid).all();
  for (const r of hr.results) if (r.credit in held) held[r.credit] = r.n;
  return {
    uid: u.uid, email: u.email, name: u.name, paid: pro, paid_until: paidUntil || null, quota,
    credits: { paid: creditsLive ? (row.doc_credits || 0) : 0, paid_until: creditsLive ? row.credits_until : null, expired: !creditsLive && (row.doc_credits || 0) > 0 ? row.doc_credits : 0,
      trial: Math.max(0, trialLimit - (row.trial_docs || 0)), trial_limit: trialLimit, held_paid: held.paid, held_trial: held.trial },
    keep: keepRule(env, pro, creditsLive && (row.doc_credits || 0) + held.paid > 0),
    batch_files: pro ? null : freeBatchFiles(env),
    site_admin: isSiteAdmin(u, env)
  };
}
/* count = 這次要處理幾個檔案（批次轉檔一次多個檔案時，每個檔案算一次） */
async function consume(u, env, feature, count = 1) {
  const q = freeQuota(env); if (!(feature in q)) throw new HttpError(400, '未知的功能');
  count = Math.max(1, Math.min(500, parseInt(count, 10) || 1));
  const acc = await account(u, env);
  const rows = n => Array.from({ length: Math.min(n, 100) }, () => '(?, ?, ?, ?)').join(',');
  const log = async (trial, n) => { const a = []; for (let i = 0; i < Math.min(n, 100); i++) a.push(u.uid, feature, trial, now()); await env.DB.prepare(`INSERT INTO usage (uid, feature, trial, created_at) VALUES ${rows(n)}`).bind(...a).run(); };
  if (acc.paid) { await log(0, count); return { ok: true, paid: true }; }
  const lim = freeBatchFiles(env);
  if (count > lim) throw new HttpError(402, `免費版一次最多批次轉 ${lim} 個檔案，這次選了 ${count} 個。開通進階版就能一次轉更多（不限次數），或分成每次 ${lim} 個以內轉`, { need_pay: true, feature, batch_limit: lim });
  if (acc.quota[feature].unlimited) { await log(1, count); return { ok: true, paid: false, unlimited: true }; }
  const left = acc.quota[feature].remaining;
  if (left < count) throw new HttpError(402, left <= 0 ? `這個月的免費次數（${q[feature]} 次）已經用完，下個月 1 日會重新計算；開通進階版就不限次數`
    : `這個月的免費次數只剩 ${left} 次，這次要轉 ${count} 個檔案。請減少檔案數，或開通進階版就不限次數`, { need_pay: true, feature, remaining: left });
  await log(1, count);
  return { ok: true, paid: false, remaining: left - count };
}
/* 批次轉檔（JPG／PNG 這種不扣次數的格式）只檢查檔案數 */
async function batchCheck(u, env, count) {
  count = Math.max(1, parseInt(count, 10) || 1); const lim = freeBatchFiles(env);
  if (count <= lim) return { ok: true, limit: lim };
  const acc = await account(u, env);
  if (acc.paid) return { ok: true, paid: true };
  throw new HttpError(402, `免費版一次最多批次轉 ${lim} 個檔案，這次選了 ${count} 個。開通進階版就能一次轉更多，或分成每次 ${lim} 個以內轉`, { need_pay: true, batch_limit: lim });
}
/* 扣 1 份：試用批次先用試用份數，用完而且有買份數時，批次自動轉成付費批次 */
async function spendCredit(env, u, b) {
  if (b.trial) {
    const r = await env.DB.prepare('UPDATE users SET trial_docs = COALESCE(trial_docs, 0) + 1 WHERE uid = ? AND COALESCE(trial_docs, 0) < ?').bind(u.uid, intVar(env, 'FREE_DOC_CREDITS', 30)).run();
    if (r.meta.changes) return 'trial';
  }
  const r = await env.DB.prepare('UPDATE users SET doc_credits = doc_credits - 1 WHERE uid = ? AND doc_credits > 0 AND credits_until > ?').bind(u.uid, now()).run();
  if (r.meta.changes) {
    if (b.trial) { await env.DB.prepare('UPDATE batches SET trial = 0 WHERE id = ?').bind(b.id).run(); b.trial = 0; }
    return 'paid';
  }
  throw new HttpError(402, b.trial ? `免費試用的 ${intVar(env, 'FREE_DOC_CREDITS', 30)} 份已經用完，購買簽名份數就能繼續上傳` : '簽名份數已經用完（或已過期），請購買份數後再上傳', { need_pay: true });
}
async function refundCredit(env, uid, kind) {
  if (kind === 'trial') await env.DB.prepare('UPDATE users SET trial_docs = MAX(0, COALESCE(trial_docs, 0) - 1) WHERE uid = ?').bind(uid).run();
  else if (kind === 'paid') await env.DB.prepare('UPDATE users SET doc_credits = COALESCE(doc_credits, 0) + 1 WHERE uid = ?').bind(uid).run();
}
// 有簽名才算份數：學生還沒簽過（charged = 0）的文件，刪除或到期時退回預留的份數
const refundable = d => !d.charged && !!d.credit;
/* 保存天數：進階版不限（forever）；有買份數最多 MAX_RETAIN_DAYS 天；免費試用最多 FREE_RETAIN_DAYS 天 */
function keepRule(env, pro, paidCredits) {
  if (pro) return { forever: true, max_days: null, grace_days: proGraceDays(env) };
  return { forever: false, max_days: paidCredits ? intVar(env, 'MAX_RETAIN_DAYS', 180) : intVar(env, 'FREE_RETAIN_DAYS', 7) };
}
function batchKeep(env, acc, trialBatch, want, base, current) {
  const rule = keepRule(env, acc.paid, !trialBatch);
  if (want === 'forever') { if (rule.forever) return null; throw new HttpError(402, '「不限保存天數」是進階版的功能', { need_pay: true }); }
  const floor = now() + DAY;
  if (rule.forever) return Math.max(floor, +want || now() + 90 * DAY);
  const cap = Math.max(floor, base + rule.max_days * DAY, current || 0);   // 不能超過上限（已經設定的日期可以保留）
  return Math.max(floor, Math.min(cap, +want || cap));
}
/* 付款成功或管理者手動開通：加進階版天數、加份數（新份數的期限會把舊份數一起延長） */
function grantStmts(env, uid, { pro_days, credits, credit_days }, reason, ref) {
  const t = now(); const s = [];
  if (pro_days) s.push(env.DB.prepare('UPDATE users SET paid_until = MAX(COALESCE(paid_until, 0), ?1) + ?2 WHERE uid = ?3').bind(t, pro_days * DAY, uid));
  if (credits) {
    s.push(env.DB.prepare('UPDATE users SET doc_credits = (CASE WHEN COALESCE(credits_until, 0) > ?1 THEN COALESCE(doc_credits, 0) ELSE 0 END) + ?2, credits_until = MAX(COALESCE(credits_until, 0), ?3) WHERE uid = ?4')
      .bind(t, credits, t + (credit_days || 365) * DAY, uid));
  }
  s.push(env.DB.prepare('INSERT INTO credit_log (uid, credits, pro_days, reason, ref, created_at) VALUES (?,?,?,?,?,?)').bind(uid, credits || 0, pro_days || 0, reason, ref || '', t));
  return s;
}
async function storedBytes(env) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(orig_size),0) + COALESCE(SUM(signed_size),0) AS bytes FROM docs').first();
  const t = await env.DB.prepare('SELECT COALESCE(SUM(tpl_size),0) AS bytes FROM batches').first();
  return (r.bytes || 0) + (t.bytes || 0);
}
/* 上傳前檢查網站的檔案空間 */
async function storageCheck(env, b, len) {
  const lim = storageLimits(env);
  if (lim.hard > 0 && (await storedBytes(env)) + len > lim.hard)   // 檔案存在 D1 時，滿了就不能再上傳，免得整個資料庫寫不進去
    throw new HttpError(503, '網站的檔案空間已滿，請先刪除已經不用的批次，或聯絡網站管理者', { storage_full: true });
  if (b.trial && lim.guard > 0 && (await storedBytes(env)) + len > lim.guard)   // 免費試用的總空間到警戒線時，先停止試用上傳；付費的照常
    throw new HttpError(503, '網站的免費試用空間暫時額滿，請過幾天再試，或購買簽名份數後馬上就能上傳', { need_pay: true, storage_full: true });
}

/* ============================== 簽名網址 ============================== */
// SITE_URL 沒填時，用目前網站的網址（Worker 同時提供網頁和後端，所以一定對）
const siteBase = (env, req) => (env.SITE_URL || (req ? new URL(req.url).origin : '')).replace(/\/$/, '');
function signUrl(env, token, req) { return `${siteBase(env, req)}/sign.html?t=${token}`; }
function joinUrl(env, link, req) { return `${siteBase(env, req)}/sign.html?b=${link}`; }

/* ============================== 簽名方式與簽名人 ==============================
 * 批次有三種簽名方式（batches.mode）：
 *  list  指定人員：每份文件 1 個人簽（名單上的 Email）
 *  multi 多人簽同一份：每份文件最多 MAX_SIGNERS 個人，照順序輪流簽，後面的人看得到前面的人簽好的樣子
 *  open  連署：不限定人員，拿到網址的人用 Google 登入就能簽，每簽一個人就多一份（份數 = 簽名人數）
 * 三種方式都用同一個共用網址（sign.html?b=batches.link）：打開後先用 Google 登入（第一次登入就等於註冊），
 * 系統再依登入的 Email 帶到他要簽的那份。舊的每人專屬網址（sign.html?t=docs.token）也還能用。
 * docs.signers = [{ email, name, at, ip, key, size }]（JSON，依簽名順序）；docs.cur = 已經簽了幾個人。
 * 每個人簽好都另存一個版本（key），退回時可以退到某個人，從他開始重簽。舊資料沒有 signers 時用 email 欄當唯一的簽名人。 */
const MAX_SIGNERS = 5;
const MODES = ['list', 'multi', 'open'];
const modeOf = b => MODES.includes(b && b.mode) ? b.mode : 'list';
function signersOf(d) {
  if (d.signers) { try { const a = JSON.parse(d.signers); if (Array.isArray(a) && a.length) return a; } catch (e) { } }
  const done = d.status === 'signed';
  return [{ email: normEmail(d.email), name: d.student_name || '', at: done ? d.signed_at : null, ip: done ? d.signed_ip : null, key: done ? d.signed_key : null, size: done ? d.signed_size : null }];
}
const curOf = (d, s) => d.signers ? Math.min(s.length, d.cur || 0) : (d.status === 'signed' ? 1 : 0);
// 第 c 個人要簽的版本：前一個人簽好的檔案；都還沒人簽就是原檔（連署用批次的共用文件）
function keyBefore(d, s, c, tplKey) { for (let i = c - 1; i >= 0; i--) if (s[i] && s[i].key) return s[i].key; return d.orig_key || tplKey || null; }
const sizeOf = s => s.reduce((n, x) => n + (x.key ? (x.size || 0) : 0), 0);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanSigners(arr, max, taken = []) {
  const out = [], seen = new Set(taken.map(normEmail).filter(Boolean));
  for (const x of (Array.isArray(arr) ? arr : [])) {
    const email = normEmail(x && x.email).slice(0, 200), name = String((x && x.name) || '').trim().slice(0, 60);
    if (!email && !name) continue;
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, `Email 格式不對：${email}`);
    if (email && seen.has(email)) throw new HttpError(400, `同一份文件裡，${email} 出現了兩次`);
    if (email) seen.add(email);
    out.push({ email, name });
  }
  if (out.length > max) throw new HttpError(400, max === 1 ? '「指定人員」每份文件只能有 1 個簽名人；要多人簽同一份，請建立「多人簽同一份」的批次' : `一份文件最多 ${max} 個人簽名`);
  return out;
}
const maxSigners = b => modeOf(b) === 'multi' ? MAX_SIGNERS : 1;

/* ============================== 批次簽名 ============================== */
async function ownBatch(env, u, id) {
  const b = await env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(id).first();
  if (!b || b.owner_uid !== u.uid) throw new HttpError(404, '找不到這個批次');
  return b;
}
async function ownDoc(env, u, id) {
  const d = await env.DB.prepare('SELECT * FROM docs WHERE id = ?').bind(id).first();
  if (!d || d.owner_uid !== u.uid) throw new HttpError(404, '找不到這份文件');
  return d;
}
const docOut = (env, d, req) => { const s = signersOf(d), c = curOf(d, s); return { id: d.id, filename: d.filename, student_id: d.student_id, student_name: d.student_name, email: d.email, status: d.status,
  sign_url: signUrl(env, d.token, req), sent_at: d.sent_at, sent_count: d.sent_count, signed_at: d.signed_at, signed_email: d.signed_email, return_reason: d.return_reason, orig_size: d.orig_size, signed_size: d.signed_size,
  signers: s.map(x => ({ email: x.email || '', name: x.name || '', at: x.key ? x.at : null })), cur: c, created_at: d.created_at }; };
// 舊批次沒有共用網址，第一次打開時補上
async function ensureLink(env, b) {
  if (b.link) return b.link;
  const link = randId(16);
  await env.DB.prepare('UPDATE batches SET link = ? WHERE id = ? AND link IS NULL').bind(link, b.id).run();
  return (b.link = (await env.DB.prepare('SELECT link FROM batches WHERE id = ?').bind(b.id).first()).link);
}
const docKeys = d => [d.orig_key, d.signed_key, ...signersOf(d).map(x => x.key)];
async function readPdf(req, env) {
  const max = intVar(env, 'MAX_PDF_MB', 20) * 1048576;
  const len = +req.headers.get('Content-Length') || 0; if (len > max) throw new HttpError(413, `檔案太大，上限 ${env.MAX_PDF_MB || 20} MB`);
  const buf = await req.arrayBuffer(); if (buf.byteLength > max) throw new HttpError(413, `檔案太大，上限 ${env.MAX_PDF_MB || 20} MB`);
  const head = new Uint8Array(buf.slice(0, 1024)); const s = String.fromCharCode(...head);
  if (!s.includes('%PDF-')) throw new HttpError(415, '這不是 PDF 檔');
  return buf;
}
/* ---------- 檔案儲存 ----------
 * 有綁 R2（FILES）就用 R2；沒有綁就把 PDF 切成小塊存進 D1 資料庫（D1 不用綁信用卡）。
 * D1 每一列最大 2 MB，所以每塊 1.8 MB；讀取時一塊一塊送出，不會一次占用太多記憶體。
 * 想把檔案和其他資料分開，可以另外建一個 D1、綁定名稱填 FILEDB；沒有就跟主資料庫放一起。 */
const CHUNK = 1800000;
const fileDb = env => env.FILEDB || env.DB;
async function filePut(env, key, buf) {
  if (env.FILES) return env.FILES.put(key, buf, { httpMetadata: { contentType: 'application/pdf' } });
  const db = fileDb(env), u8 = new Uint8Array(buf), t = now();
  const st = [db.prepare('DELETE FROM files WHERE key = ?').bind(key)];
  for (let i = 0, part = 0; i < u8.length || part === 0; i += CHUNK, part++)
    st.push(db.prepare('INSERT INTO files (key, part, data, created_at) VALUES (?, ?, ?, ?)').bind(key, part, u8.slice(i, i + CHUNK).buffer, t));
  await db.batch(st);   // 一次寫入，全部成功或全部失敗
}
async function fileGet(env, key) {
  if (env.FILES) { const o = await env.FILES.get(key); if (o) return o; }   // 改用 R2 以前存在 D1 的舊檔案，還沒搬完時從 D1 讀
  const db = fileDb(env);
  const { results } = await db.prepare('SELECT part FROM files WHERE key = ? ORDER BY part').bind(key).all();
  if (!results.length) return null;
  const parts = results.map(r => r.part); let i = 0;
  const body = new ReadableStream({
    async pull(ctrl) {
      if (i >= parts.length) return ctrl.close();
      const r = await db.prepare('SELECT data FROM files WHERE key = ? AND part = ?').bind(key, parts[i++]).first();
      if (r && r.data) ctrl.enqueue(new Uint8Array(r.data));
    }
  });
  return { body };
}
async function deleteKeys(env, keys) {
  keys = keys.filter(Boolean); if (!keys.length) return;
  if (env.FILES) for (let i = 0; i < keys.length; i += 900) await env.FILES.delete(keys.slice(i, i + 900));
  const db = fileDb(env);   // D1 裡可能還有改用 R2 前的舊檔案，一起刪
  for (let i = 0; i < keys.length; i += 50) { const k = keys.slice(i, i + 50); await db.prepare(`DELETE FROM files WHERE key IN (${k.map(() => '?').join(',')})`).bind(...k).run(); }
}
// 檔案空間上限：R2 用 GB 設定；存在 D1 時用 MB 設定（D1 免費版每個資料庫最大 500 MB）
function storageLimits(env) {
  const num = (k, d) => { const v = parseFloat(env[k]); return Number.isFinite(v) ? v : d; };
  if (env.FILES) return { mode: 'r2', limit: num('R2_FREE_GB', 10) * 1073741824, guard: num('TRIAL_STORAGE_GUARD_GB', 8) * 1073741824, hard: num('R2_MAX_GB', 50) * 1073741824 };
  const limit = num('D1_FILE_LIMIT_MB', 450) * 1048576;
  return { mode: 'd1', limit, guard: num('D1_TRIAL_GUARD_MB', 300) * 1048576, hard: limit };
}
/* 刪除整個批次（手動刪除或到期）：學生還沒簽的文件，預留的份數退回給承辦人 */
/* 從 D1 搬到 R2：一次搬幾個檔案，用串流一塊一塊寫，不占記憶體。排程每小時執行，搬完就沒事做 */
async function migrateToR2(env, maxKeys = 40) {
  if (!env.FILES) return 0;
  const db = fileDb(env); let moved = 0;
  const { results } = await db.prepare('SELECT key, SUM(LENGTH(data)) AS n FROM files GROUP BY key LIMIT ?').bind(maxKeys).all();
  for (const { key, n } of results) {
    try {
      const parts = (await db.prepare('SELECT part FROM files WHERE key = ? ORDER BY part').bind(key).all()).results.map(r => r.part);
      const { readable, writable } = new FixedLengthStream(n || 0); const w = writable.getWriter();
      const pump = (async () => { for (const part of parts) { const r = await db.prepare('SELECT data FROM files WHERE key = ? AND part = ?').bind(key, part).first(); if (r && r.data) await w.write(new Uint8Array(r.data)); } await w.close(); })();
      await Promise.all([env.FILES.put(key, readable, { httpMetadata: { contentType: 'application/pdf' } }), pump]);
      await db.prepare('DELETE FROM files WHERE key = ?').bind(key).run(); moved++;
    } catch (e) { console.error('migrate', key, e); }
  }
  return moved;
}
async function deleteBatch(env, b) {
  const { results } = await env.DB.prepare('SELECT orig_key, signed_key, signers, email, student_name, status, signed_at, signed_ip, signed_size, credit, charged FROM docs WHERE batch_id = ?').bind(b.id).all();
  await deleteKeys(env, [...new Set([b.tpl_key, ...results.flatMap(docKeys)])]);
  const back = { trial: 0, paid: 0 }; for (const d of results) if (refundable(d) && d.credit in back) back[d.credit]++;
  const st = [env.DB.prepare('DELETE FROM docs WHERE batch_id = ?').bind(b.id), env.DB.prepare('DELETE FROM batches WHERE id = ?').bind(b.id)];
  if (back.trial) st.push(env.DB.prepare('UPDATE users SET trial_docs = MAX(0, COALESCE(trial_docs, 0) - ?) WHERE uid = ?').bind(back.trial, b.owner_uid));
  if (back.paid) st.push(env.DB.prepare('UPDATE users SET doc_credits = COALESCE(doc_credits, 0) + ? WHERE uid = ?').bind(back.paid, b.owner_uid));
  await env.DB.batch(st);
  return back.trial + back.paid;
}
function fileResponse(obj, name, req, env, inline = true) {
  const h = new Headers(corsHeaders(req, env));
  h.set('Content-Type', 'application/pdf'); h.set('Cache-Control', 'private, no-store');
  h.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  h.set('X-Content-Type-Options', 'nosniff');
  return new Response(obj.body, { headers: h });
}
/* 學生端：用簽名網址裡的 token 找文件，必要時要求本人 Google 登入 */
async function signDoc(req, env, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, '簽名網址不正確');
  const d = await env.DB.prepare('SELECT d.*, b.name AS batch_name, b.org_name, b.message, b.deadline, b.require_login, b.retain_until, b.mode, b.tpl_key, b.link, b.owner_uid AS b_owner FROM docs d JOIN batches b ON b.id = d.batch_id WHERE d.token = ?').bind(token).first();
  if (!d) throw new HttpError(404, '找不到這份文件，可能已被刪除或網址不完整');
  const s = signersOf(d), c = curOf(d, s);
  d._s = s; d._cur = c;
  if (d.require_login || d.signers) {
    const hint = s.map(x => maskEmail(x.email)).filter(Boolean).join('、');
    const u = await authUser(req, env, false);
    if (!u) throw new HttpError(401, '請用對方通知你的 Google 帳號登入', { need_login: true, hint });
    const me = u.email_verified ? s.findIndex(x => x.email && x.email === u.email) : -1;
    if (me < 0) throw new HttpError(403, `這份文件只開放給 ${hint || '指定的人'} 開啟，請改用那個帳號登入`, { wrong_account: true, hint });
    d._viewer = u.email; d._me = me;
  } else d._me = Math.min(c, s.length - 1);   // 舊批次「持有網址就能簽」：誰打開都算輪到的那個人
  return d;
}

/* ============================== 綠界 ECPay ============================== */
function ecpayEncode(s) {   // 綠界規定的 .NET 版 URL encode
  return encodeURIComponent(s).replace(/%20/g, '+').replace(/~/g, '%7e').replace(/'/g, '%27');
}
async function ecpayMac(params, env) {
  const keys = Object.keys(params).filter(k => k !== 'CheckMacValue').sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  const raw = `HashKey=${env.ECPAY_HASH_KEY}&` + keys.map(k => `${k}=${params[k]}`).join('&') + `&HashIV=${env.ECPAY_HASH_IV}`;
  return (await sha256hex(ecpayEncode(raw).toLowerCase())).toUpperCase();
}
function ecpayDate() { const d = twNow().toISOString(); return d.slice(0, 10).replace(/-/g, '/') + ' ' + d.slice(11, 19); }
function timingSafeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

/* ============================== 路由 ============================== */
async function route(req, env, ctx) {
  const url = new URL(req.url); const p = url.pathname.replace(/\/+$/, ''); const M = req.method;
  if (M === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
  const J = (d, s) => json(d, s, req, env);
  let m;

  if (p === '/api/health') return J({ ok: true, time: now() });
  if (p === '/api/config' && M === 'GET') return J({ plans: plans(env), free_quota: freeQuota(env), free_doc_credits: intVar(env, 'FREE_DOC_CREDITS', 30), free_retain_days: intVar(env, 'FREE_RETAIN_DAYS', 7),
    free_max_batches: intVar(env, 'FREE_MAX_BATCHES', 2), free_batch_files: freeBatchFiles(env), pro_grace_days: proGraceDays(env), owner: env.OWNER_NAME || '', owner_note: env.OWNER_NOTE || '', max_retain_days: intVar(env, 'MAX_RETAIN_DAYS', 180), max_pdf_mb: intVar(env, 'MAX_PDF_MB', 10), site_name: env.SITE_NAME || '', support_email: env.SUPPORT_EMAIL || '' });

  /* ---------- 帳號 ---------- */
  if (p === '/api/me' && M === 'GET') {
    const u = await authUser(req, env);
    await env.DB.prepare('UPDATE users SET email = ?, name = ?, last_seen = ? WHERE uid = ?').bind(u.email, u.name, now(), u.uid).run();
    return J(await account(u, env));
  }
  if (p === '/api/usage/consume' && M === 'POST') { const u = await authUser(req, env); const { feature, count } = await body(req); return J(await consume(u, env, feature, count)); }
  if (p === '/api/usage/batch' && M === 'POST') { const u = await authUser(req, env); const { count } = await body(req); return J(await batchCheck(u, env, count)); }

  /* ---------- 客服・許願池（使用者） ---------- */
  if ((m = p.match(/^\/api\/support\/(create|mine|followup|read)$/)) && M === 'POST') { const u = await authUser(req, env); return J(await support(m[1], u, await body(req), env)); }

  /* ---------- 學生簽名（公開網址＋token） ---------- */
  if ((m = p.match(/^\/api\/sign\/([^/]+)$/)) && M === 'GET') {
    const d = await signDoc(req, env, m[1]); const s = d._s, c = d._cur, me = d._me;
    return J({ filename: d.filename, status: d.status, signed_at: d.signed_at, return_reason: d.status === 'returned' ? d.return_reason : null,
      student_name: (s[me] && s[me].name) || d.student_name, mode: modeOf(d),
      batch: { name: d.batch_name, org: d.org_name, message: d.message, deadline: d.deadline }, expired: !!(d.deadline && now() > d.deadline + DAY),
      signers: s.map((x, i) => ({ name: x.name || maskEmail(x.email) || `第 ${i + 1} 位`, done: i < c, at: i < c ? x.at : null, me: i === me })),
      cur: c, me, my_turn: me === c && c < s.length, done: c >= s.length, my_signed_at: me < c ? s[me].at : null });
  }
  if ((m = p.match(/^\/api\/sign\/([^/]+)\/file$/)) && M === 'GET') {
    const d = await signDoc(req, env, m[1]);
    const key = keyBefore(d, d._s, d._cur, d.tpl_key);   // 目前最新的版本（前面的人簽好的樣子）
    const obj = key && await fileGet(env, key); if (!obj) throw new HttpError(404, '檔案不存在');
    return fileResponse(obj, d._cur >= d._s.length ? signedName(d.filename) : d.filename, req, env);
  }
  if ((m = p.match(/^\/api\/sign\/([^/]+)\/submit$/)) && M === 'POST') {
    const d = await signDoc(req, env, m[1]); const s = d._s, c = d._cur;
    if (c >= s.length) throw new HttpError(409, '這份文件已經簽好了，不能再修改');
    if (d._me < c) throw new HttpError(409, '你已經簽過了，不能再修改');
    if (d._me > c) throw new HttpError(409, `還沒輪到你，要等「${s[c].name || maskEmail(s[c].email)}」先簽`);
    if (d.deadline && now() > d.deadline + DAY) throw new HttpError(403, '已經超過簽名期限，請聯絡承辦人員');
    const buf = await readPdf(req, env);
    const key = `b/${d.batch_id}/${d.id}/s${c + 1}-${randId(6)}.pdf`;
    await filePut(env, key, buf);
    const ip = req.headers.get('CF-Connecting-IP') || '', t = now();
    s[c] = { ...s[c], at: t, ip, key, size: buf.byteLength, by: d._viewer || '' };
    const done = c + 1 >= s.length;
    const r = await env.DB.prepare("UPDATE docs SET signers = ?, cur = ?, status = ?, charged = 1, signed_key = ?, signed_size = ?, signed_at = ?, signed_ip = ?, signed_email = ?, return_reason = CASE WHEN ? THEN NULL ELSE return_reason END WHERE id = ? AND COALESCE(cur, 0) = ? AND status != 'signed'")
      .bind(JSON.stringify(s), c + 1, done ? 'signed' : 'partial', key, sizeOf(s), t, ip, d._viewer || '', done ? 1 : 0, d.id, d.signers ? c : 0).run();
    if (!r.meta.changes) { await deleteKeys(env, [key]); throw new HttpError(409, '這份文件剛剛有人簽了，請重新整理頁面再看一次'); }
    return J({ ok: true, signed_at: t, done });
  }

  /* ---------- 共用簽名網址（sign.html?b=…）：先登入，再帶到自己要簽的那份；連署直接簽 ---------- */
  if ((m = p.match(/^\/api\/join\/([^/]+)(\/file|\/submit)?$/))) {
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(m[1])) throw new HttpError(404, '簽名網址不正確');
    const b = await env.DB.prepare('SELECT * FROM batches WHERE link = ?').bind(m[1]).first();
    if (!b) throw new HttpError(404, '找不到這個簽名，可能已經結束或網址不完整');
    const u = await authUser(req, env, false);
    if (!u) throw new HttpError(401, '請先用 Google 帳號登入', { need_login: true });
    if (!u.email || !u.email_verified) throw new HttpError(403, '這個 Google 帳號的 Email 還沒驗證，請換一個帳號登入', { wrong_account: true });
    const mode = modeOf(b), expired = !!(b.deadline && now() > b.deadline + DAY), sub = m[2] || '';
    const info = { name: b.name, org: b.org_name, message: b.message, deadline: b.deadline, mode };
    if (mode !== 'open') {
      if (sub) throw new HttpError(404, '找不到這個功能');
      const like = '%' + JSON.stringify({ email: u.email }).slice(1, -1) + '%';
      const { results } = await env.DB.prepare('SELECT * FROM docs WHERE batch_id = ? AND (email = ? OR signers LIKE ?) ORDER BY filename').bind(b.id, u.email, like).all();
      const docs = [];
      for (const d of results) {
        const s = signersOf(d), c = curOf(d, s), me = s.findIndex(x => x.email === u.email); if (me < 0) continue;
        docs.push({ token: d.token, filename: d.filename, status: d.status, total: s.length, cur: c, my_turn: me === c, my_done: me < c, done: c >= s.length, waiting: me > c ? (s[c].name || maskEmail(s[c].email)) : null });
      }
      return J({ batch: info, expired, email: u.email, docs });
    }
    // ----- 連署 -----
    const mine = await env.DB.prepare('SELECT * FROM docs WHERE batch_id = ? AND email = ? ORDER BY created_at LIMIT 1').bind(b.id, u.email).first();
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE batch_id = ?").bind(b.id).first()).n;
    const full = !!(b.max_signers && count >= b.max_signers);
    if (!sub) return J({ batch: info, expired, email: u.email, name: u.name, mine: mine ? { token: mine.token, status: mine.status } : null, count, max: b.max_signers || null, full: full && !mine, has_file: !!b.tpl_key, filename: b.tpl_name });
    if (!b.tpl_key) throw new HttpError(409, '發起人還沒放上要簽的文件');
    if (sub === '/file' && M === 'GET') { const obj = await fileGet(env, b.tpl_key); if (!obj) throw new HttpError(404, '檔案不存在'); return fileResponse(obj, b.tpl_name || 'document.pdf', req, env); }
    if (sub !== '/submit' || M !== 'POST') throw new HttpError(404, '找不到這個功能');
    if (mine) throw new HttpError(409, '你已經簽過了', { token: mine.token });
    if (expired) throw new HttpError(403, '已經超過簽名期限，請聯絡發起人');
    if (full) throw new HttpError(409, `這份連署的名額（${b.max_signers} 人）已經滿了`);
    if (count >= intVar(env, 'MAX_BATCH_DOCS', 3000)) throw new HttpError(409, '這份連署的人數已經到上限了');
    const buf = await readPdf(req, env); await storageCheck(env, b, buf.byteLength);
    let credit;
    try { credit = await spendCredit(env, { uid: b.owner_uid }, b); }
    catch (e) { if (e.status === 402) throw new HttpError(403, '發起人的簽名份數已經用完，暫時不能簽，請通知發起人'); throw e; }
    const id = randId(9), token = randId(24), key = `b/${b.id}/${id}/s1-${randId(6)}.pdf`, t = now(), ip = req.headers.get('CF-Connecting-IP') || '';
    const nm = String(u.name || '').slice(0, 60);
    const s = [{ email: u.email, name: nm, at: t, ip, key, size: buf.byteLength, by: u.email }];
    const fn = `${String(b.tpl_name || '連署').replace(/\.pdf$/i, '')}-${(nm || u.email).replace(/[\\/:*?"<>|]/g, '_')}.pdf`.slice(0, 200);
    let r;
    try {
      await filePut(env, key, buf);
      r = await env.DB.prepare(`INSERT INTO docs (id, batch_id, owner_uid, filename, student_id, student_name, email, token, status, orig_key, orig_size, signed_key, signed_size, signed_at, signed_ip, signed_email, signers, cur, sent_count, created_at, credit, charged)
        SELECT ?, ?, ?, ?, '', ?, ?, ?, 'signed', NULL, 0, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM docs WHERE batch_id = ? AND email = ?)`)
        .bind(id, b.id, b.owner_uid, fn, nm, u.email, token, key, buf.byteLength, t, ip, u.email, JSON.stringify(s), t, credit, b.id, u.email).run();
    } catch (e) { await refundCredit(env, b.owner_uid, credit); try { await deleteKeys(env, [key]); } catch (e2) { } throw e; }
    if (!r.meta.changes) { await refundCredit(env, b.owner_uid, credit); await deleteKeys(env, [key]); throw new HttpError(409, '你已經簽過了'); }
    return J({ ok: true, token, signed_at: t });
  }

  /* ---------- 批次管理（需登入） ---------- */
  if (p === '/api/batches' && M === 'GET') {
    const u = await authUser(req, env);
    const { results } = await env.DB.prepare(`SELECT b.*, COUNT(d.id) AS total, SUM(CASE WHEN d.status='signed' THEN 1 ELSE 0 END) AS signed,
      SUM(CASE WHEN d.sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent FROM batches b LEFT JOIN docs d ON d.batch_id = b.id WHERE b.owner_uid = ? GROUP BY b.id ORDER BY b.created_at DESC`).bind(u.uid).all();
    return J({ batches: results });
  }
  if (p === '/api/batches' && M === 'POST') {
    const u = await authUser(req, env); const x = await body(req);
    const name = String(x.name || '').trim().slice(0, 100); if (!name) throw new HttpError(400, '請輸入批次名稱');
    const acc = await account(u, env); const paid = acc.credits.paid > 0;
    if (!paid) {
      if (acc.credits.trial <= 0) throw new HttpError(402, `免費試用的 ${acc.credits.trial_limit} 份已經用完，購買簽名份數就能建立新的批次`, { need_pay: true });
      const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM batches WHERE owner_uid = ? AND trial = 1').bind(u.uid).first();
      if (open.n >= intVar(env, 'FREE_MAX_BATCHES', 2)) throw new HttpError(402, `免費試用最多同時有 ${intVar(env, 'FREE_MAX_BATCHES', 2)} 個批次，請先刪除舊的試用批次，或購買簽名份數`, { need_pay: true });
    }
    const retain = batchKeep(env, acc, !paid, x.forever ? 'forever' : (x.retain_until || (acc.paid ? 'forever' : undefined)), now());
    const id = randId(9), link = randId(16), mode = MODES.includes(x.mode) ? x.mode : 'list';
    const maxS = mode === 'open' && +x.max_signers > 0 ? Math.min(+x.max_signers | 0, intVar(env, 'MAX_BATCH_DOCS', 3000)) : null;
    // 一律要用 Google 帳號登入才能簽（第一次登入就等於註冊），不再提供「持有網址就能簽」
    await env.DB.prepare('INSERT INTO batches (id, owner_uid, name, org_name, message, deadline, require_login, retain_until, created_at, trial, mode, link, max_signers) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?)')
      .bind(id, u.uid, name, String(x.org_name || '').slice(0, 100), String(x.message || '').slice(0, 2000), +x.deadline || null, retain, now(), paid ? 0 : 1, mode, link, maxS).run();
    return J({ id, retain_until: retain, forever: retain === null, trial: !paid, join_url: joinUrl(env, link, req) });
  }
  if ((m = p.match(/^\/api\/batches\/([^/]+)$/))) {
    const u = await authUser(req, env); const b = await ownBatch(env, u, m[1]);
    if (M === 'GET') {
      const { results } = await env.DB.prepare(`SELECT * FROM docs WHERE batch_id = ? ORDER BY ${modeOf(b) === 'open' ? 'created_at DESC' : 'filename'}`).bind(b.id).all();
      const acc = await account(u, env); const link = await ensureLink(env, b);
      const room = Math.min(intVar(env, 'MAX_BATCH_DOCS', 3000) - results.length, (b.trial ? acc.credits.trial : 0) + acc.credits.paid);
      return J({ batch: { ...b, mode: modeOf(b), join_url: joinUrl(env, link, req), max_per_doc: maxSigners(b) }, docs: results.map(d => docOut(env, d, req)), doc_limit: results.length + Math.max(0, room), credits: acc.credits });
    }
    if (M === 'PATCH') {
      const x = await body(req);
      if (x.forever || x.retain_until !== undefined) {
        const acc = await account(u, env);
        const r = batchKeep(env, acc, !!b.trial, x.forever ? 'forever' : x.retain_until, b.created_at, b.retain_until);
        await env.DB.prepare('UPDATE batches SET retain_until = ? WHERE id = ?').bind(r, b.id).run();
      }
      await env.DB.prepare('UPDATE batches SET name = COALESCE(?, name), org_name = COALESCE(?, org_name), message = COALESCE(?, message), deadline = COALESCE(?, deadline) WHERE id = ?')
        .bind(x.name ?? null, x.org_name ?? null, x.message ?? null, x.deadline ?? null, b.id).run();
      if (x.max_signers !== undefined && modeOf(b) === 'open')
        await env.DB.prepare('UPDATE batches SET max_signers = ? WHERE id = ?').bind(+x.max_signers > 0 ? Math.min(+x.max_signers | 0, intVar(env, 'MAX_BATCH_DOCS', 3000)) : null, b.id).run();
      return J({ ok: true });
    }
    if (M === 'DELETE') {
      const back = await deleteBatch(env, b); return J({ ok: true, refunded: back });
    }
  }
  if ((m = p.match(/^\/api\/batches\/([^/]+)\/docs$/)) && M === 'POST') {
    const u = await authUser(req, env); const b = await ownBatch(env, u, m[1]);
    if (modeOf(b) === 'open') throw new HttpError(400, '連署是大家簽同一份文件，請用「放上要連署的文件」上傳');
    const max = intVar(env, 'MAX_BATCH_DOCS', 3000);
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE batch_id = ?').bind(b.id).first();
    if (c.n >= max) throw new HttpError(413, `一個批次最多 ${max} 份文件，請另外建立一個批次`);
    const buf = await readPdf(req, env);
    await storageCheck(env, b, buf.byteLength);
    let meta = {}; try { meta = JSON.parse(decodeURIComponent(req.headers.get('X-Meta') || '%7B%7D')); } catch (e) { }
    const filename = String(meta.filename || 'document.pdf').slice(0, 200);
    let sg = cleanSigners(Array.isArray(meta.signers) ? meta.signers : [{ email: meta.email, name: meta.student_name }], maxSigners(b));
    if (!sg.length) sg = [{ email: '', name: String(meta.student_name || '').slice(0, 60) }];
    const credit = await spendCredit(env, u, b);
    const id = randId(9), token = randId(24), key = `b/${b.id}/${id}/orig.pdf`;
    try {
      await filePut(env, key, buf);
      await env.DB.prepare("INSERT INTO docs (id, batch_id, owner_uid, filename, student_id, student_name, email, token, status, orig_key, orig_size, sent_count, created_at, credit, charged, signers, cur) VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?, 0, ?, ?, 0, ?, 0)")
        .bind(id, b.id, u.uid, filename, String(meta.student_id || '').slice(0, 40), String(meta.student_name || sg[0].name || '').slice(0, 60), sg[0].email, token, key, buf.byteLength, now(), credit, JSON.stringify(sg)).run();
    } catch (e) { await refundCredit(env, u.uid, credit); try { await deleteKeys(env, [key]); } catch (e2) { } throw e; }
    const d = await env.DB.prepare('SELECT * FROM docs WHERE id = ?').bind(id).first();
    return J({ doc: docOut(env, d, req) });
  }
  if ((m = p.match(/^\/api\/batches\/([^/]+)\/template$/)) && M === 'POST') {   // 連署：放上大家要簽的那一份文件
    const u = await authUser(req, env); const b = await ownBatch(env, u, m[1]);
    if (modeOf(b) !== 'open') throw new HttpError(400, '只有連署需要放共用的文件');
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE batch_id = ?').bind(b.id).first()).n;
    if (n) throw new HttpError(409, `已經有 ${n} 個人簽了，不能再換文件。要換文件請另外建立一個連署`);
    const buf = await readPdf(req, env); await storageCheck(env, b, buf.byteLength);
    let meta = {}; try { meta = JSON.parse(decodeURIComponent(req.headers.get('X-Meta') || '%7B%7D')); } catch (e) { }
    const key = `b/${b.id}/tpl-${randId(6)}.pdf`;
    await filePut(env, key, buf);
    await env.DB.prepare('UPDATE batches SET tpl_key = ?, tpl_name = ?, tpl_size = ? WHERE id = ?').bind(key, String(meta.filename || 'document.pdf').slice(0, 200), buf.byteLength, b.id).run();
    if (b.tpl_key) await deleteKeys(env, [b.tpl_key]);
    return J({ ok: true });
  }
  if ((m = p.match(/^\/api\/batches\/([^/]+)\/template$/)) && M === 'GET') {
    const u = await authUser(req, env); const b = await ownBatch(env, u, m[1]);
    const obj = b.tpl_key && await fileGet(env, b.tpl_key); if (!obj) throw new HttpError(404, '還沒放上文件');
    return fileResponse(obj, b.tpl_name || 'document.pdf', req, env);
  }
  if ((m = p.match(/^\/api\/batches\/([^/]+)\/mark-sent$/)) && M === 'POST') {    // 匯出／複製名單後標記為「已發出」（只是狀態，不影響份數）
    const u = await authUser(req, env); const b = await ownBatch(env, u, m[1]); const x = await body(req);
    const ids = (Array.isArray(x.ids) ? x.ids : []).slice(0, 3000); const t = now();
    for (let i = 0; i < ids.length; i += 50) await env.DB.batch(ids.slice(i, i + 50).map(id => env.DB.prepare("UPDATE docs SET sent_at = COALESCE(sent_at, ?), sent_count = MAX(sent_count, 1), status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END WHERE id = ? AND batch_id = ?").bind(t, id, b.id)));
    return J({ ok: true, marked: ids.length });
  }
  if ((m = p.match(/^\/api\/docs\/([^/]+)$/))) {
    const u = await authUser(req, env); const d = await ownDoc(env, u, m[1]);
    if (M === 'PATCH') {
      const x = await body(req);
      if (x.signers || x.email != null) {   // 改簽名人：已經簽好的人不能改，後面還沒簽的可以改、加、減
        const b = await ownBatch(env, u, d.batch_id); const s = signersOf(d), c = curOf(d, s);
        if (modeOf(b) === 'open') throw new HttpError(400, '連署的簽名人不能修改');
        if (c >= s.length) throw new HttpError(409, '這份文件已經全部簽好了，不能再改簽名人');
        const want = Array.isArray(x.signers) ? x.signers.slice(c) : [{ email: x.email, name: s[0].name || d.student_name }];
        if (!Array.isArray(x.signers) && c > 0) throw new HttpError(409, '已經有人簽了，請改用簽名人設定');
        const rest = cleanSigners(want, maxSigners(b) - c, s.slice(0, c).map(z => z.email));
        if (!rest.length) rest.push({ email: '', name: '' });
        const ns = s.slice(0, c).concat(rest);
        await env.DB.prepare('UPDATE docs SET signers = ?, cur = ?, email = ? WHERE id = ?').bind(JSON.stringify(ns), c, ns[0].email, d.id).run();
      }
      await env.DB.prepare('UPDATE docs SET student_name = COALESCE(?, student_name), student_id = COALESCE(?, student_id) WHERE id = ?')
        .bind(x.student_name ?? null, x.student_id ?? null, d.id).run();
      return J({ doc: docOut(env, await env.DB.prepare('SELECT * FROM docs WHERE id = ?').bind(d.id).first(), req) });
    }
    if (M === 'DELETE') {
      await deleteKeys(env, [...new Set(docKeys(d))]); await env.DB.prepare('DELETE FROM docs WHERE id = ?').bind(d.id).run();
      const back = refundable(d) ? (await refundCredit(env, u.uid, d.credit), true) : false;
      return J({ ok: true, refunded: back });
    }
  }
  if ((m = p.match(/^\/api\/docs\/([^/]+)\/file$/)) && M === 'GET') {
    const u = await authUser(req, env); const d = await ownDoc(env, u, m[1]);
    const signed = url.searchParams.get('v') === 'signed';
    const key = signed ? d.signed_key : (d.orig_key || (await ownBatch(env, u, d.batch_id)).tpl_key);
    if (!key) throw new HttpError(404, '這份文件還沒有簽名檔');
    const obj = await fileGet(env, key); if (!obj) throw new HttpError(404, '檔案不存在');
    return fileResponse(obj, signed ? signedName(d.filename) : d.filename, req, env, url.searchParams.get('dl') !== '1');
  }
  if ((m = p.match(/^\/api\/docs\/([^/]+)\/return$/)) && M === 'POST') {
    const u = await authUser(req, env); const d = await ownDoc(env, u, m[1]); const x = await body(req);
    const s = signersOf(d), c = curOf(d, s);
    if (!c) throw new HttpError(409, '這份文件還沒有人簽名，不需要退回');
    const from = Math.max(0, Math.min(c - 1, parseInt(x.from, 10) || 0));   // 從第幾個人開始重簽（0 = 第 1 個人）
    const drop = s.slice(from, c).map(z => z.key).filter(Boolean);
    for (let i = from; i < s.length; i++) s[i] = { email: s[i].email, name: s[i].name };
    const reason = String(x.reason || '').slice(0, 500), prev = keyBefore({}, s, from) ;
    await env.DB.prepare("UPDATE docs SET status = 'returned', signers = ?, cur = ?, signed_key = ?, signed_size = ?, signed_at = ?, return_reason = ? WHERE id = ?")
      .bind(JSON.stringify(s), from, prev, sizeOf(s) || null, from ? s[from - 1].at : null, reason, d.id).run();
    if (drop.length) await deleteKeys(env, drop);
    const b = await ownBatch(env, u, d.batch_id);
    return J({ ok: true, sign_url: joinUrl(env, await ensureLink(env, b), req), who: s.slice(from).map(z => z.name || z.email) });
  }

  /* ---------- 付款（綠界） ---------- */
  if (p === '/api/pay/create' && M === 'POST') {
    const u = await authUser(req, env); const { plan } = await body(req); const pl = plans(env)[plan];
    if (!pl || !(pl.price > 0)) throw new HttpError(400, '沒有這個方案');
    if (!env.ECPAY_MERCHANT_ID || !env.ECPAY_HASH_KEY) throw new HttpError(503, '付款功能尚未設定');
    const tradeNo = ('P' + now().toString(36) + randId(6).replace(/[^A-Za-z0-9]/g, '')).toUpperCase().slice(0, 20);
    const api = (env.API_URL || url.origin).replace(/\/$/, ''); const site = siteBase(env, req);
    const f = {
      MerchantID: env.ECPAY_MERCHANT_ID, MerchantTradeNo: tradeNo, MerchantTradeDate: ecpayDate(), PaymentType: 'aio',
      TotalAmount: String(pl.price), TradeDesc: (env.SITE_NAME || 'PDF').slice(0, 50), ItemName: pl.name.slice(0, 200),
      ReturnURL: api + '/api/pay/notify', ChoosePayment: pl.pay || env.ECPAY_CHOOSE_PAYMENT || 'ALL', EncryptType: '1',
      ClientBackURL: site + '/account.html?order=' + tradeNo, CustomField1: plan
    };
    // 小額方案只收信用卡；其他方案排除手續費固定、對小額不划算的付款方式（例如超商代碼一筆 31 元）
    if (f.ChoosePayment === 'ALL' && env.ECPAY_IGNORE_PAYMENT) f.IgnorePayment = env.ECPAY_IGNORE_PAYMENT;
    f.CheckMacValue = await ecpayMac(f, env);
    await env.DB.prepare("INSERT INTO orders (trade_no, uid, email, plan, amount, days, credits, credit_days, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'created', ?)")
      .bind(tradeNo, u.uid, u.email, plan, pl.price, pl.pro_days || pl.days || 0, pl.credits || 0, pl.credit_days || 0, now()).run();
    const action = env.ECPAY_STAGE === 'on' ? 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5' : 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5';
    return J({ action, fields: f, trade_no: tradeNo });
  }
  if (p === '/api/pay/notify' && M === 'POST') {
    const text = (s, st = 200) => new Response(s, { status: st, headers: { 'Content-Type': 'text/plain' } });
    const form = await req.formData(); const x = {}; for (const [k, v] of form.entries()) x[k] = String(v);
    const mac = await ecpayMac(x, env);
    if (!x.CheckMacValue || !timingSafeEq(mac, String(x.CheckMacValue).toUpperCase())) return text('0|CheckMacValue Error');
    if (x.MerchantID !== env.ECPAY_MERCHANT_ID) return text('0|MerchantID Error');
    const o = await env.DB.prepare('SELECT * FROM orders WHERE trade_no = ?').bind(x.MerchantTradeNo).first();
    if (!o) return text('0|Order Not Found');
    if (o.status === 'paid') return text('1|OK');                                     // 綠界可能重送，已處理過就直接回 OK
    const simulated = x.SimulatePaid === '1' && env.ECPAY_STAGE !== 'on';               // 正式環境不接受「模擬付款」
    if (x.RtnCode === '1' && +x.TradeAmt === +o.amount && !simulated) {
      // 先把訂單改成已付款；只有真的改到（第一次收到通知）才加天數和份數，重送的通知不會重複加
      const r = await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ?, ecpay_trade_no = ?, payment_type = ? WHERE trade_no = ? AND status != 'paid'").bind(now(), x.TradeNo || '', x.PaymentType || '', o.trade_no).run();
      if (r.meta.changes) await env.DB.batch(grantStmts(env, o.uid, { pro_days: o.days, credits: o.credits, credit_days: o.credit_days }, 'order', o.trade_no));
    } else if (['2', '800', '10100073'].includes(String(x.RtnCode))) {
      await env.DB.prepare('UPDATE orders SET note = ? WHERE trade_no = ?').bind(`等待付款（${x.PaymentType || ''} ${x.RtnMsg || ''}）`.slice(0, 300), o.trade_no).run();   // ATM 取號成功等，還沒付款
    } else {
      await env.DB.prepare("UPDATE orders SET status = 'failed', ecpay_trade_no = ?, note = ? WHERE trade_no = ? AND status != 'paid'").bind(x.TradeNo || '', `RtnCode=${x.RtnCode} ${x.RtnMsg || ''} ${simulated ? '(simulated)' : ''}`.slice(0, 300), o.trade_no).run();
    }
    return text('1|OK');
  }
  if (p === '/api/pay/orders' && M === 'GET') {
    const u = await authUser(req, env);
    const { results } = await env.DB.prepare('SELECT trade_no, plan, amount, days, credits, status, created_at, paid_at, payment_type FROM orders WHERE uid = ? ORDER BY created_at DESC LIMIT 50').bind(u.uid).all();
    const pl = plans(env);
    return J({ orders: results.map(o => ({ ...o, plan_name: (pl[o.plan] && pl[o.plan].name) || o.plan })) });
  }
  /* ---------- 管理後台（只有網站管理者） ---------- */
  if ((m = p.match(/^\/api\/admin\/([a-z-]+)$/))) {
    const u = await authUser(req, env); if (!isSiteAdmin(u, env)) throw new HttpError(403, '只有網站管理者可以使用管理後台');
    return J(await admin(m[1], M, u, M === 'GET' ? Object.fromEntries(url.searchParams) : await body(req), env));
  }
  throw new HttpError(404, '找不到這個功能');
}
function signedName(fn) { return fn.replace(/(\.pdf)?$/i, '(已簽).pdf'); }

/* ============================== 客服・許願池 ==============================
 * 參考 ar-pet：每一則訊息一筆 tickets；type 'bug' 客服・'wish' 許願池；thread 是之後的來回對話（JSON）。
 * 使用者只看得到自己的；管理後台（ops.html）看全部、回覆、結案。 */
const SUPPORT = { maxText: 2000, maxReply: 1000, perDay: 10, maxThread: 40 };
const cleanText = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const ticketOut = t => ({ id: t.id, type: t.type, text: t.text, price: t.price ?? null, status: t.status, thread: JSON.parse(t.thread || '[]'),
  user_unread: !!t.user_unread, created_at: t.created_at, updated_at: t.updated_at });
async function support(action, u, x, env) {
  if (action === 'create') {
    const type = String(x.type || ''); if (!['bug', 'wish'].includes(type)) throw new HttpError(400, '訊息種類不對');
    const text = cleanText(x.text, SUPPORT.maxText);
    if (text.length < 2) throw new HttpError(400, type === 'wish' ? '請寫下你的願望' : '請描述遇到的問題');
    let price = null;
    if (type === 'wish' && x.price !== null && x.price !== undefined && x.price !== '') {
      price = Math.round(Number(x.price)); if (!(price >= 0 && price <= 100000)) throw new HttpError(400, '金額請填 0～100000 之間的數字');
    }
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE uid = ? AND created_at > ?').bind(u.uid, now() - DAY).first();
    if (c.n >= SUPPORT.perDay) throw new HttpError(429, `24 小時內最多送出 ${SUPPORT.perDay} 則訊息，請明天再試，或在之前的訊息裡補充`);
    const id = 'T' + randId(9);
    await env.DB.prepare("INSERT INTO tickets (id, uid, email, name, type, text, price, device, status, thread, user_unread, admin_unread, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'open', '[]', 0, 1, ?, ?)")
      .bind(id, u.uid, u.email, cleanText(u.name, 60), type, text, price, cleanText(x.device, 300), now(), now()).run();
    return { ok: true, id };
  }
  if (action === 'mine') {
    const { results } = await env.DB.prepare('SELECT * FROM tickets WHERE uid = ? ORDER BY created_at DESC LIMIT 200').bind(u.uid).all();
    return { tickets: results.map(ticketOut) };
  }
  if (action === 'followup') {
    const text = cleanText(x.text, SUPPORT.maxReply); if (!text) throw new HttpError(400, '請輸入內容');
    const t = await env.DB.prepare('SELECT * FROM tickets WHERE id = ? AND uid = ?').bind(String(x.id || ''), u.uid).first();
    if (!t) throw new HttpError(404, '找不到這則訊息');
    if (t.status === 'closed') throw new HttpError(400, '這則訊息已經結案了，有新的問題請重新送出一則');
    const th = JSON.parse(t.thread || '[]'); if (th.length >= SUPPORT.maxThread) throw new HttpError(400, '這則訊息的對話太長了，請重新送出一則');
    th.push({ by: 'user', text, at: now() });
    await env.DB.prepare("UPDATE tickets SET thread = ?, status = 'open', admin_unread = 1, updated_at = ? WHERE id = ?").bind(JSON.stringify(th), now(), t.id).run();
    return { ok: true };
  }
  if (action === 'read') {
    const ids = (Array.isArray(x.ids) ? x.ids : []).slice(0, 50).map(String);
    for (const id of ids) await env.DB.prepare('UPDATE tickets SET user_unread = 0 WHERE id = ? AND uid = ?').bind(id, u.uid).run();
    return { ok: true };
  }
  throw new HttpError(404, '沒有這個功能');
}

/* ============================== 管理後台 ============================== */
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
async function userRow(env, email) { return env.DB.prepare('SELECT * FROM users WHERE email = ? ORDER BY last_seen DESC LIMIT 1').bind(normEmail(email)).first(); }
async function admin(action, M, me, x, env) {
  const DB = env.DB;
  if (action === 'stats' && M === 'GET') {
    const s = await siteStats(env);
    s.tickets_unread = ((await DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE admin_unread = 1').first()) || {}).n || 0;
    return s;
  }
  /* 帳號列表／搜尋 */
  if (action === 'users' && M === 'GET') {
    const q = String(x.q || '').trim().toLowerCase(); const t = now();
    const where = q ? 'WHERE email LIKE ?1 OR name LIKE ?1' : '';
    const { results } = await DB.prepare(`SELECT uid, email, name, paid_until, doc_credits, credits_until, trial_docs, created_at, last_seen FROM users ${where} ORDER BY last_seen DESC LIMIT 200`).bind(...(q ? ['%' + q + '%'] : [])).all();
    const pend = (await DB.prepare('SELECT * FROM pending_grants WHERE applied_at IS NULL ORDER BY created_at DESC LIMIT 100').all()).results;
    return { users: results.map(r => ({ ...r, pro: (r.paid_until || 0) > t, credits_live: (r.credits_until || 0) > t ? (r.doc_credits || 0) : 0 })), pending: pend };
  }
  /* 手動開通：加進階版天數／簽名份數。對方還沒登入過也可以，先存起來，第一次登入時自動加上 */
  if (action === 'grant' && M === 'POST') {
    const email = normEmail(x.email); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, '請輸入正確的 Email');
    const credits = clampInt(x.credits, 0, 100000, 0), pro_days = clampInt(x.pro_days, 0, 36600, 0), credit_days = clampInt(x.credit_days, 1, 3660, 365);
    if (!credits && !pro_days) throw new HttpError(400, '請填進階版天數或簽名份數');
    const note = String(x.note || '').slice(0, 200), reason = 'admin:' + me.email;
    const t = await userRow(env, email);
    if (!t) {
      await DB.prepare('INSERT INTO pending_grants (email, pro_days, credits, credit_days, reason, note, created_at) VALUES (?,?,?,?,?,?,?)').bind(email, pro_days, credits, credit_days, reason, note, now()).run();
      return { ok: true, pending: true, email };
    }
    await DB.batch(grantStmts(env, t.uid, { credits, pro_days, credit_days }, reason, note));
    return { ok: true, account: await account({ uid: t.uid, email, name: '' }, env) };
  }
  /* 直接設定：進階版到期日、剩餘份數（用來收回權限、修正錯誤） */
  if (action === 'set' && M === 'POST') {
    const t = await DB.prepare('SELECT * FROM users WHERE uid = ?').bind(String(x.uid || '')).first(); if (!t) throw new HttpError(404, '找不到這個帳號');
    const paid_until = x.paid_until === null || x.paid_until === '' ? null : clampInt(x.paid_until, 0, 9e15, t.paid_until);
    const doc_credits = x.doc_credits == null ? t.doc_credits : clampInt(x.doc_credits, 0, 1000000, t.doc_credits);
    await DB.batch([DB.prepare('UPDATE users SET paid_until = ?, doc_credits = ? WHERE uid = ?').bind(paid_until, doc_credits, t.uid),
      DB.prepare('INSERT INTO credit_log (uid, credits, pro_days, reason, ref, created_at) VALUES (?,?,?,?,?,?)').bind(t.uid, (doc_credits || 0) - (t.doc_credits || 0), 0, 'admin-set:' + me.email, String(x.note || `paid_until=${paid_until}`).slice(0, 200), now())]);
    return { ok: true, account: await account({ uid: t.uid, email: t.email, name: t.name }, env) };
  }
  if (action === 'pending-delete' && M === 'POST') { await DB.prepare('DELETE FROM pending_grants WHERE id = ? AND applied_at IS NULL').bind(+x.id || 0).run(); return { ok: true }; }
  /* 訂單：列表、標記已退款（同時收回這筆訂單給的天數和份數） */
  if (action === 'orders' && M === 'GET') {
    const { results } = await DB.prepare("SELECT * FROM orders WHERE status != 'created' OR created_at > ? ORDER BY created_at DESC LIMIT 200").bind(now() - 3 * DAY).all();
    const pl = plans(env); return { orders: results.map(o => ({ ...o, plan_name: (pl[o.plan] && pl[o.plan].name) || o.plan })) };
  }
  if (action === 'refund' && M === 'POST') {
    const o = await DB.prepare("SELECT * FROM orders WHERE trade_no = ? AND status = 'paid'").bind(String(x.trade_no || '')).first();
    if (!o) throw new HttpError(404, '找不到這筆已付款的訂單');
    const st = [DB.prepare("UPDATE orders SET status = 'refunded', note = ? WHERE trade_no = ?").bind(`退款 by ${me.email}：${String(x.note || '').slice(0, 150)}`, o.trade_no)];
    if (x.revoke !== false) {
      if (o.days) st.push(DB.prepare('UPDATE users SET paid_until = MAX(0, COALESCE(paid_until, 0) - ?) WHERE uid = ?').bind(o.days * DAY, o.uid));
      if (o.credits) st.push(DB.prepare('UPDATE users SET doc_credits = MAX(0, COALESCE(doc_credits, 0) - ?) WHERE uid = ?').bind(o.credits, o.uid));
      st.push(DB.prepare('INSERT INTO credit_log (uid, credits, pro_days, reason, ref, created_at) VALUES (?,?,?,?,?,?)').bind(o.uid, -(o.credits || 0), -(o.days || 0), 'refund:' + me.email, o.trade_no, now()));
    }
    await DB.batch(st); return { ok: true };
  }
  /* 客服・許願池 */
  if (action === 'tickets' && M === 'GET') {
    const type = ['bug', 'wish'].includes(x.type) ? x.type : null;
    const { results } = await DB.prepare(`SELECT * FROM tickets ${type ? 'WHERE type = ?' : ''} ORDER BY updated_at DESC LIMIT 500`).bind(...(type ? [type] : [])).all();
    return { tickets: results.map(t => ({ ...ticketOut(t), uid: t.uid, email: t.email, name: t.name, device: t.device, admin_unread: !!t.admin_unread })) };
  }
  if (action === 'ticket' && M === 'POST') {   // 回覆／改狀態／標記已讀
    const t = await DB.prepare('SELECT * FROM tickets WHERE id = ?').bind(String(x.id || '')).first(); if (!t) throw new HttpError(404, '找不到這則訊息');
    const text = cleanText(x.text, SUPPORT.maxReply); const th = JSON.parse(t.thread || '[]');
    let status = x.status || t.status; if (text && !x.status) status = 'replied';
    if (!['open', 'replied', 'closed'].includes(status)) throw new HttpError(400, '狀態不對');
    if (text) th.push({ by: 'admin', text, at: now() });
    await DB.prepare('UPDATE tickets SET thread = ?, status = ?, admin_unread = 0, user_unread = CASE WHEN ? THEN 1 ELSE user_unread END, updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?')
      .bind(JSON.stringify(th), status, text ? 1 : 0, text || x.status ? 1 : 0, now(), t.id).run();
    return { ok: true };
  }
  if (action === 'ticket-delete' && M === 'POST') { await DB.prepare('DELETE FROM tickets WHERE id = ?').bind(String(x.id || '')).run(); return { ok: true }; }
  throw new HttpError(404, '找不到這個功能');
}

/* ============================== 用量統計與排程 ============================== */
async function siteStats(env) {
  const warn0 = [];
  const one = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()) || {};
  const users = await one('SELECT COUNT(*) AS n, SUM(CASE WHEN paid_until > ? THEN 1 ELSE 0 END) AS paid, SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END) AS active30 FROM users', now(), now() - 30 * DAY);
  const files = await one('SELECT COUNT(*) AS docs, COALESCE(SUM(orig_size),0) + COALESCE(SUM(signed_size),0) AS bytes, SUM(CASE WHEN status = \'signed\' THEN 1 ELSE 0 END) AS signed FROM docs');
  const batches = await one('SELECT COUNT(*) AS n FROM batches');
  const sales = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM orders WHERE status = 'paid' AND paid_at >= ?", twMonthStart());
  const usage = (await env.DB.prepare('SELECT feature, COUNT(*) AS n FROM usage WHERE created_at >= ? GROUP BY feature').bind(now() - 30 * DAY).all()).results;
  const split = await one("SELECT COALESCE(SUM(CASE WHEN b.trial = 1 THEN COALESCE(d.orig_size,0) + COALESCE(d.signed_size,0) END),0) AS trial_bytes FROM docs d JOIN batches b ON b.id = d.batch_id");
  const credits = await one('SELECT COALESCE(SUM(doc_credits),0) AS open_credits, SUM(CASE WHEN credits_until > ? AND doc_credits > 0 THEN 1 ELSE 0 END) AS buyers FROM users WHERE credits_until > ?', now(), now());
  const lim = storageLimits(env), storageLimit = lim.limit, guard = lim.guard;
  const d1left = env.FILES ? await (async () => (await fileDb(env).prepare('SELECT COUNT(DISTINCT key) AS n FROM files').first()) || {})() : {};
  if (d1left.n) warn0.push(`還有 ${d1left.n} 個舊檔案在 D1，系統每小時會自動搬一批到 R2，不用處理`);
  const overGB = lim.mode === 'r2' ? Math.max(0, files.bytes - storageLimit) / 1073741824 : 0;
  const size = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(0) + ' MB';
  const warn = warn0;
  if (lim.hard > storageLimit && files.bytes > lim.hard * 0.9) warn.push(`檔案空間快到你設定的上限 R2_MAX_GB（${size(lim.hard)}），滿了就不能再上傳`);
  if (files.bytes > storageLimit * 0.8) warn.push(lim.mode === 'r2'
    ? `檔案空間已用 ${size(files.bytes)}，超過 R2 免費額度（${size(storageLimit)}）的 80%${overGB > 0 ? `；超出 ${overGB.toFixed(1)} GB，Cloudflare 約每月收 US$ ${(Math.ceil(overGB) * 0.015).toFixed(2)}` : ''}`
    : `檔案空間已用 ${size(files.bytes)}，快到上限（${size(storageLimit)}）。滿了以後就不能再上傳新文件，請刪除不用的批次，或把保存天數調短`);
  if (guard > 0 && files.bytes > guard) warn.push(`總空間超過試用警戒線（${size(guard)}），免費試用的新上傳已暫停，付費客戶不受影響`);
  return { users, files: { ...files, ...split, storage: lim.mode, limit_bytes: storageLimit, trial_guard_bytes: guard, over_gb: overGB }, credits, batches, sales_this_month: sales, usage_30d: usage, warnings: warn, time: now() };
}
async function cron(env) {
  await ensureSchema(env);
  // 1) 刪除超過保存期限的批次（個資最小化）。快到期的批次會在管理頁上顯示提醒，不寄信
  const { results } = await env.DB.prepare('SELECT * FROM batches WHERE retain_until < ? LIMIT 50').bind(now()).all();
  // 2) 「不限保存天數」的批次：進階版到期超過 PRO_GRACE_DAYS 天還沒續約，就刪除
  const lapsed = (await env.DB.prepare('SELECT b.* FROM batches b LEFT JOIN users u ON u.uid = b.owner_uid WHERE b.retain_until IS NULL AND COALESCE(u.paid_until, 0) < ? LIMIT 50').bind(now() - proGraceDays(env) * DAY).all()).results;
  for (const b of [...results, ...lapsed]) { try { await deleteBatch(env, b); } catch (e) { console.error('purge', b.id, e); } }
  // 3) 改用 R2 以後，把 D1 裡的舊檔案慢慢搬過去
  try { await migrateToR2(env); } catch (e) { console.error('migrate', e); }
}

/* ============================== 自動建立資料表 ============================== */
// 跟 schema.sql 一樣；第一次連線時自動執行（都是 IF NOT EXISTS，重複執行沒關係）
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, email TEXT, name TEXT, paid_until INTEGER, doc_credits INTEGER DEFAULT 0, credits_until INTEGER, trial_docs INTEGER DEFAULT 0, created_at INTEGER, last_seen INTEGER)`,
  `CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, feature TEXT NOT NULL, trial INTEGER NOT NULL, created_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_uid ON usage(uid, feature, trial)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at)`,
  `CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, name TEXT, org_name TEXT, message TEXT, deadline INTEGER, require_login INTEGER DEFAULT 1, retain_until INTEGER, created_at INTEGER, trial INTEGER DEFAULT 0, warned INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_batches_owner ON batches(owner_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_batches_retain ON batches(retain_until)`,
  `CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, owner_uid TEXT NOT NULL, filename TEXT, student_id TEXT, student_name TEXT, email TEXT, token TEXT UNIQUE NOT NULL, status TEXT NOT NULL, orig_key TEXT, orig_size INTEGER, signed_key TEXT, signed_size INTEGER, sent_at INTEGER, sent_count INTEGER DEFAULT 0, signed_at INTEGER, signed_ip TEXT, signed_email TEXT, return_reason TEXT, created_at INTEGER, credit TEXT, charged INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_docs_batch ON docs(batch_id)`,
  `CREATE TABLE IF NOT EXISTS orders (trade_no TEXT PRIMARY KEY, uid TEXT NOT NULL, email TEXT, plan TEXT, amount INTEGER, days INTEGER, credits INTEGER DEFAULT 0, credit_days INTEGER DEFAULT 0, status TEXT, created_at INTEGER, paid_at INTEGER, ecpay_trade_no TEXT, payment_type TEXT, note TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_uid ON orders(uid)`,
  `CREATE TABLE IF NOT EXISTS credit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, credits INTEGER, pro_days INTEGER, reason TEXT, ref TEXT, created_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_credit_uid ON credit_log(uid)`,
  `CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, uid TEXT NOT NULL, email TEXT, name TEXT, type TEXT NOT NULL, text TEXT, price INTEGER, device TEXT, status TEXT, thread TEXT, user_unread INTEGER DEFAULT 0, admin_unread INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_uid ON tickets(uid)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_upd ON tickets(updated_at)`,
  `CREATE TABLE IF NOT EXISTS pending_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, pro_days INTEGER, credits INTEGER, credit_days INTEGER, reason TEXT, note TEXT, created_at INTEGER, applied_at INTEGER, uid TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_grants(email)`
];
let schemaReady = null;
/* 舊資料庫升級：docs 加 charged 欄位（有簽名才算份數）。已經簽過（含退回重簽）的算已扣，其他的之後刪除會退回 */
const colCache = {};
async function addColumn(env, table, col) {
  if (!colCache[table]) { try { colCache[table] = new Set((await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map(r => r.name)); } catch (e) { colCache[table] = new Set(); } }
  if (colCache[table].has(col.split(' ')[0])) return false;   // 已經有這個欄位，不用再改
  try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run(); return true; }
  catch (e) { if (/duplicate column/i.test(String(e && e.message))) return false; throw e; }
}
async function upgradeSchema(env) {
  if (await addColumn(env, 'docs', 'charged INTEGER DEFAULT 0'))
    await env.DB.prepare("UPDATE docs SET charged = CASE WHEN status IN ('signed', 'returned') OR signed_at IS NOT NULL THEN 1 ELSE 0 END").run();
  /* 2026/11：三種簽名方式（指定人員／多人簽同一份／連署）＋共用簽名網址 */
  for (const c of ["mode TEXT DEFAULT 'list'", 'link TEXT', 'tpl_key TEXT', 'tpl_name TEXT', 'tpl_size INTEGER', 'max_signers INTEGER']) await addColumn(env, 'batches', c);
  for (const c of ['signers TEXT', 'cur INTEGER DEFAULT 0']) await addColumn(env, 'docs', c);
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_link ON batches(link)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_docs_batch_email ON docs(batch_id, email)').run();
}
const FILE_SCHEMA = [`CREATE TABLE IF NOT EXISTS files (key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB, created_at INTEGER, PRIMARY KEY (key, part))`];
function ensureSchema(env) {
  if (!schemaReady) {
    const jobs = [env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).then(() => upgradeSchema(env))];
    jobs.push(fileDb(env).batch(FILE_SCHEMA.map(q => fileDb(env).prepare(q))));   // PDF 存在 D1 的 files 資料表（改用 R2 後，舊檔案搬完前也要讀得到）
    schemaReady = Promise.all(jobs).catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    // 不是 /api/ 開頭的，就是網頁（web 資料夾裡的檔案）
    if (!path.startsWith('/api/') && path !== '/api' && env.ASSETS) return env.ASSETS.fetch(req);
    try { await ensureSchema(env); return await route(req, env, ctx); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status, req, env);
      console.error(e); return json({ error: '伺服器發生錯誤，請稍後再試' }, 500, req, env);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(cron(env)); }
};
export { ecpayMac, ecpayEncode };
