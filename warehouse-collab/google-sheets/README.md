# Google Sheets 作为扫码数据后端

当前状态：适配器和本地测试已完成，线上表格及绑定脚本也已准备。**Google 账号授权、Web 应用部署及正式数据迁移尚未完成，运行中的服务没有切换后端。**

## 工作方式

```text
扫码枪 / 手机
      ↓ 仓库同源 HTTPS
仓库电脑 Node.js 服务
      ↓ HTTPS + HMAC 签名
Google Apps Script
      ↓ 脚本锁 + 原子批量更新
Google Sheets：任务、成员、订单、操作记录
```

仓库电脑仍需要开机，并且可以访问 Google 服务。手机继续使用原仓库网址；不在手机保存 Google 密钥，不把共享表格开放给任何人编辑。Google Sheets 模式下不再把扫码写入 SQLite，也不会在云端断连时自动回退到本地，以免分裂成两份计数。

## 一、创建原生 Google Sheets

在 Codex 插件里连接 Google Drive。连接后，由 Google Drive 的电子表格导入功能将准备好的 `google-sheets/warehouse-schema.xlsx` 导入为原生 Google Sheets。

表内共有“使用说明”“任务”“成员”“订单”“操作记录”五个页签。表格不包含虚构订单或测试任务。不要改数据页名称、表头顺序，不要在数据区手工编辑或排序，不要删除操作记录。业务调整在扫码页面操作。表格中的操作 ID 用于重试去重，删除会破坏这一保障。

该表含业务记录和会话哈希，只需拥有者/管理员查看。扫码成员通过网页使用，不需要获得表格编辑权限。浏览器保存的原始会话令牌不会写入表格。

## 二、在此 Google Sheets 配置 Apps Script

创建表格后打开“扩展程序 → Apps Script”：

1. 将本目录 `Code.gs` 的内容放入脚本编辑器。
2. 在项目设置里显示 `appsscript.json` 清单，将本目录同名文件的内容放入。其启用高级 Google Sheets API；如果提示需要启用 Sheets API，在服务列表中添加 Google Sheets API。对于自定义 Google Cloud 项目，还需在该项目启用 Sheets API。
3. 在“项目设置 → 脚本属性”加入 `SPREADSHEET_ID`（表格网址 `/d/` 与 `/edit` 之间的 ID）和 `WAREHOUSE_SECRET`（随机生成的至少32字符密钥）。密钥只保存在此脚本属性和仓库电脑的配置文件中，不贴到聊天或放入 HTML。
4. 手动运行一次 `initializeWarehouse`，由拥有者授权此脚本访问 Google Sheets。该函数只验证表结构、设置文本格式并保存页签 ID，不创建新表。
5. 部署为网络应用，以拥有者身份执行。Node.js 的签名请求不带浏览器 Google 登录会话，因此应用入口需要允许匿名请求。接口仍会校验 HMAC 和时间戳，未签名请求不会读取表格。如组织策略禁止此部署方式，需要管理员批准或改用服务账号方案；不要将表格本身公开。
6. 保存部署完成返回的 `https://script.google.com/macros/s/部署ID/exec` 地址。

Google 账号授权及 Apps Script 部署需要账户拥有者完成或通过可用连接器授权；本交付尚未执行这些云端操作。脚本更新后请更新同一部署的版本，避免两份不同 Apps Script 项目同时写入同一表——不同项目的脚本锁不共享。

## 三、连接并迁移旧数据

先告知成员暂停扫码并停止仓库服务（关闭手动启动窗口，或停止 `WarehouseBoxCounter` 计划任务），再在仓库电脑 PowerShell 的程序目录运行。迁移前停止服务也确保旧版本进程不会绕过新增的迁移暂停逻辑。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\connect-google-sheets.ps1
```

脚本会交互询问应用地址和密钥，密钥输入不回显。它会：

1. 检查 Google 服务可用。
2. 取得本地数据库写锁后暂停本地写入。
3. 保存本地快照到 `data/before-google-sheets.json`。
4. 把任务、成员会话哈希、订单、操作记录作为一个原子批次导入空的云端表。
5. 核对各表行数，成功后写入 `data/google-sheets.json`，设置 `enabled:true`。

不要上传 data 目录到 GitHub。迁移保留原 SQLite 文件。原浏览器会话哈希也会迁移，所以成员无需因后端切换重建身份。

迁移完成后**重启仓库服务**。只有新服务启动并显示“数据后端：Google Sheets”之后，才解除本地提交暂停。现有进程不会静默切换数据源。

本迁移工具限制为单批 1.5 MB 的历史记录，以控制批次体积。超过限制会暂停而不会切换后端，需要另做分批迁移。迁移超时可以重跑相同脚本；目标若已经完整导入同一份快照，会识别为重复。目标有不同数据则拒绝覆盖。不要删除迁移锁后继续在两边录入。

## 四、累计与同步

- 一笔扫码采用一个唯一操作 ID。订单数量、任务版本和操作记录在同一 Google Sheets 原子批量更新中提交。
- 脚本锁串行处理读改写，避免两人同时对旧数量加一导致覆盖。此保障要求所有写入都通过同一脚本项目。
- 响应超时或 Google 服务错误时，页面保留原操作 ID，恢复后核对重试；不把未知结果当作未保存。
- 同一台仓库服务接收的成功操作会立即广播给成员；其他写入的同步轮询按任务合并，每10秒一次，不为每部手机各启动一组轮询。
- Google Sheets 存在调用配额和网络延迟，适合小规模、较低频率协作；它不是本地数据库同等吞吐量的替代。Google API 限流或 Google 服务不可达时会暂停提交。
- 不支持离线扫码，也不允许人工改表后继续依赖原来的版本/去重语义。预估与实际总数的人工调整请使用网页按钮。

## 五、验证范围

`npm test` 包含原 SQLite 测试及 Google Sheets 适配器测试。Google 测试使用模拟 Google Apps Script/Sheets 服务，覆盖签名认证、批次全成功或全失败、两位成员交错累计、丢失响应后的去重重试、修改冲突、归档权限、迁移暂停与重复导入核对。

**未在你的 Google 账号实测。** 在完成 Google 授权与部署后，仍需用两台设备验证新增一箱、重复请求、修改预估和服务重启，再正式切换。

官方机制说明：[Apps Script 脚本锁](https://developers.google.com/apps-script/reference/lock/lock-service)、[Google Sheets 原子批量更新](https://developers.google.com/workspace/sheets/api/guides/batchupdate)、[Apps Script 配额](https://developers.google.com/apps-script/guides/services/quotas)。
