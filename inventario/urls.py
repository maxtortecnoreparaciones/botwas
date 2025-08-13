from django.contrib import admin
from django.urls import path, include
from django.urls import path
from . import views

urlpatterns = [
    path('api/consultar_stock/<str:codigo>/', views.consultar_stock, name='consultar_stock'),
    path('consultar_productos_gsheet/', views.consultar_productos_gsheet, name='consultar_productos_gsheet'),

    # 👇  “hoja de envíos / entregas”
    path('registrar_entrega/', views.registrar_entrega, name='registrar_entrega'),
    path('actualizar_pago/', views.actualizar_pago, name='actualizar_pago'),
    path('actualizar_entrega/', views.actualizar_entrega, name='actualizar_entrega'),

]
