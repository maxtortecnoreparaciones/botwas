/**
 * index.js — WhatsApp Bot (minimalista con Sheets)
 * ✅ Solo lo necesario:
 *  - Menú por ciudad
 *  - 1) Comprar accesorios (flujo largo hasta pedido en Sheets)
 *  - 2) Reparación de celulares (equipo + falla → se registra)
 *  - 3) Bot/App (negocio + tiempo en WhatsApp → notifica admin)
 * ⚙️ CommonJS como tu código anterior. Lenguaje simple. Sin nombre de empresa.
 */

'use strict';

// ================= Dependencias =================
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;
const qrcode = require('qrcode-terminal');
const axios  = require('axios');
const pino   = require('pino');
const fs     = require('fs');

// ================= Config =================
const CONFIG = {
  ADMIN_JID: '57XXXXXXXXXX@s.whatsapp.net', // <--- cámbialo por tu número
  API_BASE: 'http://127.0.0.1:8000/api',     // <--- base de tu API
  PAGE_SIZE: 3,
  MENU_COOLDOWN_MS: 45000,
  LOG_LEVEL: 'info'
};

const ENDPOINTS = {
  LISTAR: (ciudad) => `${CONFIG.API_BASE}/consultar_productos_gsheet/?ciudad=${ciudad}`,
  LISTAR_GENERAL:   `${CONFIG.API_BASE}/consultar_productos_gsheet/`,
  REGISTRAR:        `${CONFIG.API_BASE}/registrar_entrega/`          // ventas y reparaciones
};

// ================ Estados (fases) =================
const PHASE = Object.freeze({
  SCOPE: 'scope',       // elegir ciudad
  MENU:  'menu',        // 1 accesorios / 2 reparación / 3 bot-app

  // Accesorios (venta)
  BROWSE:     'browse',
  CHECK_TEL:  'checkout_tel',
  CHECK_DIR:  'checkout_dir',
  CHECK_PAGO: 'checkout_pago',
  CHECK_REF:  'checkout_ref',

  // Reparación
  TECH_DEVICE: 'tech_device',
  TECH_ISSUE:  'tech_issue',
  TECH_CONFIRM:'tech_confirm',

  // Bot/App
  APPS_BUSINESS: 'apps_business',
  APPS_TIME:     'apps_time',
  APPS_CONFIRM:  'apps_confirm'
});

// ================ Contexto en memoria =================
const ctx = {
  sessions:  Object.create(null), // jid -> { phase, lastPromptAt }
  ciudad:    Object.create(null), // jid -> 'bogota'|'guajira'|'resto'
  listCache: Object.create(null), // jid -> { items, page, slice:[] }
  carts:     Object.create(null), // jid -> [{codigo,nombre,precio,cantidad,categoria}]
  order:     Object.create(null), // jid -> { tel, dir, pago, referido }
  tech:      Object.create(null), // jid -> { device, issue }
  apps:      Object.create(null), // jid -> { business, time }
  lastSent:  Object.create(null)  // jid -> last text
};

// ================= Utils =================
const money = (n)=> { try { return Number(n).toLocaleString('es-CO'); } catch { return String(n); } };
function norm(s=''){
  return (s||'').toLowerCase()
    .normalize('NFD').replace(/[^\p{L}\p{N}\s]/gu,'')
    .replace(/\s+/g,' ').trim();
}
function stripCode(s=''){
  return (s||'').toUpperCase()
    .normalize('NFD').replace(/[^A-Z0-9._-]/g,'')
    .trim();
}
function getText(msg){
  const m0 = msg?.message || {};
  const inner = m0.ephemeralMessage?.message
             || m0.viewOnceMessageV2?.message
             || m0.viewOnceMessageV2Extension?.message
             || m0.deviceSentMessage?.message
             || m0;
  return inner.conversation
      || inner.extendedTextMessage?.text
      || inner.imageMessage?.caption
      || inner.videoMessage?.caption
      || inner.listResponseMessage?.title
      || inner.listResponseMessage?.singleSelectReply?.selectedRowId
      || '';
}
async function say(sock, jid, text){
  if (ctx.lastSent[jid] === text) return;
  ctx.lastSent[jid] = text;
  await sock.sendMessage(jid, { text });
}
function resetChat(jid){
  ctx.sessions[jid]  = { phase: PHASE.SCOPE, lastPromptAt: 0 };
  ctx.ciudad[jid]    = null;
  ctx.listCache[jid] = null;
  ctx.carts[jid]     = [];
  ctx.order[jid]     = {};
  ctx.tech[jid]      = {};
  ctx.apps[jid]      = {};
  ctx.lastSent[jid]  = '';
}
function pickScope(input=''){
  const s = norm(input);
  const n1 = /^1\b/.test(s) || /bogo?ta/.test(s);
  const n2 = /^2\b/.test(s) || /guajira|guaji/.test(s);
  const n3 = /^3\b/.test(s) || /(otro|resto|fuera)/.test(s);
  if (n1) return 'bogota';
  if (n2) return 'guajira';
  if (n3) return 'resto';
  return null;
}

// ================ Catálogo =================
async function fetchList(scope){
  try {
    const url = (scope === 'bogota' || scope === 'guajira') ? ENDPOINTS.LISTAR(scope) : ENDPOINTS.LISTAR_GENERAL;
    const r = await axios.get(url, { timeout: 10000 });
    const arr = Array.isArray(r.data) ? r.data : (r.data?.resultados || []);
    return (arr || []).map(it => ({
      nombre:   it.nombre || it.Producto || it.producto || '',
      codigo:   String(it.codigo || it.Codigo || it.Código || it.CODIGO || ''),
      precio:   it.precio || it.Precio_Venta || it.precio_venta || it.PRECIO || 0,
      categoria:it.categoria || it.Categoria || it.Categoría || ''
    }));
  } catch (e) {
    console.error('[inventario] error:', e.message);
    return [];
  }
}
function cart(jid){ if (!ctx.carts[jid]) ctx.carts[jid] = []; return ctx.carts[jid]; }
function addToCart(jid, item, qty=1){
  const c = cart(jid);
  const i = c.findIndex(x => x.codigo === item.codigo);
  if (i >= 0) c[i].cantidad += qty; else c.push({ ...item, cantidad: qty });
}
function cartSummary(jid){
  const c = cart(jid);
  if (!c.length) return { text:'Carrito vacío.', total:0 };
  const lines = c.map(x => `• ${x.nombre} (${x.codigo}) x${x.cantidad} — $${money(Number(x.precio)*x.cantidad)}`);
  const total = c.reduce((s,x)=> s + (Number(x.precio)||0)*x.cantidad, 0);
  return { text: lines.join('\n'), total };
}
function renderNumbered(list){
  return list.map(p=>`🛒 *${p.nombre}*\n   Código: ${p.codigo}\n   Precio: $${money(p.precio)}`).join('\n\n');
}
async function sendCatalogPage(sock, jid){
  const cache = ctx.listCache[jid];
  const items = cache.items || [];
  const size  = CONFIG.PAGE_SIZE;
  const start = (cache.page || 0) * size;
  const slice = items.slice(start, start + size);
  cache.slice = slice;
  if (!slice.length) { await say(sock, jid, 'No hay más por mostrar. Escribe *carrito* o *pagar*.'); return; }

  const ciudadTxt = ctx.ciudad[jid] === 'bogota' ? 'Bogotá' : ctx.ciudad[jid] === 'guajira' ? 'Guajira' : 'Otros';
  await say(sock, jid,
`📍 ${ciudadTxt}

*Paso 2:* Escribe el *CÓDIGO* para agregar (ej: 32)

${renderNumbered(slice)}

👉 *Escribe el código* (ej: 32) o el *número* (1, 2, 3)
🔁 Más productos: escribe *más*
🧺 Ver carrito: escribe *carrito*
✅ Pagar: escribe *pagar*

✨ También ayudo a negocios a ahorrar tiempo y vender más con bots 24/7 y apps 🧠⏱️
Si te interesa, escribe: *Quiero mi app* 😉`);
}

// ============== Core Bot ==============
async function startBot(){
  const log = pino({ level: CONFIG.LOG_LEVEL });
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ auth: state, version, logger: log, printQRInTerminal: false, browser: Browsers.macOS('Safari'), syncFullHistory:false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { console.log('Escanea el QR'); qrcode.generate(qr, { small:true }); }
    if (connection === 'open') console.log('✅ Conectado');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401;
      if (shouldReconnect) setTimeout(()=> startBot().catch(()=>{}), 1500);
      else { try { fs.rmSync('baileys_auth', { recursive:true, force:true }); } catch{} setTimeout(()=> startBot().catch(()=>{}), 500); }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!['notify','append','replace'].includes(type)) return;
    const m = messages?.[0]; if (!m || m.key?.fromMe) return;
    const jid = m.key.remoteJid; if (!jid || jid.endsWith('@g.us')) return;
    const raw = getText(m); const t = norm(raw);

    // init
    if (!ctx.sessions[jid]) resetChat(jid);

    // comandos de sistema
    if (t === 'menu' || t === 'inicio' || t === 'start') { resetChat(jid); }

    // ====== SCOPE: elegir ciudad ======
    if (ctx.sessions[jid].phase === PHASE.SCOPE) {
      const now = Date.now();
      const last = ctx.sessions[jid].lastPromptAt || 0;
      if (!last || now - last > CONFIG.MENU_COOLDOWN_MS) {
        ctx.sessions[jid].lastPromptAt = now;
        await say(sock, jid,
`👋 Hola, soy tu asistente.
Elige tu zona:
1) Bogotá   2) Guajira   3) Otros
(Responde con 1, 2 o 3)`);
        return;
      }
      const scope = pickScope(raw) || pickScope(t);
      if (!scope) return;
      ctx.ciudad[jid] = scope;
      const items = await fetchList(scope);
      if (!items.length) { await say(sock, jid, '😕 Sin stock por ahora. Escribe *menu* más tarde.'); resetChat(jid); return; }
      ctx.listCache[jid] = { items, page: 0, slice: [] };
      ctx.sessions[jid].phase = PHASE.MENU;
      await say(sock, jid,
`¿Qué necesitas?
1) Comprar accesorios 🛒
2) Reparación de celular 🔧
3) Bot o app para mi negocio 🤖
(Escribe 1, 2 o 3)`);
      return;
    }

    // ====== MENU ======
    if (ctx.sessions[jid].phase === PHASE.MENU) {
      if (/^1\b/.test(t)) { ctx.sessions[jid].phase = PHASE.BROWSE; await sendCatalogPage(sock, jid); return; }
      if (/^2\b/.test(t)) { ctx.sessions[jid].phase = PHASE.TECH_DEVICE; await say(sock, jid, '📱 Dime qué celular tienes (ej: iPhone 12 / Samsung A14).'); return; }
      if (/^3\b/.test(t) || /quiero mi app/.test(t)) { ctx.sessions[jid].phase = PHASE.APPS_BUSINESS; await say(sock, jid, '🧠 ¿Qué negocio tienes? (ej: ropa, barbería, restaurante)'); return; }
      await say(sock, jid, 'Escribe 1, 2 o 3.'); return;
    }

    // ====== BROWSE (venta accesorios) ======
    if (ctx.sessions[jid].phase === PHASE.BROWSE) {
      const cache = ctx.listCache[jid];
      if (!cache || !cache.items?.length) { resetChat(jid); return; }

      // Código/SKU primero
      const code = stripCode(raw);
      if (/^[A-Z0-9._-]{1,24}$/.test(code)) {
        const item = cache.items.find(p => stripCode(p.codigo) === code);
        if (item) { addToCart(jid, item, 1); await say(sock, jid, `✅ Agregado *${item.nombre}* x1.\nResponde: *pagar*, *carrito* o *más*`); return; }
      }
      // Índice de la página
      if (/^\d+$/.test(t)) {
        const idx = parseInt(t, 10);
        const item = (cache.slice||[])[idx-1];
        if (item) { addToCart(jid, item, 1); await say(sock, jid, `✅ Agregado *${item.nombre}* x1.\nResponde: *pagar*, *carrito* o *más*`); return; }
      }
      // Más / Carrito / Pagar
      if (['mas','más','ver mas','ver más','vermas'].includes(t)) { cache.page = (cache.page||0)+1; await sendCatalogPage(sock, jid); return; }
      if (t === 'carrito') { const { text, total } = cartSummary(jid); await say(sock, jid, `🧺 *Tu carrito*\n${text}\n\nTotal: $${money(total)}\nResponde: *pagar* o *más*`); return; }
      if (t === 'pagar') { if (!cart(jid).length) { await say(sock, jid, 'Tu carrito está vacío. Escribe un *código* o un *número*.'); return; } ctx.sessions[jid].phase = PHASE.CHECK_TEL; await say(sock, jid, '📞 Escribe tu *teléfono* (solo números).'); return; }

      // Gancho apps
      if (t.includes('quiero') && t.includes('app')) { await say(sock, jid, '✨ Perfecto. Te contacto para ver tu bot/app 24/7.'); return; }

      // Si no coincidió nada, reenvía página actual
      await sendCatalogPage(sock, jid); return;
    }

    // ====== Checkout (venta accesorios) ======
    if (ctx.sessions[jid].phase === PHASE.CHECK_TEL) {
      const phone = (raw||'').replace(/[^0-9+]/g,''); if (phone.length < 7) return;
      ctx.order[jid] = { ...ctx.order[jid], tel: phone };
      ctx.sessions[jid].phase = PHASE.CHECK_DIR; await say(sock, jid, '📍 Escribe tu *dirección completa* y una referencia.'); return;
    }
    if (ctx.sessions[jid].phase === PHASE.CHECK_DIR) {
      if ((raw||'').trim().length < 5) return; ctx.order[jid] = { ...ctx.order[jid], dir: raw.trim() };
      ctx.sessions[jid].phase = PHASE.CHECK_PAGO; await say(sock, jid, '💳 Escribe *Adelantado* (QR) o *Contraentrega*.'); return;
    }
    if (ctx.sessions[jid].phase === PHASE.CHECK_PAGO) {
      const p = norm(raw); let metodo = null; if (p.includes('contra')) metodo='Contraentrega'; if (p.includes('adelant')||p.includes('qr')||p.includes('nequi')||p.includes('banco')) metodo='Adelantado'; if (!metodo) return;
      ctx.order[jid] = { ...ctx.order[jid], pago: metodo };
      ctx.sessions[jid].phase = PHASE.CHECK_REF; await say(sock, jid, '🎁 ¿Alguien te refirió? (tel/nombre) o escribe *no*.'); return;
    }
    if (ctx.sessions[jid].phase === PHASE.CHECK_REF) {
      const ref = norm(raw) === 'no' ? '' : (raw||'').trim();
      ctx.order[jid] = { ...ctx.order[jid], referido: ref };
      const c = cart(jid);
      const total = c.reduce((s,x)=> s + (Number(x.precio)||0)*x.cantidad, 0);
      const ciudad = ctx.ciudad[jid] || 'resto';
      try {
        for (const x of c) {
          await axios.post(ENDPOINTS.REGISTRAR, {
            ciudad,
            producto: `${x.nombre} x${x.cantidad}`,
            codigo: x.codigo,
            telefono: ctx.order[jid].tel,
            direccion: ctx.order[jid].dir,
            monto: (Number(x.precio)||0)*x.cantidad,
            pago: 'Pendiente',
            estado: 'Por despachar',
            observaciones: `Metodo: ${ctx.order[jid].pago}; Origen: WhatsApp`,
            referido_por: ctx.order[jid].referido || ''
          }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });
        }
        const lines = c.map(x => `• ${x.nombre} (${x.codigo}) x${x.cantidad} — $${money((Number(x.precio)||0)*x.cantidad)}`).join('\n');
        await say(sock, jid,
`🧾 *Pedido registrado*
${lines}
Total: $${money(total)}
📞 ${ctx.order[jid].tel}
🏠 ${ctx.order[jid].dir}
💳 ${ctx.order[jid].pago}
${ctx.order[jid].referido ? '🎁 Ref: ' + ctx.order[jid].referido : ''}

¡Gracias! El mensajero te contacta antes de llegar. Escribe *menu* para empezar de nuevo.`);
        // Aviso al admin
        try { await sock.sendMessage(CONFIG.ADMIN_JID, { text: `🔔 Pedido nuevo\nCiudad: ${ciudad}\n${lines}\nTotal: $${money(total)}\nTel: ${ctx.order[jid].tel}\nDir: ${ctx.order[jid].dir}\nPago: ${ctx.order[jid].pago}\nRef: ${ctx.order[jid].referido || 'N/A'}` }); } catch {}
        resetChat(jid);
      } catch (e) { console.error('[registrar venta] error:', e.message); await say(sock, jid, '❌ No pude registrar el pedido. Intenta en unos minutos con *menu*.'); resetChat(jid); }
      return;
    }

    // ====== Reparación ======
    if (ctx.sessions[jid].phase === PHASE.TECH_DEVICE) { ctx.tech[jid] = { device: raw.trim(), issue: '' }; ctx.sessions[jid].phase = PHASE.TECH_ISSUE; await say(sock, jid, '🔧 ¿Qué le pasa? (ej: no carga / pantalla rota / batería dura poco)'); return; }
    if (ctx.sessions[jid].phase === PHASE.TECH_ISSUE)  { ctx.tech[jid].issue = raw.trim(); ctx.sessions[jid].phase = PHASE.TECH_CONFIRM; await say(sock, jid, '📍 Escribe tu *dirección* o si prefieres traerlo, escribe *llevar*.'); return; }
    if (ctx.sessions[jid].phase === PHASE.TECH_CONFIRM) {
      const direccion = norm(raw)==='llevar' ? 'Cliente lleva a taller' : raw.trim();
      try {
        await axios.post(ENDPOINTS.REGISTRAR, {
          ciudad: ctx.ciudad[jid] || 'resto',
          producto: `Reparación: ${ctx.tech[jid].device}`,
          codigo: 'SERV-REP',
          telefono: '',
          direccion,
          monto: 0,
          pago: 'Pendiente',
          estado: 'Diagnóstico',
          observaciones: `Falla: ${ctx.tech[jid].issue}; Origen: WhatsApp`,
          referido_por: ''
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });
        await say(sock, jid, '✅ Listo, anotado para reparación. Te contactamos para hora y costo. Escribe *menu* si necesitas otra cosa.');
        resetChat(jid);
      } catch (e) { console.error('[registrar rep] error:', e.message); await say(sock, jid, '❌ No pude registrar. Intenta de nuevo con *menu*.'); resetChat(jid); }
      return;
    }

    // ====== Bot/App ======
    if (ctx.sessions[jid].phase === PHASE.APPS_BUSINESS) { ctx.apps[jid] = { business: raw.trim(), time: '' }; ctx.sessions[jid].phase = PHASE.APPS_TIME; await say(sock, jid, '⏱️ ¿Cuánto tiempo al día gastas respondiendo WhatsApp? (ej: 1 hora / 3 horas)'); return; }
    if (ctx.sessions[jid].phase === PHASE.APPS_TIME)     { ctx.apps[jid].time = raw.trim(); ctx.sessions[jid].phase = PHASE.APPS_CONFIRM; await say(sock, jid, '¿Te mando una propuesta sencilla por aquí? (Escribe: Sí o No)'); return; }
    if (ctx.sessions[jid].phase === PHASE.APPS_CONFIRM)  {
      if (/^s[ií]/.test(norm(raw))) {
        try { await sock.sendMessage(CONFIG.ADMIN_JID, { text: `🤖 Interés en bot/app\nNegocio: ${ctx.apps[jid].business}\nTiempo en WhatsApp: ${ctx.apps[jid].time}\nCliente: ${jid}` }); } catch {}
        await say(sock, jid, 'Perfecto. Te escribo con el plan. 🙌');
      } else {
        await say(sock, jid, 'Listo. Si te animas luego, escribe: *Quiero mi app*');
      }
      resetChat(jid); return;
    }
  });
}

// ============== Boot ==============
(async ()=>{ try { await startBot(); } catch(e){ console.error('❌ Error al iniciar:', e); process.exit(1); } })();
