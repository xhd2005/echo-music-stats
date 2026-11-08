<div align="center">

<img src="logo.png" alt="听歌统计" width="120" height="120" />

# 听歌统计

**本地化的 EchoMusic 听歌统计报告 —— 数据 100% 保存在本机，支持多账号隔离与原生目录导出**

[![release](https://img.shields.io/github/v/release/xhd2005/echo-music-stats?style=flat-square&color=31cfa1&label=release)](https://github.com/xhd2005/echo-music-stats/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](https://github.com/xhd2005/echo-music-stats/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/xhd2005/echo-music-stats?style=flat-square&color=31cfa1)](https://github.com/xhd2005/echo-music-stats/stargazers)
[![EchoMusic](https://img.shields.io/badge/EchoMusic-%E2%89%A52.2.7--beta.9%20%7C%20v2.3.3-31cfa1?style=flat-square&logo=electron&logoColor=fff)](https://github.com/hoowhoami/EchoMusic)

</div>

一个 **本地优先** 的听歌数据统计插件：自动记录你在 EchoMusic 里的每一次播放，生成 **总时长 / Top 歌手 / Top 歌曲 / 时段分布 / 音源占比 / 年度报告** 等可视化，数据完全保存在本机，不接入任何第三方服务。

## ✨ 功能特性

- **👤 多账号数据隔离与视图切换**：SQLite `plays` 表支持 `user_id` 字段隔离（旧版无账号历史数据升级后自动无损归属当前账号），报告页顶部支持一键切换「当前账号 / 全部账号」统计视图
- **📁 原生目录授权直接导出**：JSON / CSV 导出优先通过 `ctx.fs.requestDirectory` + `ctx.fs.writeFile` 直接写入选定本地目录（不支持时自动回退浏览器下载）
- **🤫 静默采集**：启用后自动记录每次播放，无需任何操作；暂停不重置、seek 取最大进度、切歌即时结算上一首
- **🛡️ 去重可靠**：`track_id + started_at` 唯一索引兜底，同一首歌连续播放只记 1 条，无重复行
- **⚙️ 阈值可配**：默认实听 ≥ 30 秒才计入，可在设置中改为 10 / 30 / 60 / 120 秒
- **🎯 完播与切歌分析**：精确识别歌曲完播（播放时长 ≥ 85%）与快速跳过（播放 < 15 秒即切歌），生成「最耐听单曲榜」与「最常跳过歌曲榜」
- **🔁 单曲循环与深夜专属**：自动挖掘单日循环次数最多的神曲，以及凌晨最常聆听的夜间单曲
- **🎧 音质与音效画像**：分析 Hi-Res / SQ 无损 / HQ 高品质与蝰蛇音效收听偏好
- **🟩 365 天听歌热力图**：GitHub 风格年度听歌活跃矩阵，直观呈现过去一年每日听歌足迹与深浅频次
- **⏰ 24 小时生物钟**：将一天划分为清晨、工作、黄昏、深夜四大时段，分析专属时段偏好与高峰时刻
- **🎖️ 听歌个性徽章**：内置 6 大趣味成就徽章（深夜哲学家、无损发烧友、百家争鸣、单曲循环狂、全天候乐迷、听歌达人）
- **💾 宿主系统备份原生集成**：与 EchoMusic 宿主 `ctx.backups` 无缝协同，系统备份自动打包本插件 SQLite 数据库与设置

## 📦 安装

需要 EchoMusic **>= 2.2.7-beta.9**（完全适配最新 **v2.3.2 / v2.3.3-beta.1**）。

1. 打开 EchoMusic → 设置 → 插件管理
2. **方式一（推荐）**：插件市场 → 添加源 `https://github.com/xhd2005/echo-music-plugins` → 搜索「听歌统计」安装
3. **方式二**：下载 [最新 release](https://github.com/xhd2005/echo-music-stats/releases/latest) 的 zip，拖入插件管理页面的本地安装区
4. 在插件列表中找到本插件并打开启用开关

## 🔧 更新日志

- **v1.4.0**（2026-11-08）：全面适配 EchoMusic `v2.3.2` / `v2.3.3-beta.1`；修正 `manifest.json` 的 `localFiles` 权限声明；新增 SQLite `plays` 表 v4 迁移（`user_id` 字段与联合索引），实现真正的多账号听歌记录隔离、旧版历史数据自动无损归属以及报告页「当前账号 / 全部账号」一键切换；接入 `ctx.fs.requestDirectory` + `ctx.fs.writeFile` 原生目录直接导出 JSON/CSV（带浏览器下载兜底）；移除污染宿主备份设置面板的空壳 `registerProvider`。
- **v1.3.0**（2026-10-18）：全量剔除 Emoji 规范：365天热力图、24小时生物钟、6大成就勋章全面重塑为哑光金属质感徽标与矢量符号。
- **v1.2.2**（2026-09-22）：365天热力图美化与 Top 歌曲榜单对称滚动容器。
- **v1.2.0**（2026-09-22）：新增 365 天 GitHub 风格活跃度热力图、24 小时音乐生物钟、6 大听歌成就徽章、音质与音效画像分布、CSV 导出与 Scrobbler 同步拓展。
- **v1.1.0**（2026-09-22）：新增完播率与切歌统计（数据库平滑迁移至 v2）、Top 歌曲榜单支持点击直达播放。
- **v1.0.0**（2026-08-16）：首个版本 —— 播放采集 + 设置面板 + 统计报告页 + 年度报告。

## 📄 许可证

本项目基于 [GPL-3.0](LICENSE) 开源。
