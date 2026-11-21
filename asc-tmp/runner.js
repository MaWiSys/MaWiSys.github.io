window.ASC = (() => {
  const API = 'https://appstoreconnect.apple.com/iris/v1/';
  const log = [];
  const req = async (method, path, body) => {
    const r = await fetch(path.startsWith('http') ? path : API + path, {
      method, credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const txt = await r.text();
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!r.ok) {
      const msg = j && j.errors ? j.errors.map(e => (e.code || '') + ': ' + (e.detail || e.title)).join(' | ') : txt.slice(0, 200);
      throw new Error(method + ' ' + path.split('?')[0] + ' -> ' + r.status + ' ' + msg);
    }
    return j;
  };
  const step = async (name, fn) => {
    try { const res = await fn(); log.push('OK ' + name + (res ? ' ' + res : '')); }
    catch (e) { log.push('FEHLER ' + name + ': ' + e.message); }
  };
  const SITE = 'https://mawisys.github.io/';

  async function texts(app, M) {
    const vers = await req('GET', `apps/${M.id}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION&include=appStoreVersionLocalizations`);
    const ver = vers.data[0];
    const infos = await req('GET', `apps/${M.id}/appInfos?include=appInfoLocalizations`);
    const info = infos.data.find(i => (i.attributes.state || i.attributes.appStoreState) !== 'READY_FOR_DISTRIBUTION') || infos.data[0];
    const vLocs = Object.fromEntries((vers.included || []).filter(x => x.type === 'appStoreVersionLocalizations').map(x => [x.attributes.locale, x.id]));
    const iLocs = Object.fromEntries((infos.included || []).filter(x => x.type === 'appInfoLocalizations').map(x => [x.attributes.locale, x.id]));
    for (const [loc, t] of Object.entries(M.loc)) {
      const ia = { name: t.name, subtitle: t.subtitle, privacyPolicyUrl: M.privacy };
      await step(`${app} ${loc} Name/Untertitel`, async () => {
        if (iLocs[loc]) await req('PATCH', `appInfoLocalizations/${iLocs[loc]}`, { data: { type: 'appInfoLocalizations', id: iLocs[loc], attributes: ia } });
        else await req('POST', 'appInfoLocalizations', { data: { type: 'appInfoLocalizations', attributes: { locale: loc, ...ia }, relationships: { appInfo: { data: { type: 'appInfos', id: info.id } } } } });
      });
      if (!vLocs[loc]) {
        const fresh = await req('GET', `appStoreVersions/${ver.id}/appStoreVersionLocalizations`);
        fresh.data.forEach(x => vLocs[x.attributes.locale] = x.id);
      }
      const va = { description: t.description, keywords: t.keywords, promotionalText: t.promotionalText, supportUrl: M.supportUrl, marketingUrl: M.marketingUrl };
      await step(`${app} ${loc} Beschreibung`, async () => {
        if (vLocs[loc]) await req('PATCH', `appStoreVersionLocalizations/${vLocs[loc]}`, { data: { type: 'appStoreVersionLocalizations', id: vLocs[loc], attributes: va } });
        else { const r = await req('POST', 'appStoreVersionLocalizations', { data: { type: 'appStoreVersionLocalizations', attributes: { locale: loc, ...va }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: ver.id } } } } }); vLocs[loc] = r.data.id; }
      });
    }
    return { ver, info, vLocs };
  }

  async function settings(app, M, ver, info) {
    await step(`${app} Kategorien`, async () => {
      const [p, s1, s2, sec] = M.cats;
      const rel = { primaryCategory: { data: { type: 'appCategories', id: p } }, primarySubcategoryOne: { data: s1 ? { type: 'appCategories', id: s1 } : null }, primarySubcategoryTwo: { data: s2 ? { type: 'appCategories', id: s2 } : null }, secondaryCategory: { data: sec ? { type: 'appCategories', id: sec } : null } };
      await req('PATCH', `appInfos/${info.id}`, { data: { type: 'appInfos', id: info.id, relationships: rel } });
    });
    await step(`${app} Altersfreigabe`, async () => {
      const d = await req('GET', `appInfos/${info.id}/ageRatingDeclaration`);
      const r = await req('PATCH', `ageRatingDeclarations/${d.data.id}`, { data: { type: 'ageRatingDeclarations', id: d.data.id, attributes: M.age } });
      return '';
    });
    await step(`${app} Copyright`, async () => {
      await req('PATCH', `appStoreVersions/${ver.id}`, { data: { type: 'appStoreVersions', id: ver.id, attributes: { copyright: M.copyright } } });
    });
    await step(`${app} Build zuordnen`, async () => {
      const b = await req('GET', `builds?filter[app]=${M.id}&filter[processingState]=VALID&sort=-uploadedDate&limit=1`);
      if (!b.data.length) throw new Error('kein gültiger Build');
      await req('PATCH', `appStoreVersions/${ver.id}/relationships/build`, { data: { type: 'builds', id: b.data[0].id } });
      return 'Build ' + b.data[0].attributes.version;
    });
    await step(`${app} Preis gratis`, async () => {
      let url = `apps/${M.id}/appPricePoints?filter[territory]=DEU&limit=200`; let free = null;
      while (url && !free) { const pp = await req('GET', url); free = pp.data.find(x => Number(x.attributes.customerPrice) === 0); url = pp.links && pp.links.next; }
      if (!free) throw new Error('kein 0-Preis gefunden');
      await req('POST', 'appPriceSchedules', { data: { type: 'appPriceSchedules', relationships: { app: { data: { type: 'apps', id: M.id } }, baseTerritory: { data: { type: 'territories', id: 'DEU' } }, manualPrices: { data: [{ type: 'appPrices', id: '${p0}' }] } } }, included: [{ type: 'appPrices', id: '${p0}', attributes: { startDate: null }, relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } } }] });
    });
  }

  async function screenshots(app, M, vLocs) {
    for (const [loc, files] of Object.entries(M.shots)) {
      const lid = vLocs[loc]; if (!lid) { log.push(`FEHLER ${app} ${loc} Screenshots: keine Lokalisierung`); continue; }
      await step(`${app} ${loc} Screenshots (${files.length})`, async () => {
        const sets = await req('GET', `appStoreVersionLocalizations/${lid}/appScreenshotSets?include=appScreenshots`);
        let set = sets.data.find(s => s.attributes.screenshotDisplayType === 'APP_IPHONE_67');
        if (set) {
          const existing = (set.relationships.appScreenshots.data || []);
          for (const e of existing) await req('DELETE', `appScreenshots/${e.id}`);
        } else {
          set = (await req('POST', 'appScreenshotSets', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: 'APP_IPHONE_67' }, relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: lid } } } } })).data;
        }
        let n = 0;
        for (const f of files) {
          const blob = await (await fetch(SITE + f + '?v=1')).blob();
          const name = f.split('/').pop();
          const res = await req('POST', 'appScreenshots', { data: { type: 'appScreenshots', attributes: { fileName: name, fileSize: blob.size }, relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: set.id } } } } });
          for (const op of res.data.attributes.uploadOperations) {
            const h = {}; (op.requestHeaders || []).forEach(x => h[x.name] = x.value);
            const r = await fetch(op.url, { method: op.method, headers: h, body: blob.slice(op.offset, op.offset + op.length) });
            if (!r.ok) throw new Error('Upload ' + name + ' -> ' + r.status);
          }
          await req('PATCH', `appScreenshots/${res.data.id}`, { data: { type: 'appScreenshots', id: res.data.id, attributes: { uploaded: true, sourceFileChecksum: window.md5hex ? await window.md5hex(blob) : undefined } } });
          n++;
        }
        return n + ' hochgeladen';
      });
    }
  }

  async function run(app, parts) {
    log.length = 0;
    const all = await (await fetch(SITE + 'asc-tmp/meta.json?v=' + Date.now())).json();
    const M = all[app];
    const { ver, info, vLocs } = await texts(app, M);
    if (!parts || parts.includes('settings')) await settings(app, M, ver, info);
    if (!parts || parts.includes('shots')) await screenshots(app, M, vLocs);
    return log.join('\n');
  }
  return { run, req, log };
})();
'ASC bereit';
