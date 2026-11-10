# Discord 音樂機器人

這是用 Node.js 和 discord.js 製作的 Bot。可以從 Windows、macOS 或 Linux 啟動。上線後在 Discord 伺服器用 `/music` 操作。

## 第一次啟動

1. 安裝 [Node.js](https://nodejs.org/en/download) 24.17 或更新版本，解壓縮專案，然後在含有 `package.json` 的資料夾開啟終端機。語音套件的開發版需要這個版本的 Node.js。
2. 到 [Discord Developer Portal](https://discord.com/developers/applications) 建立或選擇應用程式，在 **Bot** 頁面複製 **Bot Token**。請把 Token 留在自己的電腦。
3. 在終端機執行以下指令。第一次執行 `npm start` 時，貼上 Token 後按 Enter。輸入過程不會顯示 Token，登入後會存到專案的 `.env`。

   ```sh
   npm ci
   npm start
   ```

4. 看到「已上線」後，開啟終端機印出的邀請連結，選擇你有「管理伺服器」權限的伺服器並授權。Bot 會自動註冊 `/music`。如果開發者後台關閉了伺服器安裝，請先在 **Installation** 啟用 **Guild Install**。邀請所需的範圍是 `bot` 與 `applications.commands`。
5. 加入伺服器的一般語音頻道。完成下方的 YouTube 設定後，在文字頻道輸入 `/music play`，選擇 `url` 並貼上影片連結。Bot 需要該語音頻道的「檢視頻道」、「連線」和「說話」權限。

下次在同一個專案資料夾執行 `npm start` 即可。按 Ctrl+C 可關閉 Bot。Bot 只在程式持續執行、主機保持連線時上線。

## 播放 YouTube 影片

1. 在專案資料夾執行一次 `npm run setup:youtube`。這會從官方 GitHub 發行版下載適合主機的 yt-dlp，驗證 SHA-256 後放到專案的 `.tools`。
2. 啟動或重啟 Bot，等終端機顯示該伺服器的 `/music` 已就緒。
3. 進入語音頻道，選 `/music play` 的 `url` 欄位，貼上公開 YouTube 影片的網址即可。支援 `youtube.com/watch?v=…`、`youtu.be/…` 和 Shorts 連結。若網址附有播放清單參數，只會加入連結指向的單一影片。

如果多個公開影片突然無法播放，可以重跑 `npm run setup:youtube` 更新工具。影片需可在主機所在網路播放，直播、需登入或受地區限制的影片可能無法使用。若主機的架構無法使用內建安裝指令，可依 [yt-dlp 官方安裝指南](https://github.com/yt-dlp/yt-dlp/wiki/Installation) 安裝含 EJS 的版本，讓 `yt-dlp` 可從 PATH 執行，或用 `.env` 的 `YTDLP_PATH` 指定執行檔。

## Discord 指令

| 指令 | 用途 |
| --- | --- |
| `/music play` | 在 `url` 貼上 YouTube 影片連結或公開 HTTPS 音檔直連。也可以用 `file` 上傳音檔。已有歌曲播放時，加入佇列。 |
| `/music queue` | 顯示目前歌曲及待播放清單。 |
| `/music pause` / `/music resume` | 暫停或繼續播放。 |
| `/music skip` | 跳過目前歌曲。 |
| `/music stop` | 停止播放、清空佇列並離開。 |

可使用 MP3、WAV 等音檔。每首上限 100 MB、播放 30 分鐘。音檔直連需提供公開 IPv4 和 HTTPS。每個伺服器有自己的佇列，播完會自動離開語音頻道。

## 檢查與部署

- 從舊版更新時，先用 Ctrl+C 停止 Bot，再把新版專案檔案複製到原資料夾並保留 `.env`。更新 Node.js 後重新開啟 VS Code，執行 `npm ci` 再執行 `npm start`。
- `npm run check` 可檢查程式語法與 FFmpeg 的 Opus 編碼，無需 Token。
- 如果系統無法下載套件提供的 FFmpeg，可安裝含 `libopus` 的 FFmpeg，讓 `ffmpeg` 可從 PATH 執行，或在 `.env` 增加 `FFMPEG_PATH` 並填入執行檔路徑。
- 如果 PowerShell 擋下 `npm.ps1`，可用 `npm.cmd` 取代指令裡的 `npm`。
- 若要長期上線，可把相同專案放到能持續執行 Node.js 且可連到 Discord 語音服務的主機。把 `DISCORD_TOKEN` 設在主機的環境變數，安裝指令用 `npm ci`，啟動指令用 `npm start`。
- 若重設了 Token，請更新 `.env` 裡的 `DISCORD_TOKEN`（或更新主機的環境變數）後重啟。請勿上傳 `.env`。

[Discord 應用程式指令文件](https://docs.discord.com/developers/docs/interactions/slash-commands) · [discord.js 語音文件](https://discordjs.guide/voice)
