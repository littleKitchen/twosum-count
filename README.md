# Two Sum 每小时在线人数

用一张图显示 LeetCode 国际站 Two Sum 每小时的在线人数，时间固定为 PT。

静态页面在 `web/`，真实采样保存在 `web/data/history.json`，采集脚本在 `scripts/collect.mjs`。

采集失败不会写成 0，也不会使用当前人数补造过去的小时。每小时的第一次成功采样保留不变。

公开网页：https://littlekitchen.github.io/twosum-count/

访问网页的人不需要安装软件或登录；历史数据保存在公开仓库中。页面中已有两条从真实 Two Sum 浏览器页面读取的记录。

项目要求完全在云端每小时自动采集。GitHub Actions 的 Linux 云端采集实测受到 LeetCode 的安全验证拦截，尚未启用每小时定时任务，本机自动任务保持关闭。云端采集验证通过前，页面仅展示已保存的真实历史。`hourly.yml` 和 `source-probe.yml` 用于手动验证。

每次推送后，`pages.yml` 将 `web/` 发布到 GitHub Pages。网页会自动检查更新；显示的每个点对应该小时实际成功采集的第一次人数，鼠标停在点上可查看实际采集时间。时区采用 `America/Los_Angeles`，自动处理夏令时。
