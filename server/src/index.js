/* ================================================================
   AR 寵物・付款伺服器（Cloudflare Workers 免費方案，不用綁卡）
   Firebase 維持免費的 Spark 方案：這裡用「服務帳戶金鑰」直接讀寫 Firestore。

   部署：GitHub repo 連結 Cloudflare Workers Builds（根目錄 server），每次推上 GitHub 就自動更新。
   網址（部署後是 https://ar-pet-pay.<你的帳號>.workers.dev）：
     POST /ecpay/create   App 叫它建立訂單，拿到要送去綠界的表單（要帶 Firebase 登入憑證）
     POST /ecpay/notify   綠界付款成功後「伺服器對伺服器」通知這裡 → 驗證 → 把東西加進帳號
     POST /ecpay/result   付款完，使用者的瀏覽器被綠界送回這裡 → 轉回 App
     POST /play/verify    Google Play App：向 Google 確認購買 → 把東西加進帳號
     GET  /               健康檢查，打開看到 ok 就代表部署成功

   ★ 價格一律以 js/catalog.js 為準（部署時直接打包進來），不相信手機傳來的金額。
   ★ 只有這裡可以加飼料、空位、寵物；firestore.rules 已經禁止手機自己改這些欄位。

   設定（wrangler.toml 的 [vars]）：FIREBASE_PROJECT_ID、SITE_URL、ALLOWED_ORIGINS、ECPAY_MODE、PLAY_PACKAGE
   祕密（Cloudflare 主控台 → ar-pet-pay → 設定 → 變數和祕密，類型選「祕密」）：ECPAY_MERCHANT_ID、ECPAY_HASH_KEY、ECPAY_HASH_IV、GOOGLE_SERVICE_ACCOUNT
   ================================================================ */
import { PRODUCTS } from '../../js/catalog.js';

const productOf = id => PRODUCTS.find(p => p.id === id);
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (path === '/' && request.method === 'GET') return text('ok　AR 寵物付款伺服器（' + (isProd(env) ? '正式收款' : '綠界測試環境') + '）');
      if (path === '/ecpay/create' && request.method === 'POST') return json(await ecpayCreate(request, env, url), 200, cors);
      if (path === '/play/verify' && request.method === 'POST') return json(await playVerify(request, env), 200, cors);
      if (path === '/ecpay/notify' && request.method === 'POST') return await ecpayNotify(request, env);
      if (path === '/ecpay/result') return await ecpayResult(request, env, url);
      return text('not found', 404);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status, cors);
      console.error(path, e && e.stack || e);
      return json({ error: 'internal', message: '伺服器發生錯誤，請稍後再試' }, 500, cors);
    }
  },
};

/* ---------------- 小工具 ---------------- */
class ApiError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { ...h, 'content-type': 'application/json; charset=utf-8' } });
const text = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const isProd = env => env.ECPAY_MODE === 'production';
const ecpayHost = env => isProd(env) ? 'https://payment.ecpay.com.tw' : 'https://payment-stage.ecpay.com.tw';
const siteUrl = env => env.SITE_URL || 'https://wingfeeling.github.io/ar-pet/';

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allow = (env.ALLOWED_ORIGINS || 'https://wingfeeling.github.io').split(',').map(s => s.trim()).filter(Boolean);
  if (!allow.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
           'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400', vary: 'origin' };
}
async function readJson(request) {
  try { return await request.json(); } catch { throw new ApiError(400, 'invalid-argument', '資料格式不正確'); }
}
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = o => b64url(enc.encode(JSON.stringify(o)));
function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------------- Firebase 登入憑證（ID token）驗證 ----------------
   App 送來 Authorization: Bearer <ID token>，這裡用 Google 公開的金鑰驗簽章，確認是誰在買。 */
let jwks = null, jwksExp = 0;
async function googleKeys() {
  if (jwks && Date.now() < jwksExp) return jwks;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new Error('jwks ' + r.status);
  const age = +((r.headers.get('cache-control') || '').match(/max-age=(\d+)/) || [])[1] || 3600;
  jwks = (await r.json()).keys; jwksExp = Date.now() + age * 1000;
  return jwks;
}
async function requireUser(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw new ApiError(401, 'unauthenticated', '請先登入');
  const parts = m[1].split('.');
  if (parts.length !== 3) throw new ApiError(401, 'unauthenticated', '請重新登入');
  let head, claims;
  try { head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))); claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))); }
  catch { throw new ApiError(401, 'unauthenticated', '請重新登入'); }
  const jwk = head.alg === 'RS256' && (await googleKeys()).find(k => k.kid === head.kid);
  if (!jwk) throw new ApiError(401, 'unauthenticated', '請重新登入');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  const now = Date.now() / 1000, pid = env.FIREBASE_PROJECT_ID;
  if (!good || claims.aud !== pid || claims.iss !== 'https://securetoken.google.com/' + pid
      || !(claims.exp > now) || !(claims.iat < now + 300) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128)
    throw new ApiError(401, 'unauthenticated', '登入已過期，請重新登入');
  return claims.sub;
}

/* ---------------- 服務帳戶 → Google 存取權杖（Firestore、Google Play 共用） ---------------- */
let gTok = null, gTokExp = 0;
async function googleToken(env) {
  if (gTok && Date.now() < gTokExp) return gTok;
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT 沒有設定，或不是完整的金鑰 JSON'); }
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = b64urlJson({ alg: 'RS256', typ: 'JWT' }) + '.' + b64urlJson({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/androidpublisher',
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('google token ' + r.status + ' ' + (d.error_description || d.error));
  gTok = d.access_token; gTokExp = Date.now() + (d.expires_in - 300) * 1000;
  return gTok;
}

/* ---------------- Firestore（REST API） ---------------- */
const docBase = env => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const docName = (env, path) => `${docBase(env)}/${path}`;
async function fs(env, method, suffix, body) {
  const r = await fetch(`https://firestore.googleapis.com/v1/${suffix}`, {
    method, headers: { authorization: 'Bearer ' + await googleToken(env), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404 && method === 'GET') return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('firestore ' + r.status + ' ' + (d.error?.message || '')); e.status = r.status; throw e; }
  return d;
}
// JS 值 ⇄ Firestore 格式
function toVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
  return { stringValue: String(v) };
}
function fromVal(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromVal);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  return null;
}
const fromFields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromVal(v)]));
const toFields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toVal(v)]));
const now = path => ({ fieldPath: path, setToServerValue: 'REQUEST_TIME' });

async function getDoc(env, path, tx) {
  const d = await fs(env, 'GET', docName(env, path) + (tx ? '?transaction=' + encodeURIComponent(tx) : ''));
  return d ? fromFields(d.fields) : null;
}
// 改部分欄位（不存在就建立），times＝要寫入伺服器時間的欄位
function patchWrite(env, path, fields, { times = [], transforms = [], precondition } = {}) {
  const w = { update: { name: docName(env, path), fields: toFields(fields) },
              updateMask: { fieldPaths: Object.keys(fields) },
              updateTransforms: [...times.map(now), ...transforms] };
  if (precondition) w.currentDocument = precondition;
  return w;
}
// 交易：fn(tx) 讀資料、回傳要寫的內容；別人同時在改就重試
async function runTx(env, fn) {
  for (let i = 0; ; i++) {
    const { transaction } = await fs(env, 'POST', docBase(env) + ':beginTransaction', {});
    const { writes = [], result } = await fn(transaction);
    try {
      await fs(env, 'POST', docBase(env) + ':commit', { transaction, writes });
      return result;
    } catch (e) {
      if (i < 3 && (e.status === 409 || e.status === 503)) { await new Promise(r => setTimeout(r, 100 * 2 ** i)); continue; }
      throw e;
    }
  }
}

/* ---------- 把買到的東西加進帳號（綠界、Google Play 共用） ---------- */
function grantWrite(env, uid, p) {
  const inc = (f, n) => ({ fieldPath: f, increment: { integerValue: String(n) } });
  const add = (f, x) => ({ fieldPath: f, appendMissingElements: { values: [toVal(x)] } });
  const t = [];
  if (p.kind === 'food') t.push(inc('food', p.amount));
  if (p.kind === 'slot') t.push(inc('slots', p.amount));
  if (p.kind === 'pet') t.push(add('owned', p.species));
  if (p.kind === 'set') t.push(add('owned', p.species), inc('slots', p.slots), inc('food', p.food));
  return patchWrite(env, `users/${uid}`, {}, { times: ['lastPurchaseAt'], transforms: t });
}
async function alreadyOwns(env, uid, p) {
  if (p.kind !== 'pet' && p.kind !== 'set') return false;
  const d = await getDoc(env, `users/${uid}`) || {};
  return Array.isArray(d.owned) && d.owned.includes(p.species);
}

/* ---------- 綠界的檢查碼 CheckMacValue（SHA256） ----------
   1. 參數依名稱 A→Z 排序（不分大小寫）  2. 前面加 HashKey、後面加 HashIV
   3. 照 .NET 的 URL 編碼規則編碼，全部轉小寫  4. SHA256，轉大寫 */
export async function checkMac(params, key, iv) {
  const body = Object.keys(params).filter(k => k !== 'CheckMacValue')
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)
    .map(k => `${k}=${params[k]}`).join('&');
  const s = encodeURIComponent(`HashKey=${key}&${body}&HashIV=${iv}`)
    .replace(/%20/g, '+').replace(/'/g, '%27').replace(/~/g, '%7e').toLowerCase();
  return (await sha256Hex(s)).toUpperCase();
}
// 綠界要的時間格式：台灣時間 yyyy/MM/dd HH:mm:ss
function twNow() {
  const t = new Date(Date.now() + 8 * 3600e3), z = n => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${z(t.getUTCMonth() + 1)}/${z(t.getUTCDate())} ${z(t.getUTCHours())}:${z(t.getUTCMinutes())}:${z(t.getUTCSeconds())}`;
}
// 訂單編號：最多 20 個英數字，不能重複
function newTradeNo() {
  const r = hex(crypto.getRandomValues(new Uint8Array(3))).toUpperCase();
  return 'AP' + twNow().replace(/\D/g, '').slice(2) + r;          // AP + yyMMddHHmmss + 6 碼亂數 = 20 碼
}
function ecpayKeys(env) {
  const id = env.ECPAY_MERCHANT_ID, key = env.ECPAY_HASH_KEY, iv = env.ECPAY_HASH_IV;
  if (!id || !key || !iv) throw new Error('綠界金鑰（ECPAY_MERCHANT_ID／ECPAY_HASH_KEY／ECPAY_HASH_IV）沒有設定');
  return { id, key, iv };
}

/* ---------- 1. 建立訂單（App 呼叫） ---------- */
async function ecpayCreate(request, env, url) {
  const uid = await requireUser(request, env);
  const data = await readJson(request);
  const p = productOf(data?.productId);
  if (!p) throw new ApiError(404, 'not-found', '沒有這個商品');
  if (data?.agree !== true) throw new ApiError(400, 'failed-precondition', '請先同意購買須知');
  if (await alreadyOwns(env, uid, p)) throw new ApiError(409, 'already-exists', '你已經擁有這隻寵物了');
  const { id, key, iv } = ecpayKeys(env);

  const tradeNo = newTradeNo();
  const amount = Math.round(p.price);
  await fs(env, 'POST', docBase(env) + ':commit', { writes: [patchWrite(env, `orders/${tradeNo}`, {
    uid, productId: p.id, kind: p.kind, amount, label: p.label, status: 'pending', provider: 'ecpay', mode: isProd(env) ? 'production' : 'stage',
  }, { times: ['createdAt'], precondition: { exists: false } })] });

  const origin = url.origin;
  const params = {
    MerchantID: id,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: twNow(),
    PaymentType: 'aio',
    TotalAmount: String(amount),
    TradeDesc: 'AR寵物商店',
    ItemName: `AR寵物 ${p.label}`.replace(/[#&]/g, ' '),
    ReturnURL: origin + '/ecpay/notify',                        // 綠界通知付款結果（伺服器對伺服器）
    OrderResultURL: origin + '/ecpay/result',                   // 付款完把使用者送回來
    ClientBackURL: siteUrl(env) + '?order=' + tradeNo,          // 付款頁上的「返回商店」
    ChoosePayment: 'ALL',
    // 小額商品不開 ATM／超商（那些方式有固定手續費，而且要等使用者去繳費）；依你綠界後台實際開通的方式調整
    IgnorePayment: amount < 100 ? 'ATM#CVS#BARCODE#WebATM' : 'BARCODE#WebATM',
    EncryptType: '1',
    CustomField1: uid.slice(0, 50),
    NeedExtraPaidInfo: 'N',
  };
  params.CheckMacValue = await checkMac(params, key, iv);
  return { orderId: tradeNo, action: ecpayHost(env) + '/Cashier/AioCheckOut/V5', params };
}

/* ---------- 2. 綠界付款通知（綠界的伺服器呼叫，一定要回 1|OK） ---------- */
async function ecpayNotify(request, env) {
  const plain = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain' } });
  try {
    const { id, key, iv } = ecpayKeys(env);
    const b = Object.fromEntries((await request.formData()).entries());
    if (!safeEq(b.CheckMacValue, await checkMac(b, key, iv))) { console.warn('ecpay: CheckMacValue 不符', b.MerchantTradeNo); return plain('0|CheckMacValue Error', 400); }
    if (b.MerchantID !== id) return plain('0|MerchantID Error', 400);
    const no = String(b.MerchantTradeNo || '');
    if (!/^[A-Za-z0-9]{1,20}$/.test(no)) return plain('0|TradeNo Error', 400);
    const paid = String(b.RtnCode) === '1';
    const simulated = String(b.SimulatePaid) === '1';            // 從綠界後台按「模擬付款」：正式環境不出貨
    await runTx(env, async tx => {
      const o = await getDoc(env, `orders/${no}`, tx);
      if (!o) throw new Error('order not found ' + no);
      if (o.status === 'paid') return {};                        // 綠界可能重送通知：已經處理過就不要再加一次
      const info = { ecpayTradeNo: b.TradeNo || '', paymentType: b.PaymentType || '', rtnCode: String(b.RtnCode), rtnMsg: b.RtnMsg || '' };
      const upd = (status, more = []) => patchWrite(env, `orders/${no}`, { ...info, status }, { times: ['notifiedAt', ...more] });
      if (!paid) return { writes: [upd(o.status === 'pending' ? 'pending' : o.status)] };   // 例如 ATM 取號通知，還沒付錢
      if (Number(b.TradeAmt) !== o.amount) return { writes: [upd('amount_mismatch')] };
      if (simulated && isProd(env)) return { writes: [upd('simulated')] };
      const p = productOf(o.productId);
      if (!p) return { writes: [upd('unknown_product')] };
      return { writes: [grantWrite(env, o.uid, p), upd('paid', ['paidAt'])] };
    });
    return plain('1|OK');
  } catch (e) {
    console.error('ecpayNotify', e && e.stack || e);
    return plain('0|' + (e.message || 'error'), 500);           // 回錯誤，綠界會再重送
  }
}

/* ---------- 3. 付款完，使用者的瀏覽器回來（只負責轉回 App，出貨看 ecpayNotify） ---------- */
async function ecpayResult(request, env, url) {
  let no = url.searchParams.get('order') || '';
  if (request.method === 'POST') { try { no = String((await request.formData()).get('MerchantTradeNo') || no); } catch {} }
  no = no.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const to = siteUrl(env) + (no ? '?order=' + no : '');
  return new Response(`<meta http-equiv="refresh" content="0;url=${to}">`, { status: 303, headers: { location: to, 'content-type': 'text/html' } });
}

/* ---------- 4. Google Play 購買確認（App 版） ----------
   要先在 Play 管理中心 →「使用者和權限」邀請服務帳戶的 Email（GOOGLE_SERVICE_ACCOUNT 裡的 client_email），
   給它「查看財務資料、管理訂單」權限。 */
async function playVerify(request, env) {
  const uid = await requireUser(request, env);
  const { productId, purchaseToken } = await readJson(request) || {};
  const p = productOf(productId);
  if (!p || typeof purchaseToken !== 'string' || purchaseToken.length > 4096) throw new ApiError(400, 'invalid-argument', '資料不正確');

  const pkg = env.PLAY_PACKAGE || 'io.github.wingfeeling.arpet';
  const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const auth = { authorization: 'Bearer ' + await googleToken(env) };
  const r = await fetch(api, { headers: auth });
  if (!r.ok) { console.warn('play get', r.status, await r.text()); return { ok: false, reason: 'verify_failed' }; }
  const data = await r.json();
  if (data.purchaseState !== 0) return { ok: false, reason: 'not_purchased' };

  const key = await sha256Hex(purchaseToken);
  const fresh = await runTx(env, async tx => {
    if (await getDoc(env, `playPurchases/${key}`, tx)) return { result: false };   // 同一筆購買只能領一次
    return { result: true, writes: [
      grantWrite(env, uid, p),
      patchWrite(env, `playPurchases/${key}`, { uid, productId, orderId: data.orderId || '' }, { times: ['createdAt'], precondition: { exists: false } }),
    ] };
  });
  // 飼料、空位可以重複買 → 「消耗」掉；寵物、套餐只能買一次 → 「確認」
  try {
    if (p.kind === 'food' || p.kind === 'slot') await fetch(api + ':consume', { method: 'POST', headers: auth });
    else if (data.acknowledgementState !== 1) await fetch(api + ':acknowledge', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
  } catch (e) { console.warn('play consume/ack', e.message); }
  return { ok: true, fresh };
}
