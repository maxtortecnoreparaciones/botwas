/**
 * index.js — WhatsApp Bot para Service Store VIP
 *
 * Mejoras adaptadas del bot de la heladería:
 * - Se implementa un manejo de errores más robusto en cada fase de la conversación.
 * - Se añade la funcionalidad de 'editar' el pedido, el carrito y los datos de entrega.
 * - Se incorpora un flujo para "Pedidos por encargo" o personalizados.
 * - Se mejora la lógica de redireccionamiento para términos clave como 'editar', 'menú', etc.
 * - Se añade una simulación de escritura ('composing') para una mejor experiencia de usuario.
 */

'use strict';

// ============================== Dependencias (ÚNICA) ==============================
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

const qrcode = require('qrcode-terminal');
const axios = require('axios');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ================================ Config ==================================
const CONFIG = {
    ADMIN_JID: '573138777115@s.whatsapp.net',
    SOCIA_JID: '573138777115@s.whatsapp.net',
    API_BASE: 'http://127.0.0.1:8001/api',
    TIME: {
        MENU_COOLDOWN_MS: 45_000,
        WRITING_SIMULATION_MS: 3000
    },
    LOG_LEVEL: 'info',
};

const ENDPOINTS = {
    REGISTRAR_CONFIRMACION: `${CONFIG.API_BASE}/registrar_confirmacion/`,
    LISTAR_CATEGORIAS: `${CONFIG.API_BASE}/listar_categorias/`,
    LISTAR_PRODUCTOS: `${CONFIG.API_BASE}/listar_productos_por_categoria/`,
    BUSCAR_PRODUCTO: `${CONFIG.API_BASE}/buscar_producto_por_nombre/`,
};

// ================================ Estado ==================================
const PHASE = Object.freeze({
    MENU_PRINCIPAL: 'menu_principal',
    SELECCION_CATEGORIA: 'seleccion_categoria',
    SELECCION_PRODUCTO: 'seleccion_producto',
    CHECK_TEL: 'checkout_tel',
    CHECK_DIR: 'checkout_dir',
    CHECK_NAME: 'checkout_name',
    CHECK_PAGO: 'checkout_pago',
    CONFIRM_ORDER: 'confirm_order',
    EDIT_OPTIONS: 'edit_options',
    EDIT_CART_SELECTION: 'edit_cart_selection',
    CONSULTA_ESPECIAL: 'consulta_especial'
});

const ctx = {
    sessions: Object.create(null),
    carts: Object.create(null),
    order: Object.create(null),
    lastSent: Object.create(null),
    categories: null,
};

let botEnabled = true;

// ============================== Utilidades ================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function norm(s = '') {
    return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function money(n) {
    try {
        const num = Number(n);
        if (isNaN(num)) return '0';
        return num.toLocaleString('es-CO');
    } catch {
        return '0';
    }
}

function getText(msg) {
    const m0 = msg?.message || {};
    const inner = m0.ephemeralMessage?.message || m0.viewOnceMessageV2?.message || m0.viewOnceMessageV2Extension?.message || m0.deviceSentMessage?.message || m0;
    return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || inner.listResponseMessage?.title || inner.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}

function isGreeting(t = '') {
    return /^(hola+|buenas|que tal|hey|hello)\b/.test(t || '');
}

function wantsMenu(t = '') {
    const n = norm(t);
    return n.includes('menu') || n.includes('carta') || n.includes('pedir');
}

function resetChat(jid) {
    ctx.sessions[jid] = { phase: PHASE.MENU_PRINCIPAL, lastPromptAt: 0, category: null, orderProcessed: false, isEditing: false };
    ctx.carts[jid] = [];
    ctx.order[jid] = {};
    ctx.lastSent[jid] = '';
}

function cart(jid) {
    if (!ctx.carts[jid]) ctx.carts[jid] = [];
    return ctx.carts[jid];
}

function addToCart(jid, item, quantity = 1) {
    const c = cart(jid);
    const existingItemIndex = c.findIndex(x => x.codigo === item.codigo);
    if (existingItemIndex !== -1) {
        c[existingItemIndex].cantidad += quantity;
    } else {
        c.push({
            codigo: item.codigo,
            nombre: item.nombre,
            precio: item.precio,
            cantidad: quantity
        });
    }
}

function cartSummary(jid) {
    const c = cart(jid);
    if (!c.length) return { text: 'Tu carrito está vacío. ¡Vamos a llenarlo! 😉', total: 0 };
    const lines = c.map((x, i) => `*${i + 1}.* ${x.nombre} x${x.cantidad} — COP$${money(x.precio * x.cantidad)}`);
    const total = c.reduce((s, x) => s + x.precio * x.cantidad, 0);
    return { text: lines.join('\n'), total };
}

async function showOrderSummary(sock, jid) {
    const { text, total } = cartSummary(jid);
    const orderData = ctx.order[jid];
    
    const mensaje = `📝 **Resumen del pedido**
    
*Productos:*
${text}
*Total:* COP$${money(total)}

*Datos de entrega*
👤 Nombre: ${orderData.name}
📞 Teléfono: ${orderData.tel}
🏠 Dirección: ${orderData.dir}
💳 Pago: ${orderData.pago}

_¿Está todo correcto?_
_Escribe **confirmar** para finalizar, o **editar** para cambiar algún dato._
_Para cancelar y volver al inicio, escribe **menú**._`;

    await say(sock, jid, mensaje);
    ctx.sessions[jid].phase = PHASE.CONFIRM_ORDER;
}

// ============================== LOGICA ADAPTADA ================================
async function say(sock, jid, text) {
    if (ctx.lastSent[jid] === text) return;
    ctx.lastSent[jid] = text;
    
    console.log(`✅ Enviando respuesta a ${jid}: "${text.split('\n')[0]}..."`);
    
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(CONFIG.TIME.WRITING_SIMULATION_MS);
    await sock.sendMessage(jid, { text });
    await sock.sendPresenceUpdate('paused', jid);
}

// ================================ Núcleo ==================================
async function startBot() {
    const log = pino({ level: CONFIG.LOG_LEVEL });

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
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('Escanea el QR con tu teléfono');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            const me = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
            console.log('✅ Conectado como', me);
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut && code !== 401;
            console.log('Conexión cerrada. Intentando reconectar...');
            if (shouldReconnect) {
                setTimeout(() => startBot().catch(() => {}), 3000); 
            } else {
                console.log('❌ Sesión cerrada por el usuario. Eliminando archivos de autenticación.');
                try { 
                    fs.rmSync('baileys_auth', { recursive: true, force: true }); 
                } catch (e) {
                    console.error('Error al eliminar los archivos de sesión:', e.message);
                }
                setTimeout(() => startBot().catch(() => {}), 500);
            }
        }
    });

    try {
        const { data } = await axios.get(ENDPOINTS.LISTAR_CATEGORIAS);
        if (data.error) {
            console.error('❌ Error al cargar categorías al iniciar:', data);
        } else {
            ctx.categories = data;
            console.log('✅ Categorías cargadas con éxito.');
        }
    } catch (e) {
        console.error('❌ Error al cargar categorías al iniciar:', e.response?.data || e.message);
    }
    
    // ============================ Handler principal =========================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!['notify', 'append', 'replace'].includes(type)) return;
        const msg = messages?.[0];
        if (!msg || msg.key?.fromMe) return;
        
        const jid = msg.key.remoteJid;
        const number = jid.split('@')[0];
        if (jid.endsWith('@g.us') || number.length > 15) return;

        const raw = getText(msg);
        if (!raw) return;
        
        const t = norm(raw);
        
        const now = new Date();
        const formattedTime = now.toLocaleString('es-CO', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).replace(',', '');
        console.log(`[${formattedTime}] 📨 { jid: '${jid}', phase: '${ctx.sessions[jid]?.phase || 'N/A'}', raw: '${raw}' }`);

        if (jid === CONFIG.ADMIN_JID) {
            if (t === 'apagado') {
                botEnabled = false;
                await say(sock, jid, '✅ Bot apagado. No responderé a otros usuarios.');
                return;
            }
            if (t === 'encendido') {
                botEnabled = true;
                await say(sock, jid, '✅ Bot encendido. Estoy listo para atender.');
                return;
            }
        }

        if (!botEnabled && jid !== CONFIG.ADMIN_JID) return;

        if (!ctx.sessions[jid]) resetChat(jid);
        const phase = ctx.sessions[jid].phase;
        
        // Manejo de comandos globales
        if (t === 'menu' || t === 'inicio') {
            resetChat(jid);
            await say(sock, jid, '↩️ Volviste al inicio.');
        }

        if (t === 'carrito') {
            const { text, total } = cartSummary(jid);
            await say(sock, jid, `🧺 *Tu carrito*
${text}
*Total:* COP$${money(total)}
_Responde **pagar** o el nombre de otro producto para seguir comprando._
_Si quieres modificar un producto, escribe **editar**._`);
            ctx.sessions[jid].phase = PHASE.SELECCION_PRODUCTO;
            return;
        }

        if (t === 'pagar') {
            if (!cart(jid).length) {
                await say(sock, jid, 'Tu carrito está vacío. Por favor, escribe el nombre del producto para agregarlo.');
                return;
            }
            ctx.sessions[jid].isEditing = false;
            ctx.sessions[jid].phase = PHASE.CHECK_TEL;
            await say(sock, jid, '📞 *Paso 1:* Para los datos de entrega, escribe tu *número de teléfono* (solo números).');
            return;
        }

        if (t === 'editar') {
            ctx.sessions[jid].isEditing = true;
            ctx.sessions[jid].phase = PHASE.EDIT_OPTIONS;
            await say(sock, jid, `📝 *¿Qué deseas editar?*
*1)* Teléfono
*2)* Dirección
*3)* Nombre
*4)* Forma de pago
*5)* Carrito
*6)* Finalizar (confirma el pedido)
_Escribe el número de la opción o **finalizar** para continuar._`);
            return;
        }

        // --- Lógica de redireccionamiento para consultas especiales ---
        const specialKeywords = ['instalacion', 'instalaciones', 'reparacion', 'reparaciones', 'mantenimiento', 'mantenimientos', 'encargo'];
        if (specialKeywords.some(keyword => t.includes(keyword)) && phase !== PHASE.CONSULTA_ESPECIAL) {
            await say(sock, jid, `¡Claro! Con gusto te ayudamos con tu solicitud especial. Por favor, describe con detalle el servicio que necesitas.
_Ej: Necesito una instalación de un equipo de 65 pulgadas en un soporte de pared._`);
            ctx.sessions[jid].phase = PHASE.CONSULTA_ESPECIAL;
            return;
        }
        
        // --- Flujo de conversación ---
        switch (phase) {
            case PHASE.MENU_PRINCIPAL:
                if (isGreeting(t)) {
                    await say(sock, jid, `¡Hola! 👋 Bienvenido a **Service Store VIP**.

*1)* 🛍️ **Ver catálogo de productos**
*2)* 📍 **Soporte técnico**
*3)* 🌐 **Consultas especiales y ventas personalizadas**

_Escribe el número de la opción._`);
                    ctx.sessions[jid].phase = PHASE.SELECCION_CATEGORIA;
                    return;
                }
                break;

            case PHASE.SELECCION_CATEGORIA:
                const option = parseInt(t);
                if (option === 1) {
                    if (!ctx.categories) {
                        await say(sock, jid, '❌ Lo siento, no pude cargar el catálogo en este momento. Intenta de nuevo más tarde.');
                        resetChat(jid);
                        return;
                    }
                    const list = ctx.categories.map((c, i) => `*${i + 1}.* ${c.Nombre}`).join('\n');
                    await say(sock, jid, `Por favor, elige una categoría para ver nuestros productos:
${list}
_Escribe el número o el nombre de la categoría._`);
                    ctx.sessions[jid].phase = PHASE.SELECCION_PRODUCTO;
                    return;
                } else if (option === 2) {
                    await say(sock, jid, `Para soporte técnico y dudas sobre productos, por favor contáctanos directamente:
📞 **+57 313 693 9663**
_Horario de atención: 9 AM - 6 PM_
_Si quieres hacer un pedido, escribe **menú**._`);
                    resetChat(jid);
                    return;
                } else if (option === 3) {
                    await say(sock, jid, `¡Claro! Con gusto te ayudamos. Por favor, describe con detalle tu necesidad (instalación, reparación, venta personalizada, etc.).`);
                    ctx.sessions[jid].phase = PHASE.CONSULTA_ESPECIAL;
                    return;
                }
                await say(sock, jid, '❌ Opción no válida. Por favor, elige 1, 2 o 3.');
                break;

            case PHASE.SELECCION_PRODUCTO:
                const selectedCategory = ctx.categories[parseInt(t) - 1] || ctx.categories.find(c => norm(c.Nombre) === t);
                
                if (selectedCategory) {
                    ctx.sessions[jid].category = selectedCategory.Nombre;
                    try {
                        const { data } = await axios.get(ENDPOINTS.LISTAR_PRODUCTOS, { params: { categoria: selectedCategory.Nombre } });
                        if (data.error || !Array.isArray(data.productos) || data.productos.length === 0) {
                            throw new Error('No se encontraron productos.');
                        }
                        const list = data.productos.map((p, i) => `*${i + 1}.* ${p.NombreProducto} — COP$${money(p.Precio_Venta)}`).join('\n');
                        await say(sock, jid, `Aquí están los productos en la categoría *${selectedCategory.Nombre}*:
${list}
_Escribe el número o el nombre del producto que deseas agregar a tu carrito._`);
                        ctx.sessions[jid].phase = 'select_product';
                        ctx.sessions[jid].products = data.productos;
                    } catch (e) {
                        console.error('Error al listar productos:', e.message);
                        await say(sock, jid, '❌ No pude cargar los productos de esa categoría. Por favor, elige otra o intenta de nuevo más tarde.');
                        ctx.sessions[jid].phase = PHASE.SELECCION_CATEGORIA;
                    }
                } else {
                    await say(sock, jid, '❌ Categoría no válida. Por favor, elige el número o nombre de la categoría.');
                }
                break;

            case 'select_product':
                const productList = ctx.sessions[jid].products;
                let selectedProduct = null;
                const productSelection = parseInt(t);
                
                if (!isNaN(productSelection) && productSelection > 0 && productSelection <= productList.length) {
                    selectedProduct = productList[productSelection - 1];
                } else {
                    selectedProduct = productList.find(p => norm(p.NombreProducto) === t);
                }

                if (selectedProduct) {
                    addToCart(jid, {
                        codigo: selectedProduct.CodigoProducto,
                        nombre: selectedProduct.NombreProducto,
                        precio: selectedProduct.Precio_Venta
                    });
                    await say(sock, jid, `✅ ¡Agregado *${selectedProduct.NombreProducto}* a tu carrito!
_Escribe **pagar**, **carrito** o el nombre de otro producto para seguir comprando._`);
                    ctx.sessions[jid].phase = PHASE.SELECCION_PRODUCTO;
                } else {
                    await say(sock, jid, '❌ Producto no válido. Por favor, elige el número o nombre del producto de la lista.');
                }
                break;
            
            case PHASE.CHECK_TEL:
                const phone = (t || '').replace(/[^0-9+]/g, '');
                if (phone.length < 7) {
                    await say(sock, jid, '❌ Número no válido. Por favor, escribe un número de teléfono completo.');
                    return;
                }
                ctx.order[jid] = { ...ctx.order[jid], tel: phone };
                ctx.sessions[jid].phase = PHASE.CHECK_DIR;
                await say(sock, jid, '📍 *Paso 2:* Ahora escribe tu *dirección completa*.');
                break;

            case PHASE.CHECK_DIR:
                if ((raw || '').trim().length < 5) {
                    await say(sock, jid, '❌ Dirección no válida. Por favor, escribe la dirección completa.');
                    return;
                }
                ctx.order[jid] = { ...ctx.order[jid], dir: raw.trim() };
                ctx.sessions[jid].phase = PHASE.CHECK_NAME;
                await say(sock, jid, '👤 *Paso 3:* ¿A nombre de quién va el pedido? Escribe el *nombre completo*.');
                break;

            case PHASE.CHECK_NAME:
                if ((raw || '').trim().length < 3) {
                    await say(sock, jid, '❌ Nombre no válido. Por favor, escribe tu nombre completo.');
                    return;
                }
                ctx.order[jid] = { ...ctx.order[jid], name: raw.trim() };
                ctx.sessions[jid].phase = PHASE.CHECK_PAGO;
                await say(sock, jid, '💳 *Paso 4:* ¿Cómo vas a pagar? Escribe *Transferencia* o *Efectivo*.');
                break;

            case PHASE.CHECK_PAGO:
                const p = norm(raw);
                let metodo = null;
                if (p.includes('efectivo') || p.includes('contra')) metodo = 'Efectivo';
                if (p.includes('transferencia') || p.includes('adelant') || p.includes('nequi') || p.includes('bancolombia')) metodo = 'Transferencia';
                
                if (!metodo) {
                    await say(sock, jid, '❌ Opción de pago no válida. Por favor, escribe *Transferencia* o *Efectivo*.');
                    return;
                }
                ctx.order[jid] = { ...ctx.order[jid], pago: metodo };
                await showOrderSummary(sock, jid);
                break;

            case PHASE.CONFIRM_ORDER:
                if (t === 'confirmar') {
                    if (ctx.sessions[jid].orderProcessed) {
                        console.log('Orden ya procesada, ignorando mensaje duplicado.');
                        return;
                    }
                    
                    const c = cart(jid);
                    const total = c.reduce((s, x) => s + x.precio * x.cantidad, 0);
                    
                    const pedidoCompleto = {
                        nombre: ctx.order[jid].name || 'N/A',
                        telefono: ctx.order[jid].tel,
                        direccion: ctx.order[jid].dir,
                        producto: c.map(x => `${x.nombre} x${x.cantidad}`).join('; '),
                        codigo: c.map(x => x.codigo).join('; '),
                        monto: total,
                        pago: ctx.order[jid].pago,
                        estado: 'Por despachar',
                        observaciones: `Origen: WhatsApp`
                    };

                    try {
                        const response = await axios.post(ENDPOINTS.REGISTRAR_CONFIRMACION, pedidoCompleto, { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 });
                        if (response.data.ok) {
                            ctx.sessions[jid].orderProcessed = true;
                            await say(sock, jid, `🥳 ¡Gracias por tu compra! Tu pedido ha sido registrado con éxito.
*Pronto te contactaremos para confirmar la entrega y el costo del domicilio, si aplica.*
*¡Pronto te contactaremos para confirmar la entrega!*

Si quieres empezar de nuevo, solo escribe *menú*.`);
                            try {
                                await sock.sendMessage(CONFIG.SOCIA_JID, {
                                    text: `🔔 Nuevo pedido
Cliente: ${ctx.order[jid].name}
Tel: ${ctx.order[jid].tel}
Dir: ${ctx.order[jid].dir}
Pago: ${ctx.order[jid].pago}
Productos: ${pedidoCompleto.producto}
Total: COP$${money(total)}`
                                });
                            } catch {}
                        } else {
                            throw new Error(response.data.error || 'Error desconocido al registrar.');
                        }
                        resetChat(jid);
                    } catch (e) {
                        console.error('[registrar] error:', e.response?.data || e.message);
                        await say(sock, jid, '❌ Lo siento, no pude registrar el pedido. Intenta de nuevo en unos minutos escribiendo *menu*.');
                        resetChat(jid);
                    }
                } else if (t === 'editar') {
                    ctx.sessions[jid].isEditing = true;
                    ctx.sessions[jid].phase = PHASE.EDIT_OPTIONS;
                    await say(sock, jid, `📝 *¿Qué deseas editar?*
*1)* Teléfono
*2)* Dirección
*3)* Nombre
*4)* Forma de pago
*5)* Carrito
*6)* Finalizar (confirma el pedido)
_Escribe el número de la opción o **finalizar** para continuar._`);
                } else {
                    await say(sock, jid, '❌ Opción no válida. Por favor, escribe **confirmar** para enviar tu pedido o **editar** para cambiar algún dato.');
                }
                break;

            case PHASE.EDIT_OPTIONS:
                const editMap = {
                    '1': 'tel', '2': 'dir', '3': 'name', '4': 'pago', '5': 'carrito'
                };
                
                if (t === '6' || t.includes('finalizar')) {
                    ctx.sessions[jid].isEditing = false;
                    await showOrderSummary(sock, jid);
                    return;
                }

                if (editMap[t]) {
                    const editKey = editMap[t];
                    ctx.sessions[jid].phase = `checkout_${editKey}`;
                    const messages = {
                        'tel': '📞 Escribe el nuevo *número de teléfono*.',
                        'dir': '📍 Escribe la nueva *dirección completa*.',
                        'name': '👤 Escribe el nuevo *nombre completo*.',
                        'pago': '💳 Escribe la nueva forma de pago: *Transferencia* o *Efectivo*.',
                        'carrito': '🛒 Escribe el número del producto que deseas editar de tu carrito:'
                    };

                    if (editKey === 'carrito') {
                        if (cart(jid).length === 0) {
                            await say(sock, jid, 'Tu carrito está vacío. No hay nada para editar. Por favor, añade un producto primero.');
                            ctx.sessions[jid].phase = PHASE.SELECCION_CATEGORIA;
                            return;
                        }
                        const { text } = cartSummary(jid);
                        await say(sock, jid, `${messages[editKey]}\n${text}`);
                    } else {
                        await say(sock, jid, messages[editKey]);
                    }
                } else {
                    await say(sock, jid, '❌ Opción no válida. Por favor, elige un número de la lista.');
                }
                break;
            
            case PHASE.CONSULTA_ESPECIAL:
                const consultaMsg = `🛠️ **Nueva Consulta Especial**
*Cliente:* ${jid.split('@')[0]}
*Teléfono:* ${jid.split('@')[0]}
*Descripción:* ${raw}`;
                
                await sock.sendMessage(CONFIG.SOCIA_JID, { text: consultaMsg });
                await say(sock, jid, `✅ ¡Perfecto! Tu consulta ha sido enviada. Uno de nuestros asesores te contactará pronto para darte una atención personalizada.

✨ *¡Gracias por elegirnos!*
Si quieres hacer un pedido, solo escribe *menú*.`);
                resetChat(jid);
                break;

            default:
                await say(sock, jid, '❌ Lo siento, no entendí. Por favor, escribe **menú** para ver las opciones disponibles.');
                break;
        }
    });
}

(async () => {
    try {
        await startBot();
    } catch (e) {
        console.error('❌ Error al iniciar el bot:', e);
        process.exit(1);
    }
})();