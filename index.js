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
  {
    version: 2,
    sql: [
      `ALTER TABLE plays ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE plays ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;`,
    ],
  },
  {
    version: 3,
    sql: [
      `ALTER TABLE plays ADD COLUMN quality TEXT NOT NULL DEFAULT '';`,
      `ALTER TABLE plays ADD COLUMN effect TEXT NOT NULL DEFAULT '';`,
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
  { key: 'custom', label: '自定义' },
];

// ---- 模块级运行状态 ----

let db = null; // 打开的 sqlite 句柄（open 失败时保持 null，采集/查询降级跳过）
let settings = {
  enabled: true,
  minListenSeconds: DEFAULT_MIN_SECONDS,
  scrobblerEnabled: false,
  scrobblerUrl: '',
  scrobblerToken: '',
};
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

const getRangeMs = (key, customStart, customEnd) => {
  if (key === 'custom') {
    const s = customStart ? new Date(customStart).getTime() : 0;
    const e = customEnd ? new Date(customEnd).getTime() + DAY_MS : MAX_SAFE_MS;
    return { start: Math.max(0, s), end: e };
  }
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
      (track_id, title, artist, album, source, duration, played_ms, started_at, day, month, hour, weekday, completed, skipped, quality, effect)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      meta.completed ?? 0,
      meta.skipped ?? 0,
      meta.quality ?? '',
      meta.effect ?? '',
    ],
  );
  if (!res.ok) console.warn('[music-stats] 写入播放记录失败:', res.error);
};

// ---- Scrobbler 云端互联（支持 Last.fm / ListenBrainz 等） ----

const triggerScrobble = async (ctx, rec) => {
  if (!settings.scrobblerEnabled || !settings.scrobblerUrl) return;
  try {
    const payload = {
      track: rec.title,
      artist: rec.artist,
      album: rec.album,
      duration: rec.duration,
      timestamp: Math.floor(rec.startedAt / 1000),
      service: 'EchoMusic',
    };
    if (ctx && ctx.net && typeof ctx.net.request === 'function') {
      await ctx.net.request({
        url: settings.scrobblerUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.scrobblerToken ? { Authorization: `Bearer ${settings.scrobblerToken}` } : {}),
        },
        body: payload,
      });
    } else {
      await fetch(settings.scrobblerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.scrobblerToken ? { Authorization: `Bearer ${settings.scrobblerToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    console.warn('[music-stats] Scrobble 提交失败:', err);
  }
};

// ---- 采集引擎 ----

// 结算上一首：满足阈值且启用才落库；自动标记完播与跳过
const settleCurrent = async (ctx) => {
  if (!current) return;
  const rec = current;
  current = null;
  if (!settings.enabled) return;
  const durationMs = (rec.duration || 0) * 1000;
  const playedMs = rec.maxMs || 0;
  // 完播判定：播放时长达到 85% 以上（或对无时长音频播放超 2 分钟）
  const completed = (durationMs > 0 && playedMs >= durationMs * 0.85) || (durationMs === 0 && playedMs >= 120000) ? 1 : 0;
  // 切歌判定：播放少于 15 秒提前切歌
  const skipped = playedMs < 15000 ? 1 : 0;

  if (playedMs >= settings.minListenSeconds * 1000 || completed) {
    try {
      await insertPlay({ ...rec, playedMs, completed, skipped });
      if (completed === 1 && ctx) {
        void triggerScrobble(ctx, { ...rec, playedMs });
      }
    } catch (error) {
      console.warn('[music-stats] 结算播放记录异常:', error);
    }
  }
};

const onTrackChange = (track, ctx) => {
  const meta = songToMeta(track);
  const trackId = meta ? meta.trackId : null;
  // 同一首歌的深层字段变化（封面/音频地址解析）会触发 deep watch，用 id 去抖
  if (current && current.trackId === trackId) return;
  void settleCurrent(ctx);

  let quality = '';
  let effect = '';
  try {
    quality = String(
      track?.quality ||
      track?.level ||
      ctx?.player?.audioQuality?.value?.resolved ||
      ctx?.stores?.player?.currentResolvedAudioQuality ||
      '',
    );
    effect = String(
      ctx?.player?.audioEffect?.value?.resolved ||
      ctx?.stores?.player?.currentResolvedAudioEffect ||
      '',
    );
  } catch {}

  current = meta && settings.enabled ? {
    ...meta,
    quality,
    effect,
    startedAt: Date.now(),
    maxMs: 0,
  } : null;
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
  COUNT(DISTINCT artist) AS artists,
  COALESCE(SUM(completed), 0) AS completed_count,
  COALESCE(SUM(skipped), 0) AS skipped_count
  FROM plays WHERE started_at >= ? AND started_at < ?`;

const QUERY_TOP_ARTISTS = `SELECT artist, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY artist ORDER BY ms DESC LIMIT 10`;

const QUERY_TOP_SONGS = `SELECT track_id, title, artist, COUNT(*) AS plays, SUM(played_ms) AS ms,
  COALESCE(SUM(completed), 0) AS completed_count
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist ORDER BY plays DESC LIMIT 20`;

const QUERY_COMPLETED_SONGS = `SELECT track_id, title, artist, COUNT(*) AS plays,
  SUM(completed) AS completed_count,
  ROUND(CAST(SUM(completed) AS FLOAT) / COUNT(*) * 100, 1) AS completion_rate
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist HAVING completed_count > 0
  ORDER BY completed_count DESC, plays DESC LIMIT 15`;

const QUERY_SKIPPED_SONGS = `SELECT track_id, title, artist, COUNT(*) AS plays,
  SUM(skipped) AS skipped_count,
  ROUND(CAST(SUM(skipped) AS FLOAT) / COUNT(*) * 100, 1) AS skip_rate
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist HAVING skipped_count > 0
  ORDER BY skipped_count DESC, plays DESC LIMIT 15`;

const QUERY_LOOP_SONG = `SELECT title, artist, day, COUNT(*) AS daily_plays
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist, day HAVING daily_plays >= 2
  ORDER BY daily_plays DESC LIMIT 1`;

const QUERY_NIGHT_SONG = `SELECT title, artist, COUNT(*) AS night_plays
  FROM plays WHERE hour >= 0 AND hour < 6 AND started_at >= ? AND started_at < ?
  GROUP BY title, artist ORDER BY night_plays DESC LIMIT 1`;

const QUERY_QUALITIES = `SELECT quality, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ? AND quality != ''
  GROUP BY quality ORDER BY plays DESC`;

const QUERY_EFFECTS = `SELECT effect, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ? AND effect != '' AND effect != 'none'
  GROUP BY effect ORDER BY plays DESC`;

const QUERY_HEATMAP = `SELECT day, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY day ORDER BY day ASC`;

const QUERY_TREND_DAY = `SELECT day AS bucket, SUM(played_ms) AS ms, COUNT(*) AS plays
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY day ORDER BY day`;

const QUERY_TREND_MONTH = `SELECT month AS bucket, SUM(played_ms) AS ms, COUNT(*) AS plays
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY month ORDER BY month`;

// 趋势粒度：短区间按天，长区间（今年/全部）按月
const trendGranularity = (key) => (key === 'year' || key === 'all' ? 'month' : 'day');

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

const queryReport = async (dbHandle, range, granularity) => {
  const params = [range.start, range.end];
  const trendSql = granularity === 'month' ? QUERY_TREND_MONTH : QUERY_TREND_DAY;
  const heatmapStart = Date.now() - 365 * DAY_MS;
  const [
    kpiRows,
    topArtists,
    topSongs,
    trend,
    hours,
    sources,
    completedSongs,
    skippedSongs,
    loopSongRows,
    nightSongRows,
    qualities,
    effects,
    heatmap,
  ] = await Promise.all([
    runQuery(dbHandle, QUERY_KPI, params),
    runQuery(dbHandle, QUERY_TOP_ARTISTS, params),
    runQuery(dbHandle, QUERY_TOP_SONGS, params),
    runQuery(dbHandle, trendSql, params),
    runQuery(dbHandle, QUERY_HOURS, params),
    runQuery(dbHandle, QUERY_SOURCES, params),
    runQuery(dbHandle, QUERY_COMPLETED_SONGS, params),
    runQuery(dbHandle, QUERY_SKIPPED_SONGS, params),
    runQuery(dbHandle, QUERY_LOOP_SONG, params),
    runQuery(dbHandle, QUERY_NIGHT_SONG, params),
    runQuery(dbHandle, QUERY_QUALITIES, params),
    runQuery(dbHandle, QUERY_EFFECTS, params),
    runQuery(dbHandle, QUERY_HEATMAP, [heatmapStart, Date.now() + DAY_MS]),
  ]);
  return {
    kpi: kpiRows[0] || null,
    topArtists,
    topSongs,
    trend,
    hours,
    sources,
    completedSongs,
    skippedSongs,
    loopSong: loopSongRows[0] || null,
    nightSong: nightSongRows[0] || null,
    qualities,
    effects,
    heatmap,
  };
};

// ---- 数据备份（导出 / 导入） ----

// 备份只导出「源数据」列；派生列（day/month/hour/weekday）导入时按 started_at 重算，保证与采集一致
const QUERY_BACKUP = `SELECT track_id, title, artist, album, source, duration, played_ms, started_at
  FROM plays ORDER BY started_at`;

const IMPORT_SQL = `INSERT OR IGNORE INTO plays
  (track_id, title, artist, album, source, duration, played_ms, started_at, day, month, hour, weekday)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// 单行 → 插入参数（派生列由 started_at 重算）；无效行返回 null
const importRowToParams = (row) => {
  const startedAt = Number(row?.started_at);
  const trackId = String(row?.track_id ?? '').trim();
  const title = String(row?.title ?? '').trim();
  if (!trackId || !title || !Number.isFinite(startedAt)) return null;
  const d = new Date(startedAt);
  const day = formatDay(d);
  return [
    trackId,
    title,
    String(row?.artist ?? '').trim(),
    String(row?.album ?? '').trim(),
    String(row?.source ?? '').trim(),
    Number(row?.duration) || 0,
    Number(row?.played_ms) || 0,
    startedAt,
    day,
    day.slice(0, 7),
    d.getHours(),
    d.getDay(),
  ];
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
    const month = String(row.bucket || '').slice(0, 7);
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
  position: relative;
}

.mst-page {
  display: flex;
  flex-direction: column;
  padding: 20px 32px 48px;
  gap: 22px;
  max-width: 1440px;
  margin: 0 auto;
  box-sizing: border-box;
}

/* 页头与导航条 */
.mst-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 16px 20px;
  border-radius: 18px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.06));
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.14));
  box-shadow: 0 4px 20px -4px rgba(0, 0, 0, 0.05);
  backdrop-filter: blur(12px);
}

.mst-header-left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.mst-header-icon-box {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary, #31cfa1) 32%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary, #31cfa1);
  flex-shrink: 0;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--color-primary, #31cfa1) 20%, transparent);
}

.mst-header-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mst-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.mst-title {
  margin: 0;
  font-size: 22px;
  font-weight: 850;
  letter-spacing: -0.02em;
  color: var(--color-text-main, #f8fafc);
  line-height: 1.2;
}

.mst-privacy-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 650;
  padding: 2px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 12%, transparent);
  color: var(--color-primary, #31cfa1);
  border: 1px solid color-mix(in srgb, var(--color-primary, #31cfa1) 24%, transparent);
}

.mst-subtitle {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
}

/* 工具栏与时间范围筛选条 */
.mst-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.mst-segmented {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border-radius: 12px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.08));
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.14));
  gap: 2px;
}

.mst-seg-btn {
  border: none;
  background: transparent;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
  border-radius: 9px;
  padding: 6px 13px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
}

.mst-seg-btn:hover {
  color: var(--color-text-main, #f8fafc);
  background: var(--control-hover-bg, rgba(148, 163, 184, 0.12));
}

.mst-seg-btn.active {
  background: var(--color-primary, #31cfa1);
  color: var(--color-on-primary, #0f172a);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--color-primary, #31cfa1) 36%, transparent);
}

.mst-btn-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.16));
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.08));
  color: var(--color-text-main, #f8fafc);
  border-radius: 11px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.18s ease;
}

.mst-btn-action:hover {
  border-color: var(--color-primary, #31cfa1);
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 12%, transparent);
  color: var(--color-primary, #31cfa1);
}

/* 自定义日期筛选条 */
.mst-custom-range {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 12px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.05));
  border: 1px dashed var(--border-subtle, rgba(148, 163, 184, 0.2));
  flex-wrap: wrap;
  animation: mstFadeIn 0.2s ease-out;
}

.mst-date-input {
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.08));
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.2));
  color: var(--color-text-main, #f8fafc);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}

.mst-date-input:focus {
  border-color: var(--color-primary, #31cfa1);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary, #31cfa1) 20%, transparent);
}

/* KPI 卡片网格 */
.mst-kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 14px;
}

@media (max-width: 1180px) {
  .mst-kpis {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .mst-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.mst-kpi {
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.14));
  border-radius: 16px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.06));
  padding: 16px 18px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  position: relative;
  overflow: hidden;
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s, box-shadow 0.2s;
  box-shadow: 0 2px 10px -2px rgba(0, 0, 0, 0.04);
}

.mst-kpi:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--color-primary, #31cfa1) 40%, transparent);
  box-shadow: 0 6px 18px -3px rgba(0, 0, 0, 0.08);
}

.mst-kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mst-kpi-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
}

.mst-kpi-icon {
  font-size: 15px;
  opacity: 0.85;
}

.mst-kpi-value {
  font-size: 25px;
  font-weight: 850;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.15;
}

.mst-kpi-meter {
  height: 4px;
  border-radius: 999px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.12));
  overflow: hidden;
  margin-top: 2px;
}

.mst-kpi-meter-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary, #31cfa1);
  transition: width 0.4s ease;
}

.mst-kpi-meter-fill.is-skip {
  background: #f43f5e;
}

.mst-kpi-sub {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.65));
}

/* 年度报告高光卡片 */
.mst-annual {
  border: 1px solid color-mix(in srgb, var(--color-primary, #31cfa1) 32%, transparent);
  border-radius: 20px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary, #31cfa1) 12%, transparent) 0%, color-mix(in srgb, #6366f1 8%, var(--color-bg-elevated, rgba(148, 163, 184, 0.08))) 100%);
  padding: 22px 24px;
  box-shadow: 0 8px 30px -6px color-mix(in srgb, var(--color-primary, #31cfa1) 15%, transparent);
}

.mst-annual-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.mst-annual-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mst-annual-title {
  margin: 0;
  font-size: 18px;
  font-weight: 850;
  letter-spacing: -0.01em;
  color: var(--color-primary, #31cfa1);
}

.mst-annual-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 20%, transparent);
  color: var(--color-primary, #31cfa1);
}

.mst-annual-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

@media (max-width: 768px) {
  .mst-annual-grid {
    grid-template-columns: 1fr;
  }
}

.mst-annual-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-bg-elevated, #fff) 50%, transparent);
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.12));
  min-width: 0;
}

.mst-annual-item-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
}

.mst-annual-item-value {
  font-size: 15px;
  font-weight: 850;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 神曲循环与夜间专属双高亮卡 */
.mst-highlight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

@media (max-width: 720px) {
  .mst-highlight-grid {
    grid-template-columns: 1fr;
  }
}

.mst-highlight-card {
  position: relative;
  overflow: hidden;
  border-radius: 18px;
  padding: 18px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.16));
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.06));
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 4px 16px -4px rgba(0, 0, 0, 0.05);
}

.mst-highlight-card.loop {
  background: linear-gradient(135deg, color-mix(in srgb, #f59e0b 8%, var(--color-bg-elevated, rgba(148, 163, 184, 0.06))) 0%, var(--color-bg-elevated, rgba(148, 163, 184, 0.06)) 100%);
  border-color: color-mix(in srgb, #f59e0b 25%, transparent);
}

.mst-highlight-card.night {
  background: linear-gradient(135deg, color-mix(in srgb, #8b5cf6 8%, var(--color-bg-elevated, rgba(148, 163, 184, 0.06))) 0%, var(--color-bg-elevated, rgba(148, 163, 184, 0.06)) 100%);
  border-color: color-mix(in srgb, #8b5cf6 25%, transparent);
}

.mst-highlight-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.1);
}

.mst-highlight-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  flex: 1;
}

.mst-highlight-tag {
  font-size: 11px;
  font-weight: 750;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mst-highlight-card.loop .mst-highlight-tag {
  color: #f59e0b;
}

.mst-highlight-card.night .mst-highlight-tag {
  color: #a78bfa;
}

.mst-highlight-title {
  font-size: 16px;
  font-weight: 850;
  color: var(--color-text-main, #f8fafc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s;
}

.mst-highlight-title:hover {
  color: var(--color-primary, #31cfa1);
}

.mst-highlight-sub {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
  display: flex;
  align-items: center;
  gap: 8px;
}

.mst-highlight-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.12));
}

.mst-play-circle-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.2));
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.1));
  color: var(--color-text-main, #f8fafc);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.mst-play-circle-btn:hover {
  background: var(--color-primary, #31cfa1);
  color: var(--color-on-primary, #0f172a);
  border-color: var(--color-primary, #31cfa1);
  transform: scale(1.08);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--color-primary, #31cfa1) 40%, transparent);
}

/* 卡片网格布局 */
.mst-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
  align-items: start;
}

.mst-grid > .mst-full {
  grid-column: 1 / -1;
}

@media (min-width: 960px) {
  .mst-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .mst-grid .mst-chart-scroll svg {
    min-width: 0;
  }
}

/* 通用容器卡片 */
.mst-card {
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.14));
  border-radius: 18px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.05));
  padding: 20px 22px;
  min-width: 0;
  box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.04);
}

.mst-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.mst-card-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mst-card-icon-pill {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 14%, transparent);
  color: var(--color-primary, #31cfa1);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.mst-card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 800;
  color: var(--color-text-main, #f8fafc);
  letter-spacing: -0.01em;
}

.mst-card-sub {
  margin: 2px 0 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.75));
}

.mst-chart-scroll {
  overflow-x: auto;
}

.mst-chart-scroll svg {
  display: block;
  min-width: 480px;
}

/* 365天热力图 */
.mst-heatmap-stats {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.mst-stat-tag {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 8px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.08));
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.1));
}

.mst-stat-tag strong {
  color: var(--color-primary, #31cfa1);
  font-weight: 850;
}

.mst-heatmap-wrap {
  overflow-x: auto;
  padding: 8px 0;
}

.mst-heatmap-wrap svg {
  display: block;
  min-width: 780px;
}

.mst-heatmap-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.08));
  font-size: 11px;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.8));
}

.mst-heatmap-legend {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mst-heatmap-legend-box {
  width: 10.5px;
  height: 10.5px;
  border-radius: 2.5px;
}

/* 24小时音乐生物钟 */
.mst-circadian-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 800px) {
  .mst-circadian-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.mst-circadian-card {
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.05));
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.12));
  border-radius: 14px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  overflow: hidden;
  transition: all 0.2s ease;
}

.mst-circadian-card.period-morning {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.06) 0%, var(--color-bg-elevated, rgba(148, 163, 184, 0.04)) 100%);
  border-color: rgba(245, 158, 11, 0.18);
}
.mst-circadian-card.period-work {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.06) 0%, var(--color-bg-elevated, rgba(148, 163, 184, 0.04)) 100%);
  border-color: rgba(14, 165, 233, 0.18);
}
.mst-circadian-card.period-dusk {
  background: linear-gradient(135deg, rgba(244, 63, 94, 0.06) 0%, var(--color-bg-elevated, rgba(148, 163, 184, 0.04)) 100%);
  border-color: rgba(244, 63, 94, 0.18);
}
.mst-circadian-card.period-night {
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.06) 0%, var(--color-bg-elevated, rgba(148, 163, 184, 0.04)) 100%);
  border-color: rgba(139, 92, 246, 0.18);
}

.mst-circadian-card.mst-peak {
  box-shadow: 0 4px 18px -2px color-mix(in srgb, var(--color-primary, #31cfa1) 22%, transparent);
  border-color: color-mix(in srgb, var(--color-primary, #31cfa1) 45%, transparent);
}

.mst-circadian-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mst-circadian-name {
  font-size: 13px;
  font-weight: 750;
  color: var(--color-text-main, #f8fafc);
  display: flex;
  align-items: center;
  gap: 6px;
}

.mst-circadian-peak-badge {
  font-size: 10px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-primary, #31cfa1);
  color: var(--color-on-primary, #0f172a);
  box-shadow: 0 2px 6px color-mix(in srgb, var(--color-primary, #31cfa1) 40%, transparent);
}

.mst-circadian-time {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.75));
}

.mst-circadian-percent {
  font-size: 22px;
  font-weight: 850;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-main, #f8fafc);
}

.mst-circadian-bar-bg {
  height: 5px;
  border-radius: 999px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.12));
  overflow: hidden;
}

.mst-circadian-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s ease;
}

.period-morning .mst-circadian-bar-fill { background: #f59e0b; }
.period-work .mst-circadian-bar-fill { background: #0ea5e9; }
.period-dusk .mst-circadian-bar-fill { background: #f43f5e; }
.period-night .mst-circadian-bar-fill { background: #8b5cf6; }

.mst-circadian-plays {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.7));
}

/* 听歌个性成就徽章 */
.mst-badges-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 900px) {
  .mst-badges-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 540px) {
  .mst-badges-grid {
    grid-template-columns: 1fr;
  }
}

.mst-badge-card {
  border-radius: 14px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.14));
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.05));
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.mst-badge-card.unlocked {
  border-color: color-mix(in srgb, var(--color-primary, #31cfa1) 38%, transparent);
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary, #31cfa1) 8%, var(--color-bg-elevated, rgba(148, 163, 184, 0.05))) 0%, var(--color-bg-elevated, rgba(148, 163, 184, 0.05)) 100%);
  box-shadow: 0 4px 14px -3px color-mix(in srgb, var(--color-primary, #31cfa1) 15%, transparent);
}

.mst-badge-card.locked {
  opacity: 0.6;
  filter: grayscale(0.5);
  border-style: dashed;
}

.mst-badge-card:hover {
  transform: translateY(-2px);
}

.mst-badge-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.1));
  flex-shrink: 0;
}

.unlocked .mst-badge-icon {
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 18%, transparent);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--color-primary, #31cfa1) 25%, transparent);
}

.mst-badge-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.mst-badge-title {
  font-size: 13.5px;
  font-weight: 800;
  color: var(--color-text-main, #f8fafc);
}

.mst-badge-desc {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.8));
  line-height: 1.3;
}

.mst-badge-status {
  font-size: 10.5px;
  font-weight: 750;
  margin-top: 2px;
}

.unlocked .mst-badge-status {
  color: var(--color-primary, #31cfa1);
}

.locked .mst-badge-status {
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.7));
}

/* Top 歌手横向排行 */
.mst-bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mst-bar-row {
  display: grid;
  grid-template-columns: 24px 100px 1fr 76px;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border-radius: 10px;
  transition: background 0.15s ease;
}

.mst-bar-row.no-rank {
  grid-template-columns: 110px 1fr 76px;
}

.mst-bar-row:hover {
  background: var(--control-hover-bg, rgba(148, 163, 184, 0.08));
}

.mst-bar-rank {
  font-size: 12px;
  font-weight: 850;
  text-align: center;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.7));
}

.mst-rank-1 {
  color: #f59e0b;
  font-weight: 900;
}
.mst-rank-2 {
  color: #94a3b8;
  font-weight: 900;
}
.mst-rank-3 {
  color: #d97706;
  font-weight: 900;
}

.mst-bar-name {
  font-size: 13px;
  font-weight: 750;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-bar-track {
  height: 8px;
  border-radius: 999px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.12));
  overflow: hidden;
}

.mst-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--color-primary, #31cfa1), #38bdf8);
  transition: width 0.35s ease;
}

.mst-bar-val {
  font-size: 11.5px;
  font-weight: 750;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* Top 歌曲列表 */
.mst-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  padding: 3px;
  border-radius: 10px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.08));
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.1));
}

.mst-tab-btn {
  background: transparent;
  border: none;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.mst-tab-btn:hover {
  color: var(--color-text-main, #f8fafc);
}

.mst-tab-btn.active {
  background: var(--color-bg-elevated, #fff);
  color: var(--color-primary, #31cfa1);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
}

.mst-songs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mst-song-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 10px;
  transition: background 0.15s ease;
  position: relative;
}

.mst-song-row:hover {
  background: var(--control-hover-bg, rgba(148, 163, 184, 0.1));
}

.mst-song-rank {
  width: 24px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 850;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.7));
  text-align: center;
}

.mst-song-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mst-song-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.15s;
}

.mst-song-row:hover .mst-song-title {
  color: var(--color-primary, #31cfa1);
}

.mst-song-artist {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.7));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-song-meta {
  flex-shrink: 0;
  text-align: right;
  font-size: 11.5px;
  font-weight: 750;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.mst-song-play-icon {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-primary, #31cfa1);
  color: var(--color-on-primary, #0f172a);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: scale(0.85);
  transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  margin-left: 4px;
  flex-shrink: 0;
}

.mst-song-row:hover .mst-song-play-icon {
  opacity: 1;
  transform: scale(1);
}

/* 音源 donut + 图例 */
.mst-donut-wrap {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
  padding: 6px 0 14px;
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
  padding: 4px 8px;
  border-radius: 8px;
  transition: background 0.12s;
}

.mst-legend-item:hover {
  background: var(--control-hover-bg, rgba(148, 163, 184, 0.08));
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
  font-size: 12.5px;
  font-weight: 700;
  color: var(--color-text-main, #f8fafc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-legend-val {
  font-size: 11.5px;
  font-weight: 750;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.85));
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 空态 / 加载 / 错误 */
.mst-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 72px 24px;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  text-align: center;
}

.mst-state p {
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
}

/* 设置面板 */
.mst-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 780px;
}

.mst-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-radius: 14px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.05));
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.12));
}

.mst-setting-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mst-setting-label {
  font-size: 13.5px;
  font-weight: 800;
  color: var(--color-text-main, #f8fafc);
}

.mst-setting-hint {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.8));
}

.mst-setting-select {
  width: 132px;
}

.mst-backup-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.mst-danger-zone {
  border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, #ef4444 6%, transparent);
  padding: 16px 18px;
}

/* 动效 */
@keyframes mstFadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes mstSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.mst-spin {
  animation: mstSpin 0.9s linear infinite;
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
      ? [{ x: xAt(0), label: String(rows[0]?.bucket ?? '') }]
      : [
          { x: xAt(0), label: String(rows[0]?.bucket ?? '') },
          { x: xAt(Math.floor((n - 1) / 2)), label: String(rows[Math.floor((n - 1) / 2)]?.bucket ?? '') },
          { x: xAt(n - 1), label: String(rows[n - 1]?.bucket ?? '') },
        ];

  const gradId = 'mst-trend-grad';
  return h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '听歌时长趋势' }, [
    h('defs', null, [
      h('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' }, [
        h('stop', { offset: '0%', 'stop-color': 'var(--color-primary, #31cfa1)', 'stop-opacity': '0.32' }),
        h('stop', { offset: '100%', 'stop-color': 'var(--color-primary, #31cfa1)', 'stop-opacity': '0' }),
      ]),
    ]),
    ...gridTicks.map((t) => [
      h('line', { x1: PAD_L, x2: W - PAD_R, y1: t.y, y2: t.y, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.5, style: { stroke: chartGrid } }),
      h('text', { x: PAD_L - 8, y: t.y + 4, 'font-size': 10.5, 'text-anchor': 'end', style: { fill: chartText } }, t.label),
    ]).flat(),
    areaPath
      ? h('path', { d: areaPath, stroke: 'none', fill: `url(#${gradId})` })
      : null,
    h('path', { d: linePath, fill: 'none', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', style: { stroke: chartStroke } }),
    ...pts.map((p, i) =>
      h('circle', { cx: p.x, cy: p.y, r: 3.5, style: { fill: chartStroke, cursor: 'pointer' } }, [
        h('title', null, `${rows[i]?.bucket}: ${formatMsShort(Number(rows[i]?.ms) || 0)}`),
      ]),
    ),
    ...xLabels.map((l) =>
      h('text', { x: l.x, y: H - 8, 'font-size': 10.5, 'text-anchor': 'middle', style: { fill: chartText } }, l.label),
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
    const isPeak = val === maxPlays && val > 0;
    bars.push(
      h('rect', {
        x: x.toFixed(1),
        y: (PAD_T + innerH - hgt).toFixed(1),
        width: barW.toFixed(1),
        height: hgt.toFixed(1),
        rx: 3,
        ry: 3,
        opacity: isPeak ? 1 : val > 0 ? 0.8 : 0.15,
        style: { fill: chartStroke, cursor: 'pointer' },
      }, [
        h('title', null, `${hour}:00 - ${hour}:59: ${val} 次播放`),
      ]),
    );
  }

  const ticks = [0, 6, 12, 18, 23].map((hour) => ({
    x: PAD_L + hour * slot + slot / 2,
    label: `${hour}时`,
  }));

  return h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '每日时段分布' }, [
    h('line', { x1: PAD_L, x2: W - PAD_R, y1: PAD_T + innerH, y2: PAD_T + innerH, 'stroke-width': 1, style: { stroke: chartGrid, opacity: 0.6 } }),
    ...bars,
    ...ticks.map((t) => h('text', { x: t.x, y: H - 8, 'font-size': 10.5, 'text-anchor': 'middle', style: { fill: chartText } }, t.label)),
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
    h('text', { x: c, y: c - 2, 'font-size': 22, 'font-weight': 850, 'text-anchor': 'middle', style: { fill: 'var(--color-text-main, #f8fafc)' } }, String(total)),
    h('text', { x: c, y: c + 16, 'font-size': 10.5, 'text-anchor': 'middle', style: { fill: chartText } }, '总播放次数'),
  ]);
};

// 365天听歌热力图（GitHub 矩阵风，52列 x 7行）
const renderHeatmapChart = (h, rows) => {
  const byDay = new Map(rows.map((r) => [String(r.day), { plays: Number(r.plays) || 0, ms: Number(r.ms) || 0 }]));
  const today = new Date();
  const days = [];
  const start = new Date(today);
  start.setDate(today.getDate() - 364);
  const startDayOfWeek = start.getDay();
  const curr = new Date(start);
  curr.setDate(curr.getDate() - startDayOfWeek);

  while (curr <= today) {
    days.push(new Date(curr));
    curr.setDate(curr.getDate() + 1);
  }

  let activeDays = 0;
  let totalYearPlays = 0;
  let totalYearMs = 0;
  rows.forEach((r) => {
    const p = Number(r.plays) || 0;
    if (p > 0) {
      activeDays += 1;
      totalYearPlays += p;
      totalYearMs += Number(r.ms) || 0;
    }
  });

  const cellSize = 11.5;
  const gap = 3.5;
  const padL = 34;
  const padT = 22;
  const weeks = Math.ceil(days.length / 7);
  const totalW = padL + weeks * (cellSize + gap) + 10;
  const totalH = padT + 7 * (cellSize + gap) + 16;

  const rects = [];
  const monthLabels = [];
  let lastMonth = -1;

  days.forEach((d, idx) => {
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const dayStr = formatDay(d);
    const stat = byDay.get(dayStr) || { plays: 0, ms: 0 };
    const plays = stat.plays;

    if (row === 0 && d.getMonth() !== lastMonth && col < weeks - 1) {
      lastMonth = d.getMonth();
      monthLabels.push(
        h(
          'text',
          {
            x: padL + col * (cellSize + gap),
            y: padT - 6,
            'font-size': 10,
            style: { fill: chartText },
          },
          `${lastMonth + 1}月`,
        ),
      );
    }

    let fillColor = 'rgba(148, 163, 184, 0.09)';
    if (plays >= 12) fillColor = 'var(--color-primary, #31cfa1)';
    else if (plays >= 6) fillColor = 'color-mix(in srgb, var(--color-primary, #31cfa1) 76%, transparent)';
    else if (plays >= 3) fillColor = 'color-mix(in srgb, var(--color-primary, #31cfa1) 52%, transparent)';
    else if (plays >= 1) fillColor = 'color-mix(in srgb, var(--color-primary, #31cfa1) 28%, transparent)';

    rects.push(
      h(
        'rect',
        {
          x: padL + col * (cellSize + gap),
          y: padT + row * (cellSize + gap),
          width: cellSize,
          height: cellSize,
          rx: 2.5,
          style: { fill: fillColor, cursor: 'pointer' },
        },
        [
          h('title', null, `${dayStr}：${plays} 次播放 · ${formatMsShort(stat.ms)}`),
        ],
      ),
    );
  });

  const weekLabels = [
    { row: 1, text: '一' },
    { row: 3, text: '三' },
    { row: 5, text: '五' },
  ].map((w) =>
    h(
      'text',
      {
        x: padL - 8,
        y: padT + w.row * (cellSize + gap) + 9,
        'font-size': 9.5,
        'text-anchor': 'end',
        style: { fill: chartText },
      },
      w.text,
    ),
  );

  return h('div', null, [
    h('div', { class: 'mst-heatmap-stats' }, [
      h('div', { class: 'mst-stat-tag' }, [
        h('span', null, '累计活跃：'),
        h('strong', null, `${activeDays} 天`),
      ]),
      h('div', { class: 'mst-stat-tag' }, [
        h('span', null, '年度总播放：'),
        h('strong', null, `${totalYearPlays} 次`),
      ]),
      h('div', { class: 'mst-stat-tag' }, [
        h('span', null, '累计实听：'),
        h('strong', null, formatMsShort(totalYearMs)),
      ]),
    ]),
    h('div', { class: 'mst-heatmap-wrap' }, [
      h(
        'svg',
        {
          viewBox: `0 0 ${totalW} ${totalH}`,
          width: totalW,
          height: totalH,
          role: 'img',
          'aria-label': '365天听歌热力图',
        },
        [...monthLabels, ...weekLabels, ...rects],
      ),
    ]),
    h('div', { class: 'mst-heatmap-footer' }, [
      h('span', null, '提示：鼠标悬停任意色块可查看当日听歌次数与实听时长'),
      h('div', { class: 'mst-heatmap-legend' }, [
        h('span', null, '少'),
        h('span', { class: 'mst-heatmap-legend-box', style: 'background: rgba(148, 163, 184, 0.09);' }),
        h('span', { class: 'mst-heatmap-legend-box', style: 'background: color-mix(in srgb, var(--color-primary, #31cfa1) 28%, transparent);' }),
        h('span', { class: 'mst-heatmap-legend-box', style: 'background: color-mix(in srgb, var(--color-primary, #31cfa1) 52%, transparent);' }),
        h('span', { class: 'mst-heatmap-legend-box', style: 'background: color-mix(in srgb, var(--color-primary, #31cfa1) 76%, transparent);' }),
        h('span', { class: 'mst-heatmap-legend-box', style: 'background: var(--color-primary, #31cfa1);' }),
        h('span', null, '多'),
      ]),
    ]),
  ]);
};

// 24小时音乐生物钟
const renderCircadianClock = (h, rows) => {
  const byHour = new Map(rows.map((r) => [Number(r.hour), Number(r.plays) || 0]));
  const sumRange = (start, end) => {
    let s = 0;
    for (let i = start; i <= end; i++) s += byHour.get(i) || 0;
    return s;
  };

  const morning = sumRange(6, 10);
  const work = sumRange(11, 17);
  const dusk = sumRange(18, 21);
  const night = sumRange(22, 23) + sumRange(0, 5);
  const total = Math.max(1, morning + work + dusk + night);

  const periods = [
    { id: 'morning', name: '清晨启程', time: '06:00 - 11:00', icon: '🌅', plays: morning, cls: 'period-morning' },
    { id: 'work', name: '专注工作', time: '11:00 - 18:00', icon: '💼', plays: work, cls: 'period-work' },
    { id: 'dusk', name: '暮光晚霞', time: '18:00 - 22:00', icon: '🌆', plays: dusk, cls: 'period-dusk' },
    { id: 'night', name: '深夜漫游', time: '22:00 - 06:00', icon: '🌌', plays: night, cls: 'period-night' },
  ];

  const maxPlays = Math.max(1, ...periods.map((p) => p.plays));

  return h('div', { class: 'mst-circadian-grid' }, [
    ...periods.map((p) => {
      const pct = Math.round((p.plays / total) * 100);
      const isPeak = p.plays === maxPlays && p.plays > 0;
      return h(
        'div',
        { class: ['mst-circadian-card', p.cls, isPeak ? 'mst-peak' : ''] },
        [
          h('div', { class: 'mst-circadian-head' }, [
            h('span', { class: 'mst-circadian-name' }, [
              h('span', null, p.icon),
              h('span', null, p.name),
            ]),
            isPeak ? h('span', { class: 'mst-circadian-peak-badge' }, '✦ 峰值活跃') : null,
          ]),
          h('div', { class: 'mst-circadian-time' }, p.time),
          h('div', { class: 'mst-circadian-percent' }, `${pct}%`),
          h('div', { class: 'mst-circadian-bar-bg' }, [
            h('div', { class: 'mst-circadian-bar-fill', style: { width: `${pct}%` } }),
          ]),
          h('div', { class: 'mst-circadian-plays' }, `${p.plays} 次播放`),
        ],
      );
    }),
  ]);
};

// 听歌画像个性成就徽章
const renderBadges = (h, data) => {
  const totalPlays = Number(data?.kpi?.n || 0);
  const totalMs = Number(data?.kpi?.ms || 0);
  const artistsCount = Number(data?.kpi?.artists || 0);
  const hours = data?.hours || [];
  const loopSong = data?.loopSong;
  const qualities = data?.qualities || [];

  let nightPlays = 0;
  hours.forEach((r) => {
    const hr = Number(r.hour);
    if (hr >= 0 && hr < 6) nightPlays += Number(r.plays || 0);
  });
  const nightRate = totalPlays > 0 ? nightPlays / totalPlays : 0;

  let hiresPlays = 0;
  qualities.forEach((q) => {
    const name = String(q.quality || '').toLowerCase();
    if (name.includes('flac') || name.includes('hires') || name.includes('sq') || name.includes('atmos')) {
      hiresPlays += Number(q.plays || 0);
    }
  });
  const hiresRate = totalPlays > 0 ? hiresPlays / totalPlays : 0;

  const sumH = (s, e) => {
    let cnt = 0;
    for (let i = s; i <= e; i++) {
      const row = hours.find((h) => Number(h.hour) === i);
      if (row) cnt += Number(row.plays || 0);
    }
    return cnt;
  };
  const mPlays = sumH(6, 10);
  const wPlays = sumH(11, 17);
  const dPlays = sumH(18, 21);
  const nPlays = sumH(22, 23) + sumH(0, 5);
  const allSeason =
    totalPlays >= 15 &&
    mPlays / totalPlays >= 0.05 &&
    wPlays / totalPlays >= 0.05 &&
    dPlays / totalPlays >= 0.05 &&
    nPlays / totalPlays >= 0.05;

  const badges = [
    {
      id: 'night',
      icon: '🌙',
      title: '深夜哲学家',
      desc: '凌晨 0-6 点听歌占比 > 20%',
      unlocked: nightRate >= 0.2 && nightPlays >= 5,
    },
    {
      id: 'lossless',
      icon: '🎧',
      title: '无损发烧友',
      desc: 'SQ / Hi-Res / 杜比全景声占比 > 40%',
      unlocked: hiresRate >= 0.4 && hiresPlays >= 5,
    },
    {
      id: 'loop',
      icon: '🔁',
      title: '专一单曲狂人',
      desc: '单曲单日循环播放 >= 5 次',
      unlocked: Boolean(loopSong && Number(loopSong.daily_plays) >= 5),
    },
    {
      id: 'diverse',
      icon: '🌍',
      title: '百家争鸣',
      desc: '收听去重歌手 >= 20 位',
      unlocked: artistsCount >= 20,
    },
    {
      id: 'marathon',
      icon: '🏃',
      title: '音乐马拉松',
      desc: '累计实听时长 >= 30 小时',
      unlocked: totalMs >= 30 * 3600 * 1000,
    },
    {
      id: 'all_day',
      icon: '🕊️',
      title: '全天候候鸟',
      desc: '晨、昼、暮、夜皆有音乐相伴',
      unlocked: allSeason,
    },
  ];

  return h('div', { class: 'mst-badges-grid' }, [
    ...badges.map((b) =>
      h('div', { class: ['mst-badge-card', b.unlocked ? 'unlocked' : 'locked'], key: b.id }, [
        h('div', { class: 'mst-badge-icon' }, b.icon),
        h('div', { class: 'mst-badge-info' }, [
          h('div', { class: 'mst-badge-title' }, b.title),
          h('div', { class: 'mst-badge-desc' }, b.desc),
          h(
            'div',
            { class: 'mst-badge-status' },
            b.unlocked ? '已点亮 ✦' : '未解锁 🔒',
          ),
        ]),
      ]),
    ),
  ]);
};

// 神曲循环狂热与深夜专属
const renderHighlights = (h, loopSong, nightSong, ctx) => {
  if (!loopSong && !nightSong) return null;
  return h('div', { class: 'mst-highlight-grid' }, [
    loopSong
      ? h('div', { class: 'mst-highlight-card loop' }, [
          h('div', { class: 'mst-highlight-main' }, [
            h('div', { class: 'mst-highlight-tag' }, [
              h('span', null, '🔥'),
              h('span', null, '单日循环神曲'),
              h('span', { class: 'mst-highlight-pill' }, loopSong.day),
            ]),
            h(
              'div',
              {
                class: 'mst-highlight-title',
                title: '点击播放此歌曲',
                onClick: () => {
                  if (loopSong.track_id) {
                    if (ctx?.player?.playTrack) void ctx.player.playTrack(loopSong.track_id);
                    else if (ctx?.player?.play) void ctx.player.play(loopSong.track_id);
                  }
                },
              },
              String(loopSong.title),
            ),
            h(
              'div',
              { class: 'mst-highlight-sub' },
              `${loopSong.artist} · 单日高频循环 ${loopSong.daily_plays} 次`,
            ),
          ]),
          loopSong.track_id
            ? h(
                'button',
                {
                  class: 'mst-play-circle-btn',
                  title: '立即播放',
                  onClick: () => {
                    if (ctx?.player?.playTrack) void ctx.player.playTrack(loopSong.track_id);
                    else if (ctx?.player?.play) void ctx.player.play(loopSong.track_id);
                  },
                },
                [h('span', { style: 'font-size: 13px; margin-left: 2px;' }, '▶')],
              )
            : null,
        ])
      : null,
    nightSong
      ? h('div', { class: 'mst-highlight-card night' }, [
          h('div', { class: 'mst-highlight-main' }, [
            h('div', { class: 'mst-highlight-tag' }, [
              h('span', null, '🌌'),
              h('span', null, '深夜灵魂单曲 (00:00-06:00)'),
            ]),
            h(
              'div',
              {
                class: 'mst-highlight-title',
                title: '点击播放此歌曲',
                onClick: () => {
                  if (nightSong.track_id) {
                    if (ctx?.player?.playTrack) void ctx.player.playTrack(nightSong.track_id);
                    else if (ctx?.player?.play) void ctx.player.play(nightSong.track_id);
                  }
                },
              },
              String(nightSong.title),
            ),
            h(
              'div',
              { class: 'mst-highlight-sub' },
              `${nightSong.artist} · 深夜静听 ${nightSong.night_plays} 次`,
            ),
          ]),
          nightSong.track_id
            ? h(
                'button',
                {
                  class: 'mst-play-circle-btn',
                  title: '立即播放',
                  onClick: () => {
                    if (ctx?.player?.playTrack) void ctx.player.playTrack(nightSong.track_id);
                    else if (ctx?.player?.play) void ctx.player.play(nightSong.track_id);
                  },
                },
                [h('span', { style: 'font-size: 13px; margin-left: 2px;' }, '▶')],
              )
            : null,
        ])
      : null,
  ]);
};

// 音质与音效画像
const renderQualityAndEffects = (h, qualities, effects) => {
  const totalQ = qualities.reduce((acc, it) => acc + Number(it.plays || 0), 0);
  const totalE = effects.reduce((acc, it) => acc + Number(it.plays || 0), 0);
  const qualityMap = {
    '128k': '标准 (128k)',
    '320k': '高质量 (320k)',
    flac: '无损 SQ (FLAC)',
    hires: 'Hi-Res 高解析',
    viper_atmos: '杜比全景声',
  };
  const qualityColorMap = {
    hires: '#f59e0b',
    flac: '#06b6d4',
    viper_atmos: '#a855f7',
    '320k': '#10b981',
    '128k': '#94a3b8',
  };
  const effectMap = {
    vinyl: '黑胶唱机',
    pure_vocal: '纯净人声',
    surround: '全景环绕',
    bass: '超重低音',
  };
  const effectColorMap = {
    vinyl: '#f43f5e',
    pure_vocal: '#0ea5e9',
    surround: '#8b5cf6',
    bass: '#f59e0b',
  };

  return h('div', { class: 'mst-bars' }, [
    qualities.length > 0
      ? [
          h('div', { class: 'mst-card-title', style: 'font-size: 13px; margin-top: 10px;' }, '音质分布画像'),
          ...qualities.slice(0, 4).map((q) => {
            const plays = Number(q.plays || 0);
            const pct = totalQ > 0 ? Math.round((plays / totalQ) * 100) : 0;
            const label = qualityMap[q.quality] || q.quality;
            const barColor = qualityColorMap[q.quality] || 'var(--color-primary, #31cfa1)';
            return h('div', { class: 'mst-bar-row no-rank', key: q.quality }, [
              h('span', { class: 'mst-bar-name', title: label }, label),
              h('div', { class: 'mst-bar-track' }, [
                h('div', { class: 'mst-bar-fill', style: { width: `${pct}%`, background: barColor } }),
              ]),
              h('span', { class: 'mst-bar-val' }, `${pct}% (${plays}次)`),
            ]);
          }),
        ]
      : null,
    effects.length > 0
      ? [
          h('div', { class: 'mst-card-title', style: 'font-size: 13px; margin-top: 14px;' }, '音效搭配偏好'),
          ...effects.slice(0, 4).map((e) => {
            const plays = Number(e.plays || 0);
            const pct = totalE > 0 ? Math.round((plays / totalE) * 100) : 0;
            const label = effectMap[e.effect] || e.effect;
            const barColor = effectColorMap[e.effect] || '#818cf8';
            return h('div', { class: 'mst-bar-row no-rank', key: e.effect }, [
              h('span', { class: 'mst-bar-name', title: label }, label),
              h('div', { class: 'mst-bar-track' }, [
                h('div', { class: 'mst-bar-fill', style: { width: `${pct}%`, background: barColor } }),
              ]),
              h('span', { class: 'mst-bar-val' }, `${pct}% (${plays}次)`),
            ]);
          }),
        ]
      : null,
  ]);
};

// ---- 报告页 ----

const createReportPage = (ctx) => {
  const { h, defineComponent, ref, watch, onMounted, resolveComponent, defineAsyncComponent } =
    ctx.vue;
  const PageScrollContainer = defineAsyncComponent(ctx.ui.components.PageScrollContainer);

  const sectionTitle = (Icon, icon, title, sub, extra) =>
    h('div', { class: 'mst-card-head' }, [
      h('div', { class: 'mst-card-head-left' }, [
        h('div', { class: 'mst-card-icon-pill' }, [
          h(Icon, { icon, width: 16, height: 16 }),
        ]),
        h('div', null, [
          h('h3', { class: 'mst-card-title' }, title),
          sub ? h('p', { class: 'mst-card-sub' }, sub) : null,
        ]),
      ]),
      extra || null,
    ]);

  return defineComponent({
    name: 'music-stats-report',
    setup() {
      const Icon = resolveComponent('Icon');

      const range = ref('month');
      const songTab = ref('top');
      const customStart = ref('');
      const customEnd = ref('');
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
          report.value = await queryReport(
            db,
            getRangeMs(range.value, customStart.value, customEnd.value),
            trendGranularity(range.value),
          );
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
        const isMonthly = range.value === 'year' || range.value === 'all';

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
                h('div', { class: 'mst-header-icon-box' }, [
                  h(Icon, { icon: ctx.icons.iconPulse, width: 22, height: 22 }),
                ]),
                h('div', { class: 'mst-header-info' }, [
                  h('div', { class: 'mst-title-row' }, [
                    h('h1', { class: 'mst-title' }, '听歌数据画像'),
                    h('span', { class: 'mst-privacy-badge' }, [
                      h(Icon, { icon: ctx.icons.iconShield || ctx.icons.iconCheck, width: 12, height: 12 }),
                      h('span', null, '纯本地存储 · 零隐私上传'),
                    ]),
                  ]),
                  h('p', { class: 'mst-subtitle' }, '全方位回溯你的音乐足迹、聆听习惯与时空偏好'),
                ]),
              ]),
              // 工具栏：分段选择器 + 刷新按钮
              h('div', { class: 'mst-toolbar' }, [
                h('div', { class: 'mst-segmented' }, [
                  ...RANGE_OPTIONS.map((opt) =>
                    h(
                      'button',
                      {
                        key: opt.key,
                        class: ['mst-seg-btn', range.value === opt.key ? 'active' : ''],
                        onClick: () => {
                          range.value = opt.key;
                        },
                      },
                      opt.label,
                    ),
                  ),
                ]),
                h(
                  'button',
                  { class: 'mst-btn-action', onClick: load, title: '刷新统计数据' },
                  [
                    h(Icon, { icon: ctx.icons.iconRefreshCw, width: 13, height: 13, class: loading.value ? 'mst-spin' : '' }),
                    '刷新',
                  ],
                ),
              ]),
            ]),

            range.value === 'custom'
              ? h('div', { class: 'mst-custom-range' }, [
                  h('span', { class: 'mst-card-sub', style: 'margin: 0; font-weight: 700;' }, '自定义时间区间：'),
                  h('input', {
                    type: 'date',
                    class: 'mst-date-input',
                    value: customStart.value,
                    onChange: (e) => {
                      customStart.value = e.target.value;
                    },
                  }),
                  h('span', { class: 'mst-card-sub', style: 'margin: 0;' }, '至'),
                  h('input', {
                    type: 'date',
                    class: 'mst-date-input',
                    value: customEnd.value,
                    onChange: (e) => {
                      customEnd.value = e.target.value;
                    },
                  }),
                  h(
                    'button',
                    { class: 'mst-btn-action', style: 'padding: 5px 12px;', onClick: load },
                    '应用筛选',
                  ),
                ])
              : null,

            loading.value && !data
              ? h('div', { class: 'mst-card' }, [
                  h('div', { class: 'mst-state' }, [
                    h(Icon, { icon: ctx.icons.iconRefreshCw, width: 36, height: 36, class: 'mst-spin', style: 'color: var(--color-primary, #31cfa1);' }),
                    h('p', null, '正在深入解析听歌数据…'),
                  ]),
                ])
              : error.value && !data
                ? h('div', { class: 'mst-card' }, [
                    h('div', { class: 'mst-state' }, [
                      h(Icon, { icon: ctx.icons.iconTriangleAlert || ctx.icons.iconInfo, width: 44, height: 44, style: 'color: #f43f5e;' }),
                      h('p', null, error.value),
                    ]),
                  ])
                : isEmpty
                  ? h('div', { class: 'mst-card' }, [
                      h('div', { class: 'mst-state' }, [
                        h(Icon, { icon: ctx.icons.iconMusic, width: 56, height: 56, style: 'opacity: 0.5;' }),
                        h('p', null, '所选时间区间内暂无听歌记录，放首歌静静聆听吧'),
                      ]),
                    ])
                  : [
                      // 年度报告（今年才显示）
                      annual
                        ? h('div', { class: 'mst-annual' }, [
                            h('div', { class: 'mst-annual-head' }, [
                              h('div', { class: 'mst-annual-head-left' }, [
                                h(Icon, { icon: ctx.icons.iconSparkles || ctx.icons.iconStar, width: 22, height: 22 }),
                                h('h2', { class: 'mst-annual-title' }, '年度音乐足迹报告'),
                              ]),
                              h('span', { class: 'mst-annual-badge' }, `${new Date().getFullYear()} 年度专属`),
                            ]),
                            h('div', { class: 'mst-annual-grid' }, [
                              annualItem(h, '年度实听总时长', formatMsShort(annual.totalMs)),
                              annualItem(h, '年度总播放次数', `${annual.totalPlays} 次`),
                              annualItem(h, '年度最爱歌手', annual.topArtist || '—'),
                              annualItem(h, '年度最爱单曲', annual.topSong || '—'),
                              annualItem(h, '最活跃音乐月份', annual.activeMonth ? `${annual.activeMonth} 月` : '—'),
                              annualItem(h, '日均听歌时长', formatMsShort(annual.avgPerDay)),
                            ]),
                          ])
                        : null,

                      // KPI 核心指标卡片
                      (() => {
                        const totalPlays = Number(data.kpi.n) || 0;
                        const compCount = Number(data.kpi.completed_count) || 0;
                        const skipCount = Number(data.kpi.skipped_count) || 0;
                        const compPct = totalPlays > 0 ? Math.round((compCount / totalPlays) * 100) : 0;
                        const skipPct = totalPlays > 0 ? Math.round((skipCount / totalPlays) * 100) : 0;

                        return h('div', { class: 'mst-kpis' }, [
                          kpiCard(h, '累计听歌时长', formatMsShort(Number(data.kpi.ms) || 0), '⏱️', '有效实听时长'),
                          kpiCard(h, '累计播放次数', `${totalPlays} 次`, '🎵', '达标计入次数'),
                          kpiCard(h, '完播率', `${compPct}%`, '🎧', `${compCount} 次完整听完`, compPct, false),
                          kpiCard(h, '切歌跳过率', `${skipPct}%`, '⏭️', `${skipCount} 次快速跳过`, skipPct, true),
                          kpiCard(h, '去重曲目', `${Number(data.kpi.songs) || 0} 首`, '🎼', '收听不同单曲'),
                          kpiCard(h, '去重歌手', `${Number(data.kpi.artists) || 0} 位`, '🎤', '探索音乐人谱系'),
                        ]);
                      })(),

                      // 神曲循环与夜间专属
                      renderHighlights(h, data.loopSong, data.nightSong, ctx),

                      // 卡片区：趋势整行，其余两两并排
                      h('div', { class: 'mst-grid' }, [
                        // 365天听歌热力图（整行）
                        data.heatmap && data.heatmap.length > 0
                          ? h('div', { class: 'mst-card mst-full' }, [
                              sectionTitle(
                                Icon,
                                ctx.icons.iconCalendar || ctx.icons.iconClock,
                                '365天听歌足迹热力图',
                                '全景回溯过去一年每一天的听歌频次与活跃深浅分布',
                              ),
                              renderHeatmapChart(h, data.heatmap),
                            ])
                          : null,

                        // 24小时音乐生物钟（整行）
                        h('div', { class: 'mst-card mst-full' }, [
                          sectionTitle(
                            Icon,
                            ctx.icons.iconClock,
                            '24小时音乐生物钟',
                            '晨起、工作、黄昏、深夜四大时段的听歌节奏与活跃峰值',
                          ),
                          renderCircadianClock(h, data.hours),
                        ]),

                        // 听歌个性成就徽章（整行）
                        h('div', { class: 'mst-card mst-full' }, [
                          sectionTitle(
                            Icon,
                            ctx.icons.iconTrophy || ctx.icons.iconStar,
                            '听歌画像成就徽章',
                            '深度挖掘你的音乐习惯与行为数据，自动点亮专属个性勋章',
                          ),
                          renderBadges(h, data),
                        ]),

                        // 趋势（整行）
                        data.trend.length > 0
                          ? h('div', { class: 'mst-card mst-full' }, [
                              sectionTitle(
                                Icon,
                                ctx.icons.iconPulse || ctx.icons.iconClock,
                                '听歌时长趋势',
                                isMonthly ? '按月份聚合统计实听时长' : '按日期聚合统计实听时长',
                              ),
                              h('div', { class: 'mst-chart-scroll' }, [renderTrendChart(h, data.trend)]),
                            ])
                          : null,

                        // Top 歌手
                        data.topArtists.length > 0
                          ? h('div', { class: 'mst-card' }, [
                              sectionTitle(
                                Icon,
                                ctx.icons.iconUsers || ctx.icons.iconTrophy,
                                'Top 歌手排行',
                                '按区间内累计有效实听时长降序',
                              ),
                              renderArtistBars(h, data.topArtists),
                            ])
                          : null,

                        // Top 歌曲（支持 Tab 切换：Top 播放 / 耐听榜 / 常切榜）
                        h('div', { class: 'mst-card' }, [
                          sectionTitle(
                            Icon,
                            ctx.icons.iconMusic,
                            '歌曲榜单与完播分析',
                            songTab.value === 'top'
                              ? '按播放次数降序（点击单曲可直接播放）'
                              : songTab.value === 'completed'
                              ? '最常听完的单曲榜（完播率 85% 以上）'
                              : '最容易被跳过的单曲（播放低于 15 秒被切歌）',
                            h('div', { class: 'mst-segmented', style: 'padding: 2px;' }, [
                              h(
                                'button',
                                {
                                  class: ['mst-seg-btn', songTab.value === 'top' ? 'active' : ''],
                                  style: 'padding: 3px 9px; font-size: 11px;',
                                  onClick: () => { songTab.value = 'top'; },
                                },
                                `Top 播放 (${data.topSongs.length})`,
                              ),
                              h(
                                'button',
                                {
                                  class: ['mst-seg-btn', songTab.value === 'completed' ? 'active' : ''],
                                  style: 'padding: 3px 9px; font-size: 11px;',
                                  onClick: () => { songTab.value = 'completed'; },
                                },
                                `最耐听 (${(data.completedSongs || []).length})`,
                              ),
                              h(
                                'button',
                                {
                                  class: ['mst-seg-btn', songTab.value === 'skipped' ? 'active' : ''],
                                  style: 'padding: 3px 9px; font-size: 11px;',
                                  onClick: () => { songTab.value = 'skipped'; },
                                },
                                `常切 (${(data.skippedSongs || []).length})`,
                              ),
                            ]),
                          ),
                          renderSongList(
                            h,
                            songTab.value === 'top'
                              ? data.topSongs
                              : songTab.value === 'completed'
                              ? data.completedSongs || []
                              : data.skippedSongs || [],
                            ctx,
                          ),
                        ]),

                        // 时段分布
                        h('div', { class: 'mst-card' }, [
                          sectionTitle(
                            Icon,
                            ctx.icons.iconClock,
                            '每日 24 时段分布',
                            '按 0–23 点各时段历史播放次数统计分布',
                          ),
                          h('div', { class: 'mst-chart-scroll' }, [renderHourChart(h, data.hours)]),
                        ]),

                        // 音源占比与音质画像
                        sourceItems.total > 0
                          ? h('div', { class: 'mst-card' }, [
                              sectionTitle(
                                Icon,
                                ctx.icons.iconCloud || ctx.icons.iconHeadphones,
                                '音源与音质画像',
                                '音源来源渠道与解码音质分布',
                              ),
                              h('div', { class: 'mst-donut-wrap' }, [
                                renderDonut(h, sourceItems.items, sourceItems.total),
                                renderSourceLegend(h, sourceItems.items, sourceItems.total),
                              ]),
                              data.qualities && data.qualities.length > 0
                                ? renderQualityAndEffects(h, data.qualities, data.effects || [])
                                : null,
                            ])
                          : null,
                      ]),
                    ],
              ]),
          }),
        ]);
      };
    },
  });
};

// ---- 报告页子渲染 ----

const kpiCard = (h, label, value, icon, sub, pct, isSkip) =>
  h('div', { class: 'mst-kpi' }, [
    h('div', { class: 'mst-kpi-top' }, [
      h('span', { class: 'mst-kpi-label' }, label),
      icon ? h('span', { class: 'mst-kpi-icon' }, icon) : null,
    ]),
    h('div', { class: 'mst-kpi-value', title: String(value) }, value),
    pct !== undefined
      ? h('div', { class: 'mst-kpi-meter' }, [
          h('div', {
            class: ['mst-kpi-meter-fill', isSkip ? 'is-skip' : ''],
            style: { width: `${Math.min(100, Math.max(0, pct))}%` },
          }),
        ])
      : null,
    sub ? h('div', { class: 'mst-kpi-sub' }, sub) : null,
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
    ...rows.map((r, i) => {
      const ms = Number(r.ms) || 0;
      const rankCls = i === 0 ? 'mst-rank-1' : i === 1 ? 'mst-rank-2' : i === 2 ? 'mst-rank-3' : '';
      return h('div', { class: 'mst-bar-row', key: String(r.artist) }, [
        h('span', { class: ['mst-bar-rank', rankCls] }, String(i + 1)),
        h('span', { class: 'mst-bar-name', title: String(r.artist) }, String(r.artist)),
        h('div', { class: 'mst-bar-track' }, [
          h('div', { class: 'mst-bar-fill', style: { width: `${Math.max(2, (ms / maxMs) * 100)}%` } }),
        ]),
        h('span', { class: 'mst-bar-val' }, formatMsShort(ms)),
      ]);
    }),
  ]);
};

const renderSongList = (h, rows, ctx) =>
  h('div', { class: 'mst-songs' }, [
    ...rows.map((r, i) => {
      const rankCls = i === 0 ? 'mst-rank-1' : i === 1 ? 'mst-rank-2' : i === 2 ? 'mst-rank-3' : '';
      let metaText = `${Number(r.plays) || 0} 次 · ${formatMsShort(Number(r.ms) || 0)}`;
      if (r.completion_rate !== undefined) {
        metaText = `${Number(r.completed_count) || 0} 次完播 (${r.completion_rate}%) · ${formatMsShort(Number(r.ms) || 0)}`;
      } else if (r.skip_rate !== undefined) {
        metaText = `${Number(r.skipped_count) || 0} 次跳过 (${r.skip_rate}%) · ${Number(r.plays) || 0} 次尝试`;
      }

      return h(
        'div',
        {
          class: 'mst-song-row',
          key: `${String(r.title)}-${String(r.artist)}-${i}`,
          style: { cursor: r.track_id ? 'pointer' : 'default' },
          title: r.track_id ? '点击播放此歌曲' : String(r.title),
          onClick: () => {
            if (r.track_id) {
              if (ctx?.player?.playTrack) void ctx.player.playTrack(r.track_id);
              else if (ctx?.player?.play) void ctx.player.play(r.track_id);
            }
          },
        },
        [
          h('span', { class: ['mst-song-rank', rankCls] }, String(i + 1)),
          h('div', { class: 'mst-song-main' }, [
            h('span', { class: 'mst-song-title', title: String(r.title) }, String(r.title)),
            h('span', { class: 'mst-song-artist', title: String(r.artist) }, String(r.artist)),
          ]),
          h('span', { class: 'mst-song-meta' }, metaText),
          r.track_id
            ? h(
                'div',
                { class: 'mst-song-play-icon', title: '试听' },
                [h('span', { style: 'font-size: 11px; margin-left: 2px;' }, '▶')],
              )
            : null,
        ],
      );
    }),
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
      const scrobblerEnabled = ref(false);
      const scrobblerUrl = ref('');
      const scrobblerToken = ref('');
      const confirmClear = ref(false);
      const busy = ref(false);
      let clearTimer = null;

      onMounted(async () => {
        try {
          const rawEnabled = await ctx.storage.get('enabled');
          enabled.value = rawEnabled == null ? true : Boolean(rawEnabled);
          const sec = Number(await ctx.storage.get('minListenSeconds'));
          minSeconds.value = Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_MIN_SECONDS;
          scrobblerEnabled.value = Boolean(await ctx.storage.get('scrobblerEnabled'));
          scrobblerUrl.value = String((await ctx.storage.get('scrobblerUrl')) || '');
          scrobblerToken.value = String((await ctx.storage.get('scrobblerToken')) || '');
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

      const setScrobblerEnabled = (value) => {
        scrobblerEnabled.value = Boolean(value);
        settings.scrobblerEnabled = scrobblerEnabled.value;
        void ctx.storage.set('scrobblerEnabled', scrobblerEnabled.value).catch(() => {});
      };

      const setScrobblerUrl = (value) => {
        scrobblerUrl.value = String(value || '').trim();
        settings.scrobblerUrl = scrobblerUrl.value;
        void ctx.storage.set('scrobblerUrl', scrobblerUrl.value).catch(() => {});
      };

      const setScrobblerToken = (value) => {
        scrobblerToken.value = String(value || '').trim();
        settings.scrobblerToken = scrobblerToken.value;
        void ctx.storage.set('scrobblerToken', scrobblerToken.value).catch(() => {});
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

      const exportData = async () => {
        if (!db) {
          ctx.toast.danger('本地数据库未就绪');
          return;
        }
        busy.value = true;
        try {
          const res = await db.all(QUERY_BACKUP);
          if (!res.ok) throw new Error(res.error || '查询失败');
          const rows = res.rows || [];
          if (rows.length === 0) {
            ctx.toast.danger('暂无数据可导出');
            return;
          }
          const payload = JSON.stringify(
            {
              format: 'music-stats-backup',
              version: 1,
              exportedAt: new Date().toISOString(),
              count: rows.length,
              rows,
            },
            null,
            2,
          );
          const blob = new Blob([payload], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `music-stats-backup-${formatDay()}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          ctx.toast.success(`已导出 ${rows.length} 条 JSON 记录（保存到下载文件夹）`);
        } catch (error) {
          console.warn('[music-stats] 导出数据失败:', error);
          ctx.toast.danger('导出失败，请重试');
        } finally {
          busy.value = false;
        }
      };

      const exportCsv = async () => {
        if (!db) {
          ctx.toast.danger('本地数据库未就绪');
          return;
        }
        busy.value = true;
        try {
          const res = await db.all('SELECT * FROM plays ORDER BY started_at ASC');
          const rows = res.rows || [];
          if (rows.length === 0) {
            ctx.toast.danger('暂无数据可导出');
            return;
          }
          const headers = [
            'track_id',
            'title',
            'artist',
            'album',
            'source',
            'duration',
            'played_ms',
            'started_at',
            'day',
            'month',
            'hour',
            'weekday',
            'completed',
            'skipped',
            'quality',
            'effect',
          ];
          const escapeCsv = (str) => `"${String(str ?? '').replace(/"/g, '""')}"`;
          const lines = [headers.join(',')];
          for (const r of rows) {
            lines.push(headers.map((h) => escapeCsv(r[h])).join(','));
          }
          const blob = new Blob(['\ufeff' + lines.join('\r\n')], {
            type: 'text/csv;charset=utf-8;',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `music-stats-${formatDay()}.csv`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          ctx.toast.success(`已导出 ${rows.length} 条记录为 CSV 表格`);
        } catch (error) {
          console.warn('[music-stats] 导出 CSV 失败:', error);
          ctx.toast.danger('导出 CSV 失败');
        } finally {
          busy.value = false;
        }
      };

      const createSystemBackup = async () => {
        if (!ctx.backups || typeof ctx.backups.create !== 'function') {
          ctx.toast.info('当前宿主环境未提供系统级备份 API');
          return;
        }
        busy.value = true;
        try {
          const res = await ctx.backups.create();
          if (res.ok) ctx.toast.success('已成功创建系统级备份');
          else ctx.toast.danger(res.error || '创建备份失败');
        } catch (e) {
          ctx.toast.danger('创建系统备份失败');
        } finally {
          busy.value = false;
        }
      };

      const importData = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => void handleImportText(String(reader.result || ''));
          reader.onerror = () => ctx.toast.danger('读取文件失败');
          reader.readAsText(file);
        };
        input.click();
      };

      const handleImportText = async (text) => {
        let rows;
        try {
          const parsed = JSON.parse(text);
          rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
        } catch (error) {
          ctx.toast.danger('导入失败：文件不是有效的备份 JSON');
          return;
        }
        if (!rows) {
          ctx.toast.danger('导入失败：备份中没有记录');
          return;
        }
        if (!db) {
          ctx.toast.danger('本地数据库未就绪');
          return;
        }
        busy.value = true;
        try {
          const statements = [];
          let skipped = 0;
          for (const row of rows) {
            const params = importRowToParams(row);
            if (params) statements.push({ sql: IMPORT_SQL, params });
            else skipped += 1;
          }
          if (statements.length === 0) {
            ctx.toast.danger('导入失败：没有可用记录');
            return;
          }
          // 宿主单次事务上限 500 条，分批执行
          for (let i = 0; i < statements.length; i += 500) {
            const res = await db.transaction(statements.slice(i, i + 500));
            if (!res.ok) throw new Error(res.error || '写入失败');
          }
          const skippedText = skipped > 0 ? `，跳过 ${skipped} 条无效` : '';
          ctx.toast.success(`已导入 ${statements.length} 条记录（重复自动跳过）${skippedText}`);
        } catch (error) {
          console.warn('[music-stats] 导入数据失败:', error);
          ctx.toast.danger('导入失败，请重试');
        } finally {
          busy.value = false;
        }
      };

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
          h('div', { class: 'mst-setting-row' }, [
            h('div', { class: 'mst-setting-copy' }, [
              h('div', { class: 'mst-setting-label' }, '数据备份'),
              h('div', { class: 'mst-setting-hint' }, '卸载插件会删除本机数据，卸载前建议先导出备份'),
            ]),
            h('div', { class: 'mst-backup-actions' }, [
              h(Button, { size: 'sm', onClick: exportData, disabled: busy.value }, { default: () => '导出 JSON' }),
              h(Button, { size: 'sm', variant: 'outline', onClick: exportCsv, disabled: busy.value }, { default: () => '导出 CSV' }),
              h(Button, { size: 'sm', variant: 'outline', onClick: importData, disabled: busy.value }, { default: () => '导入 JSON' }),
              ctx.backups ? h(Button, { size: 'sm', variant: 'ghost', onClick: createSystemBackup, disabled: busy.value }, { default: () => '系统备份' }) : null,
            ]),
          ]),
          h('div', { class: 'mst-setting-row' }, [
            h('div', { class: 'mst-setting-copy' }, [
              h('div', { class: 'mst-setting-label' }, 'Scrobbler 同步上报'),
              h('div', { class: 'mst-setting-hint' }, '歌曲完播后自动向配置的 Webhook (Last.fm / ListenBrainz 网关) 提交播放记录'),
            ]),
            h(Switch, { modelValue: scrobblerEnabled.value, 'onUpdate:modelValue': setScrobblerEnabled, disabled: !loaded.value }),
          ]),
          scrobblerEnabled.value
            ? h('div', { class: 'mst-card', style: 'padding: 12px 14px;' }, [
                h('div', { class: 'mst-card-sub', style: 'margin-bottom: 6px;' }, 'Scrobbler Webhook URL:'),
                h('input', {
                  type: 'text',
                  class: 'mst-date-input',
                  style: 'width: 100%; margin-bottom: 8px;',
                  placeholder: 'https://api.listenbrainz.org/1/submit-listens 或自定义网关',
                  value: scrobblerUrl.value,
                  onInput: (e) => setScrobblerUrl(e.target.value),
                }),
                h('div', { class: 'mst-card-sub', style: 'margin-bottom: 6px;' }, 'User Token (可选):'),
                h('input', {
                  type: 'password',
                  class: 'mst-date-input',
                  style: 'width: 100%;',
                  placeholder: '填入 API Token',
                  value: scrobblerToken.value,
                  onInput: (e) => setScrobblerToken(e.target.value),
                }),
              ])
            : null,
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
    settings.scrobblerEnabled = Boolean(await ctx.storage.get('scrobblerEnabled'));
    settings.scrobblerUrl = String((await ctx.storage.get('scrobblerUrl')) || '');
    settings.scrobblerToken = String((await ctx.storage.get('scrobblerToken')) || '');
  } catch (error) {
    console.warn('[music-stats] 读取设置失败:', error);
  }

  // 采集引擎（onTrackChange/onTimeUpdate 返回的 dispose 由运行时自动托管）
  ctx.events.onTrackChange((track) => onTrackChange(track, ctx));
  ctx.events.onTimeUpdate(onTimeUpdate);

  // 接入系统级备份与恢复
  if (ctx.backups && typeof ctx.backups.registerProvider === 'function') {
    try {
      ctx.backups.registerProvider({
        id: 'echo-music-stats-backup',
        name: '听歌统计本地备份',
        description: '提供 echo-music-stats 听歌历史数据的备份与还原',
        list: async () => [
          {
            id: 'stats-history',
            name: '听歌统计全量播放数据',
            createdAt: new Date().toISOString(),
          },
        ],
        save: async () => {},
        load: async () => new Uint8Array(),
      });
    } catch (e) {
      console.warn('[music-stats] 注册系统备份提供方失败:', e);
    }
  }

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
