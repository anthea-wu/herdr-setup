# herdr-setup

Herdr 桌面版（`herdr-app`）與 OpenCode 的「有隻芫荽」樣式備份。打包時的 Herdr 版本是 0.1.16、OpenCode 是 2.2.7。

## 內容

| 路徑 | 用途 |
|---|---|
| `herdr-app/layouts/yuansui.json` | 版面定義，會指到下面的 theme、字型與 mods |
| `herdr-app/themes/yuansui.json` | Herdr 的配色 |
| `herdr-app/mods/ys-*` | 八個從內建 mod 複製後改樣式的 mod，logo 圖檔在 `ys-chrome` 裡 |
| `herdr-app/fonts/YuansuiMono-*.ttf` | Roboto Mono 英數加上 jf open 粉圓中文的合併字型 |
| `opencode/themes/yuansui.json` | OpenCode 的配色 |
| `tools/merge.js` | 產生合併字型的腳本，換中文字型時才需要 |

## 還原步驟

1. 把 `herdr-app/` 底下四個資料夾的內容複製到 `~/.config/herdr-app/` 的同名資料夾。
2. 把 `opencode/themes/yuansui.json` 複製到 `~/.config/opencode/themes/`。
3. 在 `~/.config/herdr-app/settings.json` 加上下面兩個設定，其他設定不動：

   ```json
   "minimum_contrast": 1,
   "colors": { "background": "#F8F6F1" }
   ```

4. 在 `~/.config/opencode/cli.json` 把 theme 區塊改成：

   ```json
   "theme": { "name": "yuansui", "mode": "light" }
   ```

5. 重開 Herdr，按 `Ctrl+Shift+L` 選 `yuansui`；已經開著的 OpenCode 要關掉重開。

不要複製 `layouts/.state/`，那是 Herdr 自己記的視窗狀態。

## 注意事項

- OpenCode 不要用 `system` theme。Herdr 0.1.16 回報給程式的 16 色色盤是預設的深色那一套，`system` 會拿它畫出黑色面板。
- `ys-*` mod 是內建 mod 的複本，Herdr 更新時不會跟著更新；Herdr 升級後版面壞掉的話，從新版內建 mod 重新複製再套樣式。
- `ys-tabs` 裡的視窗按鈕圖示是 Windows 用的，其他系統上沒有驗證過。

## 重新合併字型

需要 Node.js，以及 Roboto Mono 與中文字型的 `.ttf` 檔。

```
npm install fonteditor-core@2.4.1
node tools/merge.js <RobotoMono-Regular.ttf> <中文字型.ttf> <輸出.ttf> "Yuansui Mono" Regular
```

Medium 與 Bold 各跑一次，把最後一個參數與輸入的 Roboto Mono 檔換成對應字重。

## 授權

- Roboto Mono 採 Apache License 2.0，jf open 粉圓採 SIL Open Font License 1.1。
- `herdr-app/mods/` 內的程式碼改自 Herdr 內建的 mod，原始版權屬於 Herdr。
