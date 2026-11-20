# 小账本

一个只给自己用的轻量安卓记账 App。数据全部保存在手机本地，不需要账号，也不联网上传。

## 功能

- 记收入和支出：金额、货币、分类、支付方式（收款方式）、日期、备注
- 分类和支付方式可自定义，长按可删除
- 选中分类后显示该分类的常用金额和历史备注，点一下即可填入
- 多货币（EUR、USD、CNY、GBP、JPY、HKD、CHF）
- 账单按日期分组，可编辑、删除，可按关键词搜索
- 月度汇总：各货币收支，以及折算成主要货币的总额，另有分类和方式占比、全年每月表格
- 折算按每笔记账当天的汇率（欧洲央行历史汇率），取不到时用备用汇率
- CSV 导出和导入，用于备份和换手机
- 邮箱验证码登录和云端同步，多设备共用、换手机不丢
- App 内检查更新

## 安装

1. 打开本仓库的 **Releases** 页面，下载最新的 `xiaozhangben.apk`。
2. 在安卓手机上打开安装包，按提示允许"安装未知来源应用"。
3. 以后 App 会在打开时检查新版本，也可以点页面里的「检查更新」。发现新版本后下载并点开安装包即可覆盖安装，数据会保留。

## 数据与备份

- 数据先保存在手机本地，离线也能记账。登录账号后会同步到云端，卸载 App 或换手机后重新登录即可恢复。
- 没有登录时，卸载 App 或清除 App 数据会丢失，建议登录，或定期点「导出 CSV」备份。

## 云端同步的结构

- 后端在 `backend/`：Cloudflare Workers（接口）加 D1（数据库），邮件验证码通过 Resend 发送，发件域名为 `ledger.lofla.at`。
- 每个账号的数据互相隔离。冲突时以每条记录最后一次修改为准，删除用标记同步。
- 推送到 `main` 且修改了 `backend/` 后，GitHub Actions 自动部署后端，需要的 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`RESEND_API_KEY`。
- Cloudflare API 令牌设有有效期，到期前需要重新创建并更新 GitHub Secret，否则只影响自动部署，不影响已运行的后端。

## 开发说明

- 页面是单个文件 `www/index.html`，用 Capacitor 打包成安卓 App。
- 推送代码到 `main` 分支后，GitHub Actions 会自动构建签名的 APK，并以 `v构建号` 发布到 Releases。只修改 `.md` 文件不会触发构建。
- 构建需要在仓库 Settings → Secrets and variables → Actions 中配置：`KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`。
- 签名密钥文件（`.jks`）和密码不要上传到仓库，请单独备份。丢失后将无法覆盖更新，只能卸载重装。
- 版本号取自构建序号，App 通过对比 Releases 里最新版本号来判断是否有更新。
