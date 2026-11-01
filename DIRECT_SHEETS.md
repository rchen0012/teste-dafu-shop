# Google Sheets 直连配置

正式结构为：

```text
GitHub Pages 扫码界面 → Google Apps Script → Google Sheets
```

无需本地 Node.js 服务、SQLite、局域网地址或自签名证书。已有云端数据继续使用，不清空或重复导入。

## 后端

已绑定的 Apps Script 项目包含 `warehouse-collab/google-sheets/Code.gs`。高级 Sheets API 和表格授权已完成。更新该文件后，在 Apps Script 的“部署 → 管理部署”中为同一部署选择“新版本”，保持接口地址不变。

`browserRequest` 是网页的业务入口，只接受 `ping/create/join/state/op/history`。表格内容访问仍须有效成员会话，管理员操作仍检查角色。`doPost` 的管理导入/健康检查保留 HMAC 签名验证，服务密钥只在脚本属性中，不能放进公开 JS。

`doGet` 提供轻量连接页。它允许嵌入，但只接受 `https://rchen0012.github.io` 发来的消息；每次页面加载使用随机通道编号校验应答。成员令牌在消息体里传递，不放进网址。

Google HTML 服务通过 `google.script.run` 调用后端，避免浏览器跨域预检和静态网站直接调用 Google OAuth API 的问题。摄像头继续运行在 GitHub Pages 顶层页面，使用该网站的标准 HTTPS。

更换网站域名时，须同步修改 `Code.gs` 中允许的来源；更换部署时，须更新 `assets/cloud-client.js` 中的公开接口地址。

## 部署前验证

测试目录中的浏览器接口用例验证：

- 不允许浏览器调用导入/管理接口。
- 无效会话不能读取表格数据。
- 两个成员分别扫码，数量合并累计。
- 相同操作 ID 重试不会重复加箱。
- 普通成员不能归档，归档后不能继续提交。

仍需通过正式 GitHub HTTPS 页面做双会话验收。不要把服务端密钥、数据库、证书或迁移快照上传到仓库。
