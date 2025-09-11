/**
 * index.js — WhatsApp Bot para Venta de Accesorios de Celular con Integración de IA de Gemini
 *
 * Mejoras clave:
 * - Se ha añadido una validación más robusta para ignorar cualquier tipo de chat que no sea un chat personal (@s.whatsapp.net).
 * - **CORRECCIÓN DE ERRORES CRÍTICOS:** El bot ahora ignora mensajes de cortesía comunes ("gracias", "ok", "listo") para evitar respuestas innecesarias.
 * - **NUEVA FUNCIONALIDAD:** Se ha añadido una función para pausar el bot por un tiempo determinado (ej. "yo continuo en 1h").
 * - **MEJORA DE LA IA:** Ahora, el bot lee un archivo JSON (`ai_knowledge_base.json`) para un entrenamiento más escalable de la IA, lo que le permite manejar objeciones y consultas de forma más inteligente.
 */

'use strict';

// ============================== Dependencias ==============================
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
    GEMINI_API_KEY: 'AIzaSyDcCtduUUZBe2rL7ETNKxA9HpTi4Vj96AA', // Reemplaza con tu API Key
    ADMIN_JID: '573138777115@s.whatsapp.net',
    SOCIA_JID: '573138777115@s.whatsapp.net',
    API_BASE: 'http://127.0.0.1:8000/api',
    TIME: {
        MENU_COOLDOWN_MS: 45_000,
        WRITING_SIMULATION_MS: 3000
    },
    LOG_LEVEL: 'info',
};

const ENDPOINTS = {
    REGISTRAR_CONFIRMACION: `${CONFIG.API_BASE}/registrar_confirmacion/`,
    LISTAR_CATEGORIAS: `${CONFIG.API_BASE}/consultar_productos_gsheet/`,
    LISTAR_PRODUCTOS: `${CONFIG.API_BASE}/consultar_productos_gsheet/`,
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
    CONSULTA_ESPECIAL: 'consulta_especial',
    SELECCION_CIUDAD: 'seleccion_ciudad'
});

const ctx = {
    sessions: Object.create(null),
    carts: Object.create(null),
    order: Object.create(null),
    lastSent: Object.create(null),
    categories: null,
    allProducts: null,
};

let botEnabled = true;
let botPauseUntil = 0;
let aiKnowledgeBase = {};

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

function parsePrice(s) {
    if (typeof s === 'number') return s;
    const cleanStr = String(s || '').replace(/[^0-9,-]/g, '').replace(',', '.');
    return parseFloat(cleanStr);
}

function getDeliveryCost(dir) {
    return 3000;
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
    return n.includes('menu') || n.includes('catalogo') || n.includes('pedir');
}

function resetChat(jid) {
    ctx.sessions[jid] = { phase: PHASE.MENU_PRINCIPAL, lastPromptAt: 0, category: null, orderProcessed: false, isEditing: false, city: null };
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
            precio: item.precio
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


// ======================= MÓDULO DE IA DE GEMINI ========================
async function askGemini(rawMessage, context) {
    if (!CONFIG.GEMINI_API_KEY) {
        console.warn('⚠️ GEMINI_API_KEY no está configurada.');
        return 'Lo siento, el asistente de IA no está disponible en este momento. Por favor, intenta de nuevo más tarde o escribe **menú** para reiniciar el proceso.';
    }

    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
    
    // Obtener la respuesta de la base de conocimiento JSON si las palabras clave coinciden
    let responseFromKB = null;
    const normalizedMessage = norm(rawMessage);

    for (const item of aiKnowledgeBase.sales_objections) {
        if (item.keywords.some(keyword => normalizedMessage.includes(keyword))) {
            responseFromKB = item.response_template;
            break;
        }
    }

    // Si encontramos una respuesta relevante en la base de conocimiento, la usamos.
    if (responseFromKB) {
        console.log(`🧠 KB Response: ${responseFromKB}`);
        return responseFromKB;
    }

    // Si no hay una respuesta en la base de conocimiento, pedimos a la IA que genere una
    const prompt = `
    Eres un asistente de ventas de una tienda de accesorios de celular llamada "Service Store VIP". Tu función es ayudar a los clientes con sus pedidos y responder preguntas sobre los productos y servicios.
    El cliente está en la siguiente fase de la conversación: ${context.phase}.
    El mensaje del cliente es: "${rawMessage}".

    --- Contexto Adicional ---
    Categorías disponibles: ${ctx.categories ? ctx.categories.map(c => c.Nombre).join(', ') : 'No disponible'}.
    Productos en el carrito: ${cartSummary(context.jid).text}.
    Teléfono de contacto: +57 313 693 9663.
    
    ---
    
    Responde de manera concisa y natural. Si la pregunta es sobre compatibilidad, disponibilidad o servicios adicionales, usa la información anterior. Si es un saludo, responde amablemente. Si no puedes ayudar, guía al usuario a escribir "menú" o a continuar con el flujo de compra.
    
    Ejemplo de respuesta si preguntan por un accesorio: "Sí, tenemos ese accesorio. ¿Qué modelo de celular tienes?".
    Ejemplo si preguntan por un servicio que no ofreces: "Por el momento no ofrecemos ese servicio, pero podemos ayudarte con {servicio1}, {servicio2}, etc. ¿Te gustaría ver nuestro catálogo?".
    `.trim();

    try {
        const response = await axios.post(API_URL, {
            contents: [{
                parts: [{ text: prompt }]
            }]
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10_000
        });

        const generatedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (generatedText) {
            console.log(`🧠 AI Response: ${generatedText}`);
            const recoveryPrompt = `\n_Escribe *pagar*, *carrito* o el nombre de otro producto para seguir comprando._`;
            return generatedText + recoveryPrompt;
        } else {
            throw new Error('No se generó texto de la IA.');
        }

    } catch (e) {
        console.error('❌ Error al llamar a la API de Gemini:', e.response?.data || e.message);
        return 'Lo siento, no pude procesar tu solicitud en este momento. Por favor, intenta de nuevo o escribe **menú** para reiniciar.';
    }
}
// ================================ Núcleo ==================================
async function startBot() {
    const log = pino({ level: CONFIG.LOG_LEVEL });

    try {
        aiKnowledgeBase = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'ai_knowledge_base.json')));
        console.log('✅ Base de conocimiento de IA cargada.');
    } catch (e) {
        console.error('❌ Error al cargar la base de conocimiento de la IA:', e.message);
    }

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
            const uniqueCategories = [...new Set(data.map(p => p.categoria))].map(c => ({ Nombre: c }));
            ctx.categories = uniqueCategories;
            ctx.allProducts = data; // Guardamos la lista completa de productos
            console.log('✅ Catálogo cargado con éxito.');
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

        // ======================= CORRECCIÓN DE BUGS DE MENSAJES NO PERSONALES =======================
        if (!jid.endsWith('@s.whatsapp.net')) {
            console.log(`[${new Date().toLocaleString('es-CO')}] 🚫 Ignorando mensaje de tipo: ${jid}`);
            return;
        }
        
        const number = jid.split('@')[0];
        if (number.length > 15) return;

        const raw = getText(msg);
        if (!raw) return;
        
        const t = norm(raw);
        
        const now = new Date();
        if (botPauseUntil > now.getTime() && jid !== CONFIG.ADMIN_JID) {
            console.log(`🚫 Bot pausado temporalmente. Ignorando mensaje de ${jid}.`);
            return;
        }

        const formattedTime = now.toLocaleString('es-CO', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).replace(',', '');
        console.log(`[${formattedTime}] 📨 { jid: '${jid}', phase: '${ctx.sessions[jid]?.phase || 'N/A'}', raw: '${raw}' }`);

        if (jid === CONFIG.ADMIN_JID) {
            const pauseMatch = t.match(/yo continuo por (\d+) (minutos|horas|min|h)/);
            if (pauseMatch) {
                const amount = parseInt(pauseMatch[1]);
                const unit = pauseMatch[2];
                let ms = 0;
                if (unit === 'minutos' || unit === 'min') ms = amount * 60 * 1000;
                if (unit === 'horas' || unit === 'h') ms = amount * 60 * 60 * 1000;
                
                if (ms > 0) {
                    botPauseUntil = now.getTime() + ms;
                    await say(sock, jid, `✅ Bot pausado. No responderé a otros usuarios hasta ${new Date(botPauseUntil).toLocaleString('es-CO')}.`);
                    return;
                }
            }
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
        const sesion = ctx.sessions[jid];
        const phase = sesion.phase;

        const simplePhrases = ['gracias', 'ok', 'listo', 'perfecto', 'dale', 'genial'];
        if (simplePhrases.includes(t)) {
            await say(sock, jid, '¡De nada! ¿En qué más te puedo ayudar?');
            return;
        }

        const isResponseExpected = (() => {
            switch (phase) {
                case PHASE.MENU_PRINCIPAL:
                    return isGreeting(t) || ['1', '2', '3'].includes(t);
                case PHASE.SELECCION_CIUDAD:
                    return ['bogota', 'riohacha'].includes(t);
                case PHASE.SELECCION_CATEGORIA:
                    return ctx.categories?.some(c => norm(c.Nombre) === t) || !isNaN(parseInt(t)) || (ctx.allProducts && ctx.allProducts.some(p => norm(p.nombre).includes(t)));
                case PHASE.SELECCION_PRODUCTO:
                    return sesion.products?.some(p => norm(p.nombre) === t) || !isNaN(parseInt(t));
                case PHASE.CHECK_TEL:
                    return (t || '').replace(/[^0-9+]/g, '').length >= 7;
                case PHASE.CHECK_DIR:
                    return (t || '').trim().length >= 5;
                case PHASE.CHECK_NAME:
                    return (t || '').trim().length >= 3;
                case PHASE.CHECK_PAGO:
                    return ['transferencia', 'efectivo', 'pago'].includes(t);
                case PHASE.CONFIRM_ORDER:
                    return ['confirmar', 'editar', 'menu'].includes(t);
                case PHASE.EDIT_OPTIONS:
                    return ['1', '2', '3', '4', '5', '6', 'finalizar'].includes(t);
                case PHASE.EDIT_CART_SELECTION:
                    const selection = parseInt(t);
                    return !isNaN(selection) && selection > 0 && selection <= cart(jid).length;
                default:
                    return false;
            }
        })();

        if (!isResponseExpected && (t !== 'menu' && t !== 'inicio' && t !== 'carrito' && t !== 'pagar' && t !== 'editar')) {
            const aiResponse = await askGemini(raw, { phase, jid, categories: ctx.categories });
            await say(sock, jid, aiResponse);
            return;
        }

        // --- Flujo normal del bot (si la respuesta fue esperada) ---
        if (t === 'menu' || t === 'inicio') {
            resetChat(jid);
            await say(sock, jid, '↩️ Volviste al inicio.');
            return;
        }

        if (t === 'carrito') {
            const { text, total } = cartSummary(jid);
            await say(sock, jid, `🧺 *Tu carrito*
${text}
*Total:* COP$${money(total)}
_Responde **pagar** o el nombre de otro producto para seguir comprando._
_Si quieres modificar un producto, escribe **editar**._`);
            sesion.phase = PHASE.SELECCION_PRODUCTO;
            return;
        }

        if (t === 'pagar') {
            if (!cart(jid).length) {
                await say(sock, jid, 'Tu carrito está vacío. Por favor, escribe el nombre del producto para agregarlo.');
                return;
            }
            sesion.isEditing = false;
            sesion.phase = PHASE.CHECK_TEL;
            await say(sock, jid, '📞 *Paso 1:* Para los datos de entrega, escribe tu *número de teléfono* (solo números).');
            return;
        }

        if (t === 'editar') {
            sesion.isEditing = true;
            sesion.phase = PHASE.EDIT_OPTIONS;
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
        
        const specialKeywords = ['instalacion', 'reparacion', 'mantenimiento', 'encargo'];
        if (specialKeywords.some(keyword => t.includes(keyword)) && phase !== PHASE.CONSULTA_ESPECIAL) {
            await say(sock, jid, `¡Claro! Con gusto te ayudamos con tu solicitud especial. Por favor, describe con detalle el servicio que necesitas.`);
            sesion.phase = PHASE.CONSULTA_ESPECIAL;
            return;
        }
        
        switch (phase) {
            case PHASE.MENU_PRINCIPAL:
                if (isGreeting(t) || ['1', '2', '3'].includes(t)) {
                    if (isGreeting(t)) {
                        await say(sock, jid, `¡Hola! 👋 Bienvenido a **Service Store VIP**.
*1)* 🛍️ **Ver catálogo de productos**
*2)* 📍 **Soporte técnico**
*3)* 🌐 **Consultas especiales y ventas personalizadas**
_Escribe el número de la opción._`);
                    } else if (t === '1') {
                        await say(sock, jid, 'Para ofrecerte el inventario disponible en tu zona, por favor, dime si te encuentras en **Bogotá** o **Riohacha**.');
                        sesion.phase = PHASE.SELECCION_CIUDAD;
                    } else if (t === '2') {
                        await say(sock, jid, `Para soporte técnico, por favor contáctanos directamente:
📞 **+57 313 693 9663**
_Horario de atención: 9 AM - 6 PM_
_Si quieres hacer un pedido, escribe **menú**._`);
                        resetChat(jid);
                    } else if (t === '3') {
                        await say(sock, jid, `¡Claro! Con gusto te ayudamos. Por favor, describe con detalle tu necesidad (instalación, reparación, venta personalizada, etc.).`);
                        sesion.phase = PHASE.CONSULTA_ESPECIAL;
                    }
                }
                break;

            case PHASE.SELECCION_CIUDAD:
                const city = norm(t);
                if (['bogota', 'riohacha'].includes(city)) {
                    sesion.city = city;
                    if (!ctx.categories) {
                        await say(sock, jid, '❌ Lo siento, no pude cargar el catálogo. Intenta de nuevo más tarde.');
                        resetChat(jid);
                        return;
                    }
                    const list = ctx.categories.map((c, i) => `*${i + 1}.* ${c.Nombre}`).join('\n');
                    await say(sock, jid, `Por favor, elige una categoría para ver nuestros productos en *${city.charAt(0).toUpperCase() + city.slice(1)}*:
${list}
_Escribe el número o el nombre de la categoría._`);
                        sesion.phase = PHASE.SELECCION_CATEGORIA;
                } else {
                    await say(sock, jid, 'Por favor, elige una de las ciudades disponibles: **Bogotá** o **Riohacha**.');
                }
                break;
            
            case PHASE.SELECCION_CATEGORIA:
                const selectedCategory = ctx.categories[parseInt(t) - 1] || ctx.categories.find(c => norm(c.Nombre) === t);
                
                const availableProducts = ctx.allProducts.filter(p => norm(p.ciudad) === norm(sesion.city));
                
                if (selectedCategory) {
                    sesion.category = selectedCategory.Nombre;
                    try {
                        const productsInCategory = availableProducts.filter(p => norm(p.categoria) === norm(selectedCategory.Nombre));
                        if (productsInCategory.length === 0) {
                            throw new Error('No se encontraron productos.');
                        }
                        const list = productsInCategory.map((p, i) => `*${i + 1}.* ${p.nombre} — COP$${money(p.precio)}`).join('\n');
                        await say(sock, jid, `Aquí están los productos en la categoría *${selectedCategory.Nombre}* en *${sesion.city.charAt(0).toUpperCase() + sesion.city.slice(1)}*:
${list}
_Escribe el número o el nombre del producto que deseas agregar a tu carrito._`);
                        sesion.phase = PHASE.SELECCION_PRODUCTO;
                        sesion.products = productsInCategory;
                    } catch (e) {
                        console.error('Error al listar productos:', e.message);
                        await say(sock, jid, '❌ No pude cargar los productos de esa categoría. Por favor, elige otra o intenta de nuevo más tarde.');
                        sesion.phase = PHASE.SELECCION_CATEGORIA;
                    }
                } else {
                    const searchResults = availableProducts.filter(p => norm(p.nombre).includes(t));
                    
                    if (searchResults.length > 0) {
                        if (searchResults.length === 1) {
                            const foundProduct = searchResults[0];
                            addToCart(jid, {
                                codigo: foundProduct.codigo,
                                nombre: foundProduct.nombre,
                                precio: foundProduct.precio
                            });
                            await say(sock, jid, `✅ ¡Encontramos *${foundProduct.nombre}* y lo agregamos a tu carrito!
_Escribe **pagar**, **carrito** o el nombre de otro producto para seguir comprando._`);
                        } else {
                            const list = searchResults.map((p, i) => `*${i + 1}.* ${p.nombre} — COP$${money(p.precio)}`).join('\n');
                            await say(sock, jid, `Encontré estas coincidencias para **"${raw}"**:
*Quizás quisiste decir:*
${list}
_Escribe el número o el nombre del producto que deseas agregar a tu carrito._`);
                            sesion.phase = PHASE.SELECCION_PRODUCTO;
                            sesion.products = searchResults;
                        }
                    } else {
                        await say(sock, jid, 'No encontré productos que coincidan con tu búsqueda. ¿Te gustaría ver nuestro catálogo completo? Escribe **1** para empezar.');
                        sesion.phase = PHASE.MENU_PRINCIPAL;
                    }
                }
                break;

            case PHASE.SELECCION_PRODUCTO:
                const productList = sesion.products;
                let selectedProduct = null;
                const productSelection = parseInt(t);
                
                if (!isNaN(productSelection) && productSelection > 0 && productSelection <= productList.length) {
                    selectedProduct = productList[productSelection - 1];
                } else {
                    selectedProduct = productList.find(p => norm(p.nombre) === t);
                }

                if (selectedProduct) {
                    addToCart(jid, {
                        codigo: selectedProduct.codigo,
                        nombre: selectedProduct.nombre,
                        precio: selectedProduct.precio
                    });
                    await say(sock, jid, `✅ ¡Agregado *${selectedProduct.nombre}* a tu carrito!
_Escribe **pagar**, **carrito** o el nombre de otro producto para seguir comprando._`);
                    sesion.phase = PHASE.SELECCION_CATEGORIA;
                }
                break;

            case PHASE.CHECK_TEL:
                const phone = (t || '').replace(/[^0-9+]/g, '');
                ctx.order[jid] = { ...ctx.order[jid], tel: phone };
                sesion.phase = PHASE.CHECK_DIR;
                await say(sock, jid, '📍 *Paso 2:* Ahora escribe tu *dirección completa*.');
                break;

            case PHASE.CHECK_DIR:
                ctx.order[jid] = { ...ctx.order[jid], dir: raw.trim() };
                sesion.phase = PHASE.CHECK_NAME;
                await say(sock, jid, '👤 *Paso 3:* ¿A nombre de quién va el pedido? Escribe el *nombre completo*.');
                break;

            case PHASE.CHECK_NAME:
                ctx.order[jid] = { ...ctx.order[jid], name: raw.trim() };
                sesion.phase = PHASE.CHECK_PAGO;
                await say(sock, jid, '💳 *Paso 4:* ¿Cómo vas a pagar? Escribe *Transferencia* o *Efectivo*.');
                break;

            case PHASE.CHECK_PAGO:
                const p = norm(raw);
                let metodo = null;
                if (p.includes('efectivo') || p.includes('contra')) metodo = 'Efectivo';
                if (p.includes('transferencia') || p.includes('adelant') || p.includes('nequi') || p.includes('bancolombia')) metodo = 'Transferencia';
                
                ctx.order[jid] = { ...ctx.order[jid], pago: metodo };
                await showOrderSummary(sock, jid);
                break;
            
            case PHASE.CONFIRM_ORDER:
                if (t === 'confirmar') {
                    if (sesion.orderProcessed) return;
                    
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
                            sesion.orderProcessed = true;
                            await say(sock, jid, `🥳 ¡Gracias por tu compra! Tu pedido ha sido registrado con éxito.
*Pronto te contactaremos para confirmar la entrega.*
Si quieres empezar de nuevo, solo escribe *menú*.`);
                            await sock.sendMessage(CONFIG.SOCIA_JID, {
                                text: `🔔 Nuevo pedido
Cliente: ${ctx.order[jid].name}
Tel: ${ctx.order[jid].tel}
Dir: ${ctx.order[jid].dir}
Pago: ${ctx.order[jid].pago}
Productos: ${pedidoCompleto.producto}
Total: COP$${money(total)}`
                            });
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
                    sesion.isEditing = true;
                    sesion.phase = PHASE.EDIT_OPTIONS;
                    await say(sock, jid, `📝 *¿Qué deseas editar?*
*1)* Teléfono
*2)* Dirección
*3)* Nombre
*4)* Forma de pago
*5)* Carrito
*6)* Finalizar (confirma el pedido)
_Escribe el número de la opción o **finalizar** para continuar._`);
                }
                break;
            
            case PHASE.EDIT_OPTIONS:
                const editMap = {'1': 'tel', '2': 'dir', '3': 'name', '4': 'pago', '5': 'carrito'};
                
                if (t === '6' || t.includes('finalizar')) {
                    sesion.isEditing = false;
                    await showOrderSummary(sock, jid);
                    return;
                }

                if (editMap[t]) {
                    const editKey = editMap[t];
                    sesion.phase = `checkout_${editKey}`;
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
                            sesion.phase = PHASE.SELECCION_CATEGORIA;
                            return;
                        }
                        const { text } = cartSummary(jid);
                        await say(sock, jid, `${messages[editKey]}\n${text}`);
                    } else {
                        await say(sock, jid, messages[editKey]);
                    }
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