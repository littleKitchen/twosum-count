# Two Sum 每小时在线人数

用一张图显示 LeetCode 国际站 Two Sum 每小时的在线人数，时间固定为 PT。

静态页面在 `web/`，真实采样保存在 `web/data/history.json`，采集脚本在 `scripts/collect.mjs`。

采集失败不会写成 0，也不会使用当前人数补造过去的小时。每小时的第一次成功采样保留不变。

云端采集正在验证；验证到 GitHub Actions 能获取真实人数后，再启用定时采集并发布 GitHub Pages。
