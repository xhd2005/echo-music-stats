// 听歌统计插件 (v1.5.0)
// 本地化的听歌数据统计：静默记录每一次播放（SQLite 落库），生成
// 总时长 / Top 歌手 / Top 歌曲 / 365天热力图下钻 / 24小时生物钟 / 成就进度 / 年度报告 可视化。
// 数据 100% 保存在本机插件目录，无任何默认网络上报。
//
// 入口：
// - 侧边栏「插件」分组 → 听歌统计（路由 /main/plugin/music-stats/report）
// - 插件设置项（设置 → 插件管理 → 本插件）及报告页顶栏 ⚙ 设置抽屉
// - 命令 music-stats:open（可在快捷键设置中绑定）
//
// 采集规则：
// - 实听时长 played_ms >= minListenSeconds（默认 30s）或完播（>= 85%）才计入；低于阈值丢弃
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
  {
    version: 4,
    sql: [
      `ALTER TABLE plays ADD COLUMN user_id TEXT NOT NULL DEFAULT '';`,
      `CREATE INDEX IF NOT EXISTS idx_plays_user_started ON plays(user_id, started_at);`,
    ],
  },
];

// 时间范围选项（吸顶筛选条）
const RANGE_OPTIONS = [
  { key: 'today', label: '今天' },
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
let current = null; // 当前正在监听的曲目 { trackId,title,artist,album,source,duration,startedAt,maxMs,userId,quality,effect }
let disposeAll = null;
const reportRefreshListeners = new Set();

const notifyReportDataChanged = () => {
  for (const fn of reportRefreshListeners) {
    try {
      fn();
    } catch {}
  }
};

// ---- 账号与日期工具 ----

// 读取当前宿主登录账号信息（支持多账号隔离与旧版无账号数据归属）
const readCurrentUser = (ctx) => {
  try {
    const userStore = ctx?.pinia?._s?.get('user') || ctx?.stores?.user;
    const info = userStore?.info?.value ?? userStore?.info;
    const userId = String(info?.userid ?? info?.userId ?? '').trim();
    const nickname = String(info?.nickname ?? '').trim();
    return { userId, nickname };
  } catch {
    return { userId: '', nickname: '' };
  }
};

// 将旧版未标记账号 (user_id = '') 的历史播放记录自动归属给当前登录账号
const claimUnassignedPlays = async (dbHandle, userId) => {
  const uid = String(userId ?? '').trim();
  if (!dbHandle || !uid) return;
  try {
    await dbHandle.run(`UPDATE plays SET user_id = ? WHERE user_id = ''`, [uid]);
  } catch (err) {
    console.warn('[music-stats] 归属旧版历史数据失败:', err);
  }
};

const pad = (n) => String(n).padStart(2, '0');

const formatDay = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const formatTimeHm = (ms) => {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const parseLocalDateMs = (isoDay) => {
  const str = String(isoDay || '').trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return d.getTime();
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const getDefaultCustomRange = () => {
  const today = startOfToday();
  return {
    start: formatDay(new Date(today - 29 * DAY_MS)),
    end: formatDay(new Date(today)),
  };
};

// 毫秒 → 紧凑时长文案：<1h 显示「N 分钟」，否则「X 小时」或「X 小时 Y 分」
const formatMsShort = (ms) => {
  const totalMin = Math.max(0, Math.round(Number(ms || 0) / 60000));
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
};

const formatDurationClock = (ms) => {
  const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${pad(s)}`;
};

// 时间范围 key → [startMs, endMs)（本地时区午夜对齐，保证 day/month 分组干净）
const getRangeMs = (key, customStart, customEnd) => {
  if (key === 'custom') {
    const s = parseLocalDateMs(customStart);
    const e = parseLocalDateMs(customEnd);
    return {
      start: Number.isFinite(s) ? Math.max(0, s) : 0,
      end: Number.isFinite(e) ? e + DAY_MS : MAX_SAFE_MS,
    };
  }
  const today = startOfToday();
  if (key === 'today') return { start: today, end: today + DAY_MS };
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

// 趋势粒度：短区间按天，长区间（今年/全部）按月
const trendGranularity = (key) => (key === 'year' || key === 'all' ? 'month' : 'day');

// ---- 矢量 SVG 图标集（全矢量零 Emoji / 零裸符号） ----

const MST_ICONS = {
  play: {
    width: 24,
    height: 24,
    body: '<path d="M7 4.75v14.5c0 .7.77 1.13 1.37.76l11.25-7.25a.9.9 0 0 0 0-1.52L8.37 3.99A.9.9 0 0 0 7 4.75z" fill="currentColor"/>',
  },
  download: {
    width: 24,
    height: 24,
    body: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  trash: {
    width: 24,
    height: 24,
    body: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  chevronRight: {
    width: 24,
    height: 24,
    body: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  calendar: {
    width: 24,
    height: 24,
    body: '<rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 2v4M8 2v4M3 10h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  flame: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 2c.5 3 2.5 5 4.5 7.5 2 2.5 2.5 5.5 1.5 8.5-1.5 4-5.5 6-9 4.5-3.5-1.5-5-5-3.5-9 1-2.5 3-4.5 4-7 .5 2 1.5 3 2.5 3.5 0-2.5 0-5 0-7.5z"/>',
  },
  zap: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  },
  music: {
    width: 24,
    height: 24,
    body: '<circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  clock: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  headphones: {
    width: 24,
    height: 24,
    body: '<path d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" fill="none" stroke="currentColor" stroke-width="2"/>',
  },
  repeat: {
    width: 24,
    height: 24,
    body: '<path d="M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  globe: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15.3 15.3 0 0 1 4 9 15.3 15.3 0 0 1-4 9 15.3 15.3 0 0 1-4-9 15.3 15.3 0 0 1 4-9z" fill="none" stroke="currentColor" stroke-width="2"/>',
  },
  activity: {
    width: 24,
    height: 24,
    body: '<path d="M22 12h-4l-3 9L9 3l-3 9H2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  compass: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor"/>',
  },
  sun: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" fill="none" stroke="currentColor" stroke-width="2"/>',
  },
  briefcase: {
    width: 24,
    height: 24,
    body: '<rect x="2" y="7" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" fill="none" stroke="currentColor" stroke-width="2"/>',
  },
  sunset: {
    width: 24,
    height: 24,
    body: '<path d="M12 10V2M4.93 10.93l1.41-1.41M19.07 10.93l-1.41-1.41M2 18h20M20 10a8 8 0 0 0-16 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  moon: {
    width: 24,
    height: 24,
    body: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  lock: {
    width: 24,
    height: 24,
    body: '<rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="16" r="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4" fill="none" stroke="currentColor" stroke-width="2"/>',
  },
  check: {
    width: 24,
    height: 24,
    body: '<path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  skip: {
    width: 24,
    height: 24,
    body: '<polygon points="5 4 15 12 5 20 5 4" fill="currentColor"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  user: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" fill="none" stroke="currentColor" stroke-width="2"/>',
  },
};

const iconSvg = (h, iconData, { size = 16, className = '' } = {}) =>
  h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: `0 0 ${iconData?.width || 24} ${iconData?.height || 24}`,
    class: className,
    'aria-hidden': 'true',
    innerHTML: iconData?.body ?? '',
  });

const loadHostComponent = (ctx, name) => {
  const entry = ctx?.ui?.components?.[name];
  if (typeof entry === 'function') {
    return ctx.vue.defineAsyncComponent(entry);
  }
  if (entry && typeof entry === 'object') {
    return entry;
  }
  return null;
};

const playTrackById = (ctx, trackId) => {
  const id = String(trackId ?? '').trim();
  if (!id) return;
  if (ctx?.player?.playTrack) void ctx.player.playTrack(id);
  else if (ctx?.player?.play) void ctx.player.play(id);
};

// 跨插件协同：检测 echo-music-download 桥并安全入队单曲下载
const hasDownloadBridge = () =>
  typeof globalThis !== 'undefined' && Boolean(globalThis.__echoMusicDownload);

const enqueueSingleDownload = async (ctx, row) => {
  const bridge = typeof globalThis !== 'undefined' ? globalThis.__echoMusicDownload : null;
  if (!bridge) {
    ctx?.toast?.info?.('未检测到「歌曲下载」插件');
    return;
  }
  const trackId = String(row?.track_id ?? row?.id ?? '').trim();
  const title = String(row?.title ?? '').trim();
  const artist = String(row?.artist ?? '').trim();
  const album = String(row?.album ?? '').trim();
  const song = {
    id: trackId,
    hash: trackId,
    title,
    name: title,
    artist,
    albumName: album,
    album,
  };
  try {
    if (typeof bridge.enqueueSongs === 'function') {
      await bridge.enqueueSongs([song]);
      ctx?.toast?.success?.(`已将《${title || trackId}》加入下载队列`);
      return;
    }
    if (typeof bridge.enqueueSong === 'function') {
      await bridge.enqueueSong(song);
      ctx?.toast?.success?.(`已将《${title || trackId}》加入下载队列`);
      return;
    }
    if (typeof bridge.downloadSong === 'function') {
      await bridge.downloadSong(song);
      ctx?.toast?.success?.(`已将《${title || trackId}》加入下载队列`);
      return;
    }
    if (typeof bridge.enqueue === 'function') {
      await bridge.enqueue(song);
      ctx?.toast?.success?.(`已将《${title || trackId}》加入下载队列`);
      return;
    }
    ctx?.toast?.info?.('当前「歌曲下载」插件版本暂不支持直达单曲入队，请升级至 v2.4.0+');
  } catch (err) {
    console.warn('[music-stats] 跨插件加入下载失败:', err);
    ctx?.toast?.danger?.('加入下载队列失败');
  }
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
      (track_id, title, artist, album, source, duration, played_ms, started_at, day, month, hour, weekday, completed, skipped, quality, effect, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      String(meta.userId ?? '').trim(),
    ],
  );
  if (!res.ok) console.warn('[music-stats] 写入播放记录失败:', res.error);
};

// ---- Scrobbler 云端互联（支持 Last.fm / ListenBrainz 等） ----

const postScrobblerRequest = async (ctx, url, token, payload) => {
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  if (ctx && ctx.net && typeof ctx.net.request === 'function') {
    const res = await ctx.net.request({
      url,
      method: 'POST',
      headers,
      body: payload,
    });
    if (res && res.ok === false) {
      throw new Error(res.error || `HTTP ${res.status || 'ERROR'}`);
    }
    if (res && typeof res.status === 'number' && res.status >= 400) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp;
};

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
    await postScrobblerRequest(ctx, settings.scrobblerUrl, settings.scrobblerToken, payload);
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
  const completed =
    (durationMs > 0 && playedMs >= durationMs * 0.85) || (durationMs === 0 && playedMs >= 120000)
      ? 1
      : 0;
  // 切歌判定：播放少于 15 秒提前切歌
  const skipped = playedMs < 15000 ? 1 : 0;

  if (playedMs >= settings.minListenSeconds * 1000 || completed) {
    try {
      const uid = rec.userId || readCurrentUser(ctx).userId;
      await insertPlay({ ...rec, userId: uid, playedMs, completed, skipped });
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

  const { userId } = readCurrentUser(ctx);

  current =
    meta && settings.enabled
      ? {
          ...meta,
          userId,
          quality,
          effect,
          startedAt: Date.now(),
          maxMs: 0,
        }
      : null;
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

const QUERY_TOP_SONGS = `SELECT MAX(track_id) AS track_id, title, artist, MAX(album) AS album,
  COUNT(*) AS plays, SUM(played_ms) AS ms,
  COALESCE(SUM(completed), 0) AS completed_count
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist ORDER BY plays DESC, ms DESC LIMIT 20`;

const QUERY_COMPLETED_SONGS = `SELECT MAX(track_id) AS track_id, title, artist, MAX(album) AS album,
  COUNT(*) AS plays, SUM(played_ms) AS ms,
  SUM(completed) AS completed_count,
  ROUND(CAST(SUM(completed) AS FLOAT) / COUNT(*) * 100, 1) AS completion_rate
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist HAVING completed_count > 0
  ORDER BY completed_count DESC, plays DESC LIMIT 15`;

const QUERY_SKIPPED_SONGS = `SELECT MAX(track_id) AS track_id, title, artist, MAX(album) AS album,
  COUNT(*) AS plays, SUM(played_ms) AS ms,
  SUM(skipped) AS skipped_count,
  ROUND(CAST(SUM(skipped) AS FLOAT) / COUNT(*) * 100, 1) AS skip_rate
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist HAVING skipped_count > 0
  ORDER BY skipped_count DESC, plays DESC LIMIT 15`;

const QUERY_LOOP_SONG = `SELECT MAX(track_id) AS track_id, title, artist, MAX(album) AS album,
  day, COUNT(*) AS daily_plays
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY title, artist, day HAVING daily_plays >= 2
  ORDER BY daily_plays DESC LIMIT 1`;

const QUERY_NIGHT_SONG = `SELECT MAX(track_id) AS track_id, title, artist, MAX(album) AS album,
  COUNT(*) AS night_plays
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

const QUERY_HOURS = `SELECT hour, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY hour ORDER BY hour`;

const QUERY_SOURCES = `SELECT source, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE started_at >= ? AND started_at < ?
  GROUP BY source ORDER BY plays DESC`;

// 下钻查询：单日播放流水 / 歌手曲目与月度统计
const QUERY_DAY_PLAYS = `SELECT id, track_id, title, artist, album, source, duration, played_ms, started_at, completed, skipped, quality, effect
  FROM plays WHERE day = ?
  ORDER BY started_at DESC LIMIT 200`;

const QUERY_ARTIST_SONGS = `SELECT MAX(track_id) AS track_id, title, artist, MAX(album) AS album,
  COUNT(*) AS plays, SUM(played_ms) AS ms,
  COALESCE(SUM(completed), 0) AS completed_count
  FROM plays WHERE started_at >= ? AND started_at < ? AND artist = ?
  GROUP BY title, artist ORDER BY plays DESC, ms DESC LIMIT 30`;

const QUERY_ARTIST_MONTHLY = `SELECT month, COUNT(*) AS plays, SUM(played_ms) AS ms
  FROM plays WHERE artist = ?
  GROUP BY month ORDER BY month DESC LIMIT 12`;

const runQuery = async (dbHandle, sql, params) => {
  const res = await dbHandle.all(sql, params);
  if (!res.ok) throw new Error(res.error || '查询失败');
  return res.rows || [];
};

const applyUserScopeSql = (sql, uid, scopeMode) => {
  if (scopeMode === 'current' && uid) {
    return sql.replace('FROM plays WHERE ', "FROM plays WHERE (user_id = ? OR user_id = '') AND ");
  }
  return sql;
};

const queryReport = async (dbHandle, range, granularity, options = {}) => {
  const uid = String(options.userId ?? '').trim();
  const scopeMode = options.scopeMode || 'current';
  if (uid) {
    await claimUnassignedPlays(dbHandle, uid);
  }
  const scoped = scopeMode === 'current' && Boolean(uid);
  const params = scoped ? [uid, range.start, range.end] : [range.start, range.end];
  const trendSql = granularity === 'month' ? QUERY_TREND_MONTH : QUERY_TREND_DAY;
  const heatmapStart = Date.now() - 365 * DAY_MS;
  const heatmapParams = scoped
    ? [uid, heatmapStart, Date.now() + DAY_MS]
    : [heatmapStart, Date.now() + DAY_MS];
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
    runQuery(dbHandle, applyUserScopeSql(QUERY_KPI, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_TOP_ARTISTS, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_TOP_SONGS, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(trendSql, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_HOURS, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_SOURCES, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_COMPLETED_SONGS, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_SKIPPED_SONGS, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_LOOP_SONG, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_NIGHT_SONG, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_QUALITIES, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_EFFECTS, uid, scopeMode), params),
    runQuery(dbHandle, applyUserScopeSql(QUERY_HEATMAP, uid, scopeMode), heatmapParams),
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

const queryDayPlays = async (dbHandle, dayStr, options = {}) => {
  const uid = String(options.userId ?? '').trim();
  const scopeMode = options.scopeMode || 'current';
  const scoped = scopeMode === 'current' && Boolean(uid);
  const params = scoped ? [uid, dayStr] : [dayStr];
  return runQuery(dbHandle, applyUserScopeSql(QUERY_DAY_PLAYS, uid, scopeMode), params);
};

const queryArtistDetail = async (dbHandle, artist, range, options = {}) => {
  const uid = String(options.userId ?? '').trim();
  const scopeMode = options.scopeMode || 'current';
  const scoped = scopeMode === 'current' && Boolean(uid);
  const songParams = scoped ? [uid, range.start, range.end, artist] : [range.start, range.end, artist];
  const monthParams = scoped ? [uid, artist] : [artist];
  const [songs, monthly] = await Promise.all([
    runQuery(dbHandle, applyUserScopeSql(QUERY_ARTIST_SONGS, uid, scopeMode), songParams),
    runQuery(dbHandle, applyUserScopeSql(QUERY_ARTIST_MONTHLY, uid, scopeMode), monthParams),
  ]);
  return { songs, monthly };
};

const deletePlayById = async (dbHandle, id) => {
  if (!dbHandle || id == null) return { ok: false, error: '无效记录' };
  return dbHandle.run('DELETE FROM plays WHERE id = ?', [id]);
};

// ---- 数据备份（导出 / 导入，优先使用 ctx.fs 原生目录授权直接落盘） ----

const exportFileToDiskOrBrowser = async (ctx, filename, contentString, mimeType = 'application/json') => {
  const fsGrants =
    ctx?.fs && typeof ctx.fs.requestDirectory === 'function'
      ? ctx.fs
      : ctx?.fs?.files && typeof ctx.fs.files.requestDirectory === 'function'
        ? ctx.fs.files
        : null;
  if (fsGrants && typeof ctx?.fs?.writeFile === 'function') {
    try {
      const dirRes = await fsGrants.requestDirectory({
        access: 'read-write',
        purpose: '选择听歌统计数据导出保存目录',
        persist: true,
      });
      if (dirRes && dirRes.canceled) {
        return { canceled: true };
      }
      if (dirRes && dirRes.ok !== false && dirRes.directory?.id) {
        const writeRes = await ctx.fs.writeFile(
          {
            kind: 'directory-file',
            directoryId: dirRes.directory.id,
            relativePath: filename,
          },
          contentString,
          { encoding: 'utf8', overwrite: true },
        );
        if (writeRes && writeRes.ok !== false) {
          return {
            ok: true,
            mode: 'native',
            displayPath: dirRes.directory.displayPath || dirRes.directory.name || '所选目录',
          };
        }
      }
    } catch (err) {
      console.warn('[music-stats] 原生目录导出异常，回退浏览器下载:', err);
    }
  }
  const blob = new Blob([contentString], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true, mode: 'browser', displayPath: '下载文件夹' };
};

// 备份只导出「源数据」列；派生列（day/month/hour/weekday）导入时按 started_at 重算，保证与采集一致
const QUERY_BACKUP = `SELECT track_id, title, artist, album, source, duration, played_ms, started_at, completed, skipped, quality, effect, user_id
  FROM plays ORDER BY started_at`;

const IMPORT_SQL = `INSERT OR IGNORE INTO plays
  (track_id, title, artist, album, source, duration, played_ms, started_at, day, month, hour, weekday, completed, skipped, quality, effect, user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// 单行 → 插入参数（派生列由 started_at 重算）；无效行返回 null
const importRowToParams = (row, defaultUserId = '') => {
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
    Number(row?.completed) ? 1 : 0,
    Number(row?.skipped) ? 1 : 0,
    String(row?.quality ?? '').trim(),
    String(row?.effect ?? '').trim(),
    String(row?.user_id ?? defaultUserId ?? '').trim(),
  ];
};

const exportBackupJson = async (ctx) => {
  if (!db) {
    ctx?.toast?.danger?.('本地数据库未就绪');
    return { ok: false };
  }
  const res = await db.all(QUERY_BACKUP);
  if (!res.ok) throw new Error(res.error || '查询失败');
  const rows = res.rows || [];
  if (rows.length === 0) {
    ctx?.toast?.info?.('暂无数据可导出');
    return { ok: false, empty: true };
  }
  const payload = JSON.stringify(
    {
      format: 'music-stats-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      count: rows.length,
      rows,
    },
    null,
    2,
  );
  const filename = `music-stats-backup-${formatDay()}.json`;
  const out = await exportFileToDiskOrBrowser(ctx, filename, payload, 'application/json');
  if (out?.canceled) return { canceled: true };
  ctx?.toast?.success?.(`已导出 ${rows.length} 条 JSON 记录（保存至：${out.displayPath}）`);
  return { ok: true, count: rows.length };
};

const exportBackupCsv = async (ctx) => {
  if (!db) {
    ctx?.toast?.danger?.('本地数据库未就绪');
    return { ok: false };
  }
  const res = await db.all('SELECT * FROM plays ORDER BY started_at ASC');
  if (!res.ok) throw new Error(res.error || '查询失败');
  const rows = res.rows || [];
  if (rows.length === 0) {
    ctx?.toast?.info?.('暂无数据可导出');
    return { ok: false, empty: true };
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
    'user_id',
  ];
  const escapeCsv = (str) => `"${String(str ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((col) => escapeCsv(r[col])).join(','));
  }
  const filename = `music-stats-${formatDay()}.csv`;
  const out = await exportFileToDiskOrBrowser(
    ctx,
    filename,
    '\ufeff' + lines.join('\r\n'),
    'text/csv;charset=utf-8;',
  );
  if (out?.canceled) return { canceled: true };
  ctx?.toast?.success?.(`已导出 ${rows.length} 条记录为 CSV 表格（保存至：${out.displayPath}）`);
  return { ok: true, count: rows.length };
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

// ---- 样式（严格 .mst- 前缀，遵循 EchoMusic surfaces.css / shapes.css 第一方原生极简规范） ----

const CSS = `
.mst-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.mst-scroll {
  flex: 1;
  min-height: 0;
}

/* 顶栏 SliverHeader 内的信息与操作 */
.mst-sliver-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.mst-sliver-meta-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mst-sliver-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.mst-sliver-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mst-sliver-actions .mst-btn-inner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 吸顶筛选栏（严格使用 1px var(--border-subtle) 底线，零白线） */
.mst-sticky-bar {
  position: sticky;
  z-index: 110;
  background: var(--color-bg-main);
}

.mst-sticky-inner {
  padding: 0 24px;
}

.mst-sticky-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 50px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-subtle);
  flex-wrap: wrap;
}

.mst-filter-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.mst-scope-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-control, 6px);
  background: var(--control-muted-bg);
}

.mst-filter-btn {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-control, 6px);
  padding: 5px 11px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
  white-space: nowrap;
}

.mst-filter-btn:hover {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

.mst-filter-btn.active {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
  font-weight: 700;
}

/* 自定义日期区（采用宿主原生 DatePicker） */
.mst-custom-range {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
  flex-wrap: wrap;
  animation: mstFadeIn 0.18s ease-out;
}

.mst-custom-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.mst-date-picker-box {
  width: 158px;
}

.mst-date-fallback {
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-control, 6px);
  background: var(--field-bg);
  color: var(--color-text-main);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.mst-custom-error {
  font-size: 12px;
  font-weight: 600;
  color: var(--control-danger-text, var(--state-danger, #ef4444));
}

/* 主内容区（左右 24px 网格与 SliverHeader 对齐） */
.mst-page {
  display: flex;
  flex-direction: column;
  padding: 18px 24px 48px;
  gap: 18px;
  box-sizing: border-box;
}

/* KPI 核心指标（无边框柔和圆角面板） */
.mst-kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
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
  border: none;
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
  padding: 14px 16px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 6px;
  transition: background-color 0.16s ease;
}

.mst-kpi:hover {
  background: var(--control-hover-bg);
}

.mst-kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mst-kpi-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.mst-kpi-icon {
  color: var(--icon-secondary, var(--color-text-secondary));
  display: inline-flex;
  align-items: center;
}

.mst-kpi-value {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}

.mst-kpi-meter {
  height: 4px;
  border-radius: 999px;
  background: var(--control-muted-bg);
  overflow: hidden;
  margin-top: 2px;
}

.mst-kpi-meter-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary);
  transition: width 0.35s ease;
}

.mst-kpi-meter-fill.is-skip {
  background: var(--state-danger, #ef4444);
}

.mst-kpi-sub {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

/* 年度报告摘要面板 */
.mst-annual {
  border: none;
  border-radius: var(--radius-card, 10px);
  background: color-mix(in srgb, var(--color-primary) 9%, var(--content-panel-bg));
  padding: 18px 20px;
}

.mst-annual-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  gap: 10px;
}

.mst-annual-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-primary-text);
}

.mst-annual-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--color-primary-text);
}

.mst-annual-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.mst-annual-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
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
  padding: 11px 13px;
  border-radius: var(--radius-item, 6px);
  background: var(--content-panel-bg);
  min-width: 0;
}

.mst-annual-item-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.mst-annual-item-value {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 神曲循环与深夜灵魂双高亮卡 */
.mst-highlight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 720px) {
  .mst-highlight-grid {
    grid-template-columns: 1fr;
  }
}

.mst-highlight-card {
  position: relative;
  border: none;
  border-radius: var(--radius-card, 10px);
  padding: 15px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  background: var(--content-panel-bg);
  transition: background-color 0.16s ease;
}

.mst-highlight-card:hover {
  background: var(--control-hover-bg);
}

.mst-highlight-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.mst-highlight-tag {
  font-size: 11.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--color-primary-text);
}

.mst-highlight-card.loop .mst-highlight-tag {
  color: var(--state-warning, #d97706);
}

.mst-highlight-card.night .mst-highlight-tag {
  color: var(--color-primary-text);
}

.mst-highlight-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s ease;
}

.mst-highlight-title:hover {
  color: var(--color-primary-text);
}

.mst-highlight-sub {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mst-highlight-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
}

.mst-play-circle-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--control-active-bg);
  color: var(--color-primary-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 0.16s ease, transform 0.12s ease;
}

.mst-play-circle-btn:hover {
  background: var(--control-accent-hover-bg);
  transform: scale(1.05);
}

.mst-play-circle-btn:active {
  transform: scale(0.96);
}

/* 卡片网格 */
.mst-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
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

/* 通用分区容器（无外边框，柔和底色 var(--content-panel-bg)） */
.mst-card {
  border: none;
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
  padding: 18px 20px;
  min-width: 0;
}

.mst-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.mst-card-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.mst-card-icon-pill {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-control, 6px);
  background: var(--control-active-bg);
  color: var(--color-primary-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.mst-card-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--color-text-main);
}

.mst-card-sub {
  margin: 2px 0 0;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-text-secondary);
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
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.mst-stat-tag {
  font-size: 11.5px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: var(--radius-control, 6px);
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mst-stat-tag strong {
  color: var(--color-primary-text);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.mst-heatmap-wrap {
  overflow-x: auto;
  padding: 4px 0 8px;
}

.mst-heatmap-wrap svg {
  display: block;
  min-width: 780px;
}

.mst-heatmap-cell {
  transition: stroke 0.12s ease, opacity 0.12s ease;
}

.mst-heatmap-cell:hover {
  stroke: var(--color-text-main);
  stroke-width: 1.4;
}

.mst-heatmap-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
  font-size: 11.5px;
  color: var(--color-text-secondary);
  gap: 12px;
  flex-wrap: wrap;
}

.mst-heatmap-inspect {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 500;
}

.mst-inspect-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.mst-heatmap-legend {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.mst-heatmap-legend-box {
  width: 11px;
  height: 11px;
  border-radius: 3px;
}

/* 24小时音乐生物钟 */
.mst-circadian-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 800px) {
  .mst-circadian-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.mst-circadian-card {
  background: var(--control-muted-bg);
  border: none;
  border-radius: var(--radius-item, 6px);
  padding: 13px 15px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mst-circadian-card.mst-peak {
  background: var(--control-active-bg);
}

.mst-circadian-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.mst-circadian-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-main);
  display: flex;
  align-items: center;
  gap: 6px;
}

.mst-circadian-peak-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.mst-circadian-time {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.mst-circadian-percent {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-main);
}

.mst-circadian-bar-bg {
  height: 4px;
  border-radius: 999px;
  background: var(--control-track-bg);
  overflow: hidden;
}

.mst-circadian-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.35s ease;
}

.period-morning .mst-circadian-bar-fill { background: #d97706; }
.period-work .mst-circadian-bar-fill { background: #0284c7; }
.period-dusk .mst-circadian-bar-fill { background: #e11d48; }
.period-night .mst-circadian-bar-fill { background: var(--color-primary); }

.mst-circadian-plays {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

/* 成就徽章（带锁定进度条） */
.mst-badges-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
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
  border-radius: var(--radius-item, 6px);
  padding: 13px 15px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: none;
  background: var(--control-muted-bg);
  transition: background-color 0.16s ease;
}

.mst-badge-card.unlocked {
  background: color-mix(in srgb, var(--color-primary) 9%, var(--control-muted-bg));
}

.mst-badge-icon {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-control, 6px);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--control-bg);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.unlocked .mst-badge-icon {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.mst-badge-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.mst-badge-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mst-badge-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-main);
}

.mst-badge-desc {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
  line-height: 1.35;
}

.mst-badge-status {
  font-size: 10.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.unlocked .mst-badge-status {
  color: var(--color-primary-text);
}

.locked .mst-badge-status {
  color: var(--color-text-secondary);
}

.mst-badge-progress-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 5px;
}

.mst-badge-progress-track {
  height: 4px;
  border-radius: 999px;
  background: var(--control-track-bg);
  overflow: hidden;
}

.mst-badge-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary);
  transition: width 0.35s ease;
}

.mst-badge-progress-text {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

/* Top 歌手横向排行（支持点击下钻抽屉） */
.mst-bars {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mst-bar-row {
  display: grid;
  grid-template-columns: 24px 104px 1fr 76px 18px;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--radius-item, 6px);
  transition: background-color 0.14s ease;
}

.mst-bar-row.is-clickable {
  cursor: pointer;
}

.mst-bar-row.no-rank {
  grid-template-columns: 110px 1fr 82px;
}

.mst-bar-row:hover {
  background: var(--row-hover-bg);
}

.mst-bar-chevron {
  color: var(--icon-secondary, var(--color-text-secondary));
  opacity: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.mst-bar-row.is-clickable:hover .mst-bar-chevron {
  opacity: 1;
  transform: translateX(2px);
}

.mst-bar-rank {
  font-size: 12px;
  font-weight: 700;
  text-align: center;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.mst-rank-1 {
  color: var(--color-primary-text);
  font-weight: 800;
}

.mst-rank-2 {
  color: var(--color-text-main);
  font-weight: 800;
}

.mst-rank-3 {
  color: var(--color-text-secondary);
  font-weight: 800;
}

.mst-bar-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-bar-track {
  height: 7px;
  border-radius: 999px;
  background: var(--control-track-bg);
  overflow: hidden;
}

.mst-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary);
  transition: width 0.35s ease;
}

.mst-bar-val {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* Top 歌曲列表（对齐 EchoMusic SongList：无边框、双击播放、显式矢量播放与下载图标） */
.mst-song-tabs-bar {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 10px;
}

.mst-song-tabs-list {
  display: flex;
  align-items: center;
  gap: 20px;
  height: 34px;
}

.mst-song-tabs-list .tab-trigger {
  font-size: 13px;
  font-weight: 700;
}

.mst-songs-scroll {
  max-height: 430px;
  overflow-y: auto;
  padding-right: 4px;
}

.mst-songs-scroll::-webkit-scrollbar {
  width: 5px;
}

.mst-songs-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.mst-songs-scroll::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb-bg);
  border-radius: 999px;
}

.mst-songs-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-bg-hover);
}

.mst-songs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mst-song-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-item, 6px);
  background: transparent;
  transition: background-color 0.14s ease;
  user-select: none;
}

.mst-song-row:hover {
  background: var(--row-hover-bg);
}

.mst-song-row.is-active {
  background: var(--row-selected-bg);
}

.mst-song-rank {
  width: 24px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-secondary);
  text-align: center;
  font-variant-numeric: tabular-nums;
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
  font-weight: 600;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.14s ease;
}

.mst-song-row.is-active .mst-song-title {
  color: var(--color-primary-text);
  font-weight: 700;
}

.mst-song-artist {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-song-meta {
  flex-shrink: 0;
  text-align: right;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.mst-song-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.mst-row-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-control, 6px);
  border: none;
  background: transparent;
  color: var(--icon-main, var(--color-text-secondary));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.14s ease, background-color 0.14s ease, color 0.14s ease;
}

.mst-song-row:hover .mst-row-icon-btn,
.mst-song-row:focus-within .mst-row-icon-btn,
.mst-song-row.is-active .mst-row-icon-btn,
.mst-drawer-row:hover .mst-row-icon-btn,
.mst-drawer-row:focus-within .mst-row-icon-btn {
  opacity: 1;
}

.mst-row-icon-btn:hover {
  background: var(--control-hover-bg);
  color: var(--color-text-main);
}

.mst-row-icon-btn.is-play:hover,
.mst-song-row.is-active .mst-row-icon-btn.is-play {
  color: var(--color-primary-text);
  background: var(--control-active-bg);
}

.mst-row-icon-btn.is-danger:hover {
  color: var(--control-danger-text, var(--state-danger, #ef4444));
  background: var(--control-danger-bg);
}

/* 音源 donut + 图例 */
.mst-donut-wrap {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
  padding: 4px 0 12px;
}

.mst-legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 180px;
}

.mst-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: var(--radius-item, 6px);
  transition: background-color 0.12s ease;
}

.mst-legend-item:hover {
  background: var(--row-hover-bg);
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
  font-weight: 600;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mst-legend-val {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 侧滑抽屉内容区 */
.mst-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mst-drawer-section-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-secondary);
  margin: 0 0 8px;
}

.mst-drawer-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mst-drawer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-item, 6px);
  transition: background-color 0.14s ease;
}

.mst-drawer-row:hover {
  background: var(--row-hover-bg);
}

.mst-drawer-time {
  width: 40px;
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.mst-drawer-tag {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.mst-drawer-tag.is-completed {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.mst-drawer-tag.is-skipped {
  background: var(--control-danger-bg);
  color: var(--control-danger-text, var(--state-danger, #ef4444));
}

.mst-artist-months {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
}

.mst-artist-month-row {
  display: grid;
  grid-template-columns: 64px 1fr 92px;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

/* 空态 / 加载 / 错误 */
.mst-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 24px;
  color: var(--color-text-secondary);
  text-align: center;
}

.mst-state p {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

/* 设置面板（无边框轻底色分组，与 EchoMusic 原生设置页一致） */
.mst-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 780px;
}

.mst-settings-group {
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
  overflow: hidden;
}

.mst-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 16px;
}

.mst-setting-row + .mst-setting-row {
  border-top: 1px solid var(--border-subtle);
}

.mst-setting-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mst-setting-label {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--color-text-main);
}

.mst-setting-hint {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.mst-setting-select {
  width: 132px;
  flex-shrink: 0;
}

.mst-backup-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.mst-scrobbler-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px 15px;
  border-top: 1px solid var(--border-subtle);
}

.mst-field-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.mst-field-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.mst-scrobbler-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 2px;
}

.mst-danger-group {
  border-radius: var(--radius-card, 10px);
  background: var(--control-danger-bg);
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

/* 清空数据 Dialog 选项 */
.mst-clear-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.mst-radio-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-item, 6px);
  background: var(--control-muted-bg);
  cursor: pointer;
  transition: background-color 0.14s ease;
}

.mst-radio-card:hover {
  background: var(--control-hover-bg);
}

.mst-radio-card.is-selected {
  background: var(--control-active-bg);
}

.mst-radio-card.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mst-radio-dot {
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border-radius: 50%;
  border: 1.5px solid var(--control-checkbox-border, var(--border-strong));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.mst-radio-card.is-selected .mst-radio-dot {
  border-color: var(--color-primary);
}

.mst-radio-dot-inner {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
}

.mst-backup-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px 2px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-main);
  cursor: pointer;
  user-select: none;
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

// 折线（趋势）：单序列、主题色、柔和网格、首尾标注
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
          {
            x: xAt(Math.floor((n - 1) / 2)),
            label: String(rows[Math.floor((n - 1) / 2)]?.bucket ?? ''),
          },
          { x: xAt(n - 1), label: String(rows[n - 1]?.bucket ?? '') },
        ];

  const gradId = 'mst-trend-grad';
  return h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '听歌时长趋势' }, [
    h('defs', null, [
      h('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' }, [
        h('stop', { offset: '0%', 'stop-color': 'var(--color-primary, #31cfa1)', 'stop-opacity': '0.28' }),
        h('stop', { offset: '100%', 'stop-color': 'var(--color-primary, #31cfa1)', 'stop-opacity': '0' }),
      ]),
    ]),
    ...gridTicks
      .map((t) => [
        h('line', {
          x1: PAD_L,
          x2: W - PAD_R,
          y1: t.y,
          y2: t.y,
          'stroke-width': 1,
          'stroke-dasharray': '3 3',
          opacity: 0.65,
          style: { stroke: chartGrid },
        }),
        h(
          'text',
          { x: PAD_L - 8, y: t.y + 4, 'font-size': 10.5, 'text-anchor': 'end', style: { fill: chartText } },
          t.label,
        ),
      ])
      .flat(),
    areaPath ? h('path', { d: areaPath, stroke: 'none', fill: `url(#${gradId})` }) : null,
    h('path', {
      d: linePath,
      fill: 'none',
      'stroke-width': 2.4,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      style: { stroke: chartStroke },
    }),
    ...pts.map((p, i) =>
      h('circle', { cx: p.x, cy: p.y, r: 3.4, style: { fill: chartStroke, cursor: 'pointer' } }, [
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
      h(
        'rect',
        {
          x: x.toFixed(1),
          y: (PAD_T + innerH - hgt).toFixed(1),
          width: barW.toFixed(1),
          height: hgt.toFixed(1),
          rx: 3,
          ry: 3,
          opacity: isPeak ? 1 : val > 0 ? 0.78 : 0.15,
          style: { fill: chartStroke, cursor: 'pointer' },
        },
        [h('title', null, `${hour}:00 - ${hour}:59: ${val} 次播放`)],
      ),
    );
  }

  const ticks = [0, 6, 12, 18, 23].map((hour) => ({
    x: PAD_L + hour * slot + slot / 2,
    label: `${hour}时`,
  }));

  return h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '每日时段分布' }, [
    h('line', {
      x1: PAD_L,
      x2: W - PAD_R,
      y1: PAD_T + innerH,
      y2: PAD_T + innerH,
      'stroke-width': 1,
      style: { stroke: chartGrid },
    }),
    ...bars,
    ...ticks.map((t) =>
      h('text', { x: t.x, y: H - 8, 'font-size': 10.5, 'text-anchor': 'middle', style: { fill: chartText } }, t.label),
    ),
  ]);
};

// 音源 donut：stroke-dasharray 分段 + 中心总数 + 图例
const renderDonut = (h, segments, total) => {
  const size = 156;
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
    h('circle', { cx: c, cy: c, r, fill: 'none', 'stroke-width': 20, style: { stroke: chartMuted } }),
    ...arcs.map((arc) =>
      h('circle', {
        cx: c,
        cy: c,
        r,
        fill: 'none',
        'stroke-width': 20,
        'stroke-dasharray': `${arc.len.toFixed(2)} ${(circumference - arc.len).toFixed(2)}`,
        'stroke-dashoffset': (-arc.offset).toFixed(2),
        transform: `rotate(-90 ${c} ${c})`,
        style: { stroke: sourceColor(arc.label) },
      }),
    ),
    h(
      'text',
      {
        x: c,
        y: c - 2,
        'font-size': 21,
        'font-weight': 800,
        'text-anchor': 'middle',
        style: { fill: 'var(--color-text-main)' },
      },
      String(total),
    ),
    h('text', { x: c, y: c + 16, 'font-size': 10.5, 'text-anchor': 'middle', style: { fill: chartText } }, '总播放次数'),
  ]);
};

// 365天听歌热力图（GitHub 矩阵风，支持点击单元格打开当日流水抽屉）
const renderHeatmapChart = (h, rows, hoveredDay, onSelectDay) => {
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
  let maxStreak = 0;
  let runningStreak = 0;

  days.forEach((d) => {
    const dayStr = formatDay(d);
    const stat = byDay.get(dayStr);
    const p = stat ? stat.plays : 0;
    if (p > 0) {
      activeDays += 1;
      totalYearPlays += p;
      totalYearMs += stat.ms;
      runningStreak += 1;
      if (runningStreak > maxStreak) maxStreak = runningStreak;
    } else {
      runningStreak = 0;
    }
  });

  // 当前连续打卡天数计算（从今日或昨日向前回溯）
  const lastIdx = days.length - 1;
  const todayStr = formatDay(days[lastIdx]);
  const todayPlays = byDay.get(todayStr)?.plays || 0;
  let currentStreak = 0;
  let checkIdx = lastIdx;

  if (todayPlays === 0 && checkIdx > 0) {
    const yesterdayStr = formatDay(days[lastIdx - 1]);
    const yesterdayPlays = byDay.get(yesterdayStr)?.plays || 0;
    if (yesterdayPlays > 0) {
      checkIdx = lastIdx - 1;
    } else {
      checkIdx = -1;
    }
  }

  if (checkIdx >= 0) {
    while (checkIdx >= 0) {
      const dStr = formatDay(days[checkIdx]);
      const p = byDay.get(dStr)?.plays || 0;
      if (p > 0) {
        currentStreak += 1;
        checkIdx -= 1;
      } else {
        break;
      }
    }
  }

  const activeRate = Math.round((activeDays / 365) * 100);

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
  const weekDayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  days.forEach((d, idx) => {
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const dayStr = formatDay(d);
    const stat = byDay.get(dayStr) || { plays: 0, ms: 0 };
    const plays = stat.plays;
    const weekday = weekDayNames[d.getDay()];

    if (row === 0 && d.getMonth() !== lastMonth && col < weeks - 1) {
      lastMonth = d.getMonth();
      monthLabels.push(
        h(
          'text',
          {
            x: padL + col * (cellSize + gap),
            y: padT - 7,
            'font-size': 10,
            style: { fill: chartText },
          },
          `${lastMonth + 1}月`,
        ),
      );
    }

    let fillColor = 'var(--control-muted-bg)';
    if (plays >= 12) fillColor = 'var(--color-primary, #31cfa1)';
    else if (plays >= 6) fillColor = 'color-mix(in srgb, var(--color-primary, #31cfa1) 76%, transparent)';
    else if (plays >= 3) fillColor = 'color-mix(in srgb, var(--color-primary, #31cfa1) 50%, transparent)';
    else if (plays >= 1) fillColor = 'color-mix(in srgb, var(--color-primary, #31cfa1) 24%, transparent)';

    const dayInfo = { day: dayStr, plays, ms: stat.ms, weekday };

    rects.push(
      h(
        'rect',
        {
          class: 'mst-heatmap-cell',
          x: padL + col * (cellSize + gap),
          y: padT + row * (cellSize + gap),
          width: cellSize,
          height: cellSize,
          rx: 3,
          ry: 3,
          style: { fill: fillColor, cursor: 'pointer' },
          onMouseenter: () => {
            if (hoveredDay) hoveredDay.value = dayInfo;
          },
          onMouseleave: () => {
            if (hoveredDay) hoveredDay.value = null;
          },
          onClick: () => {
            if (typeof onSelectDay === 'function') onSelectDay(dayInfo);
          },
        },
        [h('title', null, `${dayStr} (${weekday})：${plays} 次播放 · ${formatMsShort(stat.ms)}（点击查看当日流水）`)],
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

  const curInspect = hoveredDay?.value;

  return h('div', null, [
    h('div', { class: 'mst-heatmap-stats' }, [
      h('div', { class: 'mst-stat-tag' }, [
        iconSvg(h, MST_ICONS.calendar, { size: 12 }),
        h('span', null, '累计活跃：'),
        h('strong', null, `${activeDays} / 365 天 (${activeRate}%)`),
      ]),
      h('div', { class: 'mst-stat-tag' }, [
        iconSvg(h, MST_ICONS.flame, { size: 12 }),
        h('span', null, '当前连续：'),
        h('strong', null, `${currentStreak} 天`),
      ]),
      h('div', { class: 'mst-stat-tag' }, [
        iconSvg(h, MST_ICONS.zap, { size: 12 }),
        h('span', null, '最长连胜：'),
        h('strong', null, `${maxStreak} 天`),
      ]),
      h('div', { class: 'mst-stat-tag' }, [
        iconSvg(h, MST_ICONS.music, { size: 12 }),
        h('span', null, '年度总播放：'),
        h('strong', null, `${totalYearPlays} 次`),
      ]),
      h('div', { class: 'mst-stat-tag' }, [
        iconSvg(h, MST_ICONS.clock, { size: 12 }),
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
      h('div', { class: 'mst-heatmap-inspect' }, [
        curInspect
          ? [
              h('span', { class: 'mst-inspect-pill' }, `${curInspect.day} ${curInspect.weekday}`),
              h(
                'span',
                null,
                curInspect.plays > 0
                  ? `播放 ${curInspect.plays} 次 · 实听 ${formatMsShort(curInspect.ms)} · 点击查看当日流水`
                  : '当日暂无听歌记录 · 点击可查看详情',
              ),
            ]
          : [h('span', null, '过去 365 天听歌足迹矩阵 · 点击任意日期色块可查看并清理当日播放流水')],
      ]),
      h('div', { class: 'mst-heatmap-legend' }, [
        h('span', null, '少'),
        h('span', { class: 'mst-heatmap-legend-box', style: 'background: var(--control-muted-bg);' }),
        h('span', {
          class: 'mst-heatmap-legend-box',
          style: 'background: color-mix(in srgb, var(--color-primary, #31cfa1) 24%, transparent);',
        }),
        h('span', {
          class: 'mst-heatmap-legend-box',
          style: 'background: color-mix(in srgb, var(--color-primary, #31cfa1) 50%, transparent);',
        }),
        h('span', {
          class: 'mst-heatmap-legend-box',
          style: 'background: color-mix(in srgb, var(--color-primary, #31cfa1) 76%, transparent);',
        }),
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
    { id: 'morning', name: '清晨启程', time: '06:00 - 11:00', icon: MST_ICONS.sun, plays: morning, cls: 'period-morning' },
    { id: 'work', name: '专注工作', time: '11:00 - 18:00', icon: MST_ICONS.briefcase, plays: work, cls: 'period-work' },
    { id: 'dusk', name: '暮光晚霞', time: '18:00 - 22:00', icon: MST_ICONS.sunset, plays: dusk, cls: 'period-dusk' },
    { id: 'night', name: '深夜漫游', time: '22:00 - 06:00', icon: MST_ICONS.moon, plays: night, cls: 'period-night' },
  ];

  const maxPlays = Math.max(1, ...periods.map((p) => p.plays));

  return h('div', { class: 'mst-circadian-grid' }, [
    ...periods.map((p) => {
      const pct = Math.round((p.plays / total) * 100);
      const isPeak = p.plays === maxPlays && p.plays > 0;
      return h('div', { class: ['mst-circadian-card', p.cls, isPeak ? 'mst-peak' : ''], key: p.id }, [
        h('div', { class: 'mst-circadian-head' }, [
          h('span', { class: 'mst-circadian-name' }, [iconSvg(h, p.icon, { size: 14 }), h('span', null, p.name)]),
          isPeak ? h('span', { class: 'mst-circadian-peak-badge' }, '峰值活跃') : null,
        ]),
        h('div', { class: 'mst-circadian-time' }, p.time),
        h('div', { class: 'mst-circadian-percent' }, `${pct}%`),
        h('div', { class: 'mst-circadian-bar-bg' }, [
          h('div', { class: 'mst-circadian-bar-fill', style: { width: `${pct}%` } }),
        ]),
        h('div', { class: 'mst-circadian-plays' }, `${p.plays} 次播放`),
      ]);
    }),
  ]);
};

// 听歌画像个性成就徽章（未解锁徽章展示明确进度条与数值）
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
      const row = hours.find((item) => Number(item.hour) === i);
      if (row) cnt += Number(row.plays || 0);
    }
    return cnt;
  };
  const mPlays = sumH(6, 10);
  const wPlays = sumH(11, 17);
  const dPlays = sumH(18, 21);
  const nPlays = sumH(22, 23) + sumH(0, 5);
  const periodPassCount =
    totalPlays > 0
      ? [mPlays, wPlays, dPlays, nPlays].filter((cnt) => cnt / totalPlays >= 0.05).length
      : 0;
  const allSeason = totalPlays >= 15 && periodPassCount === 4;

  const loopCount = Number(loopSong?.daily_plays || 0);
  const totalHours = totalMs / 3600000;

  const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

  const badges = [
    {
      id: 'night',
      icon: MST_ICONS.moon,
      title: '深夜哲学家',
      desc: '凌晨 0–6 点听歌占比 ≥ 20% 且 ≥ 5 次',
      unlocked: nightRate >= 0.2 && nightPlays >= 5,
      progressPct: clampPct(Math.min(nightRate / 0.2, nightPlays / 5) * 100),
      progressLabel: `深夜 ${Math.round(nightRate * 100)}% / 20%（${nightPlays} / 5 次）`,
    },
    {
      id: 'lossless',
      icon: MST_ICONS.headphones,
      title: '无损发烧友',
      desc: 'SQ / Hi-Res / 杜比全景声占比 ≥ 40% 且 ≥ 5 次',
      unlocked: hiresRate >= 0.4 && hiresPlays >= 5,
      progressPct: clampPct(Math.min(hiresRate / 0.4, hiresPlays / 5) * 100),
      progressLabel: `无损 ${Math.round(hiresRate * 100)}% / 40%（${hiresPlays} / 5 次）`,
    },
    {
      id: 'loop',
      icon: MST_ICONS.repeat,
      title: '专一单曲狂人',
      desc: '单曲单日循环播放 ≥ 5 次',
      unlocked: loopCount >= 5,
      progressPct: clampPct((loopCount / 5) * 100),
      progressLabel: `${Math.min(loopCount, 5)} / 5 次单日循环`,
    },
    {
      id: 'diverse',
      icon: MST_ICONS.globe,
      title: '百家争鸣',
      desc: '收听去重歌手 ≥ 20 位',
      unlocked: artistsCount >= 20,
      progressPct: clampPct((artistsCount / 20) * 100),
      progressLabel: `${Math.min(artistsCount, 20)} / 20 位歌手`,
    },
    {
      id: 'marathon',
      icon: MST_ICONS.activity,
      title: '音乐马拉松',
      desc: '累计实听时长 ≥ 30 小时',
      unlocked: totalHours >= 30,
      progressPct: clampPct((totalHours / 30) * 100),
      progressLabel: `${totalHours.toFixed(1)} / 30 小时`,
    },
    {
      id: 'all_day',
      icon: MST_ICONS.compass,
      title: '全天候候鸟',
      desc: '晨、昼、暮、夜四时段占比均 ≥ 5%（累计 ≥ 15 次）',
      unlocked: allSeason,
      progressPct: clampPct(Math.min(periodPassCount / 4, totalPlays / 15) * 100),
      progressLabel: `${periodPassCount} / 4 个时段达标 · ${Math.min(totalPlays, 15)} / 15 次`,
    },
  ];

  return h('div', { class: 'mst-badges-grid' }, [
    ...badges.map((b) =>
      h('div', { class: ['mst-badge-card', b.unlocked ? 'unlocked' : 'locked'], key: b.id }, [
        h('div', { class: 'mst-badge-icon' }, [iconSvg(h, b.icon, { size: 18 })]),
        h('div', { class: 'mst-badge-info' }, [
          h('div', { class: 'mst-badge-top' }, [
            h('div', { class: 'mst-badge-title' }, b.title),
            h(
              'div',
              { class: 'mst-badge-status' },
              b.unlocked
                ? [iconSvg(h, MST_ICONS.check, { size: 11 }), h('span', null, '已解锁')]
                : [iconSvg(h, MST_ICONS.lock, { size: 10 }), h('span', null, `${b.progressPct}%`)],
            ),
          ]),
          h('div', { class: 'mst-badge-desc' }, b.desc),
          !b.unlocked
            ? h('div', { class: 'mst-badge-progress-wrap' }, [
                h('div', { class: 'mst-badge-progress-track' }, [
                  h('div', { class: 'mst-badge-progress-fill', style: { width: `${b.progressPct}%` } }),
                ]),
                h('div', { class: 'mst-badge-progress-text' }, b.progressLabel),
              ])
            : null,
        ]),
      ]),
    ),
  ]);
};

// 神曲循环狂热与深夜灵魂单曲（全矢量播放图标，已修复 SQL 缺失 track_id）
const renderHighlights = (h, loopSong, nightSong, ctx) => {
  if (!loopSong && !nightSong) return null;
  return h('div', { class: 'mst-highlight-grid' }, [
    loopSong
      ? h('div', { class: 'mst-highlight-card loop' }, [
          h('div', { class: 'mst-highlight-main' }, [
            h('div', { class: 'mst-highlight-tag' }, [
              iconSvg(h, MST_ICONS.flame, { size: 13 }),
              h('span', null, '单日循环神曲'),
              h('span', { class: 'mst-highlight-pill' }, loopSong.day),
            ]),
            h(
              'div',
              {
                class: 'mst-highlight-title',
                title: loopSong.track_id ? '点击播放此歌曲' : String(loopSong.title),
                onClick: () => playTrackById(ctx, loopSong.track_id),
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
                  type: 'button',
                  class: 'mst-play-circle-btn',
                  title: '立即播放',
                  'aria-label': `播放 ${loopSong.title}`,
                  onClick: () => playTrackById(ctx, loopSong.track_id),
                },
                [iconSvg(h, MST_ICONS.play, { size: 15 })],
              )
            : null,
        ])
      : null,
    nightSong
      ? h('div', { class: 'mst-highlight-card night' }, [
          h('div', { class: 'mst-highlight-main' }, [
            h('div', { class: 'mst-highlight-tag' }, [
              iconSvg(h, MST_ICONS.moon, { size: 13 }),
              h('span', null, '深夜灵魂单曲 (00:00-06:00)'),
            ]),
            h(
              'div',
              {
                class: 'mst-highlight-title',
                title: nightSong.track_id ? '点击播放此歌曲' : String(nightSong.title),
                onClick: () => playTrackById(ctx, nightSong.track_id),
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
                  type: 'button',
                  class: 'mst-play-circle-btn',
                  title: '立即播放',
                  'aria-label': `播放 ${nightSong.title}`,
                  onClick: () => playTrackById(ctx, nightSong.track_id),
                },
                [iconSvg(h, MST_ICONS.play, { size: 15 })],
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
    hires: '#d97706',
    flac: '#0891b2',
    viper_atmos: '#7c3aed',
    '320k': '#059669',
    '128k': '#64748b',
  };
  const effectMap = {
    vinyl: '黑胶唱机',
    pure_vocal: '纯净人声',
    surround: '全景环绕',
    bass: '超重低音',
  };
  const effectColorMap = {
    vinyl: '#e11d48',
    pure_vocal: '#0284c7',
    surround: '#7c3aed',
    bass: '#d97706',
  };

  return h('div', { class: 'mst-bars' }, [
    qualities.length > 0
      ? [
          h('div', { class: 'mst-card-title', style: 'font-size: 12.5px; margin: 10px 0 4px;' }, '音质分布画像'),
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
          h('div', { class: 'mst-card-title', style: 'font-size: 12.5px; margin: 12px 0 4px;' }, '音效搭配偏好'),
          ...effects.slice(0, 4).map((e) => {
            const plays = Number(e.plays || 0);
            const pct = totalE > 0 ? Math.round((plays / totalE) * 100) : 0;
            const label = effectMap[e.effect] || e.effect;
            const barColor = effectColorMap[e.effect] || 'var(--color-primary, #31cfa1)';
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

// ---- 报告页子渲染 ----

const kpiCard = (h, RollingNumber, label, value, icon, sub, pct, isSkip) =>
  h('div', { class: 'mst-kpi' }, [
    h('div', { class: 'mst-kpi-top' }, [
      h('span', { class: 'mst-kpi-label' }, label),
      icon ? h('span', { class: 'mst-kpi-icon' }, icon) : null,
    ]),
    h('div', { class: 'mst-kpi-value', title: String(value) }, [
      RollingNumber ? h(RollingNumber, { value }) : String(value),
    ]),
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
    h('div', { class: 'mst-annual-item-value', title: String(value) }, value),
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

const renderArtistBars = (h, rows, onSelectArtist) => {
  if (!rows || rows.length === 0) {
    return h('div', { class: 'mst-state', style: 'padding: 36px 12px;' }, [h('p', null, '暂无歌手数据')]);
  }
  const maxMs = Math.max(1, ...rows.map((r) => Number(r.ms) || 0));
  return h('div', { class: 'mst-bars' }, [
    ...rows.map((r, i) => {
      const ms = Number(r.ms) || 0;
      const rankCls = i === 0 ? 'mst-rank-1' : i === 1 ? 'mst-rank-2' : i === 2 ? 'mst-rank-3' : '';
      return h(
        'div',
        {
          class: ['mst-bar-row', onSelectArtist ? 'is-clickable' : ''],
          key: String(r.artist),
          title: `点击查看 ${r.artist} 的曲目排行与月度统计`,
          onClick: () => {
            if (typeof onSelectArtist === 'function') onSelectArtist(r);
          },
        },
        [
          h('span', { class: ['mst-bar-rank', rankCls] }, String(i + 1)),
          h('span', { class: 'mst-bar-name', title: String(r.artist) }, String(r.artist)),
          h('div', { class: 'mst-bar-track' }, [
            h('div', { class: 'mst-bar-fill', style: { width: `${Math.max(2, (ms / maxMs) * 100)}%` } }),
          ]),
          h('span', { class: 'mst-bar-val' }, formatMsShort(ms)),
          h('span', { class: 'mst-bar-chevron' }, [iconSvg(h, MST_ICONS.chevronRight, { size: 14 })]),
        ],
      );
    }),
  ]);
};

// 排行榜歌曲列表：严格采用双击播放 (onDblclick) + 显式矢量播放按钮 + 正在播放高亮 + 跨插件下载入口
const renderSongList = (h, rows, ctx, options = {}) => {
  const { activeTrackId = '', Popconfirm = null, showDownload = false } = options;
  const canDownload = showDownload && hasDownloadBridge();

  if (!rows || rows.length === 0) {
    return h('div', { class: 'mst-state', style: 'padding: 36px 12px;' }, [
      h('p', null, '暂无该榜单维度的歌曲数据'),
    ]);
  }

  return h('div', { class: 'mst-songs-scroll' }, [
    h('div', { class: 'mst-songs' }, [
      ...rows.map((r, i) => {
        const rankCls = i === 0 ? 'mst-rank-1' : i === 1 ? 'mst-rank-2' : i === 2 ? 'mst-rank-3' : '';
        const isActive = Boolean(activeTrackId && r.track_id && String(r.track_id) === String(activeTrackId));
        let metaText = `${Number(r.plays) || 0} 次 · ${formatMsShort(Number(r.ms) || 0)}`;
        if (r.completion_rate !== undefined) {
          metaText = `${Number(r.completed_count) || 0} 次完播 (${r.completion_rate}%) · ${formatMsShort(Number(r.ms) || 0)}`;
        } else if (r.skip_rate !== undefined) {
          metaText = `${Number(r.skipped_count) || 0} 次跳过 (${r.skip_rate}%) · ${Number(r.plays) || 0} 次尝试`;
        }

        const downloadBtn = canDownload && r.track_id
          ? Popconfirm
            ? h(
                Popconfirm,
                {
                  title: '加入歌曲下载队列？',
                  description: `将《${r.title} - ${r.artist}》发送至歌曲下载插件`,
                  confirmText: '加入下载',
                  cancelText: '取消',
                  side: 'left',
                  onConfirm: () => void enqueueSingleDownload(ctx, r),
                },
                {
                  trigger: () =>
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'mst-row-icon-btn',
                        title: '下载此歌曲',
                        'aria-label': `下载 ${r.title}`,
                        onClick: (e) => e.stopPropagation(),
                      },
                      [iconSvg(h, MST_ICONS.download, { size: 14 })],
                    ),
                },
              )
            : h(
                'button',
                {
                  type: 'button',
                  class: 'mst-row-icon-btn',
                  title: '下载此歌曲',
                  'aria-label': `下载 ${r.title}`,
                  onClick: (e) => {
                    e.stopPropagation();
                    void enqueueSingleDownload(ctx, r);
                  },
                },
                [iconSvg(h, MST_ICONS.download, { size: 14 })],
              )
          : null;

        return h(
          'div',
          {
            class: ['mst-song-row', isActive ? 'is-active' : ''],
            key: `${String(r.title)}-${String(r.artist)}-${i}`,
            title: r.track_id ? '双击播放此歌曲' : String(r.title),
            onDblclick: () => {
              if (r.track_id) playTrackById(ctx, r.track_id);
            },
          },
          [
            h('span', { class: ['mst-song-rank', rankCls] }, String(i + 1)),
            h('div', { class: 'mst-song-main' }, [
              h('span', { class: 'mst-song-title', title: String(r.title) }, String(r.title)),
              h('span', { class: 'mst-song-artist', title: String(r.artist) }, String(r.artist)),
            ]),
            h('span', { class: 'mst-song-meta' }, metaText),
            h('div', { class: 'mst-song-actions' }, [
              downloadBtn,
              r.track_id
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'mst-row-icon-btn is-play',
                      title: '播放此歌曲',
                      'aria-label': `播放 ${r.title}`,
                      onClick: (e) => {
                        e.stopPropagation();
                        playTrackById(ctx, r.track_id);
                      },
                    },
                    [iconSvg(h, MST_ICONS.play, { size: 13 })],
                  )
                : null,
            ]),
          ],
        );
      }),
    ]),
  ]);
};

// ---- 设置面板（轻量原生组件，同时复用于插件设置页与报告页右侧设置抽屉） ----

const createSettingsPanel = (ctx) => {
  const { h, defineComponent, ref, onMounted, onBeforeUnmount } = ctx.vue;
  const Switch = loadHostComponent(ctx, 'Switch');
  const Select = loadHostComponent(ctx, 'Select');
  const Button = loadHostComponent(ctx, 'Button');
  const Input = loadHostComponent(ctx, 'Input');
  const Dialog = loadHostComponent(ctx, 'Dialog');
  const Checkbox = loadHostComponent(ctx, 'Checkbox');

  return defineComponent({
    name: 'music-stats-settings',
    props: {
      onDataChanged: { type: Function, default: null },
    },
    setup(props) {
      const loaded = ref(false);
      const enabled = ref(true);
      const minSeconds = ref(DEFAULT_MIN_SECONDS);
      const scrobblerEnabled = ref(false);
      const scrobblerUrl = ref('');
      const scrobblerToken = ref('');
      const scrobblerSaving = ref(false);
      const testingScrobbler = ref(false);
      const busy = ref(false);

      // 安全清空数据 Dialog 状态
      const clearDialogOpen = ref(false);
      const clearScope = ref('current'); // 'current' | 'all'
      const backupBeforeClear = ref(true);
      const clearing = ref(false);
      const currentUser = ref(readCurrentUser(ctx));

      let scrobblerSaveTimer = null;

      const flushScrobblerSave = () => {
        if (scrobblerSaveTimer) {
          clearTimeout(scrobblerSaveTimer);
          scrobblerSaveTimer = null;
        }
        const trimmedUrl = String(scrobblerUrl.value || '').trim();
        const trimmedToken = String(scrobblerToken.value || '').trim();
        settings.scrobblerUrl = trimmedUrl;
        settings.scrobblerToken = trimmedToken;
        void ctx.storage.set('scrobblerUrl', trimmedUrl).catch(() => {});
        void ctx.storage.set('scrobblerToken', trimmedToken).catch(() => {});
        scrobblerSaving.value = false;
      };

      const scheduleScrobblerSave = () => {
        scrobblerSaving.value = true;
        if (scrobblerSaveTimer) clearTimeout(scrobblerSaveTimer);
        scrobblerSaveTimer = setTimeout(flushScrobblerSave, 450);
      };

      onMounted(async () => {
        currentUser.value = readCurrentUser(ctx);
        clearScope.value = currentUser.value.userId ? 'current' : 'all';
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
        if (scrobblerSaveTimer) {
          flushScrobblerSave();
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

      const handleScrobblerUrlInput = (val) => {
        scrobblerUrl.value = String(val ?? '');
        scheduleScrobblerSave();
      };

      const handleScrobblerTokenInput = (val) => {
        scrobblerToken.value = String(val ?? '');
        scheduleScrobblerSave();
      };

      const testScrobblerConnection = async () => {
        flushScrobblerSave();
        const url = String(scrobblerUrl.value || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) {
          ctx.toast.danger('请先输入有效的 http(s) Webhook URL');
          return;
        }
        testingScrobbler.value = true;
        try {
          await postScrobblerRequest(ctx, url, String(scrobblerToken.value || '').trim(), {
            test: true,
            track: 'Connection Test',
            artist: 'EchoMusic',
            album: '',
            duration: 180,
            timestamp: Math.floor(Date.now() / 1000),
            service: 'EchoMusic',
          });
          ctx.toast.success('Scrobbler 连通性测试成功');
        } catch (err) {
          console.warn('[music-stats] Scrobbler 测试连接失败:', err);
          ctx.toast.danger(`连接测试失败：${err?.message || '请检查地址与网络'}`);
        } finally {
          testingScrobbler.value = false;
        }
      };

      const openClearDialog = () => {
        currentUser.value = readCurrentUser(ctx);
        clearScope.value = currentUser.value.userId ? 'current' : 'all';
        backupBeforeClear.value = true;
        clearDialogOpen.value = true;
      };

      const executeClear = async () => {
        if (!db) {
          ctx.toast.danger('本地数据库未就绪');
          return;
        }
        clearing.value = true;
        try {
          if (backupBeforeClear.value) {
            const out = await exportBackupJson(ctx);
            if (out?.canceled) {
              ctx.toast.info('已取消备份，清空操作未执行');
              return;
            }
          }
          const uid = currentUser.value.userId;
          let res;
          if (clearScope.value === 'current' && uid) {
            res = await db.run(`DELETE FROM plays WHERE user_id = ? OR user_id = ''`, [uid]);
          } else {
            res = await db.run('DELETE FROM plays');
          }
          if (res.ok) {
            clearDialogOpen.value = false;
            ctx.toast.success(
              clearScope.value === 'current' && uid
                ? '已清空当前账号的听歌统计数据'
                : '已清空全部账号的听歌统计数据',
            );
            notifyReportDataChanged();
            if (typeof props.onDataChanged === 'function') props.onDataChanged();
          } else {
            ctx.toast.danger('清空失败，请重试');
          }
        } catch (error) {
          console.warn('[music-stats] 清空数据失败:', error);
          ctx.toast.danger('清空失败，请重试');
        } finally {
          clearing.value = false;
        }
      };

      const options = MIN_SECONDS_OPTIONS.map((v) => ({ label: `${v} 秒`, value: v }));

      const handleExportJson = async () => {
        busy.value = true;
        try {
          await exportBackupJson(ctx);
        } catch (error) {
          console.warn('[music-stats] 导出数据失败:', error);
          ctx.toast.danger('导出失败，请重试');
        } finally {
          busy.value = false;
        }
      };

      const handleExportCsv = async () => {
        busy.value = true;
        try {
          await exportBackupCsv(ctx);
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
        } catch {
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
        } catch {
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
          const defaultUid = readCurrentUser(ctx).userId;
          const statements = [];
          let skipped = 0;
          for (const row of rows) {
            const params = importRowToParams(row, defaultUid);
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
          notifyReportDataChanged();
          if (typeof props.onDataChanged === 'function') props.onDataChanged();
        } catch (error) {
          console.warn('[music-stats] 导入数据失败:', error);
          ctx.toast.danger('导入失败，请重试');
        } finally {
          busy.value = false;
        }
      };

      const renderButton = (btnProps, label) =>
        Button
          ? h(Button, btnProps, { default: () => label })
          : h('button', { type: 'button', ...btnProps }, label);

      return () => {
        const hasAccount = Boolean(currentUser.value.userId);
        const accountLabel = currentUser.value.nickname
          ? `${currentUser.value.nickname} (${currentUser.value.userId})`
          : currentUser.value.userId || '未登录';

        return h('div', { class: 'mst-settings' }, [
          // 采集配置组
          h('div', { class: 'mst-settings-group' }, [
            h('div', { class: 'mst-setting-row' }, [
              h('div', { class: 'mst-setting-copy' }, [
                h('div', { class: 'mst-setting-label' }, '启用统计'),
                h('div', { class: 'mst-setting-hint' }, '关闭后停止记录新播放，已保存的历史保留'),
              ]),
              Switch
                ? h(Switch, {
                    modelValue: enabled.value,
                    'onUpdate:modelValue': setEnabled,
                    disabled: !loaded.value,
                  })
                : null,
            ]),
            h('div', { class: 'mst-setting-row' }, [
              h('div', { class: 'mst-setting-copy' }, [
                h('div', { class: 'mst-setting-label' }, '最短计入时长'),
                h('div', { class: 'mst-setting-hint' }, '实听时长低于该值且未完播的播放不计入'),
              ]),
              Select
                ? h(Select, {
                    modelValue: minSeconds.value,
                    'onUpdate:modelValue': setMinSeconds,
                    options,
                    class: 'mst-setting-select',
                    disabled: !loaded.value,
                  })
                : null,
            ]),
          ]),

          // 数据备份组
          h('div', { class: 'mst-settings-group' }, [
            h('div', { class: 'mst-setting-row' }, [
              h('div', { class: 'mst-setting-copy' }, [
                h('div', { class: 'mst-setting-label' }, '数据导出与导入'),
                h('div', { class: 'mst-setting-hint' }, '卸载插件会清除本地数据库，建议定期导出 JSON 备份'),
              ]),
              h('div', { class: 'mst-backup-actions' }, [
                renderButton({ size: 'sm', variant: 'soft-primary', onClick: handleExportJson, disabled: busy.value }, '导出 JSON'),
                renderButton({ size: 'sm', variant: 'soft-secondary', onClick: handleExportCsv, disabled: busy.value }, '导出 CSV'),
                renderButton({ size: 'sm', variant: 'soft-secondary', onClick: importData, disabled: busy.value }, '导入 JSON'),
                ctx.backups
                  ? renderButton({ size: 'sm', variant: 'ghost', onClick: createSystemBackup, disabled: busy.value }, '系统备份')
                  : null,
              ]),
            ]),
          ]),

          // Scrobbler 配置组
          h('div', { class: 'mst-settings-group' }, [
            h('div', { class: 'mst-setting-row' }, [
              h('div', { class: 'mst-setting-copy' }, [
                h('div', { class: 'mst-setting-label' }, 'Scrobbler 同步上报'),
                h(
                  'div',
                  { class: 'mst-setting-hint' },
                  '歌曲完播后向自定义 Webhook (Last.fm / ListenBrainz 网关) 提交记录',
                ),
              ]),
              Switch
                ? h(Switch, {
                    modelValue: scrobblerEnabled.value,
                    'onUpdate:modelValue': setScrobblerEnabled,
                    disabled: !loaded.value,
                  })
                : null,
            ]),
            scrobblerEnabled.value
              ? h('div', { class: 'mst-scrobbler-fields' }, [
                  h('div', { class: 'mst-field-block' }, [
                    h('label', { class: 'mst-field-label' }, 'Webhook URL'),
                    Input
                      ? h(Input, {
                          modelValue: scrobblerUrl.value,
                          'onUpdate:modelValue': handleScrobblerUrlInput,
                          placeholder: 'https://api.listenbrainz.org/1/submit-listens 或自定义网关',
                          size: 'compact',
                        })
                      : h('input', {
                          type: 'text',
                          class: 'mst-date-fallback',
                          style: 'width: 100%;',
                          value: scrobblerUrl.value,
                          onInput: (e) => handleScrobblerUrlInput(e.target.value),
                        }),
                  ]),
                  h('div', { class: 'mst-field-block' }, [
                    h('label', { class: 'mst-field-label' }, 'User Token (可选)'),
                    Input
                      ? h(Input, {
                          type: 'password',
                          modelValue: scrobblerToken.value,
                          'onUpdate:modelValue': handleScrobblerTokenInput,
                          placeholder: '填入 Bearer API Token',
                          size: 'compact',
                        })
                      : h('input', {
                          type: 'password',
                          class: 'mst-date-fallback',
                          style: 'width: 100%;',
                          value: scrobblerToken.value,
                          onInput: (e) => handleScrobblerTokenInput(e.target.value),
                        }),
                  ]),
                  h('div', { class: 'mst-scrobbler-footer' }, [
                    h(
                      'span',
                      { class: 'mst-setting-hint' },
                      scrobblerSaving.value ? '正在自动保存…' : '输入后自动防抖保存',
                    ),
                    renderButton(
                      {
                        size: 'sm',
                        variant: 'soft-secondary',
                        loading: testingScrobbler.value,
                        disabled: testingScrobbler.value,
                        onClick: testScrobblerConnection,
                      },
                      '测试连接',
                    ),
                  ]),
                ])
              : null,
          ]),

          // 危险区：通过原生 Dialog 进行分级清空
          h('div', { class: 'mst-danger-group' }, [
            h('div', { class: 'mst-setting-copy' }, [
              h('div', { class: 'mst-setting-label' }, '清空统计数据'),
              h('div', { class: 'mst-setting-hint' }, '支持仅清空当前账号或全部账号，清空前可自动导出 JSON 备份'),
            ]),
            renderButton(
              { variant: 'danger', size: 'sm', onClick: openClearDialog },
              '清空数据…',
            ),
          ]),

          // 分级安全清理原生 Dialog
          Dialog
            ? h(
                Dialog,
                {
                  open: clearDialogOpen.value,
                  'onUpdate:open': (val) => {
                    clearDialogOpen.value = Boolean(val);
                  },
                  title: '清空听歌统计数据',
                  description: '删除后的播放记录无法从数据库恢复，请选择清理范围。',
                  showClose: true,
                },
                {
                  default: () =>
                    h('div', null, [
                      h('div', { class: 'mst-clear-options' }, [
                        h(
                          'div',
                          {
                            class: [
                              'mst-radio-card',
                              clearScope.value === 'current' ? 'is-selected' : '',
                              !hasAccount ? 'is-disabled' : '',
                            ],
                            role: 'radio',
                            'aria-checked': clearScope.value === 'current',
                            onClick: () => {
                              if (hasAccount) clearScope.value = 'current';
                            },
                          },
                          [
                            h('span', { class: 'mst-radio-dot' }, [
                              clearScope.value === 'current' ? h('span', { class: 'mst-radio-dot-inner' }) : null,
                            ]),
                            h('div', { class: 'mst-setting-copy' }, [
                              h('div', { class: 'mst-setting-label' }, '仅清空当前账号'),
                              h(
                                'div',
                                { class: 'mst-setting-hint' },
                                hasAccount ? `清理账号：${accountLabel} 的全部播放记录` : '当前未登录账号，请使用全部清理',
                              ),
                            ]),
                          ],
                        ),
                        h(
                          'div',
                          {
                            class: ['mst-radio-card', clearScope.value === 'all' ? 'is-selected' : ''],
                            role: 'radio',
                            'aria-checked': clearScope.value === 'all',
                            onClick: () => {
                              clearScope.value = 'all';
                            },
                          },
                          [
                            h('span', { class: 'mst-radio-dot' }, [
                              clearScope.value === 'all' ? h('span', { class: 'mst-radio-dot-inner' }) : null,
                            ]),
                            h('div', { class: 'mst-setting-copy' }, [
                              h('div', { class: 'mst-setting-label' }, '清空全部账号'),
                              h('div', { class: 'mst-setting-hint' }, '删除本地 SQLite 数据库中的所有播放历史'),
                            ]),
                          ],
                        ),
                      ]),
                      h(
                        'label',
                        {
                          class: 'mst-backup-check-row',
                          onClick: (e) => {
                            if (!Checkbox) {
                              e.preventDefault();
                              backupBeforeClear.value = !backupBeforeClear.value;
                            }
                          },
                        },
                        [
                          Checkbox
                            ? h(Checkbox, {
                                modelValue: backupBeforeClear.value,
                                'onUpdate:modelValue': (v) => {
                                  backupBeforeClear.value = Boolean(v);
                                },
                                ariaLabel: '清空前先导出 JSON 备份',
                              })
                            : h('input', {
                                type: 'checkbox',
                                checked: backupBeforeClear.value,
                                onChange: (e) => {
                                  backupBeforeClear.value = Boolean(e.target.checked);
                                },
                              }),
                          h('span', null, '清空前先导出 JSON 备份（推荐）'),
                        ],
                      ),
                    ]),
                  footer: () => [
                    renderButton(
                      {
                        variant: 'secondary',
                        size: 'sm',
                        disabled: clearing.value,
                        onClick: () => {
                          clearDialogOpen.value = false;
                        },
                      },
                      '取消',
                    ),
                    renderButton(
                      {
                        variant: 'danger',
                        size: 'sm',
                        loading: clearing.value,
                        disabled: clearing.value,
                        onClick: executeClear,
                      },
                      backupBeforeClear.value ? '备份并清空' : '确认清空',
                    ),
                  ],
                },
              )
            : null,
        ]);
      };
    },
  });
};

// ---- 报告页 ----

const createReportPage = (ctx, SettingsPanelComp) => {
  const { h, defineComponent, ref, computed, watch, onMounted, onBeforeUnmount, resolveComponent } =
    ctx.vue;

  const PageScrollContainer = loadHostComponent(ctx, 'PageScrollContainer');
  const DetailPageSliverHeader = loadHostComponent(ctx, 'DetailPageSliverHeader');
  const PageStickyHeader = loadHostComponent(ctx, 'PageStickyHeader');
  const DatePicker = loadHostComponent(ctx, 'DatePicker');
  const RollingNumber = loadHostComponent(ctx, 'RollingNumber');
  const Drawer = loadHostComponent(ctx, 'Drawer');
  const DrawerHeader = loadHostComponent(ctx, 'DrawerHeader');
  const Popconfirm = loadHostComponent(ctx, 'Popconfirm');
  const Button = loadHostComponent(ctx, 'Button');
  const Tabs = loadHostComponent(ctx, 'Tabs');
  const TabsList = loadHostComponent(ctx, 'TabsList');
  const TabsTrigger = loadHostComponent(ctx, 'TabsTrigger');

  const sectionTitle = (Icon, icon, title, sub, extra) =>
    h('div', { class: 'mst-card-head' }, [
      h('div', { class: 'mst-card-head-left' }, [
        h('div', { class: 'mst-card-icon-pill' }, [h(Icon, { icon, width: 16, height: 16 })]),
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

      const sliverHeaderRef = ref(null);
      const stickyTop = computed(() => sliverHeaderRef.value?.currentHeight ?? 56);

      const coverUrl = computed(() => {
        if (ctx?.cover && typeof ctx.cover.createThemedIconCoverUrl === 'function') {
          return ctx.cover.createThemedIconCoverUrl({
            icon: ctx.icons?.iconPulse || ctx.icons?.iconMusic,
          });
        }
        return '';
      });

      const activeTrackId = computed(() =>
        String(ctx?.player?.currentTrackId?.value ?? ctx?.stores?.player?.currentTrackId ?? ''),
      );

      const range = ref('30d');
      const accountScope = ref('current'); // 'current' | 'all'
      const currentUser = ref(readCurrentUser(ctx));
      const songTab = ref('top');
      const customStart = ref('');
      const customEnd = ref('');
      const loading = ref(false);
      const exporting = ref(false);
      const error = ref('');
      const report = ref(null);
      const hoveredHeatmapDay = ref(null);

      // 下钻 / 设置侧滑抽屉状态
      const drawerOpen = ref(false);
      const drawerMode = ref(''); // 'day' | 'artist' | 'settings'
      const drawerTitle = ref('');
      const drawerDesc = ref('');
      const drawerLoading = ref(false);
      const drawerDayPlays = ref([]);
      const drawerArtistDetail = ref({ songs: [], monthly: [] });
      const activeDayInfo = ref(null);

      const customRangeError = computed(() => {
        if (range.value !== 'custom') return '';
        if (customStart.value && customEnd.value && customStart.value > customEnd.value) {
          return '开始日期不能晚于结束日期';
        }
        return '';
      });

      const load = async () => {
        if (!db) {
          error.value = '本地数据库未就绪';
          return;
        }
        if (customRangeError.value) {
          return;
        }
        loading.value = true;
        error.value = '';
        currentUser.value = readCurrentUser(ctx);
        try {
          report.value = await queryReport(
            db,
            getRangeMs(range.value, customStart.value, customEnd.value),
            trendGranularity(range.value),
            {
              userId: currentUser.value.userId,
              scopeMode: accountScope.value,
            },
          );
        } catch (err) {
          console.warn('[music-stats] 查询报告失败:', err);
          error.value = '读取统计失败，请稍后重试';
        } finally {
          loading.value = false;
        }
      };

      const selectRange = (key) => {
        if (key === 'custom' && (!customStart.value || !customEnd.value)) {
          const def = getDefaultCustomRange();
          customStart.value = def.start;
          customEnd.value = def.end;
        }
        range.value = key;
      };

      const handleQuickExportJson = async () => {
        exporting.value = true;
        try {
          await exportBackupJson(ctx);
        } catch (err) {
          console.warn('[music-stats] 导出 JSON 失败:', err);
          ctx.toast.danger('导出 JSON 失败');
        } finally {
          exporting.value = false;
        }
      };

      const handleQuickExportCsv = async () => {
        exporting.value = true;
        try {
          await exportBackupCsv(ctx);
        } catch (err) {
          console.warn('[music-stats] 导出 CSV 失败:', err);
          ctx.toast.danger('导出 CSV 失败');
        } finally {
          exporting.value = false;
        }
      };

      const openDayDrawer = async (dayInfo) => {
        if (!db || !dayInfo?.day) return;
        activeDayInfo.value = dayInfo;
        drawerMode.value = 'day';
        drawerTitle.value = `${dayInfo.day} 播放流水`;
        drawerDesc.value = `${dayInfo.weekday} · ${dayInfo.plays} 次播放 · 实听 ${formatMsShort(dayInfo.ms)}`;
        drawerOpen.value = true;
        drawerLoading.value = true;
        drawerDayPlays.value = [];
        try {
          drawerDayPlays.value = await queryDayPlays(db, dayInfo.day, {
            userId: currentUser.value.userId,
            scopeMode: accountScope.value,
          });
        } catch (err) {
          console.warn('[music-stats] 查询单日流水失败:', err);
          ctx.toast.danger('读取当日播放流水失败');
        } finally {
          drawerLoading.value = false;
        }
      };

      const handleDeleteDayPlay = async (playRow) => {
        if (!db || playRow?.id == null) return;
        try {
          const res = await deletePlayById(db, playRow.id);
          if (!res.ok) throw new Error(res.error || '删除失败');
          drawerDayPlays.value = drawerDayPlays.value.filter((it) => it.id !== playRow.id);
          const totalMs = drawerDayPlays.value.reduce((acc, it) => acc + (Number(it.played_ms) || 0), 0);
          const weekday = activeDayInfo.value?.weekday || '';
          drawerDesc.value = `${weekday} · ${drawerDayPlays.value.length} 次播放 · 实听 ${formatMsShort(totalMs)}`;
          ctx.toast.success('已删除该条播放记录');
          void load();
        } catch (err) {
          console.warn('[music-stats] 删除播放记录失败:', err);
          ctx.toast.danger('删除失败，请重试');
        }
      };

      const openArtistDrawer = async (artistRow) => {
        if (!db || !artistRow?.artist) return;
        const artist = String(artistRow.artist);
        drawerMode.value = 'artist';
        drawerTitle.value = artist;
        drawerDesc.value = `区间内 ${Number(artistRow.plays) || 0} 次播放 · 实听 ${formatMsShort(Number(artistRow.ms) || 0)}`;
        drawerOpen.value = true;
        drawerLoading.value = true;
        drawerArtistDetail.value = { songs: [], monthly: [] };
        try {
          drawerArtistDetail.value = await queryArtistDetail(
            db,
            artist,
            getRangeMs(range.value, customStart.value, customEnd.value),
            {
              userId: currentUser.value.userId,
              scopeMode: accountScope.value,
            },
          );
        } catch (err) {
          console.warn('[music-stats] 查询歌手详情失败:', err);
          ctx.toast.danger('读取歌手详情失败');
        } finally {
          drawerLoading.value = false;
        }
      };

      const openSettingsDrawer = () => {
        drawerMode.value = 'settings';
        drawerTitle.value = '听歌统计设置';
        drawerDesc.value = '采集规则、备份导出、Scrobbler 与数据清理';
        drawerOpen.value = true;
      };

      let unsubscribeUser = null;

      onMounted(() => {
        reportRefreshListeners.add(load);
        void load();
        // 监听多账号切换（支持 EchoMusic v2.3.2+ 多账号会话隔离，卸载时严格释放订阅）
        try {
          const userStore = ctx.pinia?._s?.get('user');
          if (userStore && typeof userStore.$subscribe === 'function') {
            let lastUid = String(userStore.info?.userid ?? userStore.info?.userId ?? '');
            let lastRev = Number(userStore.accountRevision || 0);
            unsubscribeUser = userStore.$subscribe(() => {
              const curUid = String(userStore.info?.userid ?? userStore.info?.userId ?? '');
              const curRev = Number(userStore.accountRevision || 0);
              if (curUid !== lastUid || curRev !== lastRev) {
                lastUid = curUid;
                lastRev = curRev;
                currentUser.value = readCurrentUser(ctx);
                void load();
              }
            });
          }
        } catch {}
      });

      onBeforeUnmount(() => {
        reportRefreshListeners.delete(load);
        if (typeof unsubscribeUser === 'function') {
          try {
            unsubscribeUser();
          } catch {}
          unsubscribeUser = null;
        }
      });

      watch(range, () => {
        if (!customRangeError.value) void load();
      });
      watch(accountScope, load);
      watch([customStart, customEnd], () => {
        if (range.value === 'custom' && customStart.value && customEnd.value && !customRangeError.value) {
          void load();
        }
      });

      const renderDrawerContent = () => {
        if (drawerMode.value === 'settings') {
          return h('div', { class: 'mst-drawer-body' }, [
            SettingsPanelComp ? h(SettingsPanelComp, { onDataChanged: load }) : null,
          ]);
        }

        if (drawerLoading.value) {
          return h('div', { class: 'mst-drawer-body' }, [
            h('div', { class: 'mst-state' }, [
              h(Icon, { icon: ctx.icons.iconRefreshCw, width: 28, height: 28, class: 'mst-spin' }),
              h('p', null, '正在加载明细…'),
            ]),
          ]);
        }

        if (drawerMode.value === 'day') {
          const rows = drawerDayPlays.value;
          if (!rows.length) {
            return h('div', { class: 'mst-drawer-body' }, [
              h('div', { class: 'mst-state' }, [h('p', null, '当日暂无播放记录')]),
            ]);
          }
          return h('div', { class: 'mst-drawer-body' }, [
            h('div', { class: 'mst-drawer-list' }, [
              ...rows.map((r) =>
                h('div', { class: 'mst-drawer-row', key: r.id ?? `${r.track_id}-${r.started_at}` }, [
                  h('span', { class: 'mst-drawer-time' }, formatTimeHm(r.started_at)),
                  h('div', { class: 'mst-song-main' }, [
                    h('span', { class: 'mst-song-title', title: String(r.title) }, String(r.title)),
                    h(
                      'span',
                      { class: 'mst-song-artist', title: `${r.artist}${r.album ? ` · ${r.album}` : ''}` },
                      `${r.artist} · 实听 ${formatDurationClock(r.played_ms)}`,
                    ),
                  ]),
                  Number(r.completed) === 1
                    ? h('span', { class: 'mst-drawer-tag is-completed' }, '完播')
                    : Number(r.skipped) === 1
                      ? h('span', { class: 'mst-drawer-tag is-skipped' }, '跳过')
                      : null,
                  r.track_id
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'mst-row-icon-btn is-play',
                          title: '播放',
                          'aria-label': `播放 ${r.title}`,
                          onClick: () => playTrackById(ctx, r.track_id),
                        },
                        [iconSvg(h, MST_ICONS.play, { size: 13 })],
                      )
                    : null,
                  Popconfirm
                    ? h(
                        Popconfirm,
                        {
                          title: '删除此条播放记录？',
                          description: '将从本地统计中永久移除该记录（适合清理挂机或误播记录）',
                          tone: 'danger',
                          confirmText: '删除',
                          cancelText: '取消',
                          side: 'left',
                          onConfirm: () => void handleDeleteDayPlay(r),
                        },
                        {
                          trigger: () =>
                            h(
                              'button',
                              {
                                type: 'button',
                                class: 'mst-row-icon-btn is-danger',
                                title: '删除记录',
                                'aria-label': `删除 ${r.title} 的播放记录`,
                              },
                              [iconSvg(h, MST_ICONS.trash, { size: 13 })],
                            ),
                        },
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          class: 'mst-row-icon-btn is-danger',
                          title: '删除记录',
                          onClick: () => void handleDeleteDayPlay(r),
                        },
                        [iconSvg(h, MST_ICONS.trash, { size: 13 })],
                      ),
                ]),
              ),
            ]),
          ]);
        }

        if (drawerMode.value === 'artist') {
          const { songs, monthly } = drawerArtistDetail.value;
          const maxMonthPlays = Math.max(1, ...monthly.map((m) => Number(m.plays) || 0));
          return h('div', { class: 'mst-drawer-body' }, [
            monthly.length > 0
              ? h('div', null, [
                  h('h4', { class: 'mst-drawer-section-title' }, '近期月度收听汇总'),
                  h('div', { class: 'mst-artist-months' }, [
                    ...monthly.map((m) =>
                      h('div', { class: 'mst-artist-month-row', key: m.month }, [
                        h('span', { class: 'mst-bar-name', style: 'font-size: 12px;' }, String(m.month)),
                        h('div', { class: 'mst-bar-track' }, [
                          h('div', {
                            class: 'mst-bar-fill',
                            style: { width: `${Math.max(4, ((Number(m.plays) || 0) / maxMonthPlays) * 100)}%` },
                          }),
                        ]),
                        h('span', { class: 'mst-bar-val' }, `${Number(m.plays) || 0} 次 · ${formatMsShort(m.ms)}`),
                      ]),
                    ),
                  ]),
                ])
              : null,
            h('div', null, [
              h('h4', { class: 'mst-drawer-section-title' }, `区间热门曲目 (${songs.length})`),
              renderSongList(h, songs, ctx, {
                activeTrackId: activeTrackId.value,
                Popconfirm,
                showDownload: true,
              }),
            ]),
          ]);
        }

        return null;
      };

      const renderButton = (btnProps, children) =>
        Button
          ? h(Button, btnProps, { default: () => children })
          : h('button', { type: 'button', ...btnProps }, children);

      return () => {
        const data = report.value;
        const isEmpty = !data || !data.kpi || Number(data.kpi.n) === 0;
        const isMonthly = range.value === 'year' || range.value === 'all';
        const todayStr = formatDay();

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

        const sourceItems = data ? buildSourceSegments(data.sources) : { items: [], total: 0 };

        const accountScopeLabel =
          accountScope.value === 'all'
            ? '全部账号合并视图'
            : currentUser.value.nickname
              ? `当前账号：${currentUser.value.nickname}`
              : currentUser.value.userId
                ? `当前账号：${currentUser.value.userId}`
                : '当前账号视图';

        const headerNode = DetailPageSliverHeader
          ? h(
              DetailPageSliverHeader,
              {
                ref: sliverHeaderRef,
                typeLabel: 'STATS',
                title: '听歌统计',
                coverUrl: coverUrl.value,
                hasDetails: true,
                distributeDetails: true,
                expandedHeight: 176,
                collapsedHeight: 56,
              },
              {
                details: () =>
                  h('div', { class: 'mst-sliver-details' }, [
                    h('div', { class: 'mst-sliver-meta-line' }, [
                      h('span', { class: 'mst-sliver-pill' }, [
                        h(Icon, { icon: ctx.icons.iconShield || ctx.icons.iconCheck, width: 12, height: 12 }),
                        h('span', null, '纯本地 SQLite · 零隐私上传'),
                      ]),
                      h('span', null, accountScopeLabel),
                    ]),
                    h(
                      'div',
                      { class: 'mst-sliver-meta-line' },
                      data && !isEmpty
                        ? `当前区间：${Number(data.kpi.n) || 0} 次播放 · 实听 ${formatMsShort(data.kpi.ms)} · ${Number(data.kpi.songs) || 0} 首曲目 · ${Number(data.kpi.artists) || 0} 位歌手`
                        : '自动静默采集播放足迹，点击热力图与歌手排行可下钻查看明细',
                    ),
                  ]),
                actions: () =>
                  h('div', { class: 'mst-sliver-actions' }, [
                    renderButton(
                      {
                        variant: 'soft-primary',
                        size: 'sm',
                        disabled: loading.value,
                        onClick: load,
                      },
                      h('span', { class: 'mst-btn-inner' }, [
                        h(Icon, {
                          icon: ctx.icons.iconRefreshCw,
                          width: 14,
                          height: 14,
                          class: loading.value ? 'mst-spin' : '',
                        }),
                        h('span', null, '刷新'),
                      ]),
                    ),
                    renderButton(
                      {
                        variant: 'soft-secondary',
                        size: 'sm',
                        disabled: exporting.value,
                        onClick: handleQuickExportJson,
                      },
                      '导出 JSON',
                    ),
                    renderButton(
                      {
                        variant: 'soft-secondary',
                        size: 'sm',
                        disabled: exporting.value,
                        onClick: handleQuickExportCsv,
                      },
                      '导出 CSV',
                    ),
                    renderButton(
                      {
                        variant: 'ghost',
                        size: 'icon',
                        tooltip: '听歌统计设置',
                        onClick: openSettingsDrawer,
                      },
                      h(Icon, { icon: ctx.icons.iconSettings || ctx.icons.iconSlidersHorizontal, width: 16, height: 16 }),
                    ),
                  ]),
                'collapsed-actions': () => [
                  renderButton(
                    {
                      variant: 'ghost',
                      size: 'icon',
                      class: 'action-icon',
                      tooltip: '刷新统计',
                      onClick: load,
                    },
                    h(Icon, {
                      icon: ctx.icons.iconRefreshCw,
                      width: 16,
                      height: 16,
                      class: loading.value ? 'mst-spin' : '',
                    }),
                  ),
                  renderButton(
                    {
                      variant: 'ghost',
                      size: 'icon',
                      class: 'action-icon',
                      tooltip: '导出 JSON',
                      onClick: handleQuickExportJson,
                    },
                    h(Icon, { icon: ctx.icons.iconArrowBarToDown || ctx.icons.iconUpload, width: 16, height: 16 }),
                  ),
                  renderButton(
                    {
                      variant: 'ghost',
                      size: 'icon',
                      class: 'action-icon',
                      tooltip: '听歌统计设置',
                      onClick: openSettingsDrawer,
                    },
                    h(Icon, { icon: ctx.icons.iconSettings || ctx.icons.iconSlidersHorizontal, width: 16, height: 16 }),
                  ),
                ],
              },
            )
          : null;

        const stickyBarContent = h('div', { class: 'mst-sticky-inner' }, [
          h('div', { class: 'mst-sticky-row' }, [
            h('div', { class: 'mst-filter-group', role: 'tablist', 'aria-label': '时间范围' }, [
              ...RANGE_OPTIONS.map((opt) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: opt.key,
                    class: ['mst-filter-btn', range.value === opt.key ? 'active' : ''],
                    onClick: () => selectRange(opt.key),
                  },
                  opt.label,
                ),
              ),
            ]),
            h('div', { class: 'mst-scope-group', title: '切换当前登录账号或全部账号合并统计' }, [
              h(
                'button',
                {
                  type: 'button',
                  class: ['mst-filter-btn', accountScope.value === 'current' ? 'active' : ''],
                  onClick: () => {
                    accountScope.value = 'current';
                  },
                },
                currentUser.value.nickname
                  ? `当前账号 (${currentUser.value.nickname})`
                  : '当前账号',
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: ['mst-filter-btn', accountScope.value === 'all' ? 'active' : ''],
                  onClick: () => {
                    accountScope.value = 'all';
                  },
                },
                '全部账号',
              ),
            ]),
          ]),
        ]);

        const stickyNode = PageStickyHeader
          ? h(
              PageStickyHeader,
              {
                stickyTop: stickyTop.value,
                class: 'song-list-sticky mst-sticky-bar',
                style: { top: `${stickyTop.value}px` },
              },
              { default: () => stickyBarContent },
            )
          : h('div', { class: 'mst-sticky-bar' }, [stickyBarContent]);

        const songSubTabsNode =
          Tabs && TabsList && TabsTrigger
            ? h('div', { class: 'mst-song-tabs-bar' }, [
                h(
                  Tabs,
                  {
                    modelValue: songTab.value,
                    'onUpdate:modelValue': (val) => {
                      songTab.value = String(val || 'top');
                    },
                  },
                  {
                    default: () =>
                      h(TabsList, { class: 'mst-song-tabs-list' }, {
                        default: () => [
                          h(TabsTrigger, { value: 'top' }, { default: () => `Top 播放 (${data.topSongs.length})` }),
                          h(
                            TabsTrigger,
                            { value: 'completed' },
                            { default: () => `最耐听 (${(data.completedSongs || []).length})` },
                          ),
                          h(
                            TabsTrigger,
                            { value: 'skipped' },
                            { default: () => `常切 (${(data.skippedSongs || []).length})` },
                          ),
                        ],
                      }),
                  },
                ),
              ])
            : h('div', { class: 'mst-filter-group', style: 'margin-bottom: 10px;' }, [
                h(
                  'button',
                  {
                    type: 'button',
                    class: ['mst-filter-btn', songTab.value === 'top' ? 'active' : ''],
                    onClick: () => {
                      songTab.value = 'top';
                    },
                  },
                  `Top 播放 (${data.topSongs.length})`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: ['mst-filter-btn', songTab.value === 'completed' ? 'active' : ''],
                    onClick: () => {
                      songTab.value = 'completed';
                    },
                  },
                  `最耐听 (${(data.completedSongs || []).length})`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: ['mst-filter-btn', songTab.value === 'skipped' ? 'active' : ''],
                    onClick: () => {
                      songTab.value = 'skipped';
                    },
                  },
                  `常切 (${(data.skippedSongs || []).length})`,
                ),
              ]);

        const bodyContent = h('div', { class: 'mst-page' }, [
          // 自定义日期选择条（原生 DatePicker + 预填近 30 天 + start <= end 校验）
          range.value === 'custom'
            ? h('div', { class: 'mst-custom-range' }, [
                h('span', { class: 'mst-custom-label' }, '自定义时间区间：'),
                h('div', { class: 'mst-date-picker-box' }, [
                  DatePicker
                    ? h(DatePicker, {
                        modelValue: customStart.value,
                        'onUpdate:modelValue': (val) => {
                          customStart.value = String(val || '');
                        },
                        max: customEnd.value || todayStr,
                        size: 'compact',
                        placeholder: '开始日期',
                        ariaLabel: '开始日期',
                      })
                    : h('input', {
                        type: 'date',
                        class: 'mst-date-fallback',
                        value: customStart.value,
                        max: customEnd.value || todayStr,
                        onChange: (e) => {
                          customStart.value = e.target.value;
                        },
                      }),
                ]),
                h('span', { class: 'mst-custom-label' }, '至'),
                h('div', { class: 'mst-date-picker-box' }, [
                  DatePicker
                    ? h(DatePicker, {
                        modelValue: customEnd.value,
                        'onUpdate:modelValue': (val) => {
                          customEnd.value = String(val || '');
                        },
                        min: customStart.value || undefined,
                        max: todayStr,
                        size: 'compact',
                        placeholder: '结束日期',
                        ariaLabel: '结束日期',
                      })
                    : h('input', {
                        type: 'date',
                        class: 'mst-date-fallback',
                        value: customEnd.value,
                        min: customStart.value || undefined,
                        max: todayStr,
                        onChange: (e) => {
                          customEnd.value = e.target.value;
                        },
                      }),
                ]),
                renderButton(
                  {
                    variant: 'soft-primary',
                    size: 'sm',
                    disabled: Boolean(customRangeError.value) || loading.value,
                    onClick: load,
                  },
                  '应用筛选',
                ),
                customRangeError.value ? h('span', { class: 'mst-custom-error' }, customRangeError.value) : null,
              ])
            : null,

          loading.value && !data
            ? h('div', { class: 'mst-card' }, [
                h('div', { class: 'mst-state' }, [
                  h(Icon, {
                    icon: ctx.icons.iconRefreshCw,
                    width: 32,
                    height: 32,
                    class: 'mst-spin',
                    style: 'color: var(--color-primary-text);',
                  }),
                  h('p', null, '正在深入解析听歌数据…'),
                ]),
              ])
            : error.value && !data
              ? h('div', { class: 'mst-card' }, [
                  h('div', { class: 'mst-state' }, [
                    h(Icon, {
                      icon: ctx.icons.iconTriangleAlert || ctx.icons.iconInfo,
                      width: 40,
                      height: 40,
                      style: 'color: var(--state-danger, #ef4444);',
                    }),
                    h('p', null, error.value),
                  ]),
                ])
              : isEmpty
                ? h('div', { class: 'mst-card' }, [
                    h('div', { class: 'mst-state' }, [
                      h(Icon, { icon: ctx.icons.iconMusic, width: 48, height: 48, style: 'opacity: 0.45;' }),
                      h('p', null, '所选时间区间内暂无听歌记录，放首歌静静聆听吧'),
                    ]),
                  ])
                : [
                    // 年度报告摘要（选择「今年」时展示）
                    annual
                      ? h('div', { class: 'mst-annual' }, [
                          h('div', { class: 'mst-annual-head' }, [
                            h('div', { class: 'mst-annual-head-left' }, [
                              h(Icon, { icon: ctx.icons.iconSparkles || ctx.icons.iconStar, width: 20, height: 20 }),
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

                    // KPI 核心指标（接入宿主原生 RollingNumber）
                    (() => {
                      const totalPlays = Number(data.kpi.n) || 0;
                      const compCount = Number(data.kpi.completed_count) || 0;
                      const skipCount = Number(data.kpi.skipped_count) || 0;
                      const compPct = totalPlays > 0 ? Math.round((compCount / totalPlays) * 100) : 0;
                      const skipPct = totalPlays > 0 ? Math.round((skipCount / totalPlays) * 100) : 0;

                      return h('div', { class: 'mst-kpis' }, [
                        kpiCard(
                          h,
                          RollingNumber,
                          '累计听歌时长',
                          formatMsShort(Number(data.kpi.ms) || 0),
                          iconSvg(h, MST_ICONS.clock, { size: 14 }),
                          '有效实听时长',
                        ),
                        kpiCard(
                          h,
                          RollingNumber,
                          '累计播放次数',
                          `${totalPlays} 次`,
                          iconSvg(h, MST_ICONS.music, { size: 14 }),
                          '达标计入次数',
                        ),
                        kpiCard(
                          h,
                          RollingNumber,
                          '完播率',
                          `${compPct}%`,
                          iconSvg(h, MST_ICONS.headphones, { size: 14 }),
                          `${compCount} 次完整听完`,
                          compPct,
                          false,
                        ),
                        kpiCard(
                          h,
                          RollingNumber,
                          '切歌跳过率',
                          `${skipPct}%`,
                          iconSvg(h, MST_ICONS.skip, { size: 14 }),
                          `${skipCount} 次快速跳过`,
                          skipPct,
                          true,
                        ),
                        kpiCard(
                          h,
                          RollingNumber,
                          '去重曲目',
                          `${Number(data.kpi.songs) || 0} 首`,
                          iconSvg(h, MST_ICONS.music, { size: 14 }),
                          '收听不同单曲',
                        ),
                        kpiCard(
                          h,
                          RollingNumber,
                          '去重歌手',
                          `${Number(data.kpi.artists) || 0} 位`,
                          iconSvg(h, MST_ICONS.user, { size: 14 }),
                          '探索音乐人谱系',
                        ),
                      ]);
                    })(),

                    // 单日循环神曲 & 深夜灵魂单曲
                    renderHighlights(h, data.loopSong, data.nightSong, ctx),

                    // 卡片网格区
                    h('div', { class: 'mst-grid' }, [
                      // 365天听歌热力图（点击任意日期打开右侧流水抽屉）
                      data.heatmap && data.heatmap.length > 0
                        ? h('div', { class: 'mst-card mst-full' }, [
                            sectionTitle(
                              Icon,
                              ctx.icons.iconCalendar || ctx.icons.iconClock,
                              '365天听歌足迹热力图',
                              '点击任意日期方格可展开当日播放流水并清理异常记录',
                            ),
                            renderHeatmapChart(h, data.heatmap, hoveredHeatmapDay, openDayDrawer),
                          ])
                        : null,

                      // 24小时音乐生物钟
                      h('div', { class: 'mst-card mst-full' }, [
                        sectionTitle(
                          Icon,
                          ctx.icons.iconClock,
                          '24小时音乐生物钟',
                          '晨起、工作、黄昏、深夜四大时段的听歌节奏与活跃峰值',
                        ),
                        renderCircadianClock(h, data.hours),
                      ]),

                      // 听歌个性成就徽章（带进度条）
                      h('div', { class: 'mst-card mst-full' }, [
                        sectionTitle(
                          Icon,
                          ctx.icons.iconTrophy || ctx.icons.iconStar,
                          '听歌画像成就徽章',
                          '深度挖掘你的音乐习惯与行为数据，实时追踪每枚勋章达成进度',
                        ),
                        renderBadges(h, data),
                      ]),

                      // 听歌时长趋势
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

                      // Top 歌手（点击歌手行下钻抽屉）
                      data.topArtists.length > 0
                        ? h('div', { class: 'mst-card' }, [
                            sectionTitle(
                              Icon,
                              ctx.icons.iconUsers || ctx.icons.iconTrophy,
                              'Top 歌手排行',
                              '按区间内累计有效实听时长降序 · 点击歌手查看曲目与月度趋势',
                            ),
                            renderArtistBars(h, data.topArtists, openArtistDrawer),
                          ])
                        : null,

                      // Top 歌曲（原生 Tabs + 双击播放 + 显式矢量播放与下载图标）
                      h('div', { class: 'mst-card' }, [
                        sectionTitle(
                          Icon,
                          ctx.icons.iconMusic,
                          '歌曲榜单与完播分析',
                          songTab.value === 'top'
                            ? '双击歌曲行或点击右侧播放图标即可试听'
                            : songTab.value === 'completed'
                              ? '最常听完的单曲榜（完播率 85% 以上）'
                              : '最容易被跳过的单曲（播放低于 15 秒被切歌）',
                        ),
                        songSubTabsNode,
                        renderSongList(
                          h,
                          songTab.value === 'top'
                            ? data.topSongs
                            : songTab.value === 'completed'
                              ? data.completedSongs || []
                              : data.skippedSongs || [],
                          ctx,
                          {
                            activeTrackId: activeTrackId.value,
                            Popconfirm,
                            showDownload: songTab.value === 'top',
                          },
                        ),
                      ]),

                      // 每日 24 时段分布
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
        ]);

        const scrollInner = [headerNode, stickyNode, bodyContent];

        return h('div', { class: 'mst-root' }, [
          PageScrollContainer
            ? h(PageScrollContainer, { class: 'mst-scroll' }, { default: () => scrollInner })
            : h('div', { class: 'mst-scroll', style: 'overflow-y: auto;' }, scrollInner),

          // 右侧下钻 / 设置原生 Drawer
          Drawer
            ? h(
                Drawer,
                {
                  open: drawerOpen.value,
                  'onUpdate:open': (val) => {
                    drawerOpen.value = Boolean(val);
                  },
                  side: 'right',
                  title: drawerTitle.value,
                  panelStyle: { width: drawerMode.value === 'settings' ? 'min(520px, 92vw)' : 'min(480px, 90vw)' },
                },
                {
                  default: () => [
                    DrawerHeader
                      ? h(DrawerHeader, {
                          title: drawerTitle.value,
                          description: drawerDesc.value,
                          onClose: () => {
                            drawerOpen.value = false;
                          },
                        })
                      : null,
                    renderDrawerContent(),
                  ],
                },
              )
            : null,
        ]);
      };
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
      const { userId } = readCurrentUser(ctx);
      if (userId) {
        await claimUnassignedPlays(db, userId);
      }
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

  // 说明：EchoMusic 宿主备份 (ctx.backups) 原生会自动将本插件的 SQLite 数据库 (plays) 与 KV 存储打包进备份包中，
  // 无需注册空壳 registerProvider（registerProvider 仅用于扩展 WebDAV 等外部云存储后端）。

  const SettingsPanelComp = createSettingsPanel(ctx);

  // 报告页 + 侧边栏入口
  ctx.ui.addPage({
    id: 'report',
    title: '听歌统计',
    icon: ctx.icons.iconPulse,
    component: createReportPage(ctx, SettingsPanelComp),
    order: 20,
    sidebar: true,
  });

  // 设置面板（独立轻量面板，绝不嵌套 PageScrollContainer）
  ctx.ui.settings.define({
    id: 'music-stats',
    title: '听歌统计',
    description: '采集开关、最短计入时长、数据备份、Scrobbler 与分级清空',
    component: SettingsPanelComp,
  });

  // 命令
  ctx.commands.register(
    'music-stats:open',
    () => ctx.router.push('/main/plugin/music-stats/report'),
    { title: '听歌统计' },
  );

  disposeAll = async () => {
    await settleCurrent(ctx);
    current = null;
    db = null;
    reportRefreshListeners.clear();
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
