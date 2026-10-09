import type {
  ArticleDTO,
  DirListing,
  QbRuleImportRequest,
  RuleImportResult,
  RuleFeedsRequest,
  RssConfig,
  RssConfigSaveResult,
  RuleFeedsResult,
  FeedDTO,
  RssHistoryDTO,
  RuleDTO,
  RuleInput,
  StatsHistory,
  StatsSnapshot,
  UpcomingResponse,
  MissingResponse,
  SiteDTO,
  SiteInput,
  SitePresetDTO,
  SiteTestResult,
  LibraryEntryDTO,
  AddMagnetRequest,
  AddTorrentFileRequest,
  CategoryDTO,
  PeerDTO,
  SettingsResponse,
  TorrentDTO,
  UpdateTorrentRequest,
} from '@draxmax/shared';

/**
 * API token: the desktop app passes it in the page URL (`?token=`); it is kept in
 * sessionStorage so in-app navigation doesn't lose it.
 */
function resolveToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('token');
  try {
    if (fromUrl) sessionStorage.setItem('draxmax-token', fromUrl);
    return fromUrl ?? sessionStorage.getItem('draxmax-token');
  } catch {
    return fromUrl;
  }
}

const token = resolveToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Called on any 401 so the app can switch to the login/setup screen. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Non-JSON error body.
    }
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    throw new ApiError(res.status, message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function wsUrl(path: string): string {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/** Reads a File into base64 without blowing the call stack on large inputs. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  setupCodeRequired: boolean;
  username: string | null;
  managedByEnv: boolean;
}

const enc = encodeURIComponent;

export const api = {
  // Torrents
  listTorrents: () => request<TorrentDTO[]>('GET', '/api/torrents'),
  addMagnet: (req: AddMagnetRequest) => request<TorrentDTO>('POST', '/api/torrents/magnet', req),
  addTorrentFile: (req: AddTorrentFileRequest) =>
    request<TorrentDTO>('POST', '/api/torrents/file', req),
  update: (id: string, patch: UpdateTorrentRequest) =>
    request<TorrentDTO>('PATCH', `/api/torrents/${id}`, patch),
  pauseAll: () => request<undefined>('POST', '/api/torrents/pause-all'),
  resumeAll: () => request<undefined>('POST', '/api/torrents/resume-all'),
  pause: (id: string) => request<TorrentDTO>('POST', `/api/torrents/${id}/pause`),
  resume: (id: string) => request<TorrentDTO>('POST', `/api/torrents/${id}/resume`),
  reannounce: (id: string) => request<TorrentDTO>('POST', `/api/torrents/${id}/reannounce`),
  recheck: (id: string) => request<TorrentDTO>('POST', `/api/torrents/${id}/recheck`),
  queue: (id: string, move: 'top' | 'up' | 'down' | 'bottom') =>
    request<TorrentDTO>('POST', `/api/torrents/${id}/queue`, { move }),
  peers: (id: string) => request<PeerDTO[]>('GET', `/api/torrents/${id}/peers`),
  remove: (id: string, deleteFiles: boolean) =>
    request<undefined>('DELETE', `/api/torrents/${id}?deleteFiles=${deleteFiles}`),
  setFilePriorities: (id: string, files: { index: number; priority: number }[]) =>
    request<TorrentDTO>('PATCH', `/api/torrents/${id}/files`, { files }),
  addTrackers: (id: string, urls: string[]) =>
    request<TorrentDTO>('POST', `/api/torrents/${id}/trackers`, { urls }),
  removeTrackers: (id: string, urls: string[]) =>
    request<TorrentDTO>('DELETE', `/api/torrents/${id}/trackers`, { urls }),
  setTrackerEnabled: (id: string, url: string, enabled: boolean) =>
    request<TorrentDTO>('PATCH', `/api/torrents/${id}/trackers`, { url, enabled }),

  // Categories & tags
  categories: () => request<CategoryDTO[]>('GET', '/api/categories'),
  saveCategory: (name: string, savePath: string | null) =>
    request<CategoryDTO>('PUT', `/api/categories/${enc(name)}`, { savePath }),
  deleteCategory: (name: string) => request<undefined>('DELETE', `/api/categories/${enc(name)}`),
  tags: () => request<string[]>('GET', '/api/tags'),

  // Settings
  settings: () => request<SettingsResponse>('GET', '/api/settings'),
  restart: () => request<{ restarting: boolean }>('POST', '/api/system/restart'),
  patchSettings: (patch: Record<string, unknown>) =>
    request<SettingsResponse>('PATCH', '/api/settings', patch),

  // RSS
  feeds: () => request<FeedDTO[]>('GET', '/api/rss/feeds'),
  addFeed: (url: string, refreshMinutes?: number | null) =>
    request<FeedDTO>('POST', '/api/rss/feeds', { url, refreshMinutes }),
  updateFeed: (
    id: string,
    patch: { url?: string; title?: string; enabled?: boolean; refreshMinutes?: number | null },
  ) => request<FeedDTO>('PATCH', `/api/rss/feeds/${id}`, patch),
  deleteFeed: (id: string) => request<undefined>('DELETE', `/api/rss/feeds/${id}`),
  refreshFeed: (id: string) => request<FeedDTO>('POST', `/api/rss/feeds/${id}/refresh`),
  refreshAllFeeds: () => request<FeedDTO[]>('POST', '/api/rss/refresh'),
  articles: (q: { feedId?: string | null; unread?: boolean; q?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (q.feedId) p.set('feedId', q.feedId);
    if (q.unread) p.set('unread', 'true');
    if (q.q) p.set('q', q.q);
    p.set('limit', String(q.limit ?? 300));
    return request<ArticleDTO[]>('GET', `/api/rss/articles?${p}`);
  },
  markRead: (body: {
    feedId?: string;
    articles?: { feedId: string; id: string }[];
    read: boolean;
  }) => request<undefined>('POST', '/api/rss/articles/read', body),
  downloadArticle: (feedId: string, id: string) =>
    request<{ torrentId: string | null; status: 'added' | 'duplicate' }>(
      'POST',
      '/api/rss/articles/download',
      { feedId, id },
    ),
  rules: () => request<RuleDTO[]>('GET', '/api/rss/rules'),
  createRule: (r: RuleInput) => request<RuleDTO>('POST', '/api/rss/rules', r),
  updateRule: (id: string, r: RuleInput) => request<RuleDTO>('PUT', `/api/rss/rules/${id}`, r),
  deleteRule: (id: string) => request<undefined>('DELETE', `/api/rss/rules/${id}`),
  deleteRules: (ids: string[]) =>
    request<{ deleted: number }>('POST', '/api/rss/rules/delete', { ids }),
  importQbRules: (body: QbRuleImportRequest) =>
    request<RuleImportResult>('POST', '/api/rss/rules/import', body),
  rssConfig: () => request<RssConfig>('GET', '/api/rss/config'),
  saveRssConfig: (cfg: RssConfig & { removeMissing: boolean }) =>
    request<RssConfigSaveResult>('PUT', '/api/rss/config', cfg),
  setRuleFeeds: (body: Partial<RuleFeedsRequest> & { ids: string[] }) =>
    request<RuleFeedsResult>('POST', '/api/rss/rules/feeds', body),
  previewRule: (r: RuleInput) => request<ArticleDTO[]>('POST', '/api/rss/rules/preview', r),
  sites: () => request<SiteDTO[]>('GET', '/api/sites'),
  sitePresets: () => request<SitePresetDTO[]>('GET', '/api/sites/presets'),
  createSite: (s: SiteInput) => request<SiteDTO>('POST', '/api/sites', s),
  updateSite: (id: string, s: SiteInput) => request<SiteDTO>('PUT', `/api/sites/${id}`, s),
  setSiteEnabled: (id: string, enabled: boolean) =>
    request<SiteDTO>('PATCH', `/api/sites/${id}`, { enabled }),
  deleteSite: (id: string) => request<undefined>('DELETE', `/api/sites/${id}`),
  testSite: (id: string, query: string) =>
    request<SiteTestResult>('POST', `/api/sites/${id}/test`, { query }),
  missing: () => request<MissingResponse>('GET', '/api/missing'),
  checkMissing: (ruleIds?: string[]) =>
    request<MissingResponse>('POST', '/api/missing/check', ruleIds ? { ruleIds } : {}),
  rssHistory: () => request<RssHistoryDTO[]>('GET', '/api/rss/history'),
  clearRssHistory: () => request<undefined>('DELETE', '/api/rss/history'),

  // Server folder browser
  dirs: (path?: string) =>
    request<DirListing>('GET', `/api/fs/dirs${path ? `?path=${enc(path)}` : ''}`),
  mkdir: (path: string) => request<DirListing>('POST', '/api/fs/dirs', { path }),

  // Stats
  stats: () => request<StatsSnapshot>('GET', '/api/stats'),
  statsHistory: (range: 'live' | 'day') =>
    request<StatsHistory>('GET', `/api/stats/history?range=${range}`),

  // Upcoming / library
  upcoming: () => request<UpcomingResponse>('GET', '/api/upcoming'),
  refreshUpcoming: () => request<UpcomingResponse>('POST', '/api/upcoming/refresh'),
  upcomingAction: (id: string, action: 'ignore' | 'have' | 'reset') =>
    request<UpcomingResponse>('POST', '/api/upcoming/action', { id, action }),
  library: () => request<LibraryEntryDTO[]>('GET', '/api/library'),
  addLibraryEntry: (entry: {
    title: string;
    type: 'movie' | 'tv' | 'anime' | 'other';
    seasonsOwned?: number[];
    year?: number;
  }) => request<LibraryEntryDTO>('POST', '/api/library', entry),
  setLibraryHidden: (id: string, hidden: boolean) =>
    request<LibraryEntryDTO>('PATCH', `/api/library/${enc(id)}`, { hidden }),
  rescanLibrary: () => request<LibraryEntryDTO[]>('POST', '/api/library/rescan'),

  // Auth
  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  login: (username: string, password: string) =>
    request<AuthStatus>('POST', '/api/auth/login', { username, password }),
  logout: () => request<undefined>('POST', '/api/auth/logout'),
  setupAuth: (username: string, password: string, setupCode?: string) =>
    request<AuthStatus>('POST', '/api/auth/setup', { username, password, setupCode }),
  changeCredentials: (username: string, password: string, currentPassword?: string) =>
    request<AuthStatus>('PUT', '/api/auth/credentials', { username, password, currentPassword }),
  clearCredentials: () => request<undefined>('DELETE', '/api/auth/credentials'),
};
