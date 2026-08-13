/**
 * PLAN B - Lector de precios con navegador real
 * ----------------------------------------------
 * Se usa SOLO para los sitios que le devuelven 403 a Google Apps Script
 * (tipicamente adidas.com y nike.com).
 *
 * Como funciona:
 *   1. Lee la lista de links desde su Google Sheet publicado como CSV
 *   2. Abre un Chrome de verdad (invisible) en una computadora de GitHub
 *   3. Saca el precio de cada pagina
 *   4. Le manda los precios de vuelta a su hoja
 *
 * Corre solo todos los dias. Usted no ejecuta nada.
 */

const { chromium } = require('playwright');

const CSV_URL   = process.env.CSV_URL;    // link CSV publicado de la hoja Watchlist
const WEBAPP    = process.env.WEBAPP_URL; // link del Web App de Apps Script
const TOKEN     = process.env.TOKEN;      // clave secreta compartida

// Solo estos dominios pasan por aca. El resto ya los resuelve Apps Script.
const DOMINIOS_DIFICILES = ['adidas.com', 'nike.com'];

function partirCSV(texto) {
  return texto.trim().split('\n').map(linea => {
    const campos = [];
    let actual = '', dentroDeComillas = false;
    for (const ch of linea) {
      if (ch === '"') dentroDeComillas = !dentroDeComillas;
      else if (ch === ',' && !dentroDeComillas) { campos.push(actual); actual = ''; }
      else actual += ch;
    }
    campos.push(actual);
    return campos;
  });
}

async function precioDeLaPagina(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500); // dejar que cargue el precio por JavaScript

  return await page.evaluate(() => {
    const buscar = (o) => {
      if (!o || typeof o !== 'object') return null;
      if (Array.isArray(o)) { for (const x of o) { const r = buscar(x); if (r) return r; } return null; }
      if (o.offers) {
        const of = Array.isArray(o.offers) ? o.offers[0] : o.offers;
        if (of?.price)     return parseFloat(of.price);
        if (of?.lowPrice)  return parseFloat(of.lowPrice);
      }
      for (const k in o) { if (typeof o[k] === 'object') { const r = buscar(o[k]); if (r) return r; } }
      return null;
    };
    // Metodo 1: JSON-LD
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const p = buscar(JSON.parse(s.textContent)); if (p) return p; } catch (e) {}
    }
    // Metodo 2: Open Graph
    const og = document.querySelector('meta[property="product:price:amount"]');
    if (og?.content) return parseFloat(og.content);
    // Metodo 3: microdatos
    const ip = document.querySelector('[itemprop="price"]');
    if (ip) return parseFloat(ip.getAttribute('content') || ip.textContent.replace(/[^\d.]/g, ''));
    return null;
  });
}

(async () => {
  const csv   = await (await fetch(CSV_URL)).text();
  const filas = partirCSV(csv);

  const objetivos = [];
  for (let i = 4; i < filas.length; i++) {   // fila 5 en adelante (indice 4)
    const url    = (filas[i][3]  || '').trim();  // columna D
    const estado = (filas[i][8]  || '').trim().toLowerCase(); // columna I
    if (!url || estado !== 'activo') continue;
    if (!DOMINIOS_DIFICILES.some(d => url.includes(d))) continue;
    objetivos.push({ fila: i + 1, url });
  }
  console.log(`Voy a revisar ${objetivos.length} links dificiles`);

  const navegador = await chromium.launch();
  const contexto  = await navegador.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1366, height: 900 }
  });
  const page = await contexto.newPage();

  const resultados = [];
  for (const o of objetivos) {
    try {
      const precio = await precioDeLaPagina(page, o.url);
      console.log(`fila ${o.fila}: ${precio ?? 'no encontrado'}`);
      if (precio) resultados.push({ fila: o.fila, precio });
    } catch (e) {
      console.log(`fila ${o.fila}: fallo (${e.message.slice(0, 60)})`);
    }
    await page.waitForTimeout(3000);
  }
  await navegador.close();

  if (resultados.length) {
    const r = await fetch(WEBAPP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, precios: resultados })
    });
    console.log('Enviado a la hoja:', await r.text());
  }
})();
