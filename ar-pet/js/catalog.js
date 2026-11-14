/* ================================================================
   寵物目錄與遊戲規則
   以後要新增寵物種類、改數值、加商品，都只要改這個檔案。
   ================================================================ */

/* ---------- 遊戲數值 ---------- */
export const RULES = {
  startFood: 5,            // 新玩家一開始送幾包飼料
  freePetSlots: 4,         // 沒買擴充時，同時最多召喚幾隻
  maxFoodOnGround: 3,      // 地上最多同時放幾包還沒吃的飼料

  // 飽食度（0～100）
  newPetFull: 50,          // 新寵物的飽食度
  feedFull: 50,            // 吃一包加多少
  fullDropPerHour: 1,      // 每小時減少多少

  // 親密度（0～100）
  feedAff: 10,             // 吃一包加多少
  petAff: 1,               // 摸一次（連續摸 1.5 秒）加多少
  petAffPerDay: 5,         // 摸摸每天最多加多少
  petAffCap: 60,           // 親密度到這裡以後，摸摸就不會再增加
  petCooldownSec: 20,      // 摸完一次後，要隔幾秒再摸才會再加
  callAff: 80,             // 到這裡以上，叫名字會跑過來對你叫
  handAff: 100,            // 到這裡，伸手摸會有專屬互動
};

/* ---------- 寵物種類 ----------
   interact：親密度 100% 時，伸手摸牠的反應
     'lick' 舔你的手・'rub' 用頭和身體蹭你的手・'nuzzle' 用頭輕輕頂你的手
   voice：叫聲類型（'cat'、'dog'、'none'）
   free：true＝免費，false＝要購買（productId 是 Play 管理中心裡的商品 ID）
   rig：'toon'＝程式畫的 Q 版造型，'glb'＝用模型檔（之後新增的種類用這個）    */
export const SPECIES = {
  cat: {
    label: '貓咪', emoji: '🐱', voice: 'cat', interact: 'rub', free: true, rig: 'toon',
    palettes: {
      orange: { label: '橘貓', fur: 0xf7a24f, dark: 0xdf7a2c, cream: 0xfff4e3, stripes: true,  eye: 0x2a1d16 },
      white:  { label: '白貓', fur: 0xfbfaf7, dark: 0xebe5dc, cream: 0xffffff, stripes: false, eye: 0x4f8fe0, pupil: true },
      gray:   { label: '灰貓', fur: 0xa7b1bd, dark: 0x76818e, cream: 0xf0f2f5, stripes: true,  eye: 0x2a2a2a },
      black:  { label: '黑貓', fur: 0x34303a, dark: 0x1f1c22, cream: 0x4d4852, stripes: false, eye: 0xf2c94c, pupil: true },
    },
  },
  dog: {
    label: '小狗', emoji: '🐶', voice: 'dog', interact: 'lick', free: true, rig: 'toon',
    palettes: {
      shiba:  { label: '柴犬',     fur: 0xeca65e, dark: 0xcc8443, cream: 0xfff5e6, ears: 'up',   eye: 0x221812 },
      white:  { label: '白色小狗', fur: 0xfcfbf8, dark: 0xeee6da, cream: 0xffffff, ears: 'flop', earColor: 0xf1dcc0, eye: 0x221812 },
      black:  { label: '黑柴',     fur: 0x3b3331, dark: 0x262020, cream: 0xf3e5d1, ears: 'up',   eye: 0x221812 },
    },
  },
  /* 以後要賣的新種類，照這個格式加就好，例如：
  rabbit: {
    label: '兔子', emoji: '🐰', voice: 'none', interact: 'nuzzle', free: false, productId: 'pet_rabbit',
    rig: 'glb', model: 'models/rabbit.glb', size: 0.14, behavior: 'hop',
  },
  */
};

/* ---------- 商店商品（之後接 Google Play 付款時用） ----------
   id 要和 Play 管理中心「應用程式內商品」的商品 ID 完全一樣。 */
export const PRODUCTS = [
  { id: 'food_1',  kind: 'food',  amount: 1,  label: '飼料 1 包' },
  { id: 'food_5',  kind: 'food',  amount: 5,  label: '飼料 5 包' },
  { id: 'food_20', kind: 'food',  amount: 20, label: '飼料 20 包' },
  { id: 'slot_1',  kind: 'slot',  amount: 1,  label: '召喚上限 +1' },
];
