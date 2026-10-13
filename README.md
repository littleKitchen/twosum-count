# Two Sum 每小时在线人数

公开网页：**https://littlekitchen.github.io/twosum-count/**

网页只有一张人数图。GitHub 云端每小时采集 LeetCode 国际站 Two Sum 的在线人数，保存到公开仓库，再发布到 GitHub Pages。访问者无需登录或安装软件，时间统一显示为 **PT**（`America/Los_Angeles`，自动处理夏令时）。

采集完全由 GitHub Actions 运行，不依赖本机、Codex、打开的浏览器或第三方付费服务。使用 `curl_cffi==0.16.3` 的标准 WebSocket 传输读取 LeetCode 官方人数服务 `wss://collaboration-ws.leetcode.com/problems/two-sum`；只接受本次连接收到的数字消息，采集时间在收到消息时记录。

[首次真实云端验证](https://github.com/littleKitchen/twosum-count/actions/runs/38460889438)在 2026-10-13 13:12:03 PT 读到 **713 人**。此前的普通云端浏览器连接失败；这些失败不会写为零，也不会补造历史。

- `hourly.yml`：每小时第 17 分钟采集，保存 `web/data/history.json`，并在同一工作流发布更新后的网页。GitHub 定时任务可能延迟，点的提示显示实际采集时间。
- `pages.yml`：代码推送后发布静态网页。
- `source-probe.yml`：手动验证一次全新数据源连接，不读取或修改历史。
- `scripts/collect.mjs`：每小时第一次成功采样保留不变；采集失败保留原始数据，没有采样的小时留空。

网页每分钟检查已经发布的历史数据，并自动显示新点。全部历史保存在公开仓库，横向滚动可以查看更早的小时。

本地可以运行 `npm ci` 和 `npm test` 检查数据保存和接口验证逻辑。真实数据源读取仅允许在 GitHub Actions 中执行。无需 API key、TinyFish 或本机定时任务。
