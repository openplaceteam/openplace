# Cambios Críticos de Branding: wplace → opnplace

Fecha: 6 de octubre de 2025

## ✅ Cambios Realizados

### 🎯 Identidad del Sitio

1. **Nombre de descarga de mapas**
   - ❌ Antes: `wplace_FECHA.png`
   - ✅ Ahora: `opnplace_FECHA.png`
   - Archivo: `frontend/_app/immutable/nodes/4.CrDfIbdR.js`

2. **Email de contacto**
   - ❌ Antes: `contact@wplace.live`
   - ✅ Ahora: `contact@opnplace.live`
   - Archivo: `frontend/_app/immutable/nodes/4.CrDfIbdR.js`

3. **Logos (alt text)**
   - ❌ Antes: `alt="Wplace logo"`
   - ✅ Ahora: `alt="Opnplace logo"`
   - Archivos:
     - `frontend/_app/immutable/chunks/D3yDgRbd.js`
     - `frontend/404.html`
     - `frontend/admin.html`
     - `frontend/index.html`
     - `frontend/offline.html`
     - `frontend/payment/success.html`

4. **Descripciones del sitio (meta tags)**
   - ❌ Antes: `"openplace is a free unofficial open source backend for wplace."`
   - ✅ Ahora: `"opnplace is a free open source pixel art canvas on the world map."`
   - Archivos: Todos los HTML en `frontend/` (20+ archivos)

5. **README del proyecto**
   - ❌ Antes: Mencionaba "backend for wplace"
   - ✅ Ahora: Fork personalizado con créditos al proyecto original
   - Archivo: `docs/README.md`

6. **Manifest del sitio**
   - ❌ Antes: `"backend for wplace"`
   - ✅ Ahora: `"pixel art canvas on the world map"`
   - Archivo: `frontend/site.webmanifest`

## 📊 Estadísticas de Cambios

- **Archivos modificados**: 30+
- **Tipo de cambios**: Branding y identidad visual
- **Impacto**: Alto (afecta toda la experiencia de usuario)

## ⚠️ Elementos NO Cambiados (Por Diseño)

### Redes Sociales (mantenidas del proyecto original)
- Discord: `https://discord.gg/ZRC4DnP9Z2`
- Reddit: `/r/WplaceLive`
- Instagram, YouTube, TikTok, Twitch

**Razón**: Estos son links a las comunidades del proyecto original de wplace.live

### Código Backend
- Clase `WplaceBitMap` en `src/utils/bitmap.ts`

**Razón**: Mantener compatibilidad con el protocolo original

### Documentación Técnica
- `docs/protocol.md` - Referencia al protocolo original

**Razón**: Documentación histórica y técnica del protocolo wplace

## 🚀 Próximos Pasos Recomendados

1. **Si quieres cambiar las redes sociales**:
   - Crear tus propias comunidades
   - Actualizar los links en el frontend compilado

2. **Para personalización completa del frontend**:
   - Necesitarías acceso al código fuente Svelte
   - Los archivos actuales son compilados

3. **Email funcional**:
   - Configurar `contact@opnplace.live` en tu servidor de email
   - O usar un servicio de forwarding

## 📝 Notas Importantes

- Los cambios están en tu working directory (no commiteados)
- El frontend es un submódulo de Git independiente
- Algunos archivos HTML fueron modificados masivamente con `sed`
- Para hacer commit de estos cambios, necesitas decidir qué incluir

## 🔍 Verificación de Cambios

Para verificar que los cambios se aplicaron correctamente:

```bash
# Verificar nombre de descarga
grep "opnplace_" frontend/_app/immutable/nodes/4.CrDfIbdR.js

# Verificar email
grep "contact@opnplace.live" frontend/_app/immutable/nodes/4.CrDfIbdR.js

# Verificar logos
grep "Opnplace logo" frontend/*.html

# Verificar descripciones
grep "opnplace is a free open source" frontend/index.html
```

## 💡 Recomendación Final

Estos cambios establecen tu identidad como "opnplace" manteniendo el respeto y los créditos al proyecto original "openplace/wplace". Es una buena práctica en proyectos de código abierto.
