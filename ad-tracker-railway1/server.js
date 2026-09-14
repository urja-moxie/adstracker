/**
 * Ad tracker — Railway server
 *
 *   GET /            -> public/index.html
 *   GET /api/data    -> { ads, fetchedAt, counts }  (live from Notion)
 *   GET /healthz     -> ok
 *
 * Environment variables (set these in Railway → Variables):
 *   NOTION_TOKEN   internal connection secret, starts with ntn_   [required]
 *   NOTION_DB_ID   the Projects database id                        [required]
 *   CACHE_SECONDS  how long to hold a Notion response (default 300)
 *   PORT           injected by Railway automatically
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 300);
const NOTION_VERSION = '2025-09-03';

/* ── status routing — must match the dashboard's definition of live ── */
const LIVE = new Set(['completed', 'live']);
const PIPE = new Set([
  'shooting', 'scripting on creator', 'reshoot', 'to be scripted',
  'pod discussion', 'in edit', 'storyboarding', 'in approval',
  'to be storyboarded', 'scripting', 'script in approval', 'footage review',
  'garage copy', 'edit on creator/outsourced', 'edit to be picked',
  'non-collab post',
]);
// Canned, Stand By, Referencing, Creator to be mapped and Waiting for BAs
// are deliberately ignored.

const PMAP = {
  'WAVY': 'Wavy', 'CURLY': 'Curly', 'WURLY': 'Wurly', 'SCALP': 'Scalp',
  'OTF': 'OTF', 'RSD': 'RSD', 'WAX STICK': 'Wax Stick', 'MASK(DDHM)': 'DDHM',
  'HRHM': 'HRHM', 'HA': 'HA', 'DS': 'DS', 'OIL': 'Oil',
};

/* ── tiny in-memory cache ── */
let cache = { at: 0, body: null };

/* ── Notion helpers ── */
async function notion(pathname, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Notion ${res.status} on ${pathname}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function queryAll(dataSourceId) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const j = await notion(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}

/** A database is now a container; list the data sources inside it. */
async function listDataSources(dbId) {
  const db = await notion(`/databases/${dbId}`);
  const sources = db.data_sources || [];
  if (!sources.length) throw new Error(`Database ${dbId} reports no data sources.`);
  return sources; // [{ id, name }]
}

const plain = (arr) => (arr || []).map((t) => t.plain_text).join('').trim();

function titleOf(page) {
  const props = page.properties || {};
  for (const k of Object.keys(props)) {
    if (props[k] && props[k].type === 'title') return plain(props[k].title);
  }
  return '';
}

/**
 * Build { pageId: title } for a relation property.
 * From 2025-09-03 a relation carries data_source_id as well as database_id.
 */
const relCache = new Map();
async function relationMap(schema, propName) {
  const prop = schema.properties && schema.properties[propName];
  if (!prop || prop.type !== 'relation') {
    console.warn(`  ! "${propName}" is missing or not a relation`);
    return {};
  }
  let dsId = prop.relation && prop.relation.data_source_id;
  if (!dsId && prop.relation && prop.relation.database_id) {
    const subs = await listDataSources(prop.relation.database_id);
    dsId = subs[0] && subs[0].id;
  }
  if (!dsId) return {};
  if (relCache.has(dsId)) return relCache.get(dsId);

  const map = {};
  for (const p of await queryAll(dsId)) map[p.id] = titleOf(p);
  relCache.set(dsId, map);
  return map;
}

function readSelect(p) {
  if (!p) return '';
  if (p.type === 'select') return p.select ? p.select.name : '';
  if (p.type === 'status') return p.status ? p.status.name : '';
  if (p.type === 'multi_select') return (p.multi_select[0] || {}).name || '';
  if (p.type === 'rich_text') return plain(p.rich_text);
  return '';
}
const readDate = (p) =>
  p && p.type === 'date' && p.date ? p.date.start || null : null;
const readRelation = (p, map) =>
  p && p.type === 'relation' && p.relation.length
    ? map[p.relation[0].id] || ''
    : '';

/* ── main fetch + transform ── */
async function loadAds() {
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is not set');
  if (!process.env.NOTION_DB_ID) throw new Error('NOTION_DB_ID is not set');
  relCache.clear();

  // Either target one data source directly, or every source in the database.
  let sources;
  if (process.env.NOTION_DATA_SOURCE_ID) {
    sources = [{ id: process.env.NOTION_DATA_SOURCE_ID, name: 'pinned' }];
  } else {
    sources = await listDataSources(process.env.NOTION_DB_ID);
    console.log(`  data sources: ${sources.map((s) => `${s.name} (${s.id})`).join(', ')}`);
  }

  const ads = [];
  const seen = new Set();
  const diag = {
    sources: sources.map((s) => ({ id: s.id, name: s.name })),
    properties: {},
    totalPages: 0,
    dropped: { status: 0, portfolio: 0, closeBy: 0, format: 0, duplicate: 0 },
    seenStatuses: {},
    seenFormats: {},
    seenPortfolios: {},
    samples: [],
  };

  for (const src of sources) {
    const schema = await notion(`/data_sources/${src.id}`);
    diag.properties[src.name] = Object.entries(schema.properties || {})
      .map(([k, v]) => `${k} (${v.type})`).sort();
    const [portfolioMap, messagingMap] = await Promise.all([
      relationMap(schema, 'Portfolios'),
      relationMap(schema, 'Messaging Funnels'),
    ]);

    const pages = await queryAll(src.id);
    diag.totalPages += pages.length;

    for (const page of pages) {
      if (seen.has(page.id)) { diag.dropped.duplicate++; continue; }
      seen.add(page.id);
      const pr = page.properties || {};

      const status = readSelect(pr['Status']);
      const rawPortfolio = readRelation(pr['Portfolios'], portfolioMap);
      const format = readSelect(pr['Format']);
      const closeByRaw = readDate(pr['Close by']);

      const tally = (o, v) => { const k = v || '(blank)'; o[k] = (o[k] || 0) + 1; };
      tally(diag.seenStatuses, status);
      tally(diag.seenFormats, format);
      tally(diag.seenPortfolios, rawPortfolio);
      if (diag.samples.length < 3) {
        diag.samples.push({
          title: titleOf(page), status, portfolio: rawPortfolio, format,
          closeBy: closeByRaw, funnel: readSelect(pr['Funnel']),
          messaging: readRelation(pr['Messaging Funnels'], messagingMap),
        });
      }

      const key = status.trim().toLowerCase();
      let shipped;
      if (LIVE.has(key)) shipped = true;
      else if (PIPE.has(key)) shipped = false;
      else { diag.dropped.status++; continue; }

      const portfolio = PMAP[rawPortfolio.trim().toUpperCase()];
      if (!portfolio) { diag.dropped.portfolio++; continue; }

      const closeBy = closeByRaw;
      if (!closeBy) { diag.dropped.closeBy++; continue; }

      if (!['Video', 'Static', 'GIF'].includes(format)) { diag.dropped.format++; continue; }

      let funnel = readSelect(pr['Funnel']);
      if (!['ToFu', 'MoFu', 'BoFu'].includes(funnel)) funnel = 'Unspecified';

      ads.push({
        portfolio,
        closeBy: closeBy.slice(0, 10),
        month: closeBy.slice(0, 7),
        format,
        funnel,
        messaging: readRelation(pr['Messaging Funnels'], messagingMap) || 'Unspecified',
        shipped,
        status,
        name: titleOf(page),
        source: src.name,
      });
    }
  }
  diag.kept = ads.length;
  return { ads, diag };
}

/* ── static files ── */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) {          // path traversal guard
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(buf);
  });
}

/* ── server ── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const { pathname } = u;

  const code = u.searchParams.get('code');
  if (code) { await handleOAuth(code, res); return; }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  if (pathname === '/api/sources') {
    try {
      const sources = await listDataSources(process.env.NOTION_DB_ID);
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ database: process.env.NOTION_DB_ID, sources }, null, 2));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/debug') {
    try {
      const { diag } = await loadAds();
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(diag, null, 2));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: err.message }, null, 2));
    }
    return;
  }

  if (pathname === '/api/data') {
    const fresh = Date.now() - cache.at < CACHE_SECONDS * 1000;
    if (fresh && cache.body) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-cache': 'hit',
      }).end(cache.body);
      return;
    }
    try {
      const { ads } = await loadAds();
      const body = JSON.stringify({
        ads,
        fetchedAt: new Date().toISOString(),
        counts: {
          total: ads.length,
          live: ads.filter((a) => a.shipped).length,
          pipeline: ads.filter((a) => !a.shipped).length,
        },
      });
      cache = { at: Date.now(), body };
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-cache': 'miss',
      }).end(body);
    } catch (err) {
      console.error('[api/data]', err.message);
      res.writeHead(502, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => console.log(`ad-tracker listening on ${PORT}`));
