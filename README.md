# Two Sum 每小时在线人数

用一张图显示 LeetCode 国际站 Two Sum 每小时的在线人数，时间固定为 PT。

静态页面在 `web/`，真实采样保存在 `web/data/history.json`，采集脚本在 `scripts/collect.mjs`。

采集失败不会写成 0，也不会使用当前人数补造过去的小时。每小时的第一次成功采样保留不变。

公开网页：https://littlekitchen.github.io/twosum-count/

访问网页的人不需要安装软件或登录；历史数据保存在公开仓库中。页面中已有两条从真实 Two Sum 浏览器页面读取的记录。

项目要求完全在云端每小时自动采集。GitHub Actions 的 Linux 云端采集实测受到 LeetCode 的安全验证拦截，尚未启用每小时定时任务，本机自动任务保持关闭。云端采集验证通过前，页面仅展示已保存的真实历史。`hourly.yml` 和 `source-probe.yml` 用于手动验证。

2026-10-13 的真实云端验证均未获得人数：Linux、Windows、macOS 的普通 Chromium，以及 macOS 正式 Google Chrome 均返回 HTTP 403 / Cloudflare 安全验证。验证直接请求新的源数据，不会因为本小时已经保存过记录而跳过。可查看 [Linux 验证](https://github.com/littleKitchen/twosum-count/actions/runs/38449893722)、[Windows 验证](https://github.com/littleKitchen/twosum-count/actions/runs/38452214570/job/115485730046)、[macOS Chromium 验证](https://github.com/littleKitchen/twosum-count/actions/runs/38452973392)、[Google Chrome 验证](https://github.com/littleKitchen/twosum-count/actions/runs/38453348029)。自动采集尚未打通，项目目前未满足完整需求。

每次推送后，`pages.yml` 将 `web/` 发布到 GitHub Pages。网页会自动检查更新；显示的每个点对应该小时实际成功采集的第一次人数，鼠标停在点上可查看实际采集时间。时区采用 `America/Los_Angeles`，自动处理夏令时。

备用云端浏览器接入已经实现，但未进行服务调用、未启用付费或定时任务。授权后可将自己的 TinyFish API key 保存为本仓库加密的 Actions Secret `TINYFISH_API_KEY`，手动运行 `source-probe.yml` 并选择 `tinyfish` 进行真实验证。密钥不会写入公开源码，日志不会输出密钥或浏览器连接凭证。采集要求可见人数与十秒内收到的官方数字数据一致；采样时间在读取成功时记录，关闭浏览器的耗时不会移动样本所属小时。仅在真实云端验证成功后启用按小时采集。服务接口：[TinyFish Browser API](https://docs.tinyfish.ai/browser-api)。
