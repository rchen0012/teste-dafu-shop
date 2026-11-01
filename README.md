# 订单箱数核验

根目录 `index.html` 为当前 GitHub Pages 单机页面。

## 仓库多人协作版

完整程序位于 [`warehouse-collab/`](warehouse-collab/README.md)，支持扫码枪与手机摄像头、同一任务多人共享累计、操作记录、数量修改冲突检查、归档及 CSV 导出。

```text
手机 / 扫码枪设备 → 仓库电脑 Node.js 服务 → SQLite 或 Google Sheets
```

每扫描一次完整的8位订单号，实际箱数加一。Google Sheets 模式通过签名请求、Apps Script 脚本锁和原子批量更新处理累计及去重。

### 在仓库电脑运行

1. 安装 Node.js 24 或更新版本。
2. 下载此仓库，进入 `warehouse-collab`。
3. 双击 `start.cmd`，按启动窗口给出的内网地址访问。
4. 手机摄像头需要受信任的 HTTPS，参见[部署说明](warehouse-collab/README.md)。

无需 `npm install`。扫码库已随程序保存，保留其许可证。

### Google Sheets 后端

[配置说明和部署步骤](warehouse-collab/google-sheets/README.md)，[数据表结构模板](warehouse-collab/google-sheets/warehouse-schema.xlsx)。

云端表格和绑定脚本已准备，但 Google 账户授权、Apps Script Web 应用部署和正式数据迁移尚未完成。代码同步不代表在线协作已启用。

GitHub Pages 只托管静态页面，不能直接运行 Node.js 或 Apps Script。根目录首页保留现有行为；多人协作需访问实际运行服务的地址。

## 验证

```sh
cd warehouse-collab
npm test
```

Google Sheets 相关测试使用模拟服务，仍需在真实 Google 部署后进行双设备验收。

## 本地运行数据

仓库不包含数据库、操作备份、HTTPS 私钥或 Google 服务密钥。`data/` 和 `certs/` 仅保存在部署电脑，不应提交到 Git。
