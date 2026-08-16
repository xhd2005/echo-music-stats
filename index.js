// 听歌统计插件
// 本地化的听歌数据统计：静默记录每一次播放（SQLite 落库），生成
// 总时长 / Top 歌手 / Top 歌曲 / 时段分布 / 音源占比 / 年度报告 可视化。
// 数据 100% 保存在本机插件目录，无任何网络上报。
//
// 入口：
// - 侧边栏「插件」分组 → 听歌统计（路由 /main/plugin/music-stats/report）
// - 插件设置项（设置 → 插件管理 → 本插件）：启用开关 / 最短计入时长 / 清空数据
// - 命令 music-stats:open（可在快捷键设置中绑定）
//
// 采集规则（单条可配、简单可预期）：
// - 实听时长 played_ms >= minListenSeconds（默认 30s）才计入；低于阈值丢弃
// - 去重：track_id + started_at 唯一索引兜底，同一首歌连续播放只记 1 条
// - 暂停不重置、seek 取最大进度、切歌/停用立即结算上一首
// - title 或 artist 解析为空 → 跳过（如无歌手信息的本地文件）

// ---- 常量与默认配置 ----

const DB_NAME = 'plays';
const DEFAULT_MIN_SECONDS = 30;
const MIN_SECONDS_OPTIONS = [10, 30, 60, 120];
const DAY_MS = 86400000;
const MAX_SAFE_MS = 9007199254740991; // 用于「全部」时间范围的上界

const MIGRATIONS = [
  {
    version: 1,
    sql: [
      `CREATE TABLE IF NOT EXISTS plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL,
        title  TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        album  TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        played_ms INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        day   TEXT NOT NULL,
        month TEXT NOT NULL,
        hour  INTEGER NOT NULL,
        weekday INTEGER NOT NULL
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_plays_once ON plays(track_id, started_at);`,
      `CREATE INDEX IF NOT EXISTS idx_plays_month ON plays(month);`,
      `CREATE INDEX IF NOT EXISTS idx_plays_day ON plays(day);`,
    ],
  },
];

// 时间范围（默认「本月」）
const RANGE_OPTIONS = [
  { key: 'month', label: '本月' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'year', label: '今年' },
  { key: 'all', label: '全部' },
];

// ---- 模块级运行状态 ----

let db = null; // 打开的 sqlite 句柄（open 失败时保持 null，采集/查询降级跳过）
let settings = { enabled: true, minListenSeconds: DEFAULT_MIN_SECONDS };
let current = null; // 当前正在监听的曲目 { trackId,title,artist,album,source,duration,startedAt,maxMs }
let disposeAll = null;

// ---- 工具函数 ----

const pad = (n) => String(n).padStart(2, '0');

const formatDay = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// 毫秒 → 紧凑时长文案：<1h 显示「N 分钟」，否则「X 小时」或「X 小时 Y 分」
const formatMsShort = (ms) => {
  const totalMin = Math.max(0, Math.round(Number(ms || 0) / 60000));
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
};

// 时间范围 key → [startMs, endMs)（本地时区午夜对齐，保证 day/month 分组干净）
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const getRangeMs = (key) => {
  const today = startOfToday();
  if (key === '7d') return { start: today - 6 * DAY_MS, end: today + DAY_MS };
  if (key === '30d') return { start: today - 29 * DAY_MS, end: today + DAY_MS };
  const now = new Date();
  if (key === 'month') {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
    };
  }
  if (key === 'year') {
    return {
      start: new Date(now.getFullYear(), 0, 1).getTime(),
      end: new Date(now.getFullYear() + 1, 0, 1).getTime(),
    };
  }
  return { start: 0, end: MAX_SAFE_MS };
};

// ---- 元数据解析（与宿主 Song 模型对齐） ----

// 返回落库所需字段；title/artist/trackId 任一为空则返回 null（跳过规则）
const songToMeta = (song) => {
  if (!song) return null;
  const title = String(song.title ?? song.name ?? '').trim();
  const artist = String(
    song.artist || song.artists?.[0]?.name || song.singers?.[0]?.name || '',
  ).trim();
  const trackId = String(song.id ?? '').trim();
  if (!title || !artist || !trackId) return null;
  return {
    trackId,
    title,
    artist,
    album: String(song.albumName ?? song.album ?? '').trim(),
    source: String(song.source ?? '').trim(),
    duration: Number(song.duration) || 0,
  };
};

// ---- 落库 ----

const insertPlay = async (meta) => {
  if (!db || !meta) return;
  const date = new Date(meta.startedAt);
  const day = formatDay(date);
  const res = await db.run(
    `INSERT OR IGNORE INTO plays
      (track_id, title, artist, album, source, duration, played_ms, started_at, day, month, hour, weekday)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.trackId,
      meta.title,
      meta.artist,
      meta.album,
      meta.source,
      meta.duration,
      meta.playedMs,
      meta.startedAt,
      day,
      day.slice(0, 7),
      date.getHours(),
      date.getDay(),
    ],
  );
  if (!res.ok) console.warn('[music-stats] 写入播放记录失败:', res.error);
};

// ---- 采集引擎 ----

// 结算上一首：满足阈值且启用才落库；否则丢弃
const settleCurrent = async () => {
  if (!current) return;
  const rec = current;
  current = null;
  if (settings.enabled && rec.maxMs >= settings.minListenSeconds * 1000) {
    try {
      await insertPlay({ ...rec, playedMs: rec.maxMs });
    } catch (error) {
      console.warn('[music-stats] 结算播放记录异常:', error);
    }
  }
};

const onTrackChange = (track) => {
  const meta = songToMeta(track);
  const trackId = meta ? meta.trackId : null;
  // 同一首歌的深层字段变化（封面/音频地址解析）会触发 deep watch，用 id 去抖
  if (current && current.trackId === trackId) return;
  void settleCurrent();
  current = meta && settings.enabled ? { ...meta, startedAt: Date.now(), maxMs: 0 } : null;
};

const onTimeUpdate = (payload) => {
  if (!current || !payload) return;
  if (payload.trackId != null && String(payload.trackId) !== String(current.trackId)) return;
  let ms = Math.max(0, Math.floor((payload.currentTime ?? 0) * 1000));
  // 时长已知时夹紧，避免 seek 越界产生虚高时长
  if (current.duration > 0) ms = Math.min(ms, current.duration * 1000);
  if (ms > current.maxMs) current.maxMs = ms;
};

// ---- SQL 查询 ----

const QUERY_KPI = `SELECT COUNT(*) AS n, COALESCE(SUM(played_ms), 0) AS ms,
  COUNT(DISTINCT title || '|' || artist) AS songs,
  COUNT(DISTINCT artist) AS artists
  FROM plays WHERE started_at >= ? AND started_at < ?`;

const QUERY_TOP_ARTISTS = `SELECT artist, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY artist ORDER BY ms DESC LIMIT 10`;

const QUERY_TOP_SONGS = `SELECT title, artist, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist ORDER BY plays DESC LIMIT 20`;

const QUERY_TREND = `SELECT day, SUM(played_ms) AS ms, COUNT(*) AS plays
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY day ORDER BY day`;

const QUERY_HOURS = `SELECT hour, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY hour ORDER BY hour`;

const QUERY_SOURCES = `SELECT source, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY source ORDER BY plays DESC`;

const runQuery = async (dbHandle, sql, params) => {
  const res = await dbHandle.all(sql, params);
  if (!res.ok) throw new Error(res.error || '查询失败');
  return res.rows || [];
};

const queryReport = async (dbHandle, range) => {
  const params = [range.start, range.end];
  const [kpiRows, topArtists, topSongs, trend, hours, sources] = await Promise.all([
    runQuery(dbHandle, QUERY_KPI, params),
    runQuery(dbHandle, QUERY_TOP_ARTISTS, params),
    runQuery(dbHandle, QUERY_TOP_SONGS, params),
    runQuery(dbHandle, QUERY_TREND, params),
    runQuery(dbHandle, QUERY_HOURS, params),
    runQuery(dbHandle, QUERY_SOURCES, params),
  ]);
  return { kpi: kpiRows[0] || null, topArtists, topSongs, trend, hours, sources };
};

// ---- 音源标签与配色（实体 → 固定色，不随排名变化） ----

const SOURCE_LABELS = {
  '': '在线曲库',
  cloud: '本地/云盘',
  plugin: '插件音源',
};
const SOURCE_COLORS = {
  在线曲库: '#31cfa1',
  '本地/云盘': '#4E79A7',
  插件音源: '#B07AA1',
};
const FALLBACK_COLOR = '#9CA3AF';

const sourceLabel = (raw) => SOURCE_LABELS[raw] ?? (raw ? raw : '在线曲库');
const sourceColor = (label) => SOURCE_COLORS[label] ?? FALLBACK_COLOR;

// ---- 年度报告派生数据 ----

const daysElapsedThisYear = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.max(1, Math.floor((startOfToday() - start.getTime()) / DAY_MS) + 1);
};

const mostActiveMonth = (trend) => {
  const map = new Map();
  for (const row of trend) {
    const month = String(row.day || '').slice(0, 7);
    if (!month) continue;
    map.set(month, (map.get(month) || 0) + (Number(row.ms) || 0));
  }
  let best = null;
  for (const [month, ms] of map) {
    if (!best || ms > best.ms) best = { month, ms };
  }
  return best;
};

// ---- 样式（插件 CSS 全局生效，严格 .mst- 前缀，仅用宿主 CSS 变量） ----

const CSS = `
.mst-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.mst-page {
  display: flex;
  flex-direction: column;
  padding: 0 32px 40px;
  gap: 20px;
}

.mst-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 20px;
}

.mst-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.mst-header-icon {
  color: var(--color-primary, #31cfa1);
  flex-shrink: 0;
}

.mst-title {
  margin: 0;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: -0.02em;
  color: var(--color-text-main, #f8fafc);
}

.mst-subtitle {
  margin: 2px 0 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

/* 时间范围筛选条 + 刷新 */
.mst-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mst-chip {
  border: 1px solid var(--control-border, rgba(148, 163, 184, 0.2));
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.1));
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s;
}

.mst-chip:hover {
  background: var(--control-hover-bg, rgba(148, 163, 184, 0.16));
}

.mst-chip-active {
  border-color: var(--color-primary, #31cfa1);
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 16%, transparent);
  color: var(--color-primary, #31cfa1);
}

.mst-refresh {
  margin-left: auto;
}

/* KPI 卡片 */
.mst-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.mst-kpi {
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.16));
  border-radius: 18px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.08));
  padding: 16px 18px;
  min-width: 0;
}

.mst-kpi-value {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: -0.02em;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-kpi-label {
  margin-top: 4px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

/* 通用卡片 */
.mst-card {
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.16));
  border-radius: 18px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.08));
  padding: 18px;
  min-width: 0;
}

.mst-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 900;
  color: var(--color-text-main, #f8fafc);
}

.mst-card-title-icon {
  color: var(--color-primary, #31cfa1);
  flex-shrink: 0;
}

.mst-card-sub {
  margin: 0 0 14px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

.mst-chart-scroll {
  overflow-x: auto;
}

.mst-chart-scroll svg {
  display: block;
  min-width: 480px;
}

/* 年度报告高亮卡 */
.mst-annual {
  border: 1px solid color-mix(in srgb, var(--color-primary, #31cfa1) 34%, transparent);
  border-radius: 20px;
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 8%, var(--color-bg-elevated, rgba(148, 163, 184, 0.08)));
  padding: 20px;
}

.mst-annual-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.mst-annual-title {
  margin: 0;
  font-size: 16px;
  font-weight: 900;
  color: var(--color-primary, #31cfa1);
}

.mst-annual-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 20px;
}

.mst-annual-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mst-annual-item-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.7;
}

.mst-annual-item-value {
  font-size: 14px;
  font-weight: 900;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Top 歌手横向条形 */
.mst-bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mst-bar-row {
  display: grid;
  grid-template-columns: 96px 1fr 72px;
  align-items: center;
  gap: 12px;
}

.mst-bar-name {
  font-size: 12px;
  font-weight: 800;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-bar-track {
  height: 12px;
  border-radius: 999px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.1));
  overflow: hidden;
}

.mst-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary, #31cfa1);
}

.mst-bar-val {
  font-size: 11px;
  font-weight: 800;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  text-align: right;
  white-space: nowrap;
}

/* Top 歌曲列表 */
.mst-songs {
  display: flex;
  flex-direction: column;
}

.mst-song-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.1));
}

.mst-song-row:last-child {
  border-bottom: none;
}

.mst-song-rank {
  width: 24px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 900;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  text-align: center;
  opacity: 0.7;
}

.mst-song-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mst-song-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-song-artist {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-song-meta {
  flex-shrink: 0;
  text-align: right;
  font-size: 11px;
  font-weight: 800;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  white-space: nowrap;
}

/* 音源 donut + 图例 */
.mst-donut-wrap {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.mst-legend {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 180px;
}

.mst-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mst-legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.mst-legend-label {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-legend-val {
  font-size: 11px;
  font-weight: 800;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  white-space: nowrap;
}

/* 空态 / 加载 / 错误 */
.mst-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 24px;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  text-align: center;
}

.mst-state p {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
}

/* 设置面板 */
.mst-settings {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.mst-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mst-setting-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mst-setting-label {
  font-size: 13px;
  font-weight: 900;
  color: var(--color-text-main, #f8fafc);
}

.mst-setting-hint {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

.mst-setting-select {
  width: 132px;
}

.mst-danger-zone {
  border: 1px solid color-mix(in srgb, #ef4444 32%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, #ef4444 6%, transparent);
  padding: 14px 16px;
}

@media (max-width: 640px) {
  .mst-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .mst-annual-grid {
    grid-template-columns: 1fr;
  }
}
`;

// ---- 图表渲染辅助（自绘 SVG，无 npm 依赖 / 外链） ----

const chartStroke = 'var(--color-primary, #31cfa1)';
const chartGrid = 'var(--border-subtle, rgba(148, 163, 184, 0.16))';
const chartText = 'var(--color-text-secondary, rgba(148, 163, 184, 0.9))';
const chartMuted = 'var(--control-muted-bg, rgba(148, 163, 184, 0.1))';

// 折线（趋势）：单序列、主题色、recessive 网格、首尾直接标注
const renderTrendChart = (h, rows) => {
  const W = 720;
  const H = 220;
  const PAD_L = 52;
  const PAD_R = 16;
  const PAD_T = 14;
  const PAD_B = 30;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const values = rows.map((r) => Number(r.ms) || 0);
  const maxMs = Math.max(1, ...values);
  const n = rows.length;
  const xAt = (i) => (n <= 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW);
  const yAt = (ms) => PAD_T + innerH - (ms / maxMs) * innerH;

  const pts = rows.map((r, i) => ({ x: xAt(i), y: yAt(Number(r.ms) || 0) }));
  const linePath = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const areaPath =
    pts.length > 1
      ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(PAD_T + innerH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(PAD_T + innerH).toFixed(1)} Z`
      : '';

  const gridTicks = [0, 0.5, 1].map((f) => ({
    y: PAD_T + innerH - f * innerH,
    label: formatMsShort(maxMs * f),
  }));

  const xLabels =
    n <= 1
      ? [{ x: xAt(0), label: String(rows[0]?.day ?? '') }]
      : [
          { x: xAt(0), label: String(rows[0]?.day ?? '') },
          { x: xAt(Math.floor((n - 1) / 2)), label: String(rows[Math.floor((n - 1) / 2)]?.day ?? '') },
          { x: xAt(n - 1), label: String(rows[n - 1]?.day ?? '') },
        ];

  return h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '听歌时长趋势' }, [
    ...gridTicks.map((t) => [
      h('line', { x1: PAD_L, x2: W - PAD_R, y1: t.y, y2: t.y, 'stroke-width': 1, style: { stroke: chartGrid } }),
      h('text', { x: PAD_L - 8, y: t.y + 4, 'font-size': 10, 'text-anchor': 'end', style: { fill: chartText } }, t.label),
    ]).flat(),
    areaPath
      ? h('path', { d: areaPath, stroke: 'none', style: { fill: 'color-mix(in srgb, var(--color-primary, #31cfa1) 14%, transparent)' } })
      : null,
    h('path', { d: linePath, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', style: { stroke: chartStroke } }),
    ...pts.map((p) => h('circle', { cx: p.x, cy: p.y, r: 3, style: { fill: chartStroke } })),
    ...xLabels.map((l) =>
      h('text', { x: l.x, y: H - 10, 'font-size': 10, 'text-anchor': 'middle', style: { fill: chartText } }, l.label),
    ),
  ]);
};

// 时段分布：24 根柱子，主色单序列，仅标注 0/6/12/18/23
const renderHourChart = (h, rows) => {
  const W = 720;
  const H = 200;
  const PAD_L = 40;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 26;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const byHour = new Map(rows.map((r) => [Number(r.hour), Number(r.plays) || 0]));
  const maxPlays = Math.max(1, ...Array.from(byHour.values()));
  const slot = innerW / 24;
  const barW = Math.max(2, slot * 0.6);

  const bars = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const val = byHour.get(hour) || 0;
    const hgt = val > 0 ? Math.max(2, (val / maxPlays) * innerH) : 0;
    const x = PAD_L + hour * slot + (slot - barW) / 2;
    bars.push(
      h('rect', {
        x: x.toFixed(1),
        y: (PAD_T + innerH - hgt).toFixed(1),
        width: barW.toFixed(1),
        height: hgt.toFixed(1),
        rx: 2,
        opacity: val > 0 ? 0.85 : 0.18,
        style: { fill: chartStroke },
      }),
    );
  }

  const ticks = [0, 6, 12, 18, 23].map((hour) => ({
    x: PAD_L + hour * slot + slot / 2,
    label: `${hour}时`,
  }));

  return h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '每日时段分布' }, [
    h('line', { x1: PAD_L, x2: W - PAD_R, y1: PAD_T + innerH, y2: PAD_T + innerH, 'stroke-width': 1, style: { stroke: chartGrid } }),
    ...bars,
    ...ticks.map((t) => h('text', { x: t.x, y: H - 8, 'font-size': 10, 'text-anchor': 'middle', style: { fill: chartText } }, t.label)),
  ]);
};

// 音源 donut：stroke-dasharray 分段 + 中心总数 + 图例
const renderDonut = (h, segments, total) => {
  const size = 160;
  const c = size / 2;
  const r = 50;
  const circumference = 2 * Math.PI * r;
  let acc = 0;
  const arcs = segments.map((seg) => {
    const frac = total > 0 ? seg.value / total : 0;
    const len = frac * circumference;
    const arc = { ...seg, len, offset: acc };
    acc += len;
    return arc;
  });

  return h('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': '音源分布' }, [
    h('circle', { cx: c, cy: c, r, fill: 'none', 'stroke-width': 22, style: { stroke: chartMuted } }),
    ...arcs.map((arc) =>
      h('circle', {
        cx: c,
        cy: c,
        r,
        fill: 'none',
        'stroke-width': 22,
        'stroke-dasharray': `${arc.len.toFixed(2)} ${(circumference - arc.len).toFixed(2)}`,
        'stroke-dashoffset': (-arc.offset).toFixed(2),
        transform: `rotate(-90 ${c} ${c})`,
        style: { stroke: sourceColor(arc.label) },
      }),
    ),
    h('text', { x: c, y: c - 2, 'font-size': 20, 'font-weight': 900, 'text-anchor': 'middle', style: { fill: 'var(--color-text-main, #f8fafc)' } }, String(total)),
    h('text', { x: c, y: c + 16, 'font-size': 10, 'text-anchor': 'middle', style: { fill: chartText } }, '次播放'),
  ]);
};

// ---- 报告页 ----

const createReportPage = (ctx) => {
  const { h, defineComponent, ref, watch, onMounted, resolveComponent, defineAsyncComponent } =
    ctx.vue;
  const PageScrollContainer = defineAsyncComponent(ctx.ui.components.PageScrollContainer);

  const sectionTitle = (Icon, icon, text) =>
    h('div', { class: 'mst-card-title' }, [
      h(Icon, { icon, width: 16, height: 16, class: 'mst-card-title-icon' }),
      h('span', null, text),
    ]);

  return defineComponent({
    name: 'music-stats-report',
    setup() {
      const Icon = resolveComponent('Icon');

      const range = ref('month');
      const loading = ref(false);
      const error = ref('');
      const report = ref(null); // { kpi, topArtists, topSongs, trend, hours, sources }

      const load = async () => {
        if (!db) {
          error.value = '本地数据库未就绪';
          return;
        }
        loading.value = true;
        error.value = '';
        try {
          report.value = await queryReport(db, getRangeMs(range.value));
        } catch (err) {
          console.warn('[music-stats] 查询报告失败:', err);
          error.value = '读取统计失败，请稍后重试';
        } finally {
          loading.value = false;
        }
      };

      onMounted(load);
      watch(range, load);

      return () => {
        const data = report.value;
        const isEmpty = !data || !data.kpi || Number(data.kpi.n) === 0;

        // 年度报告派生
        let annual = null;
        if (data && !isEmpty && range.value === 'year') {
          const kpi = data.kpi;
          const topArtist = data.topArtists[0];
          const topSong = data.topSongs[0];
          const activeMonth = mostActiveMonth(data.trend);
          annual = {
            totalMs: Number(kpi.ms) || 0,
            totalPlays: Number(kpi.n) || 0,
            topArtist: topArtist ? String(topArtist.artist) : '',
            topSong: topSong ? `${String(topSong.title)} · ${String(topSong.artist)}` : '',
            activeMonth: activeMonth ? activeMonth.month : '',
            avgPerDay: (Number(kpi.ms) || 0) / daysElapsedThisYear(),
          };
        }

        // 音源 donut 数据
        const sourceItems = data ? buildSourceSegments(data.sources) : { items: [], total: 0 };

        return h('div', { class: 'mst-root' }, [
          h(PageScrollContainer, null, {
            default: () =>
              h('div', { class: 'mst-page' }, [
            // 页头
            h('div', { class: 'mst-header' }, [
              h('div', { class: 'mst-header-left' }, [
                h(Icon, { icon: ctx.icons.iconPulse, width: 26, height: 26, class: 'mst-header-icon' }),
                h('div', null, [
                  h('h1', { class: 'mst-title' }, '听歌统计'),
                  h('p', { class: 'mst-subtitle' }, '数据仅保存在本机，无任何上传'),
                ]),
              ]),
            ]),

            // 时间范围 + 刷新
            h('div', { class: 'mst-toolbar' }, [
              ...RANGE_OPTIONS.map((opt) =>
                h(
                  'button',
                  {
                    key: opt.key,
                    class: ['mst-chip', range.value === opt.key ? 'mst-chip-active' : ''],
                    onClick: () => {
                      range.value = opt.key;
                    },
                  },
                  opt.label,
                ),
              ),
              h(
                'button',
                { class: 'mst-chip mst-refresh', onClick: load },
                [
                  h(Icon, { icon: ctx.icons.iconRefreshCw, width: 12, height: 12, style: { verticalAlign: '-2px', marginRight: '4px' } }),
                  '刷新',
                ],
              ),
            ]),

            loading.value && !data
              ? h('div', { class: 'mst-card' }, [h('div', { class: 'mst-state' }, [h('p', null, '加载中…')])])
              : error.value && !data
                ? h('div', { class: 'mst-card' }, [h('div', { class: 'mst-state' }, [h('p', null, error.value)])])
                : isEmpty
                  ? h('div', { class: 'mst-card' }, [
                      h('div', { class: 'mst-state' }, [
                        h(Icon, { icon: ctx.icons.iconMusic, width: 56, height: 56 }),
                        h('p', null, '这段时间还没有记录，去听首歌吧'),
                      ]),
                    ])
                  : [
                      // 年度报告（今年才显示）
                      annual
                        ? h('div', { class: 'mst-annual' }, [
                            h('div', { class: 'mst-annual-head' }, [
                              h(Icon, { icon: ctx.icons.iconStar, width: 20, height: 20 }),
                              h('h2', { class: 'mst-annual-title' }, '年度报告'),
                            ]),
                            h('div', { class: 'mst-annual-grid' }, [
                              annualItem(h, '今年总时长', formatMsShort(annual.totalMs)),
                              annualItem(h, '今年总播放', `${annual.totalPlays} 次`),
                              annualItem(h, '最爱歌手', annual.topArtist || '—'),
                              annualItem(h, '最爱歌曲', annual.topSong || '—'),
                              annualItem(h, '最活跃月份', annual.activeMonth || '—'),
                              annualItem(h, '平均每天', formatMsShort(annual.avgPerDay)),
                            ]),
                          ])
                        : null,

                      // KPI
                      h('div', { class: 'mst-kpis' }, [
                        kpiCard(h, '总听歌时长', formatMsShort(Number(data.kpi.ms) || 0)),
                        kpiCard(h, '总播放次数', `${Number(data.kpi.n) || 0} 次`),
                        kpiCard(h, '去重歌曲', `${Number(data.kpi.songs) || 0} 首`),
                        kpiCard(h, '去重歌手', `${Number(data.kpi.artists) || 0} 位`),
                      ]),

                      // 趋势
                      data.trend.length > 0
                        ? h('div', { class: 'mst-card' }, [
                            sectionTitle(Icon, ctx.icons.iconClock, '听歌时长趋势'),
                            h('p', { class: 'mst-card-sub' }, '按天聚合实听时长'),
                            h('div', { class: 'mst-chart-scroll' }, [renderTrendChart(h, data.trend)]),
                          ])
                        : null,

                      // Top 歌手
                      data.topArtists.length > 0
                        ? h('div', { class: 'mst-card' }, [
                            sectionTitle(Icon, ctx.icons.iconTrophy, 'Top 歌手'),
                            h('p', { class: 'mst-card-sub' }, '按累计实听时长降序'),
                            renderArtistBars(h, data.topArtists),
                          ])
                        : null,

                      // Top 歌曲
                      data.topSongs.length > 0
                        ? h('div', { class: 'mst-card' }, [
                            sectionTitle(Icon, ctx.icons.iconMusic, 'Top 歌曲'),
                            h('p', { class: 'mst-card-sub' }, '按播放次数降序'),
                            renderSongList(h, data.topSongs),
                          ])
                        : null,

                      // 时段分布
                      h('div', { class: 'mst-card' }, [
                        sectionTitle(Icon, ctx.icons.iconClock, '每日时段分布'),
                        h('p', { class: 'mst-card-sub' }, '按播放次数统计（0–23 点）'),
                        h('div', { class: 'mst-chart-scroll' }, [renderHourChart(h, data.hours)]),
                      ]),

                      // 音源占比
                      sourceItems.total > 0
                        ? h('div', { class: 'mst-card' }, [
                            sectionTitle(Icon, ctx.icons.iconCloud, '音源占比'),
                            h('p', { class: 'mst-card-sub' }, '按播放次数统计'),
                            h('div', { class: 'mst-donut-wrap' }, [
                              renderDonut(h, sourceItems.items, sourceItems.total),
                              renderSourceLegend(h, sourceItems.items, sourceItems.total),
                            ]),
                          ])
                        : null,
                    ],
              ]),
          }),
        ]);
      };
    },
  });
};

// ---- 报告页子渲染 ----

const kpiCard = (h, label, value) =>
  h('div', { class: 'mst-kpi' }, [
    h('div', { class: 'mst-kpi-value' }, value),
    h('div', { class: 'mst-kpi-label' }, label),
  ]);

const annualItem = (h, label, value) =>
  h('div', { class: 'mst-annual-item' }, [
    h('div', { class: 'mst-annual-item-label' }, label),
    h('div', { class: 'mst-annual-item-value' }, value),
  ]);

const buildSourceSegments = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const label = sourceLabel(String(row.source ?? ''));
    if (!map.has(label)) map.set(label, { label, value: 0 });
    map.get(label).value += Number(row.plays) || 0;
  }
  const items = Array.from(map.values()).sort((a, b) => b.value - a.value);
  const total = items.reduce((sum, it) => sum + it.value, 0);
  return { items, total };
};

const renderSourceLegend = (h, items, total) =>
  h('div', { class: 'mst-legend' }, [
    ...items.map((it) =>
      h('div', { class: 'mst-legend-item', key: it.label }, [
        h('span', { class: 'mst-legend-dot', style: { background: sourceColor(it.label) } }),
        h('span', { class: 'mst-legend-label' }, it.label),
        h(
          'span',
          { class: 'mst-legend-val' },
          `${it.value} 次 · ${total > 0 ? Math.round((it.value / total) * 100) : 0}%`,
        ),
      ]),
    ),
  ]);

const renderArtistBars = (h, rows) => {
  const maxMs = Math.max(1, ...rows.map((r) => Number(r.ms) || 0));
  return h('div', { class: 'mst-bars' }, [
    ...rows.map((r) => {
      const ms = Number(r.ms) || 0;
      return h('div', { class: 'mst-bar-row', key: String(r.artist) }, [
        h('span', { class: 'mst-bar-name', title: String(r.artist) }, String(r.artist)),
        h('div', { class: 'mst-bar-track' }, [
          h('div', { class: 'mst-bar-fill', style: { width: `${Math.max(2, (ms / maxMs) * 100)}%` } }),
        ]),
        h('span', { class: 'mst-bar-val' }, formatMsShort(ms)),
      ]);
    }),
  ]);
};

const renderSongList = (h, rows) =>
  h('div', { class: 'mst-songs' }, [
    ...rows.map((r, i) =>
      h('div', { class: 'mst-song-row', key: `${String(r.title)}-${String(r.artist)}` }, [
        h('span', { class: 'mst-song-rank' }, String(i + 1)),
        h('div', { class: 'mst-song-main' }, [
          h('span', { class: 'mst-song-title', title: String(r.title) }, String(r.title)),
          h('span', { class: 'mst-song-artist', title: String(r.artist) }, String(r.artist)),
        ]),
        h('span', { class: 'mst-song-meta' }, `${Number(r.plays) || 0} 次 · ${formatMsShort(Number(r.ms) || 0)}`),
      ]),
    ),
  ]);

// ---- 设置面板 ----

const createSettingsPanel = (ctx) => {
  const { h, defineComponent, ref, onMounted, onBeforeUnmount } = ctx.vue;
  const Switch = ctx.vue.defineAsyncComponent(ctx.ui.components.Switch);
  const Select = ctx.vue.defineAsyncComponent(ctx.ui.components.Select);
  const Button = ctx.vue.defineAsyncComponent(ctx.ui.components.Button);

  return defineComponent({
    name: 'music-stats-settings',
    setup() {
      const loaded = ref(false);
      const enabled = ref(true);
      const minSeconds = ref(DEFAULT_MIN_SECONDS);
      const confirmClear = ref(false);
      let clearTimer = null;

      onMounted(async () => {
        try {
          const rawEnabled = await ctx.storage.get('enabled');
          enabled.value = rawEnabled == null ? true : Boolean(rawEnabled);
          const sec = Number(await ctx.storage.get('minListenSeconds'));
          minSeconds.value = Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_MIN_SECONDS;
        } catch (error) {
          console.warn('[music-stats] 读取设置失败:', error);
        }
        loaded.value = true;
      });

      onBeforeUnmount(() => {
        if (clearTimer) {
          clearTimeout(clearTimer);
          clearTimer = null;
        }
      });

      const setEnabled = (value) => {
        enabled.value = Boolean(value);
        settings.enabled = enabled.value;
        if (!settings.enabled) current = null;
        void ctx.storage.set('enabled', settings.enabled).catch(() => {});
      };

      const setMinSeconds = (value) => {
        minSeconds.value = Number(value) || DEFAULT_MIN_SECONDS;
        settings.minListenSeconds = minSeconds.value;
        void ctx.storage.set('minListenSeconds', settings.minListenSeconds).catch(() => {});
      };

      const handleClear = async () => {
        if (!confirmClear.value) {
          confirmClear.value = true;
          clearTimer = setTimeout(() => {
            confirmClear.value = false;
            clearTimer = null;
          }, 4000);
          return;
        }
        if (clearTimer) {
          clearTimeout(clearTimer);
          clearTimer = null;
        }
        confirmClear.value = false;
        try {
          const res = db ? await db.run('DELETE FROM plays') : { ok: false, error: '数据库未就绪' };
          if (res.ok) ctx.toast.success('统计数据已清空');
          else ctx.toast.danger('清空失败，请重试');
        } catch (error) {
          console.warn('[music-stats] 清空数据失败:', error);
          ctx.toast.danger('清空失败，请重试');
        }
      };

      const options = MIN_SECONDS_OPTIONS.map((v) => ({ label: `${v} 秒`, value: v }));

      return () =>
        h('div', { class: 'mst-settings' }, [
          h('div', { class: 'mst-setting-row' }, [
            h('div', { class: 'mst-setting-copy' }, [
              h('div', { class: 'mst-setting-label' }, '启用统计'),
              h('div', { class: 'mst-setting-hint' }, '关闭后停止记录新播放，已保存的历史保留'),
            ]),
            h(Switch, { modelValue: enabled.value, 'onUpdate:modelValue': setEnabled, disabled: !loaded.value }),
          ]),
          h('div', { class: 'mst-setting-row' }, [
            h('div', { class: 'mst-setting-copy' }, [
              h('div', { class: 'mst-setting-label' }, '最短计入时长'),
              h('div', { class: 'mst-setting-hint' }, '实听时长低于该值的播放不计入'),
            ]),
            h(Select, {
              modelValue: minSeconds.value,
              'onUpdate:modelValue': setMinSeconds,
              options,
              class: 'mst-setting-select',
              disabled: !loaded.value,
            }),
          ]),
          h('div', { class: 'mst-danger-zone' }, [
            h('div', { class: 'mst-setting-copy', style: { marginBottom: '12px' } }, [
              h('div', { class: 'mst-setting-label' }, '清空数据'),
              h('div', { class: 'mst-setting-hint' }, '删除全部播放记录，不可恢复'),
            ]),
            h(Button, {
              variant: confirmClear.value ? 'danger' : 'outline',
              size: 'sm',
              onClick: handleClear,
            }, { default: () => (confirmClear.value ? '再次点击确认清空' : '清空数据') }),
          ]),
        ]);
    },
  });
};

// ---- 插件入口 ----

export async function activate(ctx) {
  ctx.css.inject(CSS, { id: 'page' });

  // 开库（await；失败则采集/查询全部降级跳过，报告页显示提示）
  try {
    const opened = await ctx.sqlite.open({ name: DB_NAME, migrations: MIGRATIONS });
    if (opened.ok) {
      db = opened;
    } else {
      console.warn('[music-stats] 打开数据库失败:', opened.error);
    }
  } catch (error) {
    console.warn('[music-stats] 打开数据库异常:', error);
  }

  // 读配置
  try {
    const rawEnabled = await ctx.storage.get('enabled');
    settings.enabled = rawEnabled == null ? true : Boolean(rawEnabled);
    const sec = Number(await ctx.storage.get('minListenSeconds'));
    settings.minListenSeconds = Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_MIN_SECONDS;
  } catch (error) {
    console.warn('[music-stats] 读取设置失败:', error);
  }

  // 采集引擎（onTrackChange/onTimeUpdate 返回的 dispose 由运行时自动托管）
  ctx.events.onTrackChange(onTrackChange);
  ctx.events.onTimeUpdate(onTimeUpdate);

  // 报告页 + 侧边栏入口
  ctx.ui.addPage({
    id: 'report',
    title: '听歌统计',
    icon: ctx.icons.iconPulse,
    component: createReportPage(ctx),
    order: 20,
    sidebar: true,
  });

  // 设置面板
  ctx.ui.settings.define({
    id: 'music-stats',
    title: '听歌统计',
    description: '采集开关、最短计入时长与数据清空',
    component: createSettingsPanel(ctx),
  });

  // 命令
  ctx.commands.register(
    'music-stats:open',
    () => ctx.router.push('/main/plugin/music-stats/report'),
    { title: '听歌统计' },
  );

  disposeAll = async () => {
    await settleCurrent();
    current = null;
    db = null;
  };
}

export async function deactivate() {
  if (disposeAll) {
    try {
      await disposeAll();
    } catch (error) {
      console.warn('[music-stats] 清理失败:', error);
    }
    disposeAll = null;
  }
}
