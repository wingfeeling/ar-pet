-- PDF 線上編輯器 D1 資料表（參考用：後端第一次連線時會自動建立，不用手動執行）
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  paid_until INTEGER,            -- 進階版到期時間（毫秒）
  doc_credits INTEGER DEFAULT 0, -- 買來的批次簽名份數（剩下）
  credits_until INTEGER,         -- 份數的使用期限（毫秒）
  trial_docs INTEGER DEFAULT 0,  -- 已用掉的免費試用份數
  created_at INTEGER,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  feature TEXT NOT NULL,         -- ocr / convert
  trial INTEGER NOT NULL,        -- 1 = 扣每月免費次數, 0 = 進階版使用（只做統計）
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_uid ON usage(uid, feature, trial);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  name TEXT,
  org_name TEXT,
  message TEXT,
  deadline INTEGER,              -- 簽名截止（毫秒）
  require_login INTEGER DEFAULT 1,
  retain_until INTEGER,          -- 超過這個時間由排程自動刪除全部檔案；NULL = 不限天數（進階版，到期 PRO_GRACE_DAYS 天後刪除）
  created_at INTEGER,
  trial INTEGER DEFAULT 0,       -- 1 = 免費試用批次（保存天數較短）
  warned INTEGER DEFAULT 0,      -- （保留欄位，目前沒用到）
  mode TEXT DEFAULT 'list',      -- list 指定人員 / multi 多人簽同一份（最多 5 人依序簽）/ open 連署
  link TEXT,                     -- 共用簽名網址 sign.html?b=… 裡的亂碼
  tpl_key TEXT, tpl_name TEXT, tpl_size INTEGER,  -- 連署：大家要簽的那一份文件
  max_signers INTEGER            -- 連署人數上限（NULL = 不限）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_link ON batches(link);
CREATE INDEX IF NOT EXISTS idx_batches_owner ON batches(owner_uid);
CREATE INDEX IF NOT EXISTS idx_batches_retain ON batches(retain_until);

CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  filename TEXT,
  student_id TEXT,
  student_name TEXT,
  email TEXT,
  token TEXT UNIQUE NOT NULL,    -- 簽名網址裡的亂碼
  status TEXT NOT NULL,          -- pending / sent / signed / returned
  orig_key TEXT, orig_size INTEGER,
  signed_key TEXT, signed_size INTEGER,
  sent_at INTEGER, sent_count INTEGER DEFAULT 0,
  signed_at INTEGER, signed_ip TEXT, signed_email TEXT,
  return_reason TEXT,
  created_at INTEGER,
  credit TEXT,                   -- 預留的是 trial 還是 paid 份數
  charged INTEGER DEFAULT 0,     -- 1 = 有人簽過了，這份已算掉；0 = 還沒簽，刪除或到期時退回預留的份數
  signers TEXT,                  -- 簽名人 JSON：[{email, name, at, ip, key, size}]，依簽名順序；key = 這個人簽好後的版本
  cur INTEGER DEFAULT 0          -- 已經簽了幾個人（status：pending/sent 沒人簽、partial 簽名中、signed 全部簽好、returned 退回）
);
CREATE INDEX IF NOT EXISTS idx_docs_batch_email ON docs(batch_id, email);
CREATE INDEX IF NOT EXISTS idx_docs_batch ON docs(batch_id);


CREATE TABLE IF NOT EXISTS orders (
  trade_no TEXT PRIMARY KEY,
  uid TEXT NOT NULL, email TEXT,
  plan TEXT, amount INTEGER,
  days INTEGER,                  -- 進階版天數
  credits INTEGER DEFAULT 0,     -- 簽名份數
  credit_days INTEGER DEFAULT 0, -- 份數使用期限（天）
  status TEXT,                   -- created / paid / failed
  created_at INTEGER, paid_at INTEGER,
  ecpay_trade_no TEXT, payment_type TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_uid ON orders(uid);

CREATE TABLE IF NOT EXISTS credit_log (   -- 每一次加份數／加天數的紀錄（付款或管理者手動開通）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL, credits INTEGER, pro_days INTEGER,
  reason TEXT, ref TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_credit_uid ON credit_log(uid);

-- 沒有綁 R2 時，PDF 切成 1.8 MB 一塊存在這裡（不用綁信用卡）
CREATE TABLE IF NOT EXISTS files (
  key TEXT NOT NULL,             -- 跟 docs.orig_key / docs.signed_key 一樣
  part INTEGER NOT NULL,         -- 第幾塊，從 0 開始
  data BLOB,
  created_at INTEGER,
  PRIMARY KEY (key, part)
);

-- 客服・許願池（參考 ar-pet）：type = bug（客服）/ wish（許願池）；thread = 來回對話的 JSON
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, email TEXT, name TEXT,
  type TEXT NOT NULL, text TEXT, price INTEGER, device TEXT,
  status TEXT,                   -- open / replied / closed
  thread TEXT, user_unread INTEGER DEFAULT 0, admin_unread INTEGER DEFAULT 1,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_uid ON tickets(uid);
CREATE INDEX IF NOT EXISTS idx_tickets_upd ON tickets(updated_at);

-- 管理後台手動開通給「還沒登入過」的 Email：對方第一次登入時自動加上
CREATE TABLE IF NOT EXISTS pending_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
  pro_days INTEGER, credits INTEGER, credit_days INTEGER, reason TEXT, note TEXT,
  created_at INTEGER, applied_at INTEGER, uid TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_grants(email);
