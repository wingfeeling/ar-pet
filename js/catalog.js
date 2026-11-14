/* ================================================================
   寵物目錄與遊戲規則
   以後要新增寵物種類、改數值、加商品，都只要改這個檔案。
   ================================================================ */

/* ---------- 遊戲數值 ---------- */
export const RULES = {
  startFood: 5,            // 新玩家一開始送幾包飼料
  freeFoodDays: 3,         // 每隔幾天免費送飼料（不會累積，打開 App 時領）
  freeFoodAmount: 1,       // 每次免費送幾包（改這裡的話，firestore.rules 裡的 +1 也要一起改）
  baseSlots: 1,            // 預設寵物以外，一開始有幾個空位
  maxPets: 6,              // 寵物清單最多幾隻（含預設寵物），也是同時最多召喚幾隻
  maxFoodOnGround: 3,      // 地上最多同時放幾包還沒吃的飼料

  // 飽食度（0～100）
  newPetFull: 50,          // 新寵物的飽食度
  feedFull: 50,            // 吃一包加多少
  fullDropPerHour: 1,      // 每小時減少多少
  fullRefuse: 90,          // 飽食度到這裡以上就吃不下

  // 親密度（0～100）
  feedAff: 10,             // 吃一包加多少
  petAff: 1,               // 摸一次（連續摸 1.5 秒）加多少
  petAffPerDay: 5,         // 摸摸每天最多加多少
  petAffCap: 60,           // 親密度到這裡以後，摸摸就不會再增加
  petCooldownSec: 20,      // 摸完一次後，要隔幾秒再摸才會再加
  callAff: 80,             // 到這裡以上，叫名字會跑過來對你叫
  handAff: 100,            // 到這裡，伸手會有「親密互動」
};

/* ---------- 寵物種類 ----------
   interact：親密互動（親密度 100% 時伸手）
     'lick' 舔你的手・'rub' 用頭和身體蹭你的手・'nuzzle' 用頭輕輕頂你的手
     'climb' 爬到你手上・'sleep' 走到你旁邊睡覺・'hum' 靠到你面前嗯嗯叫
   acts：自己會做的小動作（隨機）
     'wag' 搖尾巴・'stretch' 伸懶腰・'yawn' 打哈欠・'loaf' 趴著・'side' 側躺・'groom' 洗臉・'stand' 站起來張望・'look' 東張西望・'doze' 打瞌睡
   belly：被摸久了會翻過來露出肚子
   voice：叫聲類型（'cat'、'dog'、'none'）
   free：true＝免費，false＝要購買・price：新台幣・desc：商店裡的介紹
   rig：'toon'＝程式畫的 Q 版造型，'glb'＝用模型檔
   scale：體型（貓＝1）・speed：走路速度和散步範圍（貓＝1）
   jump：跳躍能力（公尺，參考真實動物）up＝最高往上跳・down＝最高往下跳・gap＝最遠水平跳
   wander：自己散步時，有多少機率會跳到別的高度
   words：語音召喚時，聽到這些字就叫這個種類（用 | 隔開）    */
export const SPECIES = {
  cat: {
    label: '貓咪', emoji: '🐱', voice: 'cat', interact: 'rub', free: true, rig: 'toon',
    acts: ['loaf', 'side', 'stretch', 'yawn', 'look'],
    scale: 1, speed: 1, jump: { up: 1.0, down: 1.6, gap: 0.55 }, wander: 0.35, words: '貓|猫|喵|咪',
    palettes: {
      orange: { label: '橘貓', fur: 0xf7a24f, dark: 0xdf7a2c, cream: 0xfff4e3, stripes: true,  eye: 0x2a1d16 },
      white:  { label: '白貓', fur: 0xfbfaf7, dark: 0xebe5dc, cream: 0xffffff, stripes: false, eye: 0x4f8fe0, pupil: true },
      gray:   { label: '灰貓', fur: 0xa7b1bd, dark: 0x76818e, cream: 0xf0f2f5, stripes: true,  eye: 0x2a2a2a },
      black:  { label: '黑貓', fur: 0x34303a, dark: 0x1f1c22, cream: 0x4d4852, stripes: false, eye: 0xf2c94c, pupil: true },
    },
  },
  dog: {
    label: '小狗', emoji: '🐶', voice: 'dog', interact: 'lick', free: true, rig: 'toon',
    acts: ['wag', 'stretch', 'yawn', 'loaf', 'wag'], belly: true,
    scale: 1, speed: 1, jump: { up: 0.5, down: 0.9, gap: 0.35 }, wander: 0.18, words: '狗|汪',
    palettes: {
      shiba:  { label: '柴犬',     fur: 0xeca65e, dark: 0xcc8443, cream: 0xfff5e6, ears: 'up',   eye: 0x221812 },
      white:  { label: '白色小狗', fur: 0xfcfbf8, dark: 0xeee6da, cream: 0xffffff, ears: 'flop', earColor: 0xf1dcc0, eye: 0x221812 },
      black:  { label: '黑柴',     fur: 0x3b3331, dark: 0x262020, cream: 0xf3e5d1, ears: 'up',   eye: 0x221812 },
    },
  },
  // 倉鼠：很小、跑得快；真實的倉鼠跳不高，從高處掉下來會受傷，所以只會上下很矮的高度
  hamster: {
    label: '倉鼠', emoji: '🐹', voice: 'hamster', interact: 'climb', free: false, productId: 'pet_hamster', price: 64, rig: 'toon',
    desc: '圓滾滾、臉頰鼓鼓的小倉鼠。動作很快，但膽子小，只敢上下很矮的地方。', acts: ['groom', 'stand', 'yawn', 'groom'],
    scale: 0.6, speed: 0.8, jump: { up: 0.12, down: 0.2, gap: 0.12 }, wander: 0.1, words: '倉鼠|仓鼠|鼠',
    palettes: {
      golden: { label: '金黃倉鼠', fur: 0xeeb36a, dark: 0xd18f45, cream: 0xfff7ec, eye: 0x1c1412 },
      white:  { label: '白色倉鼠', fur: 0xfbf8f3, dark: 0xece4d8, cream: 0xffffff, eye: 0x7a2232 },
      dwarf:  { label: '三線鼠',   fur: 0xbdb2a6, dark: 0x6e645c, cream: 0xfbf7f2, eye: 0x1c1412, stripe: true },
      pudding:{ label: '布丁鼠',   fur: 0xf6d27a, dark: 0xe0b154, cream: 0xfffaf0, eye: 0x1c1412 },
    },
  },
  // 羊駝：脖子長、腿長；不太會跳家具，大概只上得去矮凳、低沙發
  alpaca: {
    label: '羊駝', emoji: '🦙', voice: 'alpaca', interact: 'hum', free: false, productId: 'pet_alpaca', price: 64, rig: 'toon',
    desc: '毛蓬蓬、脖子長長的羊駝。腿長走得快，會發出「嗯～」的哼哼聲。', acts: ['look', 'loaf', 'yawn', 'stretch'],
    scale: 0.95, speed: 1.15, jump: { up: 0.4, down: 0.6, gap: 0.4 }, wander: 0.12, words: '羊駝|羊驼|草泥馬|草泥马|駝|驼',
    palettes: {
      white: { label: '白色羊駝', fur: 0xfbf7ef, dark: 0xe9dfcf, cream: 0xfffdf8, eye: 0x1c1412 },
      latte: { label: '奶茶羊駝', fur: 0xe7d0a8, dark: 0xcdb085, cream: 0xfaf0dd, eye: 0x1c1412 },
      brown: { label: '咖啡羊駝', fur: 0xb4835a, dark: 0x8d6140, cream: 0xe9d3b6, eye: 0x1c1412 },
    },
  },
  // 水豚：身體重、動作慢，很少跳；水豚頭上頂橘子是網路上很紅的樣子
  capybara: {
    label: '水豚', emoji: '🦫', voice: 'capybara', interact: 'sleep', free: false, productId: 'pet_capybara', price: 64, rig: 'toon',
    desc: '永遠一臉放鬆的水豚，慢慢走、很少跳。有「頭頂橘子」的版本。', acts: ['loaf', 'doze', 'yawn', 'loaf'],
    scale: 1.05, speed: 0.75, jump: { up: 0.3, down: 0.5, gap: 0.3 }, wander: 0.08, words: '水豚|豚',
    palettes: {
      brown: { label: '水豚',         fur: 0xae7e52, dark: 0x7e5737, cream: 0xc99c70, eye: 0x1c1412 },
      light: { label: '淺棕水豚',     fur: 0xc79d6f, dark: 0x9a7149, cream: 0xddb98f, eye: 0x1c1412 },
      yuzu:  { label: '頭頂橘子水豚', fur: 0xae7e52, dark: 0x7e5737, cream: 0xc99c70, eye: 0x1c1412, yuzu: true },
    },
  },
  /* 以後要賣的新種類，照這個格式加就好，例如：
  rabbit: {
    label: '兔子', emoji: '🐰', voice: 'none', interact: 'nuzzle', free: false, productId: 'pet_rabbit',
    rig: 'glb', model: 'models/rabbit.glb', size: 0.14, behavior: 'hop',
  },
  */
};

/* ---------- 商店商品 ----------
   id 要和 Play 管理中心「應用程式內商品」的商品 ID 完全一樣；price 是新台幣（測試模式顯示用，正式價格以 Play 管理中心為準）。
   kind：'food' 飼料（可重複買）・'slot' 加一個寵物空位（可重複買，到上限為止）
         'pet' 解鎖一種寵物（只能買一次）・'set' 寵物套餐＝寵物＋1 個空位＋飼料（只能買一次）
   bonus：商店上顯示的小標籤 */
export const PRODUCTS = [
  { id: 'food_5',  kind: 'food', amount: 5,  price: 10, label: '飼料 5 包',  bonus: '試吃包' },
  { id: 'food_12', kind: 'food', amount: 12, price: 20, label: '飼料 12 包', bonus: '多送 2 包' },
  { id: 'food_45', kind: 'food', amount: 45, price: 64, label: '飼料 45 包', bonus: '多送 5 包' },
  { id: 'slot_1',  kind: 'slot', amount: 1,  price: 64, label: '寵物空位 +1' },
  ...Object.entries(SPECIES).filter(([, v]) => !v.free).flatMap(([k, v]) => [
    { id: v.productId, kind: 'pet', species: k, price: v.price, label: `${v.label}` },
    { id: 'set_' + k,  kind: 'set', species: k, slots: 1, food: 10, price: 128, label: `${v.label}套餐` },
  ]),
];
