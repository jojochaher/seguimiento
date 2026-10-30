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
            set: async (data) => { await tx('docs', 'readwrite', s => s.put({ key: col + '/' + id, col, id, data: JSON.parse(JSON.stringify(data)) })); emit(col); },
            delete: async () => { await tx('docs', 'readwrite', s => s.delete(col + '/' + id)); emit(col); }
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

  const ready = (async () => { await seedIfEmpty(); await loadAssets(); })();
  window.claude = { use: async (name) => { await ready; return name === 'db' ? db : name === 'assets' ? assets : null; }, local: true, exportAll, importAll };
})();
