/**
 * Genesis 3D — MakerWorld bridge (Cloudflare Worker, Free Tier compatible)
 * Public-data bridge only. No login, cookies, API keys or personal data.
 *
 * Optional environment variable:
 *   GENESIS_ORIGIN = https://douglasscaramelli-spec.github.io
 *
 * Routes:
 *   GET /health
 *   GET /search?q=...&page=1&limit=20&sort=relevance
 *   GET /model?url=https://makerworld.com/.../models/123...
 *   GET /image?url=https://...bblmw.com/...jpg
 */

const DEFAULT_GENESIS_ORIGIN = 'https://douglasscaramelli-spec.github.io';
const MW_ORIGIN = 'https://makerworld.com';
const BAMBU_API = 'https://api.bambulab.com/v1';
const SEARCH_TTL = 20 * 60;
const MODEL_TTL = 6 * 60 * 60;
const IMAGE_TTL = 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 9000;

function allowedOrigin(request, env) {
  const configured = String(env.GENESIS_ORIGIN || DEFAULT_GENESIS_ORIGIN).replace(/\/$/, '');
  const origin = request.headers.get('Origin');
  if (!origin) return configured; // direct browser/open test
  return origin === configured ? origin : null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

function json(data, status, origin, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function cleanQuery(value) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 120);
}

function extractModelId(value) {
  const text = String(value || '');
  const match = text.match(/\/models\/(\d+)/i) || text.match(/^\d+$/);
  return match ? (match[1] || match[0]) : '';
}

function safeMakerWorldUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const host = u.hostname.toLowerCase();
    if (!(host === 'makerworld.com' || host.endsWith('.makerworld.com'))) return null;
    if (!/^\/[^?#]*models\/\d+/i.test(u.pathname) && !/^\/(?:en|pt|pt-br|es|de|fr)\/models\/\d+/i.test(u.pathname)) return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

function safeImageUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    const allowed = h === 'makerworld.com' || h.endsWith('.makerworld.com') || h === 'bblmw.com' || h.endsWith('.bblmw.com');
    return allowed ? u : null;
  } catch {
    return null;
  }
}

async function fetchTimeout(url, init = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

const MW_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; Genesis3D/1.0; +https://douglasscaramelli-spec.github.io/Corrigido/)',
  'Referer': 'https://makerworld.com/',
  'x-bbl-app-source': 'makerworld',
  'x-bbl-client-name': 'MakerWorld',
  'x-bbl-client-type': 'web',
  'x-bbl-client-version': '00.00.00.01',
};

function walkObjects(root, maxDepth = 8) {
  const out = [];
  const seen = new WeakSet();
  function walk(value, depth) {
    if (!value || typeof value !== 'object' || depth > maxDepth) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
    if (Array.isArray(value)) {
      for (const x of value) walk(x, depth + 1);
    } else {
      for (const x of Object.values(value)) walk(x, depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

function firstText(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function creatorName(o) {
  return firstText(
    o?.designCreator?.name, o?.creator?.name, o?.designer?.name, o?.user?.name, o?.owner?.name,
    o?.creator_name, o?.user_name, o?.author?.name, o?.designer_name
  );
}

function imageUrl(o) {
  return firstText(o?.cover, o?.cover_url, o?.coverUrl, o?.image, o?.image_url, o?.imageUrl, o?.thumbnail, o?.thumbnail_url, o?.thumbnailUrl);
}

function modelUrl(id, title, raw) {
  if (raw) {
    try {
      const u = new URL(raw, MW_ORIGIN);
      if (u.hostname === 'makerworld.com' || u.hostname.endsWith('.makerworld.com')) return u.href;
    } catch {}
  }
  if (!id) return '';
  const slug = String(title || 'model').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${MW_ORIGIN}/en/models/${encodeURIComponent(id)}${slug ? '-' + slug : ''}`;
}

function normalizeSearchPayload(payload) {
  const map = new Map();
  const probableLists = [
    payload?.design, payload?.designs, payload?.items, payload?.hits, payload?.results,
    payload?.data?.design, payload?.data?.designs, payload?.data?.items, payload?.data?.hits, payload?.data?.results,
  ].filter(Array.isArray);
  const preferred = new Set(probableLists.flat().filter(x => x && typeof x === 'object'));

  for (const o of walkObjects(payload, 7)) {
    if (Array.isArray(o)) continue;
    const title = firstText(o.title, o.design_title, o.designTitle, o.model_title, o.modelTitle, o.name);
    let id = firstText(o.design_id, o.designId, o.design?.id);
    const url = firstText(o.url, o.link, o.design_url, o.designUrl, o.jump_url, o.jumpUrl);
    if (!id && url) id = extractModelId(url);
    if (!id && preferred.has(o)) id = firstText(o.id);

    // Prefer known result arrays. Outside them, require explicit design hints or a /models/ URL
    // so print-profile objects do not become duplicate model cards.
    const likelyDesign = Boolean(o.design_id || o.designId || o.design || /\/models\/\d+/i.test(url) || preferred.has(o));
    if (!title || (!id && !url) || !likelyDesign) continue;
    const key = String(id || url).toLowerCase();
    if (map.has(key)) continue;

    map.set(key, {
      modelId: id,
      title,
      creator: creatorName(o),
      imageUrl: imageUrl(o),
      makerWorldUrl: modelUrl(id, title, url),
      profiles: [],
      license: '',
      commercialUse: 'unknown',
      popularity: Number(o.like_count || o.download_count || o.collect_count || o.favorite_count || o.favoriteCount || 0) || 0,
      createdAt: o.created_at || o.create_time || o.createdAt || null,
    });
  }
  return [...map.values()];
}
function normalizePrinters(value) {
  const out = [];
  const add = v => {
    const s = firstText(v);
    if (s && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') add(v);
      else add(v?.dev_product_name || v?.name || v?.printer || v?.product_name);
    }
  } else if (value && typeof value === 'object') {
    add(value.dev_product_name || value.name || value.printer || value.product_name);
  } else add(value);
  return out;
}

function profileMinutes(o) {
  const direct = Number(o.timeMinutes ?? o.minutes ?? o.predictionMinutes);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const seconds = Number(o.prediction);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null;
}

function profileWeight(o) {
  let n = Number(o.weightGrams ?? o.weight ?? o.used_g);
  if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  const fils = Array.isArray(o.instance_filaments) ? o.instance_filaments : (Array.isArray(o.filaments) ? o.filaments : []);
  n = fils.reduce((sum, f) => sum + (Number.parseFloat(f?.used_g) || 0), 0);
  return n > 0 ? Math.round(n * 100) / 100 : null;
}

function normalizeProfile(o, index) {
  const printers = normalizePrinters(o.compatibility || o.compatibilities || o.printers || o.printer || o.compatible_printers || o.dev_product_name);
  const fils = Array.isArray(o.instance_filaments) ? o.instance_filaments : (Array.isArray(o.filaments) ? o.filaments : []);
  const materials = [...new Set(fils.map(f => firstText(f?.type, f?.material)).filter(Boolean))];
  const name = firstText(o.title, o.name, o.profile_name, o.profileName) || `Perfil ${index + 1}`;
  const layerMatch = firstText(o.layerHeight, o.layer_height, name).match(/(\d+(?:[.,]\d+)?)\s*mm/i);
  return {
    id: firstText(o.id, o.instance_id, o.instanceId, o.profile_id, o.profileId) || `profile-${index}`,
    name,
    printers,
    printer: printers[0] || '',
    layerHeight: layerMatch ? `${layerMatch[1].replace(',', '.')} mm` : firstText(o.layerHeight, o.layer_height),
    timeMinutes: profileMinutes(o),
    weightGrams: profileWeight(o),
    material: materials.join(', ') || firstText(o.material),
    plates: Number(o.plate_count || o.plateCount || (Array.isArray(o.plates) ? o.plates.length : 0)) || null,
  };
}

function commercialUseFrom(root, licenseText) {
  const objs = walkObjects(root, 5);
  for (const o of objs) {
    for (const key of ['commercial_use_allowed', 'commercialUseAllowed', 'allow_commercial_use', 'allowCommercialUse']) {
      if (o[key] === true || o[key] === 1) return 'allowed';
      if (o[key] === false || o[key] === 0) return 'not-allowed';
    }
  }
  const s = String(licenseText || '').toLowerCase();
  if (/non[- ]?commercial|não comercial|no commercial use|commercial use prohibited/.test(s)) return 'not-allowed';
  if (/commercial use allowed|commercial use permitted|uso comercial permitido/.test(s)) return 'allowed';
  return 'unknown';
}

function normalizeModelPayload(payload, id, urlHint) {
  const objects = walkObjects(payload, 8);
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const design = objects.find(o => !Array.isArray(o) && (String(o.id || '') === String(id) || String(o.design_id || o.designId || '') === String(id)) && (o.title || o.name)) || root || {};
  const title = firstText(design.title, design.name) || 'Modelo MakerWorld';
  const modelId = firstText(design.id, design.design_id, design.designId, id);
  const profiles = [];
  const seen = new Set();
  for (const o of objects) {
    if (Array.isArray(o)) continue;
    const looksProfile = Number(o.prediction) > 0 || Number(o.weight) > 0 || o.instance_id || o.instanceId || o.profile_id || o.profileId || (o.compatibility && (o.title || o.name));
    if (!looksProfile) continue;
    const p = normalizeProfile(o, profiles.length);
    const key = `${p.id}|${p.name}|${p.printer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push(p);
    if (profiles.length >= 60) break;
  }
  const license = firstText(design?.license?.name, design?.license_name, design?.licenseName, typeof design?.license === 'string' ? design.license : '', payload?.license?.name, typeof payload?.license === 'string' ? payload.license : '');
  return {
    __normalizedModel: true,
    modelId,
    title,
    creator: creatorName(design),
    imageUrl: imageUrl(design),
    makerWorldUrl: modelUrl(modelId, title, urlHint),
    profiles,
    license,
    commercialUse: commercialUseFrom(payload, license),
  };
}

async function cachedJson(request, ttlSeconds, producer) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await producer();
  if (response.ok) {
    const cacheable = new Response(response.body, response);
    cacheable.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    await cache.put(request, cacheable.clone());
    return cacheable;
  }
  return response;
}

async function handleSearch(request, url, origin) {
  const q = cleanQuery(url.searchParams.get('q'));
  if (!q) return json({ ok: false, error: 'Informe uma busca.' }, 400, origin);
  const page = clampInt(url.searchParams.get('page'), 1, 20, 1);
  const limit = clampInt(url.searchParams.get('limit'), 1, 20, 20);
  const sort = ['relevance', 'popular', 'recent'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'relevance';

  const cacheKey = new Request(`${url.origin}/search?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}&sort=${sort}`, { headers: { Origin: origin } });
  return cachedJson(cacheKey, SEARCH_TTL, async () => {
    try {
      const endpoint = new URL(`${MW_ORIGIN}/api/v1/search-service/suggest2`);
      endpoint.searchParams.set('keyword', q);
      endpoint.searchParams.set('include', 'design');
      endpoint.searchParams.set('page', String(page));
      endpoint.searchParams.set('pageSize', String(limit));
      endpoint.searchParams.set('limit', String(limit));
      endpoint.searchParams.set('offset', String((page - 1) * limit));
      const upstream = await fetchTimeout(endpoint.href, { headers: MW_HEADERS });
      if (!upstream.ok) throw new Error(`MakerWorld search HTTP ${upstream.status}`);
      const payload = await upstream.json();
      let items = normalizeSearchPayload(payload);
      if (sort === 'popular' && items.some(x => x.popularity)) items.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      if (sort === 'recent' && items.some(x => x.createdAt)) items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      items = items.slice(0, limit);
      return json({ ok: true, __normalized: true, items, hasMore: items.length >= Math.min(limit, 10), page }, 200, origin);
    } catch (error) {
      console.error('MakerWorld /search:', error);
      return json({ ok: false, error: 'MakerWorld indisponível no momento.' }, 502, origin);
    }
  });
}

async function handleModel(request, url, origin) {
  const raw = cleanQuery(url.searchParams.get('url'));
  const modelUrlValue = safeMakerWorldUrl(raw);
  const id = extractModelId(raw);
  if (!id || (!modelUrlValue && !/^\d+$/.test(raw))) return json({ ok: false, error: 'Link MakerWorld inválido.' }, 400, origin);

  const canonicalUrl = modelUrlValue ? modelUrlValue.href : modelUrl(id, 'model', '');
  const cacheKey = new Request(`${url.origin}/model?id=${encodeURIComponent(id)}`, { headers: { Origin: origin } });
  return cachedJson(cacheKey, MODEL_TTL, async () => {
    try {
      // Public metadata endpoint. No bearer token/cookie is sent.
      const upstream = await fetchTimeout(`${BAMBU_API}/design-service/design/${encodeURIComponent(id)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': MW_HEADERS['User-Agent'] },
      });
      if (!upstream.ok) throw new Error(`Bambu public metadata HTTP ${upstream.status}`);
      const payload = await upstream.json();
      const model = normalizeModelPayload(payload, id, canonicalUrl);
      return json({ ok: true, ...model }, 200, origin);
    } catch (error) {
      console.error('MakerWorld /model:', error);
      return json({ ok: false, error: 'Não foi possível carregar os detalhes públicos do modelo.' }, 502, origin);
    }
  });
}

async function handleImage(request, url, origin) {
  const target = safeImageUrl(url.searchParams.get('url'));
  if (!target) return json({ ok: false, error: 'Imagem não permitida.' }, 400, origin);
  const cacheKey = new Request(`${url.origin}/image?url=${encodeURIComponent(target.href)}`, { headers: { Origin: origin } });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  try {
    const upstream = await fetchTimeout(target.href, { headers: { 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'User-Agent': MW_HEADERS['User-Agent'], 'Referer': 'https://makerworld.com/' } }, 12000);
    if (!upstream.ok) throw new Error(`Image HTTP ${upstream.status}`);
    const type = upstream.headers.get('Content-Type') || '';
    if (!type.toLowerCase().startsWith('image/')) return json({ ok: false, error: 'Conteúdo não é uma imagem.' }, 415, origin);
    const len = Number(upstream.headers.get('Content-Length') || 0);
    if (len && len > 8 * 1024 * 1024) return json({ ok: false, error: 'Imagem muito grande.' }, 413, origin);
    const response = new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': type,
        'Cache-Control': `public, max-age=${IMAGE_TTL}`,
      },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    console.error('MakerWorld /image:', error);
    return json({ ok: false, error: 'Não foi possível carregar a imagem.' }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (!origin) return new Response('Origin not allowed', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return json({ ok: false, error: 'Método não permitido.' }, 405, origin);

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'genesis-makerworld-bridge', source: 'public-only' }, 200, origin, { 'Cache-Control': 'public, max-age=60' });
    }
    if (url.pathname === '/search') return handleSearch(request, url, origin);
    if (url.pathname === '/model') return handleModel(request, url, origin);
    if (url.pathname === '/image') return handleImage(request, url, origin);
    return json({ ok: false, error: 'Endpoint inexistente.' }, 404, origin);
  },
};
