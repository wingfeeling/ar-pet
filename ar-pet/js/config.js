/* ================================================================
   ★ 帳號登入設定（Firebase）——整個 App 只有這裡要填
   到 Firebase 主控台 → 專案設定 → 你的應用程式，
   只複製 const firebaseConfig = { … }; 這一段，貼上來取代下面那一行。
   不要複製 import 那幾行，也不要複製 initializeApp 那一行。

   還沒設定時，App 一樣能用，只是資料只會存在這支手機上。
   ================================================================ */

/* ↓↓↓ 把 Firebase 給你的整段設定貼在這裡，取代下面這一行 ↓↓↓ */
const firebaseConfig = {
  apiKey: "AIzaSyCriWJSfh6hEOzRUxlT8H1iiibgCG6eR64",
  authDomain: "ar-pet-524e2.firebaseapp.com",
  projectId: "ar-pet-524e2",
  storageBucket: "ar-pet-524e2.firebasestorage.app",
  messagingSenderId: "87047682313",
  appId: "1:87047682313:web:b977dd2681e23ee6203bd8"
};
/* ↑↑↑ 貼到這裡為止 ↑↑↑ */
