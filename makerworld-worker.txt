const ALLOWED_ORIGINS = new Set([
  'https://douglasscaramelli-spec.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
]);
const MAKERWORLD_BASE = 'https://makerworld.com';
const BAMBU_API = 'https://api.bambulab.com/v1';
const COMMUNITY_INDEX = 'https://api.tryar.in';
const UA = 'Genesis3D/1.0 (+https://douglasscaramelli-spec.github.io/Corrigido/)';

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://douglasscaramelli-spec.github.io';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) }
  });
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function cleanText(v, max = 120) { return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function parseModelId(v) {
  const s = String(v || '');
  const m = s.match(/\/models\/(\d+)/i);
  if (m) return m[1];
  return /^\d{1,12}$/.test(s) ? s : '';
}
async function fetchTimeout(url, options = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}
const commonHeaders = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': UA,
  'Referer': 'https://makerworld.com/'
};
function first(...vals) { return vals.find(v => v !== undefined && v !== null && v !== ''); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function parseTimeMinutes(obj = {}) {
  const directMin = n(first(obj.timeMinutes, obj.printTimeMinutes, obj.estimatedMinutes));
  if (directMin && directMin > 0) return directMin;
  const hours = n(first(obj.printTimeHours, obj.timeHours));
  if (hours && hours > 0) return Math.round(hours * 60 * 10) / 10;
  const sec = n(first(obj.printTimeSeconds, obj.printingTimeSeconds, obj.estimatedTimeSeconds, obj.prediction));
  if (sec && sec > 0) return Math.round(sec / 6) / 10;
  const raw = first(obj.printTime, obj.printingTime, obj.estimatedTime, obj.time);
  if (typeof raw === 'number' && raw > 0) return raw > 600 ? Math.round(raw / 6) / 10 : raw;
  if (typeof raw === 'string') {
    const h = raw.match(/(\d+(?:[.,]\d+)?)\s*h/i); const m = raw.match(/(\d+)\s*m/i);
    if (h || m) return (h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
    if (/^\d+(?:\.\d+)?$/.test(raw)) { const x = Number(raw); return x > 600 ? x / 60 : x; }
  }
  return null;
}
function parseWeight(obj = {}) {
  const g = n(first(obj.weightGrams, obj.filamentWeight, obj.totalFilamentWeight, obj.weight, obj.filament_used_g, obj.filamentUsed));
  return g && g > 0 ? Math.round(g * 10) / 10 : null;
}
function normalizePrinter(v) {
  if (!v) return '';
  if (typeof v === 'string') return cleanText(v, 60);
  return cleanText(first(v.name, v.model, v.modelName, v.displayName), 60);
}
function normalizeProfile(p = {}, idx = 0) {
  const meta = p.metadata || p.meta || p.sliceInfo || p.printInfo || {};
  const printer = normalizePrinter(first(p.printer, p.printerName, p.printerModel, p.machine, meta.printer, meta.printerName, meta.machine));
  const layer = first(p.layerHeight, p.layer_height, meta.layerHeight, meta.layer_height);
  const filaments = Array.isArray(p.filaments) ? p.filaments : (Array.isArray(meta.filaments) ? meta.filaments : []);
  const material = cleanText(first(p.material, p.filamentType, meta.material, filaments[0]?.type, filaments[0]?.material), 40);
  const plateCount = n(first(p.plateCount, p.plate_count, p.plates?.length, meta.plateCount));
  return {
    id: String(first(p.id, p.instanceId, p.profileId, p.pid, idx)),
    name: cleanText(first(p.name, p.title, p.profileName, p.instanceName, `Perfil ${idx + 1}`), 100),
    printer,
    layerHeight: layer === undefined || layer === null || layer === '' ? '' : String(layer).replace('mm', '').trim(),
    timeMinutes: parseTimeMinutes({ ...meta, ...p }),
    weightGrams: parseWeight({ ...meta, ...p }),
    material,
    plateCount: plateCount && plateCount > 0 ? plateCount : null
  };
}
function normalizeDesign(raw = {}, fallbackUrl = '') {
  const id = String(first(raw.id, raw.designId, raw.design_id, raw.modelIdNumeric, parseModelId(fallbackUrl), ''));
  const instances = first(raw.instances, raw.printProfiles, raw.profiles, raw.designInstances, raw.plates, []);
  const profiles = Array.isArray(instances) ? instances.map(normalizeProfile) : [];
  const creatorObj = first(raw.creator, raw.user, raw.author, raw.designUser, {});
  const creator = typeof creatorObj === 'string' ? creatorObj : cleanText(first(creatorObj.name, creatorObj.handle, creatorObj.nickname, raw.creatorName, raw.authorName), 80);
  const image = cleanText(first(raw.coverUrl, raw.cover, raw.image, raw.modelImage, raw.thumbnail, raw.thumbnailUrl, raw.images?.[0]?.url, raw.pictures?.[0]), 1000);
  const license = cleanText(first(raw.license, raw.licenseName, raw.licenseType, raw.license?.name, raw.licenseInfo?.name), 120);
  const url = cleanText(first(raw.cleanUrl, raw.url, fallbackUrl, id ? `https://makerworld.com/en/models/${id}` : ''), 1000);
  const printers = [...new Set(profiles.map(p => p.printer).filter(Boolean))];
  return {
    modelId: id,
    title: cleanText(first(raw.title, raw.name, raw.modelName, raw.titleTranslated, 'Modelo MakerWorld'), 180),
    creator,
    image,
    makerWorldUrl: url,
    license,
    commercialUse: cleanText(first(raw.commercialUse, raw.commercial_use), 40) || 'unknown',
    profiles,
    printers,
    material: cleanText(first(raw.material, profiles.find(p => p.material)?.material), 40),
    source: cleanText(first(raw.source, 'makerworld'), 40)
  };
}
async function officialSuggest(query) {
  const url = `${MAKERWORLD_BASE}/api/v1/search-service/suggest2?keyword=${encodeURIComponent(query)}&include=design`;
  const res = await fetchTimeout(url, { headers: commonHeaders }, 9000);
  if (!res.ok) throw new Error(`MakerWorld search ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.design) ? data.design : (Array.isArray(data.designs) ? data.designs : []);
  return list.map(x => normalizeDesign({ ...x, source: 'makerworld' }));
}
async function communitySearch(query, sort) {
  const mappedSort = sort === 'recent' ? 'recent' : 'popular';
  const url = `${COMMUNITY_INDEX}/api/models?q=${encodeURIComponent(query)}&sort=${mappedSort}`;
  const res = await fetchTimeout(url, { headers: { 'Accept': 'application/json', 'User-Agent': UA } }, 9000);
  if (!res.ok) return [];
  const data = await res.json();
  const rows = Array.isArray(data.models) ? data.models : [];
  return rows.map(r => {
    const p = normalizeProfile({
      id: r.profileId, name: r.profileName, printTimeHours: r.printTimeHours,
      weightGrams: r.weightGrams, plateCount: r.plateCount, printer: r.printerName || r.printer
    }, 0);
    return normalizeDesign({
      id: r.modelId, title: r.modelName, modelImage: r.modelImage, creatorName: r.creatorName,
      cleanUrl: r.cleanUrl, license: r.license, profiles: [p], source: 'community-index'
    }, r.cleanUrl);
  });
}
function dedupe(list) {
  const map = new Map();
  for (const x of list) {
    const key = x.modelId || x.makerWorldUrl;
    if (!key) continue;
    if (!map.has(key)) map.set(key, x);
    else {
      const prev = map.get(key);
      if ((!prev.profiles?.length && x.profiles?.length) || (!prev.image && x.image)) map.set(key, { ...prev, ...x, profiles: x.profiles?.length ? x.profiles : prev.profiles });
    }
  }
  return [...map.values()];
}
async function searchModels(query, page, limit, sort) {
  let official = [], community = [];
  const settled = await Promise.allSettled([officialSuggest(query), communitySearch(query, sort)]);
  if (settled[0].status === 'fulfilled') official = settled[0].value;
  if (settled[1].status === 'fulfilled') community = settled[1].value;
  const all = dedupe([...official, ...community]);
  const start = (page - 1) * limit;
  return { models: all.slice(start, start + limit), totalKnown: all.length, hasMore: start + limit < all.length, sources: { makerworld: official.length, communityIndex: community.length } };
}
async function fetchDesign(id) {
  const primaryUrl = `${BAMBU_API}/design-service/design/${id}`;
  try {
    const res = await fetchTimeout(primaryUrl, { headers: commonHeaders }, 10000);
    if (res.ok) {
      const data = await res.json();
      const raw = data.design || data.data || data;
      const model = normalizeDesign(raw, `https://makerworld.com/en/models/${id}`);
      if (model.title && model.title !== 'Modelo MakerWorld') return model;
    }
  } catch (_) {}
  // Fallback gratuito e sem autenticação: índice comunitário que faz scrape de metadados públicos.
  const fallbackUrl = `${COMMUNITY_INDEX}/api/scrape?url=${encodeURIComponent(`https://makerworld.com/en/models/${id}`)}`;
  const res2 = await fetchTimeout(fallbackUrl, { headers: { 'Accept': 'application/json', 'User-Agent': UA } }, 12000);
  if (!res2.ok) throw new Error(`Não foi possível consultar o modelo (${res2.status})`);
  const data2 = await res2.json();
  const raw2 = data2.model || data2.data || data2;
  return normalizeDesign(raw2, `https://makerworld.com/en/models/${id}`);
}
function allowedImageHost(host) {
  const h = host.toLowerCase();
  return h === 'makerworld.com' || h.endsWith('.makerworld.com') || h.endsWith('.bambulab.com') || h.endsWith('.bblmw.com') || h.endsWith('.amazonaws.com');
}
async function proxyImage(rawUrl, origin) {
  let u;
  try { u = new URL(rawUrl); } catch { return json({ ok: false, error: 'URL de imagem inválida' }, 400, origin); }
  if (u.protocol !== 'https:' || !allowedImageHost(u.hostname)) return json({ ok: false, error: 'Host de imagem não permitido' }, 403, origin);
  const res = await fetchTimeout(u.toString(), { headers: { 'User-Agent': UA, 'Accept': 'image/*' }, redirect: 'follow' }, 10000);
  if (!res.ok) return json({ ok: false, error: 'Imagem indisponível' }, 502, origin);
  const ct = res.headers.get('content-type') || 'image/jpeg';
  if (!ct.startsWith('image/')) return json({ ok: false, error: 'Conteúdo não é imagem' }, 415, origin);
  return new Response(res.body, { status: 200, headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400', ...cors(origin) } });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return json({ ok: false, error: 'Método não permitido' }, 405, origin);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'Origem não permitida' }, 403, origin);

    const url = new URL(request.url);
    try {
      if (url.pathname === '/health' || url.pathname === '/') {
        return json({ ok: true, service: 'Genesis 3D MakerWorld Bridge', version: 1, time: new Date().toISOString() }, 200, origin);
      }
      if (url.pathname === '/search') {
        const q = cleanText(url.searchParams.get('q'), 80);
        if (q.length < 2) return json({ ok: false, error: 'Busca muito curta' }, 400, origin);
        const page = clamp(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1, 20);
        const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1, 20);
        const sort = ['relevance', 'popular', 'recent'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'relevance';
        const data = await searchModels(q, page, limit, sort);
        return new Response(JSON.stringify({ ok: true, ...data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', ...cors(origin) } });
      }
      if (url.pathname === '/model') {
        const id = parseModelId(url.searchParams.get('id') || url.searchParams.get('url'));
        if (!id) return json({ ok: false, error: 'ID MakerWorld inválido' }, 400, origin);
        const model = await fetchDesign(id);
        return new Response(JSON.stringify({ ok: true, model }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=14400', ...cors(origin) } });
      }
      if (url.pathname === '/image') return proxyImage(url.searchParams.get('url') || '', origin);
      return json({ ok: false, error: 'Endpoint inexistente' }, 404, origin);
    } catch (err) {
      console.error('[Genesis3D Worker]', err);
      const msg = err?.name === 'AbortError' ? 'Tempo limite excedido' : cleanText(err?.message || 'Falha temporária', 180);
      return json({ ok: false, error: msg }, 502, origin);
    }
  }
};
