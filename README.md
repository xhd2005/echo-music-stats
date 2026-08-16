<div align="center">

<img src="logo.png" alt="听歌统计" width="100" height="100" />

# 听歌统计

**本地化的 EchoMusic 听歌统计报告 —— 数据 100% 保存在本机，无任何上传**

[![release](https://img.shields.io/github/v/release/xhd2005/echo-music-stats?style=flat-square&color=31cfa1&label=release)](https://github.com/xhd2005/echo-music-stats/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](https://github.com/xhd2005/echo-music-stats/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/xhd2005/echo-music-stats?style=flat-square&color=31cfa1)](https://github.com/xhd2005/echo-music-stats/stargazers)
[![EchoMusic](https://img.shields.io/badge/EchoMusic-%E2%89%A52.2.7--beta.9-31cfa1?style=flat-square&logo=electron&logoColor=fff)](https://github.com/hoowhoami/EchoMusic)

</div>

一个 **本地优先** 的听歌数据统计插件：自动记录你在 EchoMusic 里的每一次播放，生成 **总时长 / Top 歌手 / Top 歌曲 / 时段分布 / 音源占比 / 年度报告** 等可视化，数据完全保存在本机，不接入任何第三方服务。

> EchoMusic 是多音源聚合播放器（网易 / QQ / 酷狗 / 酷我 / Spotify / Apple / 汽水 / 本地），本插件跨音源通用。

## ✨ 功能特性

- **🤫 静默采集**：启用后自动记录每次播放，无需任何操作；暂停不重置、seek 取最大进度、切歌即时结算上一首
- **🛡️ 去重可靠**：`track_id + started_at` 唯一索引兜底，同一首歌连续播放只记 1 条，无重复行
- **⚙️ 阈值可配**：默认实听 ≥ 30 秒才计入，可在设置中改为 10 / 30 / 60 / 120 秒
- **📅 时间范围**：全部 / 近 7 天 / 近 30 天 / 本月 / 今年，切换即时重查
- **📊 五类可视化**：趋势折线 / Top 歌手条形 / Top 歌曲列表 / 时段柱状 / 音源 donut，自绘内联 SVG，无外链、无 npm 依赖
- **🏆 年度报告**：选择「今年」时显示总时长 / 总次数 / 最爱歌手 / 最爱歌曲 / 最活跃月份 / 平均每天
- **🗑️ 一键清空**：设置面板二次确认后删除全部记录
- **🔒 隐私优先**：数据仅存本机插件目录，无任何网络上报

## 📦 安装

1. 打开 EchoMusic → 设置 → 插件管理
2. **方式一（推荐）**：插件市场 → 添加源 `https://github.com/xhd2005/echo-music-plugins` → 搜索「听歌统计」安装
3. **方式二**：下载 [最新 release](https://github.com/xhd2005/echo-music-stats/releases/latest) 的 zip，拖入插件管理页面的本地安装区
4. 在插件列表中找到本插件并打开启用开关

## 🚀 使用说明

| 操作 | 说明 |
|---|---|
| 查看报告 | 侧边栏「插件」分组 →「听歌统计」，或运行命令 `music-stats:open`（可绑定快捷键） |
| 切换范围 | 页面顶部点击 全部 / 近 7 天 / 近 30 天 / 本月 / 今年 |
| 年度报告 | 把时间范围切到「今年」即显示 |
| 插件设置 | 设置 → 插件管理 → 听歌统计 → 打开插件设置（开关 / 阈值 / 清空） |
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

## 📄 许可证

本项目基于 [GPL-3.0](LICENSE) 开源。

> 本插件为第三方社区作品，与 EchoMusic 官方无关；不收集、不上传任何用户数据，所有统计仅保存在本机插件目录。
