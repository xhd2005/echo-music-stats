<div align="center">

<img src="logo.png" alt="听歌统计" width="120" height="120" />

# 听歌统计

**本地化的 EchoMusic 听歌统计报告 —— 数据 100% 保存在本机，无任何上传**

[![release](https://img.shields.io/github/v/release/xhd2005/echo-music-stats?style=flat-square&color=31cfa1&label=release)](https://github.com/xhd2005/echo-music-stats/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](https://github.com/xhd2005/echo-music-stats/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/xhd2005/echo-music-stats?style=flat-square&color=31cfa1)](https://github.com/xhd2005/echo-music-stats/stargazers)
[![EchoMusic](https://img.shields.io/badge/EchoMusic-%E2%89%A52.2.7--beta.9-31cfa1?style=flat-square&logo=electron&logoColor=fff)](https://github.com/hoowhoami/EchoMusic)

</div>

一个 **本地优先** 的听歌数据统计插件：自动记录你在 EchoMusic 里的每一次播放，生成 **总时长 / Top 歌手 / Top 歌曲 / 时段分布 / 音源占比 / 年度报告** 等可视化，数据完全保存在本机，不接入任何第三方服务。

> EchoMusic 是多音源聚合播放器（酷狗 / 网易 / QQ / 酷我 / Spotify / Apple / 汽水 / 本地），本插件跨音源通用。

## ✨ 功能特性

- **🤫 静默采集**：启用后自动记录每次播放，无需任何操作；暂停不重置、seek 取最大进度、切歌即时结算上一首
- **🛡️ 去重可靠**：`track_id + started_at` 唯一索引兜底，同一首歌连续播放只记 1 条，无重复行
- **⚙️ 阈值可配**：默认实听 ≥ 30 秒才计入，可在设置中改为 10 / 30 / 60 / 120 秒
- **📅 时间范围**：全部 / 近 7 天 / 近 30 天 / 本月 / 今年，切换即时重查
- **🎯 完播与切歌分析**：精确识别歌曲完播（播放时长 ≥ 85%）与快速跳过（播放 < 15 秒即切歌），生成「最耐听单曲榜」与「最常跳过歌曲榜」
- **🔁 单曲循环与深夜专属**：自动挖掘单日循环次数最多的神曲，以及凌晨（02:00-05:00）最常聆听的夜间单曲
- **🎧 音质与音效画像**：分析 Hi-Res / SQ 无损 / HQ 高品质与蝰蛇音效（黑胶、纯净人声等）收听偏好
- **🟩 365 天听歌热力图**：GitHub 风格年度听歌活跃矩阵，直观呈现过去一年每日听歌足迹与深浅频次
- **⏰ 24 小时生物钟**：将一天划分为清晨、工作、黄昏、深夜四大时段，分析专属时段偏好与高峰时刻
- **🎖️ 听歌个性徽章**：内置 6 大趣味成就徽章（深夜哲学家、无损发烧友、百家争鸣、单曲循环狂、全天候乐迷、听歌达人）
- **📊 丰富可视化 & 指标**：总时长 / 完播率 / 去重统计 / 趋势折线 / Top 歌手条形 / Top 歌曲列表（点击直接播放） / 来源分布 donut，自绘内联 SVG，无外链依赖
- **🏆 年度报告**：选择「今年」时显示总时长 / 总次数 / 最爱歌手 / 最爱歌曲 / 最活跃月份 / 平均每天
- **💾 数据备份与多格式导出**：支持 JSON 完整备份导入导出、CSV 明细表格导出，并接入宿主系统级 `ctx.backups` 恢复机制
- **🌐 Scrobbler 云端互联**：支持配置 Webhook / ListenBrainz / Last.fm 兼容协议，曲目完播时自动同步打卡
- **🔒 隐私优先**：数据仅存本机插件目录，无任何网络上报

## 📦 安装

1. 打开 EchoMusic → 设置 → 插件管理
2. **方式一（推荐）**：插件市场 → 添加源 `https://github.com/xhd2005/echo-music-plugins` → 搜索「听歌统计」安装
3. **方式二**：下载 [最新 release](https://github.com/xhd2005/echo-music-stats/releases/latest) 的 zip，拖入插件管理页面的本地安装区
4. 在插件列表中找到本插件并打开启用开关

## 🚀 使用说明

| 操作 | 说明 |
|---|---|
| 查看报告 | 侧边栏「插件」分组 →「听歌统计」，或运行命令 `music-stats:open`（支持快捷键） |
| 切换范围 | 页面顶部点击 全部 / 近 7 天 / 近 30 天 / 本月 / 今年 / 自定义区间 |
| 榜单交互 | Top 歌曲、耐听榜、循环神曲支持直接点击图标或整行快速播放 |
| 年度报告 | 把时间范围切到「今年」即显示 |
| 插件设置 | 设置 → 插件管理 → 听歌统计 → 打开插件设置（开关 / 阈值 / Scrobbler / 导入导出 / 清空） |
| 页面路由 | `/main/plugin/music-stats/report` |



## 📐 计入规则

- 实听时长 `>= 最短计入时长`（默认 30 秒）→ 写入 1 条记录；低于阈值丢弃
- 暂停不重置、拖动进度不影响（取最大播放进度）
- 切换歌曲 / 停止播放 / 禁用插件 → 立即结算上一首
- `title` 或 `artist` 解析为空 → 跳过（如无歌手信息的本地文件）

## 🛠️ 技术栈

![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=000)
![Vue](https://img.shields.io/badge/Vue-3.x-4FC08D?style=flat-square&logo=vuedotjs&logoColor=fff)
![SQLite](https://img.shields.io/badge/SQLite-local-003B57?style=flat-square&logo=sqlite&logoColor=fff)
![Electron](https://img.shields.io/badge/Electron-runtime-47848F?style=flat-square&logo=electron&logoColor=fff)

- **单文件 ESM 插件**，无 npm 依赖、无外链 CDN（宿主 CSP 禁止外链资源）
- 采集事件 `ctx.events.onTrackChange` + `ctx.events.onTimeUpdate`；落库走宿主 `ctx.sqlite` 沙箱
- 图表为自绘 SVG（折线 / 条形 / 柱状 / donut），遵循「单序列主色、图例标注、文本用文字色」的可视化规范
- 明暗主题随宿主 CSS 变量自适应，样式以 `.mst-` 前缀隔离

## ❓ 常见问题

- **报告为空**：确认已开启「启用统计」，且播放时长达到最短计入时长；统计只覆盖启用之后发生的播放
- **时长和实际不符**：统计的是「实听时长」（播放进度推进量），暂停期间不计入，与歌曲本身完整时长无关
- **音源占比里的「在线曲库」**：宿主对在线歌曲的 `source` 字段为空、云盘/本地为 `cloud`，插件据此归类；在线曲库不区分具体平台
- **清空后无法恢复**：清空为不可逆操作，请谨慎确认
- **卸载后数据丢失**：卸载插件会同时删除本机统计数据库（数据无法找回），卸载前请先在设置面板「数据备份」里导出

## 🔧 更新日志

- **v1.2.2**（2026-09-22）：365天热力图美化（当前连续打卡/最长连胜指标与即指即显实时检视条）、Top 歌曲榜单对称滚动容器（自适应限高并对齐 Top 10 歌手高度）。
- **v1.2.1**（2026-09-22）：UI/UX 全景视觉重构与布局美化：毛玻璃质感页头与隐私安全徽标、iOS/Fluent 分段选择器、自适应 6 列 KPI 仪表板与完播/跳过可视化进度槽、单曲循环与深夜专属双高亮卡、金银铜牌榜单色标与试听交互动效。
- **v1.2.0**（2026-09-22）：新增 365 天 GitHub 风格活跃度热力图、24 小时音乐生物钟、6 大听歌成就徽章、音质与音效画像分布、CSV 导出、系统级 `ctx.backups` 支持与 Scrobbler 同步拓展。
- **v1.1.0**（2026-09-22）：新增完播率与切歌统计（数据库平滑迁移至 v2）、Top 歌曲榜单支持点击直达播放、KPI 卡片增加完播率指标
- **v1.0.2**（2026-08-18）：页面紧凑化（卡片两两并排）、趋势图按时间范围切换粒度、新增数据导出 / 导入备份
- **v1.0.1**（2026-08-17）：修复迁移 SQL 缺分号导致建表失败、报告页「读取统计失败」；更换插件图标
- **v1.0.0**（2026-08-16）：首个版本 —— 播放采集 + 设置面板 + 统计报告页 + 年度报告

## 📄 许可证

本项目基于 [GPL-3.0](LICENSE) 开源。

> 本插件为第三方社区作品，与 EchoMusic 官方无关；不收集、不上传任何用户数据，所有统计仅保存在本机插件目录。
