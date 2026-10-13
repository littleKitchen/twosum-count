# Two Sum 每小时在线人数

用一张图显示 LeetCode 国际站 Two Sum 每小时的在线人数，时间固定为 PT。

静态页面在 `web/`，真实采样保存在 `web/data/history.json`，采集脚本在 `scripts/collect.mjs`。

采集失败不会写成 0，也不会使用当前人数补造过去的小时。每小时的第一次成功采样保留不变。

公开网页：https://littlekitchen.github.io/twosum-count/

当前通过采集电脑中正常打开的 Two Sum 浏览器页面读取真实人数，由每小时的 Codex 自动任务保存并推送到 GitHub。访问网页的人不需要安装软件或登录；历史数据保存在公开仓库中，采集电脑关闭时仍能查看已保存的历史。新增采样需要采集电脑、Codex 和浏览器保持运行。

GitHub Actions 云端采集实测受到 LeetCode 的安全验证拦截，尚未启用其每小时定时任务。`hourly.yml` 仅供手动验证，不承担当前采集。

每次推送后，`pages.yml` 将 `web/` 发布到 GitHub Pages。网页会自动检查更新；显示的每个点对应该小时实际成功采集的第一次人数，鼠标停在点上可查看实际采集时间。时区采用 `America/Los_Angeles`，自动处理夏令时。
