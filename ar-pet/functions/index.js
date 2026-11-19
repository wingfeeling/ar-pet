/* ================================================================
   AR 寵物・付款伺服器（Firebase Cloud Functions）
   ─ 網頁版：綠界 ECPay（信用卡等）
       ecpayCreateOrder  App 叫它建立訂單，拿到要送去綠界的表單
       ecpayNotify       綠界付款成功後「伺服器對伺服器」通知這裡 → 驗證 → 把東西加進帳號
       ecpayResult       付款完，使用者的瀏覽器被綠界送回這裡 → 轉回 App
   ─ Google Play App：verifyPlayPurchase  向 Google 確認購買 → 把東西加進帳號

   ★ 價格一律以這裡讀到的 catalog（js/catalog.js 的複本）為準，不相信手機傳來的金額。
   ★ 只有這裡（伺服器）可以加飼料、空位、寵物；firestore.rules 已經禁止手機自己改這些欄位。
   ================================================================ */
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { PRODUCTS } from './catalog.mjs';   // 部署時自動從 js/catalog.js 複製過來（firebase.json 的 predeploy）

initializeApp();
const db = getFirestore();

const REGION = 'asia-east1';                                   // 台灣機房
const ECPAY_MERCHANT_ID = defineSecret('ECPAY_MERCHANT_ID');
const ECPAY_HASH_KEY    = defineSecret('ECPAY_HASH_KEY');
const ECPAY_HASH_IV     = defineSecret('ECPAY_HASH_IV');
const ECPAY_MODE  = defineString('ECPAY_MODE', { default: 'stage' });   // 'stage' 測試環境・'production' 正式收款
const SITE_URL    = defineString('SITE_URL', { default: 'https://wingfeeling.github.io/ar-pet/' });
const PLAY_PACKAGE = defineString('PLAY_PACKAGE', { default: 'io.github.wingfeeling.arpet' });

const isProd = () => ECPAY_MODE.value() === 'production';
const ecpayHost = () => isProd() ? 'https://payment.ecpay.com.tw' : 'https://payment-stage.ecpay.com.tw';
const fnUrl = name => `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/${name}`;
const productOf = id => PRODUCTS.find(p => p.id === id);

/* ---------- 把買到的東西加進帳號（綠界、Google Play 共用） ---------- */
function grant(tx, uid, p, extra = {}) {
  const ref = db.doc(`users/${uid}`), up = { ...extra };
  if (p.kind === 'food') up.food = FieldValue.increment(p.amount);
  if (p.kind === 'slot') up.slots = FieldValue.increment(p.amount);
  if (p.kind === 'pet') up.owned = FieldValue.arrayUnion(p.species);
  if (p.kind === 'set') { up.owned = FieldValue.arrayUnion(p.species); up.slots = FieldValue.increment(p.slots); up.food = FieldValue.increment(p.food); }
  tx.set(ref, up, { merge: true });
}
async function alreadyOwns(uid, p) {
  if (p.kind !== 'pet' && p.kind !== 'set') return false;
  const d = (await db.doc(`users/${uid}`).get()).data() || {};
  return Array.isArray(d.owned) && d.owned.includes(p.species);
}

/* ---------- 綠界的檢查碼 CheckMacValue（SHA256） ----------
   1. 參數依名稱 A→Z 排序（不分大小寫）  2. 前面加 HashKey、後面加 HashIV
   3. 照 .NET 的 URL 編碼規則編碼，全部轉小寫  4. SHA256，轉大寫 */
function checkMac(params, key, iv) {
  const body = Object.keys(params).filter(k => k !== 'CheckMacValue')
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)
    .map(k => `${k}=${params[k]}`).join('&');
  const enc = encodeURIComponent(`HashKey=${key}&${body}&HashIV=${iv}`)
    .replace(/%20/g, '+').replace(/'/g, '%27').replace(/~/g, '%7e').toLowerCase();
  return crypto.createHash('sha256').update(enc).digest('hex').toUpperCase();
}
const safeEq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// 綠界要的時間格式：台灣時間 yyyy/MM/dd HH:mm:ss
function twNow() {
  const t = new Date(Date.now() + 8 * 3600e3), z = n => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${z(t.getUTCMonth() + 1)}/${z(t.getUTCDate())} ${z(t.getUTCHours())}:${z(t.getUTCMinutes())}:${z(t.getUTCSeconds())}`;
}
// 訂單編號：最多 20 個英數字，不能重複
function newTradeNo() {
  const t = twNow().replace(/\D/g, '').slice(2);               // yyMMddHHmmss
  return 'AP' + t + crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

/* ---------- 1. 建立訂單（App 呼叫） ---------- */
export const ecpayCreateOrder = onCall({ region: REGION, secrets: [ECPAY_MERCHANT_ID, ECPAY_HASH_KEY, ECPAY_HASH_IV] }, async req => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '請先登入');
  const p = productOf(req.data?.productId);
  if (!p) throw new HttpsError('not-found', '沒有這個商品');
  if (req.data?.agree !== true) throw new HttpsError('failed-precondition', '請先同意購買須知');
  if (await alreadyOwns(uid, p)) throw new HttpsError('already-exists', '你已經擁有這隻寵物了');

  const tradeNo = newTradeNo();
  const amount = Math.round(p.price);
  await db.doc(`orders/${tradeNo}`).set({
    uid, productId: p.id, kind: p.kind, amount, label: p.label, status: 'pending', provider: 'ecpay',
    mode: ECPAY_MODE.value(), createdAt: FieldValue.serverTimestamp(),
  });

  const params = {
    MerchantID: ECPAY_MERCHANT_ID.value(),
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: twNow(),
    PaymentType: 'aio',
    TotalAmount: String(amount),
    TradeDesc: 'AR寵物商店',
    ItemName: `AR寵物 ${p.label}`.replace(/[#&]/g, ' '),
    ReturnURL: fnUrl('ecpayNotify'),                            // 綠界通知付款結果（伺服器對伺服器）
    OrderResultURL: fnUrl('ecpayResult'),                       // 付款完把使用者送回來
    ClientBackURL: SITE_URL.value() + '?order=' + tradeNo,      // 付款頁上的「返回商店」
    ChoosePayment: 'ALL',
    // 小額商品不開 ATM／超商（那些方式有固定手續費，而且要等使用者去繳費）；依你綠界後台實際開通的方式調整
    IgnorePayment: amount < 100 ? 'ATM#CVS#BARCODE#WebATM' : 'BARCODE#WebATM',
    EncryptType: '1',
    CustomField1: uid.slice(0, 50),
    NeedExtraPaidInfo: 'N',
  };
  params.CheckMacValue = checkMac(params, ECPAY_HASH_KEY.value(), ECPAY_HASH_IV.value());
  return { orderId: tradeNo, action: ecpayHost() + '/Cashier/AioCheckOut/V5', params };
});

/* ---------- 2. 綠界付款通知（綠界的伺服器呼叫，一定要回 1|OK） ---------- */
export const ecpayNotify = onRequest({ region: REGION, secrets: [ECPAY_MERCHANT_ID, ECPAY_HASH_KEY, ECPAY_HASH_IV] }, async (req, res) => {
  try {
    const b = req.body || {};
    if (!safeEq(b.CheckMacValue, checkMac(b, ECPAY_HASH_KEY.value(), ECPAY_HASH_IV.value()))) {
      logger.warn('ecpay: CheckMacValue 不符', b.MerchantTradeNo); res.status(400).send('0|CheckMacValue Error'); return;
    }
    if (b.MerchantID !== ECPAY_MERCHANT_ID.value()) { res.status(400).send('0|MerchantID Error'); return; }
    const ref = db.doc(`orders/${b.MerchantTradeNo}`);
    const paid = String(b.RtnCode) === '1';
    const simulated = String(b.SimulatePaid) === '1';            // 從綠界後台按「模擬付款」：正式環境不出貨
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('order not found ' + b.MerchantTradeNo);
      const o = snap.data();
      if (o.status === 'paid') return;                           // 綠界可能重送通知：已經處理過就不要再加一次
      const info = { ecpayTradeNo: b.TradeNo || '', paymentType: b.PaymentType || '', rtnCode: String(b.RtnCode), rtnMsg: b.RtnMsg || '', notifiedAt: FieldValue.serverTimestamp() };
      if (!paid) { tx.update(ref, { ...info, status: o.status === 'pending' ? 'pending' : o.status }); return; }   // 例如 ATM 取號通知，還沒付錢
      if (Number(b.TradeAmt) !== o.amount) { tx.update(ref, { ...info, status: 'amount_mismatch' }); return; }
      if (simulated && isProd()) { tx.update(ref, { ...info, status: 'simulated' }); return; }
      const p = productOf(o.productId);
      if (!p) { tx.update(ref, { ...info, status: 'unknown_product' }); return; }
      grant(tx, o.uid, p, { lastPurchaseAt: FieldValue.serverTimestamp() });
      tx.update(ref, { ...info, status: 'paid', paidAt: FieldValue.serverTimestamp() });
    });
    res.type('text/plain').send('1|OK');
  } catch (e) {
    logger.error('ecpayNotify', e);
    res.status(500).type('text/plain').send('0|' + (e.message || 'error'));   // 回錯誤，綠界會再重送
  }
});

/* ---------- 3. 付款完，使用者的瀏覽器回來（只負責轉回 App，出貨看 ecpayNotify） ---------- */
export const ecpayResult = onRequest({ region: REGION }, (req, res) => {
  const no = String(req.body?.MerchantTradeNo || req.query?.order || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const url = SITE_URL.value() + (no ? '?order=' + no : '');
  res.status(303).set('Location', url).send(`<meta http-equiv="refresh" content="0;url=${url}">`);
});

/* ---------- 4. Google Play 購買確認（App 版） ----------
   要先在 Play 管理中心 →「使用者和權限」邀請 Cloud Functions 的服務帳戶，給它「查看財務資料、管理訂單」權限。 */
export const verifyPlayPurchase = onCall({ region: REGION }, async req => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '請先登入');
  const { productId, purchaseToken } = req.data || {};
  const p = productOf(productId);
  if (!p || typeof purchaseToken !== 'string' || purchaseToken.length > 4096) throw new HttpsError('invalid-argument', '資料不正確');

  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
  const api = google.androidpublisher({ version: 'v3', auth });
  const packageName = PLAY_PACKAGE.value();
  const { data } = await api.purchases.products.get({ packageName, productId, token: purchaseToken });
  if (data.purchaseState !== 0) return { ok: false, reason: 'not_purchased' };

  const key = crypto.createHash('sha256').update(purchaseToken).digest('hex');
  const ref = db.doc(`playPurchases/${key}`);
  const fresh = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (s.exists) return false;                                // 同一筆購買只能領一次
    grant(tx, uid, p, { lastPurchaseAt: FieldValue.serverTimestamp() });
    tx.set(ref, { uid, productId, orderId: data.orderId || '', createdAt: FieldValue.serverTimestamp() });
    return true;
  });
  // 飼料、空位可以重複買 → 「消耗」掉；寵物、套餐只能買一次 → 「確認」
  try {
    if (p.kind === 'food' || p.kind === 'slot') await api.purchases.products.consume({ packageName, productId, token: purchaseToken });
    else if (data.acknowledgementState !== 1) await api.purchases.products.acknowledge({ packageName, productId, token: purchaseToken, requestBody: {} });
  } catch (e) { logger.warn('play consume/ack', e.message); }
  return { ok: true, fresh };
});
