/**
 * index.js
 * WhatsApp Bot — Flujo profesional, estricto y paso-a-paso
 *
 * Principios:
 *  - 1 mensaje por turno: nunca encadena dos respuestas.
 *  - No avanza sin respuesta válida del usuario.
 *  - Silencio absoluto ante entradas no permitidas en cada fase.
 *  - Filtros: ignora links sueltos, multimedia sin caption, ruido/emoji.
 *  - Parche anti-515 (versión oficial WA Web + Browser consistente).
 *  - Logs claros y útiles para depuración en producción.
 *
 * Autor: (tu equipo)
 */

'use strict';

// ============================== Dependencias ==============================
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios  = require('axios');
const pino   = require('pino');
const fs     = require('fs');

// ================================ Config ==================================
const CONFIG = {
  ADMIN_JID: '57XXXXXXXXXX@s.whatsapp.net', // Bogotá (notificación interna)
  SOCIA_JID: '57YYYYYYYYYY@s.whatsapp.net', // Guajira (notificación interna)

  API_BASE: 'http://127.0.0.1:8000/api',
  TIME: {
    MENU_COOLDOWN_MS: 45_000
  },
  CATALOG: {
    PAGE_SIZE: 3
  },
  LOG_LEVEL: 'info' // 'debug' en desarrollo, 'info' en producción
};

const ENDPOINTS = {
  LISTAR: (ciudad) => `${CONFIG.API_BASE}/consultar_productos_gsheet/?ciudad=${ciudad}`,
  LISTAR_GENERAL:   `${CONFIG.API_BASE}/consultar_productos_gsheet/`,
  REGISTRAR:        `${CONFIG.API_BASE}/registrar_entrega/`
};

// ================================ Estado ==================================
/** Fases del flujo (máquina de estados) */
const PHASE = Object.freeze({
  SCOPE:          'scope',          // elegir zona
  BROWSE:         'browse',         // ver/añadir productos
  CHECK_TEL:      'checkout_tel',   // pedir teléfono
  CHECK_DIR:      'checkout_dir',   // pedir dirección
  CHECK_PAGO:     'checkout_pago',  // elegir método de pago
  CHECK_REF:      'checkout_ref'    // referido y registrar
});

/** Contexto por chat (jid) */
const ctx = {
  sessions:      Object.create(null), // jid -> { phase, lastPromptAt }
  reach:         Object.create(null), // jid -> 'bogota' | 'guajira' | 'resto'
  listCache:     Object.create(null), // jid -> { items, page }
  carts:         Object.create(null), // jid -> [{codigo,nombre,precio,cantidad}]
  order:         Object.create(null), // jid -> { tel, dir, pago, referido }
  lastSent:      Object.create(null)  // jid -> last text (evita duplicados)
};

// ============================== Utilidades ================================
const sleep = (ms)=> new Promise(r => setTimeout(r, ms));

/** Normaliza texto para comparaciones robustas */
function norm(s=''){
  return (s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // sin acentos
    .replace(/[^\p{L}\p{N}\s]/gu,'')                 // sin signos
    .replace(/\s+/g,' ')
    .trim();
}
/** Limpia códigos (SKU) */
function stripCode(s=''){
  return (s||'').toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Z0-9._-]/g,'')
    .trim();
}
/** Money */
function money(n){ try { return Number(n).toLocaleString('es-CO'); } catch { return String(n); } }

/** Extractor de texto desde mensaje (desempaqueta variantes WA) */
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

/** Filtros de ruido/links/media */
function hasUrl(s=''){ return /(https?:\/\/|www\.)\S+/i.test(s); }
function isOnlyUrlOrShort(s=''){
  const trimmed = (s||'').trim(); if (!trimmed) return false;
  if (hasUrl(trimmed)) { const words = trimmed.split(/\s+/); return words.length <= 3; }
  return false;
}
function isMediaOnly(msg){
  const m0 = msg?.message || {};
  const inner = m0.ephemeralMessage?.message
            || m0.viewOnceMessageV2?.message
            || m0.viewOnceMessageV2Extension?.message
            || m0.deviceSentMessage?.message
            || m0;
  const hasMedia = !!(inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.documentMessage || inner.stickerMessage);
  const caption = inner.imageMessage?.caption || inner.videoMessage?.caption || '';
  return hasMedia && (!caption || isOnlyUrlOrShort(caption));
}
function isGreeting(t=''){ return /^(hola+|buenas|hey)\b/.test(t||''); }

/** Resolución de zona: acepta 1/2/3, variantes "1)", "uno", "bogota", etc. */
function pickScope(input=''){
  const s = (input||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const n1 = /^\s*1[\s).,-]?/.test(s) || /\buno\b/.test(s) || /bogo?ta\b/.test(s);
  const n2 = /^\s*2[\s).,-]?/.test(s) || /\bdos\b/.test(s) || /guajira|guaji\b/.test(s);
  const n3 = /^\s*3[\s).,-]?/.test(s) || /\btres\b/.test(s) || /\b(otro|resto|fuera)\b/.test(s);
  if (n1) return 'bogota';
  if (n2) return 'guajira';
  if (n3) return 'resto';
  return null;
}

/** Envío con anti-duplicado (estricto: 1 mensaje por turno) */
async function say(sock, jid, text){
  if (ctx.lastSent[jid] === text) return;
  ctx.lastSent[jid] = text;
  await sock.sendMessage(jid, { text });
}

/** Reinicia contexto del chat */
function resetChat(jid){
  ctx.sessions[jid] = { phase: PHASE.SCOPE, lastPromptAt: 0 };
  ctx.reach[jid]    = null;
  ctx.listCache[jid]= null;
  ctx.carts[jid]    = [];
  ctx.order[jid]    = {};
  ctx.lastSent[jid] = '';
}

/** Carrito */
function cart(jid){ if (!ctx.carts[jid]) ctx.carts[jid] = []; return ctx.carts[jid]; }
function addToCart(jid, item, qty=1){
  const c = cart(jid); const i = c.findIndex(x => x.codigo === item.codigo);
  if (i >= 0) c[i].cantidad += qty;
  else c.push({ codigo:item.codigo, nombre:item.nombre, precio:item.precio, cantidad:qty });
}
function cartSummary(jid){
  const c = cart(jid);
  if (!c.length) return { text:'Carrito vacío.', total:0 };
  const lines = c.map(x => `• ${x.nombre} (${x.codigo}) x${x.cantidad} — $${money(x.precio * x.cantidad)}`);
  const total = c.reduce((s,x)=> s + (Number(x.precio)||0) * x.cantidad, 0);
  return { text: lines.join('\n'), total };
}
function renderPage(items){
  return items.map(p => `• ${p.nombre}\n  Código: *${p.codigo}*  —  $${money(p.precio)}`).join('\n\n');
}

/** Inventario */
async function fetchList(scope){
  try {
    const url = (scope === 'bogota' || scope === 'guajira') ? ENDPOINTS.LISTAR(scope) : ENDPOINTS.LISTAR_GENERAL;
    const r = await axios.get(url, { timeout: 10_000 });
    const arr = Array.isArray(r.data) ? r.data : (r.data?.resultados || []);
    return (arr || []).map(it => ({
      nombre: it.nombre || it.Producto || it.producto || '',
      codigo: (it.codigo || it.Codigo || it.Código || it.CODIGO || '').toString(),
      precio: it.precio || it.Precio_Venta || it.precio_venta || it.PRECIO || 0
    }));
  } catch (e) {
    console.error('[inventario] error:', e.message);
    return [];
  }
}

// ================================ Núcleo ==================================
async function startBot(){
  const log = pino({ level: CONFIG.LOG_LEVEL });

  // Auth y versión oficial (parche anti-515)
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: log,
    printQRInTerminal: false,
    browser: Browsers.macOS('Safari'),
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { console.log('Escanea el QR'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') {
      const me = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
      console.log('✅ Conectado como', me);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401;
      if (shouldReconnect) setTimeout(() => startBot().catch(()=>{}), 1500);
      else {
        try { fs.rmSync('baileys_auth', { recursive:true, force:true }); } catch {}
        setTimeout(() => startBot().catch(()=>{}), 500);
      }
    }
  });

  // ============================ Handler principal =========================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!['notify','append','replace'].includes(type)) return;
    const msg = messages?.[0]; if (!msg || msg.key?.fromMe) return;
    const jid = msg.key.remoteJid; if (!jid || jid.endsWith('@g.us')) return;

    const raw = getText(msg);
    const t   = norm(raw);
    const phase = ctx.sessions[jid]?.phase;

    console.log('📨', { jid, phase, raw, t });

    // Filtros globales: silencio para media sin caption o link suelto
    if (isMediaOnly(msg) || isOnlyUrlOrShort(raw)) return;

    // Inicia contexto si no existe
    if (!ctx.sessions[jid]) resetChat(jid);

    // ============================== FASE: SCOPE ===========================
    if (ctx.sessions[jid].phase === PHASE.SCOPE) {
      const now = Date.now();
      const last = ctx.sessions[jid].lastPromptAt || 0;

      // Permite "hola" / "menu" para mostrar menú (con cooldown)
      if (isGreeting(t) || t === 'menu' || !last) {
        if (now - last > CONFIG.TIME.MENU_COOLDOWN_MS) {
          ctx.sessions[jid].lastPromptAt = now;
          await say(sock, jid,
`👋 Hola, soy Johan.

Paso 1️⃣: Elige tu zona
1) Bogotá   2) Guajira   3) Otros

(Responde con 1, 2 o 3)`);
        }
        return;
      }

      // Acepta SÓLO una elección válida; sino, silencio
      const chosen = pickScope(raw) || pickScope(t);
      if (!chosen) return;

      ctx.reach[jid] = chosen;

      // Carga de inventario (primera vez)
      if (!ctx.listCache[jid]) {
        const items = await fetchList(chosen);
        ctx.listCache[jid] = { items, page: 0 };
      }
      const items = ctx.listCache[jid].items || [];
      if (!items.length) {
        await say(sock, jid, '😕 Sin stock por ahora. Escribe "menu" más tarde.');
        resetChat(jid);
        return;
      }

      ctx.sessions[jid].phase = PHASE.BROWSE;

      // 1 mensaje: primera página + instrucción clara
      const slice = items.slice(0, CONFIG.CATALOG.PAGE_SIZE);
      await say(sock, jid,
`Paso 2️⃣: Escribe el *CÓDIGO* para agregar (ej: 32)

${renderPage(slice)}

Respuestas válidas:
• CÓDIGO (ej: 32)
• "más"
• "carrito"
• "pagar"`);
      return;
    }

    // ============================= FASE: BROWSE ===========================
    if (ctx.sessions[jid].phase === PHASE.BROWSE) {
      const cache = ctx.listCache[jid];
      if (!cache || !cache.items?.length) { resetChat(jid); return; }

      // Válidos: CÓDIGO, "más", "carrito", "pagar"
      const isMas     = (t === 'mas' || t === 'más' || t === 'ver mas' || t === 'ver más' || t === 'vermas');
      const isCarrito = (t === 'carrito');
      const isPagar   = (t === 'pagar');

      // CÓDIGO → agrega 1 (silencio si el código no existe)
      const code = stripCode(raw);
      if (/^[A-Z0-9._-]{1,15}$/.test(code)) {
        const item = cache.items.find(p => stripCode(p.codigo) === code);
        if (!item) return;
        addToCart(jid, item, 1);
        await say(sock, jid, `✅ Agregado *${item.nombre}* x1.\n\nResponde: "pagar", "carrito" o "más".`);
        return;
      }

      if (isMas) {
        cache.page += 1;
        const start = cache.page * CONFIG.CATALOG.PAGE_SIZE;
        const slice = cache.items.slice(start, start + CONFIG.CATALOG.PAGE_SIZE);
        if (!slice.length) {
          await say(sock, jid, 'No hay más por mostrar. Responde "carrito" o "pagar".');
          return;
        }
        await say(sock, jid,
`${renderPage(slice)}

Respuestas válidas: CÓDIGO • "carrito" • "pagar"`);
        return;
      }

      if (isCarrito) {
        const { text, total } = cartSummary(jid);
        await say(sock, jid, `🧺 Carrito\n${text}\n\nTotal: $${money(total)}\n\nResponde: "pagar" o "más".`);
        return;
      }

      if (isPagar) {
        if (!cart(jid).length) { await say(sock, jid, 'Tu carrito está vacío. Responde con un CÓDIGO o "más".'); return; }
        ctx.sessions[jid].phase = PHASE.CHECK_TEL;
        await say(sock, jid, '📞 Paso 3️⃣: Escribe tu *teléfono* (solo números).');
        return;
      }

      // Entrada no válida → silencio
      return;
    }

    // =========================== FASE: CHECK_TEL ==========================
    if (ctx.sessions[jid].phase === PHASE.CHECK_TEL) {
      const phone = (t || '').replace(/[^0-9+]/g,'');
      if (phone.length < 7) return; // silencio si inválido
      ctx.order[jid] = { ...ctx.order[jid], tel: phone };
      ctx.sessions[jid].phase = PHASE.CHECK_DIR;
      await say(sock, jid, '📍 Paso 4️⃣: Escribe tu *dirección completa*.');
      return;
    }

    // =========================== FASE: CHECK_DIR ==========================
    if (ctx.sessions[jid].phase === PHASE.CHECK_DIR) {
      if ((raw || '').trim().length < 5) return; // silencio si inválido
      ctx.order[jid] = { ...ctx.order[jid], dir: raw.trim() };
      ctx.sessions[jid].phase = PHASE.CHECK_PAGO;
      await say(sock, jid, '💳 Paso 5️⃣: Escribe *Adelantado* o *Contraentrega*.');
      return;
    }

    // ========================== FASE: CHECK_PAGO ==========================
    if (ctx.sessions[jid].phase === PHASE.CHECK_PAGO) {
      const p = norm(raw);
      let metodo = null;
      if (p.includes('contra')) metodo = 'Contraentrega';
      if (p.includes('adelant') || p.includes('qr') || p.includes('nequi') || p.includes('bancolombia')) metodo = 'Adelantado';
      if (!metodo) return; // silencio si inválido
      ctx.order[jid] = { ...ctx.order[jid], pago: metodo };
      ctx.sessions[jid].phase = PHASE.CHECK_REF;
      await say(sock, jid, '🎁 ¿Alguien te refirió? (tel/nombre) o escribe "no".');
      return;
    }

    // =========================== FASE: CHECK_REF ==========================
    if (ctx.sessions[jid].phase === PHASE.CHECK_REF) {
      const ref = norm(raw) === 'no' ? '' : (raw || '').trim();
      ctx.order[jid] = { ...ctx.order[jid], referido: ref };

      const alcance = ctx.reach[jid] || 'resto';
      const c = cart(jid);
      const total = c.reduce((s,x)=> s + (Number(x.precio)||0)*x.cantidad, 0);

      try {
        for (const x of c) {
          await axios.post(ENDPOINTS.REGISTRAR, {
            ciudad: alcance,
            producto: `${x.nombre} x${x.cantidad}`,
            codigo: x.codigo,
            telefono: ctx.order[jid].tel,
            direccion: ctx.order[jid].dir,
            monto: (Number(x.precio)||0) * x.cantidad,
            pago: 'Pendiente',
            estado: 'Por despachar',
            observaciones: `Metodo: ${ctx.order[jid].pago}; Origen: WhatsApp`,
            referido_por: ctx.order[jid].referido || ''
          }, { headers: { 'Content-Type': 'application/json' }, timeout: 12_000 });
        }

        const label = alcance==='bogota' ? 'Bogotá' : alcance==='guajira' ? 'Guajira' : 'Otros';
        const lines = c.map(x => `• ${x.nombre} (${x.codigo}) x${x.cantidad} — $${money((Number(x.precio)||0)*x.cantidad)}`).join('\n');

        await say(sock, jid,
`🧾 Pedido registrado
📍 ${label}
${lines}
Total: $${money(total)}
📞 ${ctx.order[jid].tel}
🏠 ${ctx.order[jid].dir}
💳 ${ctx.order[jid].pago}
${ctx.order[jid].referido ? 'Ref: ' + ctx.order[jid].referido : ''}

¡Gracias! Escribe "menu" si quieres empezar de nuevo.`);

        // Notificación interna (no afecta al flujo del cliente)
        try {
          await sock.sendMessage(CONFIG.SOCIA_JID, { text:
`🔔 Nuevo pedido
Ciudad: ${alcance}
${lines}
Total: $${money(total)}
Tel: ${ctx.order[jid].tel}
Dir: ${ctx.order[jid].dir}
Pago: ${ctx.order[jid].pago}
Ref: ${ctx.order[jid].referido || 'N/A'}`});
        } catch {}

        resetChat(jid);
      } catch (e) {
        console.error('[registrar] error:', e.message);
        await say(sock, jid, '❌ No pude registrar el pedido. Intenta en unos minutos con "menu".');
        resetChat(jid);
      }
      return;
    }

    // ========================= Fallback controlado ========================
    if (t === 'menu') {
      resetChat(jid);
      await say(sock, jid, 'Menú reiniciado.\nResponde 1) Bogotá  2) Guajira  3) Otros');
    }
    // Cualquier otro input fuera de fase → silencio.
  });
}

// ================================ Boot ====================================
(async () => {
  try { await startBot(); }
  catch (e) { console.error('❌ Error al iniciar:', e); process.exit(1); }
})();