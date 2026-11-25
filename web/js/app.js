/* 共用：Google 登入、呼叫後端、頁首 */
(function () {
  const C = window.APP_CONFIG || {};
  const API = (C.apiBase || '').replace(/\/$/, '');
  let fb = null, auth = null;
  const devToken = new URLSearchParams(location.search).get('devlogin') || sessionStorage.getItem('devlogin');   // 只在後端開 DEV_AUTH 時有用
  if (devToken) sessionStorage.setItem('devlogin', devToken);
  try { if (window.firebase && C.firebase && !/貼上/.test(C.firebase.apiKey)) { fb = firebase.initializeApp(C.firebase); auth = firebase.auth(); } } catch (e) { console.warn(e); }
  let user = devToken ? { email: devToken, displayName: devToken.split('@')[0], dev: true } : null;
  const listeners = [];
  const ready = new Promise(res => {
    if (devToken || !auth) return res(user);
    auth.onAuthStateChanged(u => { user = u; listeners.forEach(f => f(u)); res(u); });
  });
  async function signIn() {
    if (!auth) { alert('網站還沒設定 Google 登入（請管理者填寫 js/config.js）'); throw new Error('no auth'); }
    const prov = new firebase.auth.GoogleAuthProvider(); prov.setCustomParameters({ prompt: 'select_account' });
    if (inApp()) { alert('LINE、Facebook、Instagram 裡面的瀏覽器不能用 Google 登入（Google 的規定）。\n請按右上角「⋯」選「用瀏覽器開啟」（Chrome／Safari）後再登入。'); throw new Error('已取消登入'); }
    try { const r = await auth.signInWithPopup(prov); user = r.user; return user; }
    catch (e) {
      const code = e.code || '';
      if (/popup-blocked|operation-not-supported/.test(code)) { await auth.signInWithRedirect(prov); return null; }
      if (/popup-closed|cancelled-popup/.test(code)) throw new Error('已取消登入');
      throw new Error(loginErr(code, e.message));
    }
  }
  // 登入失敗的原因翻成看得懂的話
  function loginErr(code, msg) {
    if (/unauthorized-domain/.test(code)) return `登入失敗：這個網址（${location.hostname}）還沒加進 Firebase 的「授權網域」。\n網站管理者請到 Firebase 主控台 → Authentication → 設定 → 授權網域 → 新增網域，填入：${location.hostname}`;
    if (/network-request-failed/.test(code)) return '登入失敗：連不上 Google，請確認網路後再試';
    if (/too-many-requests/.test(code)) return '登入嘗試太多次，請過幾分鐘再試';
    if (/internal-error|web-storage-unsupported/.test(code)) return '登入失敗：瀏覽器擋住了登入需要的儲存空間（無痕模式或封鎖第三方 Cookie 時會這樣），請換一般視窗再試';
    return '登入失敗：' + (msg || code);
  }
  function inApp() { return /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent); }
  // 用跳轉方式登入回來時，如果失敗也要顯示原因
  if (auth) auth.getRedirectResult().catch(e => { if (!/popup-closed|cancelled|no-auth-event/.test(e.code || '')) alert(loginErr(e.code || '', e.message)); });
  async function signOut() { sessionStorage.removeItem('devlogin'); if (auth) await auth.signOut(); user = null; location.reload(); }
  async function token() { await ready; if (devToken) return 'dev:' + devToken; return user ? await user.getIdToken() : null; }
  async function api(path, opt = {}) {
    const h = Object.assign({}, opt.headers || {}); const t = await token(); if (t) h.Authorization = 'Bearer ' + t;
    let bodyv = opt.body;
    if (bodyv && !(bodyv instanceof Blob) && !(bodyv instanceof ArrayBuffer) && !(bodyv instanceof Uint8Array) && typeof bodyv === 'object') { bodyv = JSON.stringify(bodyv); h['Content-Type'] = 'application/json'; }
    let r;
    try { r = await fetch(API + path, { method: opt.method || (bodyv ? 'POST' : 'GET'), headers: h, body: bodyv }); }
    catch (e) { const er = new Error('連不上伺服器，請確認網路後再試'); er.status = 0; throw er; }
    if (opt.raw) { if (!r.ok) { let d = {}; try { d = await r.json(); } catch (e) { } const er = new Error(d.error || ('錯誤 ' + r.status)); er.status = r.status; er.data = d; throw er; } return r; }
    let d = {}; try { d = await r.json(); } catch (e) { }
    if (!r.ok) { const er = new Error(d.error || ('錯誤 ' + r.status)); er.status = r.status; er.data = d; throw er; }
    return d;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function header(active) {
    const el = document.getElementById('siteHeader'); if (!el) return;
    const links = [['index.html', '首頁'], ['editor.html', 'PDF 編輯器'], ['admin.html', '批次線上簽名'], ['pricing.html', '方案與價格'], ['wish.html', '🌠 許願池・客服']];
    el.innerHTML = `<div class="hd"><a class="logo" href="index.html"><i>PDF</i>${esc(C.siteName || 'PDF 線上編輯器')}</a>
      <nav>${links.map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`).join('')}<a href="ops.html" id="hdOps" class="${active === 'ops.html' ? 'on' : ''}" style="display:none">管理後台</a></nav>
      <div class="who" id="who"></div></div>`;
    const who = () => { const w = document.getElementById('who'); if (!w) return;
      w.innerHTML = user ? `<a href="account.html" class="acct" title="${esc(user.email)}">${user.photoURL ? `<img src="${esc(user.photoURL)}" alt="">` : '<span class="av">' + esc((user.displayName || user.email || '?')[0]) + '</span>'}<span>${esc(user.displayName || user.email)}</span></a>`
        : `<button class="btn primary sm" id="hdLogin">用 Google 登入</button>`;
      const b = document.getElementById('hdLogin'); if (b) b.onclick = () => signIn().then(u => u && location.reload()).catch(e => e.message !== '已取消登入' && alert(e.message));
      if (user) me().then(m => { const o = document.getElementById('hdOps'); if (o && m && m.site_admin) o.style.display = ''; }).catch(() => { }); };
    ready.then(who); listeners.push(who);
  }
  let meP = null; function me() { return meP || (meP = api('/api/me').catch(e => { meP = null; throw e; })); }
  // 頁尾：經營者資訊（每一頁都一樣，改 js/config.js 就好）
  function footer() {
    const f = document.querySelector('footer'); if (!f || f.dataset.info) return; f.dataset.info = 1;
    if (!f.querySelector('a[href="wish.html"]')) f.insertAdjacentHTML('beforeend', '<a href="wish.html">許願池・客服</a>');
    f.insertAdjacentHTML('beforeend', `<div class="small muted" style="width:100%;margin-top:8px">${esc(C.siteName || '')}・經營者：${esc(C.owner || '')}・客服信箱：<a href="mailto:${esc(C.supportEmail || '')}">${esc(C.supportEmail || '')}</a><br>${esc(C.ownerNote || '')}<br>© ${new Date().getFullYear()} ${esc(C.copyright || C.owner || '')} 版權所有</div>`);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', footer); else footer();
  function fmtDate(ms, time) { if (!ms) return ''; const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}` + (time ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : ''); }
  window.App = { config: C, ready, signIn, signOut, token, api, header, esc, fmtDate, me, loginErr, get user() { return user; }, onAuth: f => listeners.push(f) };
})();
