# herdr-setup

Herdr 桌面版（`herdr-app`）與 OpenCode 的「有隻芫荽」樣式備份。打包時的 Herdr 版本是 0.1.16、OpenCode 是 2.2.7。

## 內容

| 路徑 | 用途 |
|---|---|
| `herdr-app/layouts/yuansui.json` | 版面定義，會指到下面的 theme、字型與 mods |
| `herdr-app/themes/yuansui.json` | Herdr 的配色 |
| `herdr-app/mods/ys-*` | 七個從內建 mod 複製後改樣式的 mod（logo 圖檔在 `ys-chrome` 裡），加上自己寫的 `ys-git` |
| `herdr-app/mods/ys-git` | 視窗最右側的唯讀 Git 面板，說明見下方「Git 面板」 |
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

5. 在 `~/.config/herdr-app/keys.json` 的 `global` 區塊加上 Git 面板的兩個快捷鍵。`alt-9` 原本是 `space.select:9`，要換掉：

   ```json
   "alt-9": "ys-tabs.git-tree",
   "alt-0": "ys-tabs.git-changes"
   ```

6. 重開 Herdr，按 `Ctrl+Shift+L` 選 `yuansui`；已經開著的 OpenCode 要關掉重開。

不要複製 `layouts/.state/`，那是 Herdr 自己記的視窗狀態。

Git 面板需要 `git` 在 PATH 上，否則只會顯示讀不到 repo。

## macOS

上面的步驟是照 Windows 寫的，在 macOS 上有這些不同：

- 切換版面是 `Cmd+Shift+L`，不是 `Ctrl+Shift+L`。
- macOS 不裝 Git 面板：
  1. 第 1 步不要複製 `mods/ys-git`。
  2. 把 `~/.config/herdr-app/layouts/yuansui.json` 最外層 `id` 為 `git` 的節點整段刪掉。
  3. 跳過第 5 步，不加 `alt-9`、`alt-0`。

  `ys-tabs` 找不到 `git` 節點時，會自己藏起 Git 按鈕，快捷鍵也會直接跳過，其他 mod 不受影響。
- 重開 Herdr 後字型沒有變的話，把 `fonts/` 裡的三個 `.ttf` 用「字體簿」安裝。

## Git 面板

`ys-git` 掛在 `layouts/yuansui.json` 最外層的 `git` 節點，只跑唯讀的 git 指令，不會改動 repo。

- 開關：tab bar 右邊的 Git 按鈕，或 `Alt+9`（Tree）、`Alt+0`（Changes）。面板沒開時，快捷鍵會打開並把鍵盤 focus 交給面板；開著但 focus 在別處時只把 focus 拿過來；focus 已在面板且就是那個 tab 時才收合，focus 回到原本的 pane。快捷鍵由 `ys-tabs` 接收，因為收合中的 mod 收不到命令；面板開著時再轉給 `ys-git` 判斷。
- Tree：所有 branch 的 commit graph。點短 hash 複製到剪貼簿，點其他位置在下方展開該 commit 的檔案與 diff，最上面那列 uncommitted 會跳到 Changes。
- Tree 上方的搜尋框會把清單縮到 hash、訊息第一行、作者或 branch 名稱符合的 commit，搜尋中不畫 graph 的線。面板有 focus 時按 `Ctrl+F` 跳到搜尋框，`Esc` 清除。每次改搜尋文字，結果會捲回第一筆；結束搜尋時，選取中的 commit 會捲到清單正中間。
- Changes：還沒 commit 的檔案與 diff。
- 標題列的「repo · branch」可以選一個 space 固定顯示，選 Follow focus 則跟著目前的 pane 走。這個選擇存在各台電腦自己的儲存區，不會跟著 repo 走。

## 注意事項

- OpenCode 不要用 `system` theme。Herdr 0.1.16 回報給程式的 16 色色盤是預設的深色那一套，`system` 會拿它畫出黑色面板。
- `ys-*` mod 是內建 mod 的複本，Herdr 更新時不會跟著更新；Herdr 升級後版面壞掉的話，從新版內建 mod 重新複製再套樣式。
- `ys-tabs` 裡的視窗按鈕圖示是 Windows 用的，其他系統上沒有驗證過。
- Git 面板開著時，視窗的最小化、最大化、關閉按鈕改由 `ys-git` 的標題列畫，`ys-tabs` 會把自己那組藏起來。
- Git 面板 diff 的藍底與紅底是照 Claude Code 的淺色色盲友善主題，寫死在 `ys-git/main.js` 開頭的 `ADD`、`ADD_BG`、`DEL`、`DEL_BG`；換 Claude Code 主題時要手動改。
- Git 面板 graph 的線條顏色抄自 `ys-spaces/main.js` 的 `MARK`，改其中一邊時另一邊要一起改。
- `ys-git` 借用內建 mod `workspace-chrome`、`changes`、`pane` 的圖示，Herdr 升級後若圖示消失，先檢查這三個內建 mod 的檔名有沒有變。

## 重新合併字型

需要 Node.js，以及 Roboto Mono 與中文字型的 `.ttf` 檔。

```
npm install fonteditor-core@2.4.1
node tools/merge.js <RobotoMono-Regular.ttf> <中文字型.ttf> <輸出.ttf> "Yuansui Mono" Regular
```

Medium 與 Bold 各跑一次，把最後一個參數與輸入的 Roboto Mono 檔換成對應字重。

## 授權

- Roboto Mono 採 Apache License 2.0，jf open 粉圓採 SIL Open Font License 1.1。
- `herdr-app/mods/` 內除了 `ys-git` 以外的程式碼改自 Herdr 內建的 mod，原始版權屬於 Herdr；`ys-git` 的 diff 讀取與顯示參考了內建的 `changes` mod。
