/* Almacenamiento local (IndexedDB) con la misma interfaz que usaba la página en Claude:
   db.collection(c).doc(id).set(obj) / .delete(), db.collection(c).onSnapshot(cb),
   assets.upload(blob) / assets.delete(id), blobUrl(id).
   Si la página corre dentro de Claude (window.claude existe) no hace nada. */
(() => {
  if (window.claude && window.claude.use) { window.blobUrl = id => '/_blob/' + id; return; }

  const DB_NAME = 'seguimiento', DB_VER = 1;
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        const docs = d.createObjectStore('docs', { keyPath: 'key' });
        docs.createIndex('col', 'col');
        d.createObjectStore('assets', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
  const getAll = (col) => open().then(d => new Promise((res, rej) => {
    const r = d.transaction('docs').objectStore('docs').index('col').getAll(col);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));

  const listeners = {};
  async function emit(col) {
    const rows = await getAll(col);
    const qs = { docs: rows.map(r => ({ id: r.id, data: () => r.data })) };
    (listeners[col] || []).forEach(cb => { try { cb(qs); } catch (e) { console.warn(e); } });
  }

  const db = {
    collection(col) {
      return {
        doc(id) {
          return {
            set: async (data) => { await tx('docs', 'readwrite', s => s.put({ key: col + '/' + id, col, id, data: JSON.parse(JSON.stringify(data)) })); emit(col); markDirty(); },
            delete: async () => { await tx('docs', 'readwrite', s => s.delete(col + '/' + id)); emit(col); markDirty(); }
          };
        },
        onSnapshot(cb) { (listeners[col] = listeners[col] || []).push(cb); emit(col); return () => { listeners[col] = listeners[col].filter(f => f !== cb); }; }
      };
    }
  };

  const urls = new Map();
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const assets = {
    async upload(blob) { const id = rid(); await tx('assets', 'readwrite', s => s.put({ id, blob })); urls.set(id, URL.createObjectURL(blob)); return { id }; },
    async delete(id) { await tx('assets', 'readwrite', s => s.delete(id)); const u = urls.get(id); if (u) URL.revokeObjectURL(u); urls.delete(id); }
  };
  window.blobUrl = id => urls.get(id) || '';

  async function loadAssets() {
    const d = await open();
    await new Promise((res) => { const r = d.transaction('assets').objectStore('assets').getAll(); r.onsuccess = () => { r.result.forEach(a => urls.set(a.id, URL.createObjectURL(a.blob))); res(); }; r.onerror = res; });
  }
  async function seedIfEmpty() {
    const any = await open().then(d => new Promise(res => { const r = d.transaction('docs').objectStore('docs').count(); r.onsuccess = () => res(r.result > 0); r.onerror = () => res(true); }));
    if (any) return;
    try {
      const seed = await fetch('seed.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
      if (!seed) return;
      await tx('docs', 'readwrite', s => { for (const col of Object.keys(seed)) for (const id of Object.keys(seed[col])) s.put({ key: col + '/' + id, col, id, data: seed[col][id] }); });
    } catch (e) { console.warn('seed', e); }
  }

  /* respaldo: exportar / importar todo (docs + fotos en base64) */
  const b64 = blob => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  async function exportAll() {
    const d = await open();
    const docs = await new Promise(res => { const r = d.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => res(r.result); });
    const as = await new Promise(res => { const r = d.transaction('assets').objectStore('assets').getAll(); r.onsuccess = () => res(r.result); });
    const assetsOut = {};
    for (const a of as) assetsOut[a.id] = await b64(a.blob);
    return { v: 1, exportado: new Date().toISOString(), docs: docs.map(r => ({ col: r.col, id: r.id, data: r.data })), assets: assetsOut };
  }
  async function importAll(obj) {
    if (!obj || !Array.isArray(obj.docs)) throw new Error('Archivo inválido');
    await tx('docs', 'readwrite', s => { for (const r of obj.docs) s.put({ key: r.col + '/' + r.id, col: r.col, id: r.id, data: r.data }); });
    const ids = Object.keys(obj.assets || {});
    for (const id of ids) { const blob = await fetch(obj.assets[id]).then(r => r.blob()); await tx('assets', 'readwrite', s => s.put({ id, blob })); urls.set(id, URL.createObjectURL(blob)); }
    for (const col of new Set(obj.docs.map(r => r.col))) emit(col);
  }

  /* sync: copia de los datos (sin fotos) a un repo privado de GitHub, para que Claude pueda leerla */
  const SK = 'seg-sync';
  const syncCfg = () => { try { return JSON.parse(localStorage.getItem(SK) || 'null'); } catch (e) { return null; } };
  const syncSave = c => { try { localStorage.setItem(SK, JSON.stringify(c)); } catch (e) {} };
  function markDirty() { const c = syncCfg(); if (c && c.token) { c.dirty = true; syncSave(c); } }
  const b64utf8 = str => { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
  let pushing = null;
  async function syncPush(force) {
    const c = syncCfg(); if (!c || !c.token || !c.repo) return { ok: false, msg: 'Sin configurar' };
    if (!force && !c.dirty) return { ok: true, msg: 'Sin cambios' };
    if (pushing) return pushing;
    pushing = (async () => {
      try {
        const d = await open();
        const docs = await new Promise(res => { const r = d.transaction('docs').objectStore('docs').getAll(); r.onsuccess = () => res(r.result); });
        const out = { v: 1, exportado: new Date().toISOString(), datos: {} };
        for (const r of docs) { (out.datos[r.col] = out.datos[r.col] || {})[r.id] = r.data; }
        const url = `https://api.github.com/repos/${c.repo}/contents/datos.json`;
        const H = { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json' };
        let sha;
        const g = await fetch(url + '?ref=main', { headers: H, cache: 'no-store' });
        if (g.ok) sha = (await g.json()).sha; else if (g.status !== 404) throw new Error('GitHub ' + g.status);
        const p = await fetch(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ message: 'datos ' + out.exportado.slice(0, 16), content: b64utf8(JSON.stringify(out, null, 1)), sha, branch: 'main' }) });
        if (!p.ok) throw new Error('GitHub ' + p.status);
        const n = syncCfg() || c; n.dirty = false; n.last = Date.now(); n.err = ''; syncSave(n);
        return { ok: true, msg: 'Sincronizado' };
      } catch (e) { const n = syncCfg() || c; n.err = String(e.message || e); syncSave(n); return { ok: false, msg: n.err }; }
      finally { pushing = null; }
    })();
    return pushing;
  }
  /* leer un archivo del repo de datos (p. ej. respuestas.json que escribe Claude) */
  async function syncFetch(name) {
    const c = syncCfg(); if (!c || !c.token || !c.repo) return null;
    const r = await fetch(`https://api.github.com/repos/${c.repo}/contents/${name}?ref=main`, { headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
    if (r.status === 404) return null; if (!r.ok) throw new Error('GitHub ' + r.status);
    return r.json();
  }
  async function syncWrite(name, obj, msg) {
    const c = syncCfg(); if (!c || !c.token || !c.repo) return { ok: false, msg: 'Sin configurar' };
    try {
      const url = `https://api.github.com/repos/${c.repo}/contents/${name}`, H = { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json' };
      let sha; const g = await fetch(url + '?ref=main', { headers: H, cache: 'no-store' }); if (g.ok) sha = (await g.json()).sha; else if (g.status !== 404) throw new Error('GitHub ' + g.status);
      const p = await fetch(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ message: msg || name, content: b64utf8(JSON.stringify(obj, null, 1)), sha, branch: 'main' }) });
      if (!p.ok) throw new Error('GitHub ' + p.status);
      return { ok: true };
    } catch (e) { return { ok: false, msg: String(e.message || e) }; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') setTimeout(() => syncPush(), 1500); });
  setInterval(() => syncPush(), 5 * 60000);

  const ready = (async () => { await seedIfEmpty(); await loadAssets(); })();
  window.claude = { use: async (name) => { await ready; return name === 'db' ? db : name === 'assets' ? assets : null; }, local: true, exportAll, importAll, syncCfg, syncSave, syncPush, syncFetch, syncWrite };
})();
