/**
 * PLAN B v2 - Lector de precios con navegador real + diagnostico
 * ---------------------------------------------------------------
 * Cambios respecto a la v1:
 *   - Dice QUE paso en cada link (codigo HTTP, titulo de la pagina)
 *   - Disimula que es un robot (Akamai detecta navegadores automatizados)
 *   - Para adidas usa el mismo endpoint JSON que usa su propia web
 *   - Espera mas tiempo antes de leer el precio
 */

const { chromium } = require('playwright');

const CSV_URL = process.env.CSV_URL;
const WEBAPP  = process.env.WEBAPP_URL;
const TOKEN   = process.env.TOKEN;

const DOMINIOS_DIFICILES = ['adidas.com', 'nike.com'];

function partirCSV(texto) {
  return texto.trim().split('\n').map(linea => {
    const campos = [];
    let actual = '', comillas = false;
    for (const ch of linea) {
      if (ch === '"') comillas = !comillas;
      else if (ch === ',' && !comillas) { campos.push(actual); actual = ''; }
      else actual += ch;
    }
    campos.push(actual);
    return campos;
  });
}

/** Saca el codigo de producto de una URL de adidas: .../JQ3230.html -> JQ3230 */
function skuAdidas(url) {
  const m = url.match(/\/([A-Z0-9]{6,10})\.html/i);
  return m ? m[1].toUpperCase() : null;
}

/** Metodo A: el endpoint JSON que usa la propia web de adidas. Mas estable que leer HTML. */
async function precioViaApiAdidas(page, url) {
  const sku = skuAdidas(url);
  if (!sku) return null;
  try {
    return await page.evaluate(async (sku) => {
      const r = await fetch('/api/products/' + sku, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      const p = j && j.pricing_information;
      if (!p) return null;
      return parseFloat(p.currentPrice || p.standard_price || 0) || null;
    }, sku);
  } catch (e) {
    return null;
  }
}

/** Metodo B: leer el precio del contenido de la pagina. */
async function precioViaPagina(page) {
  return await page.evaluate(() => {
    const buscar = (o) => {
      if (!o || typeof o !== 'object') return null;
      if (Array.isArray(o)) { for (const x of o) { const r = buscar(x); if (r) return r; } return null; }
      if (o.offers) {
        const of = Array.isArray(o.offers) ? o.offers[0] : o.offers;
        if (of && of.price)    return parseFloat(of.price);
        if (of && of.lowPrice) return parseFloat(of.lowPrice);
      }
      for (const k in o) { if (typeof o[k] === 'object') { const r = buscar(o[k]); if (r) return r; } }
      return null;
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const p = buscar(JSON.parse(s.textContent)); if (p) return p; } catch (e) {}
    }
    const og = document.querySelector('meta[property="product:price:amount"]');
    if (og && og.content) return parseFloat(og.content);

    const ip = document.querySelector('[itemprop="price"]');
    if (ip) {
      const v = ip.getAttribute('content') || ip.textContent;
      const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
      if (n) return n;
    }
    // ultimo recurso: elementos cuyo atributo o clase mencione precio
    for (const el of document.querySelectorAll('[data-testid*="price" i],[class*="price" i]')) {
      const n = parseFloat(el.textContent.replace(/[^\d.]/g, ''));
      if (n > 15 && n < 1000) return n;
    }
    return null;
  });
}

(async () => {
  const csv = await (await fetch(CSV_URL)).text();
  const filas = partirCSV(csv);

  const objetivos = [];
  for (let i = 4; i < filas.length; i++) {
    const url    = (filas[i][3] || '').trim();
    const estado = (filas[i][8] || '').trim().toLowerCase();
    if (!url || estado !== 'activo') continue;
    if (!DOMINIOS_DIFICILES.some(d => url.includes(d))) continue;
    objetivos.push({ fila: i + 1, url });
  }
  console.log('Voy a revisar ' + objetivos.length + ' links dificiles');

  const navegador = await chromium.launch({
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const contexto = await navegador.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  // borra las huellas tipicas de un navegador automatizado
  await contexto.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  const page = await contexto.newPage();
  const resultados = [];

  for (const o of objetivos) {
    try {
      const resp = await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const codigo = resp ? resp.status() : 0;

      await page.waitForTimeout(5000);
      const titulo = (await page.title()).slice(0, 60);

      let precio = null;
      if (o.url.indexOf('adidas.com') !== -1) precio = await precioViaApiAdidas(page, o.url);
      if (!precio) precio = await precioViaPagina(page);

      if (precio) {
        console.log('fila ' + o.fila + ': $' + precio + '   [HTTP ' + codigo + '] ' + titulo);
        resultados.push({ fila: o.fila, precio: precio });
      } else {
        console.log('fila ' + o.fila + ': SIN PRECIO  [HTTP ' + codigo + '] titulo="' + titulo + '"');
      }
    } catch (e) {
      console.log('fila ' + o.fila + ': ERROR ' + e.message.slice(0, 80));
    }
    await page.waitForTimeout(4000);
  }

  await navegador.close();

  console.log('\nLeidos ' + resultados.length + ' de ' + objetivos.length);

  if (resultados.length) {
    const r = await fetch(WEBAPP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, precios: resultados })
    });
    console.log('Enviado a la hoja:', await r.text());
  } else {
    console.log('No se envio nada a la hoja.');
  }
})();
