# MediaPipe 手部辨識（版本 1.2.3）

這個資料夾是網站用來辨識手部關節的程式和模型，直接放在網站裡，不用連外部網站。

- `vision_bundle.mjs`、`wasm/`：@mediapipe/tasks-vision 1.2.3（Google，Apache License 2.0）
- `hand_landmarker.task`：MediaPipe Hand Landmarker 模型 float16 第 1 版（Google，Apache License 2.0）

授權條款全文：https://www.apache.org/licenses/LICENSE-2.0
原始來源：https://github.com/google-ai-edge/mediapipe

請不要修改這些檔案。要升級版本時，建立新的 `mediapipe-<新版本>` 資料夾，再修改 index.html 裡的 MP_VER。
