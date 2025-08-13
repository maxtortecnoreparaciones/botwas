from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from .google_sheets import obtener_inventario
import unicodedata
import json
from .google_sheets import agregar_entrega, marcar_pago, marcar_entrega

# ---------- helpers de normalización ----------

def _strip_accents(s: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFD', (s or '')) if unicodedata.category(c) != 'Mn')

def _norm(s: str) -> str:
    s = _strip_accents(s or '')
    return ' '.join(s.lower().strip().split())

def _city_match(row_city_norm: str, q_city_norm: str) -> bool:
    """
    Coincidencia robusta de ciudad.
    - 'bogota' -> fila que contenga 'bogota' (soporta 'bogotá').
    - 'guajira' -> fila que contenga 'guajira', 'la guajira' o 'riohacha'/'rio hacha'.
    - 'resto' / 'intl' -> no filtra (devuelve todo para que el bot lo use).
    """
    if not q_city_norm:
        return True
    if q_city_norm in ('resto', 'otros', 'otra ciudad', 'otra ciudad de colombia', 'resto de colombia', 'colombia'):
        return True
    if q_city_norm in ('intl', 'internacional', 'otros paises', 'otro pais', 'otros países'):
        return True

    if q_city_norm == 'bogota':
        return 'bogota' in row_city_norm

    if q_city_norm == 'guajira':
        return any(k in row_city_norm for k in ('guajira', 'la guajira', 'riohacha', 'rio hacha'))

    return q_city_norm in row_city_norm


# ---------- API: listado desde Google Sheets (según tus encabezados) ----------

@csrf_exempt
def consultar_productos_gsheet(request):
    """
    Devuelve lista para el bot: [{nombre,codigo,precio,categoria,ciudad}, ...]
    Query params:
      - ciudad: bogota | guajira | resto | intl   (tolerante a variantes)
      - categoria: texto libre (contains)
      - producto:  texto libre (contains)
      - limit: int (opcional)
      - debug: '1' (muestra conteos y muestras)
    """
    inv_raw = obtener_inventario()  # lista de dicts con EXACTAMENTE los encabezados que diste
    limit = int(request.GET.get('limit', '0') or 0)

    q_ciudad = _norm(request.GET.get('ciudad', ''))
    q_categoria = _norm(request.GET.get('categoria', ''))
    q_producto = _norm(request.GET.get('producto', ''))
    debug = request.GET.get('debug', '') == '1'

    # Normaliza al formato que consume el bot
    normalized = []
    for it in inv_raw:
        # **Usamos TUS encabezados exactos**
        nombre = str(it.get('Producto', '')).strip()
        codigo = str(it.get('Codigo', '')).strip()
        precio = it.get('Precio_Venta', 0)
        categoria = str(it.get('Categoria', '')).strip()
        ciudad = str(it.get('Ciudad', '')).strip()

        normalized.append({
            'nombre': nombre,
            'codigo': codigo,
            'precio': precio,
            'categoria': categoria,
            'ciudad': ciudad,
        })

    # Aplicar filtros
    out = []
    for it in normalized:
        city_ok = _city_match(_norm(it['ciudad']), q_ciudad)

        cat_ok = True
        if q_categoria:
            cat_ok = (q_categoria in _norm(it['categoria'])) or (q_categoria in _norm(it['nombre']))

        prod_ok = True
        if q_producto:
            prod_ok = (q_producto in _norm(it['nombre']))

        if city_ok and cat_ok and prod_ok:
            out.append(it)

    # Salvavidas: si pediste ciudad local y quedó vacío, devolvemos catálogo general
    if q_ciudad in ('bogota', 'guajira') and not out:
        out = normalized[:]

    if limit and limit > 0:
        out = out[:limit]

    if debug:
        return JsonResponse({
            'query': {
                'ciudad': q_ciudad, 'categoria': q_categoria, 'producto': q_producto, 'limit': limit
            },
            'counts': {
                'raw': len(inv_raw), 'normalized': len(normalized), 'filtered': len(out)
            },
            'sample_raw': inv_raw[:5],
            'sample_normalized': normalized[:5],
            'result': out[:5]
        }, safe=False)

    return JsonResponse(out, safe=False)


# ---------- API: stock por código (según tus encabezados) ----------

def consultar_stock(request, codigo):
    """
    Busca por 'Codigo' y devuelve producto/stock/ciudad/precio.
    """
    inv_raw = obtener_inventario()
    code_q = _norm(codigo)
    for it in inv_raw:
        code_val = _norm(str(it.get('Codigo', '')))
        if code_val == code_q:
            return JsonResponse({
                'producto': it.get('Producto', ''),
                'stock': it.get('Stock_Actual', ''),
                'ciudad': it.get('Ciudad', ''),
                'precio': it.get('Precio_Venta', 0),
            })
    return JsonResponse({'error': 'Producto no encontrado'}, status=404)

@csrf_exempt
def registrar_entrega(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Método no permitido'}, status=405)
    try:
        data = json.loads(request.body.decode('utf-8'))
        # Campos esperados desde el bot:
        # ciudad, producto, codigo, telefono, direccion, monto, pago, estado, observaciones, referido_por
        ok, msg = agregar_entrega(data)
        if not ok:
            return JsonResponse({'ok': False, 'error': msg}, status=400)
        return JsonResponse({'ok': True})
    except Exception as e:
        return JsonResponse({'ok': False, 'error': str(e)}, status=500)

@csrf_exempt
def actualizar_pago(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Método no permitido'}, status=405)
    try:
        data = json.loads(request.body.decode('utf-8'))
        codigo = data.get('codigo', '')
        pagado = bool(data.get('pagado', False))
        ok, msg = marcar_pago(codigo, pagado)
        if not ok:
            return JsonResponse({'ok': False, 'error': msg}, status=400)
        return JsonResponse({'ok': True})
    except Exception as e:
        return JsonResponse({'ok': False, 'error': str(e)}, status=500)

@csrf_exempt
def actualizar_entrega(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Método no permitido'}, status=405)
    try:
        data = json.loads(request.body.decode('utf-8'))
        codigo = data.get('codigo', '')
        entregado = bool(data.get('entregado', False))
        ok, msg = marcar_entrega(codigo, entregado)
        if not ok:
            return JsonResponse({'ok': False, 'error': msg}, status=400)
        return JsonResponse({'ok': True})
    except Exception as e:
        return JsonResponse({'ok': False, 'error': str(e)}, status=500)
