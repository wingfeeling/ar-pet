/* 編輯器的進階功能檢查：登入 → 向後端扣試用次數（付費會員不扣） */
(function () {
  const NAMES = { ocr: '掃描檔文字辨識', convert: 'Word／Excel／PPT 轉檔', batch: '批次轉檔' };
  async function login(feature) {
    await App.ready;
    if (App.user) return true;
    if (!confirm(`「${NAMES[feature] || feature}」要先用 Google 帳號登入（免費）。\n要現在登入嗎？`)) return false;
    try { await App.signIn(); } catch (e) { if (e.message !== '已取消登入') alert(e.message); return false; }
    if (!App.user) return false; paintWho(); return true;
  }
  function needPay(e) { if (e.status === 402) { if (confirm(e.message + '\n\n要打開「方案與價格」頁面嗎？')) window.open('pricing.html', '_blank'); return true; } return false; }
  window.PDFAPP = {
    /* count：這次要轉幾個檔案（批次轉檔時每個檔案算一次） */
    async gate(feature, count = 1) {
      if (!(await login(feature))) return false;
      try {
        const r = await App.api('/api/usage/consume', { body: { feature, count } });
        if (!r.paid && r.remaining != null && r.remaining <= 3 && window.toast) setTimeout(() => toast(`「${NAMES[feature]}」這個月的免費次數還剩 ${r.remaining} 次`, 5000), 2500);
        return true;
      } catch (e) { if (needPay(e)) return false; throw e; }
    },
    /* 批次轉檔：免費版一次最多 N 個檔案（後台設定 FREE_BATCH_FILES），超過要進階版 */
    async batch(count) {
      if (!(await login('batch'))) return false;
      try { await App.api('/api/usage/batch', { body: { count } }); return true; }
      catch (e) { if (needPay(e)) return false; throw e; }
    }
  };
  function paintWho() {
    const el = document.getElementById('edWho'); if (!el) return; const u = App.user;
    el.innerHTML = u ? `<a href="account.html" target="_blank" title="${App.esc(u.email)}" style="font-size:12.5px;color:#374151;text-decoration:none;white-space:nowrap">👤 ${App.esc(u.displayName || u.email)}</a>`
      : `<button class="btn sm" id="edLogin">登入</button>`;
    // 以前登入失敗時什麼都不顯示，看起來像視窗「閃退」；現在會跳出原因
    const b = document.getElementById('edLogin'); if (b) b.onclick = () => App.signIn().then(paintWho).catch(e => { if (e.message !== '已取消登入') alert(e.message); });
  }
  App.ready.then(paintWho); App.onAuth(paintWho);
})();
