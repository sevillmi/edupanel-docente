# EduPanel Docente

Asistente docente de escritorio con IA. Cada docente usa su propia clave de IA (Claude, OpenAI o Gemini); no existe ningún servidor intermedio.

## Usar (en Windows, con Node.js instalado)

```
npm install
npm start          # probar la app
npm test           # 140+ pruebas de seguridad e interfaz (no necesita Windows)
npm run build      # genera dist\Instalar-EduPanel-Docente.exe (instalador de un clic)
```

## Antes de repartirla

1. **Escribe tu correo de contacto** en `src/about.config.js` (campo `email`). Sin él, "Acerca de" y el reporte de errores muestran "contacto no configurado".
2. Revisa el texto de "intención" en ese mismo archivo y ajústalo a tu voz.
3. Abre las tres páginas de claves (Claude, OpenAI, Gemini) desde el asistente y confirma que siguen vigentes.
4. Prueba la app instalada en un Windows limpio: las pruebas simulan Electron, no lo reemplazan.

## Qué incluye

- **Registrar:** panel con indicadores, estudiantes (importación Excel/CSV/JSON), asistencia y notas.
- **Planear / Crear con IA:** planeamientos, evaluaciones, retroalimentación y análisis del panel; adaptados al contexto de la zona y del grupo.
- **Primer inicio:** asistente de 3 pasos para crear y pegar la clave de IA.
- **Perfil:** cuenta, IA, centros, contexto de la zona, **Seguridad**, respaldo, **Preguntas frecuentes** y **Acerca de**.

## Seguridad

- Datos y clave de IA cifrados con el almacén seguro de Windows (DPAPI, vía `safeStorage`); escritura atómica y copia automática.
- **Candado con PIN** (4–8 dígitos, hash con sal), código de recuperación, espera progresiva tras fallos, autobloqueo por inactividad / bloqueo de sesión / suspensión.
- Interfaz aislada (sandbox, sin Node, CSP estricta, sin navegación ni ventanas nuevas, solo enlaces permitidos); el proceso principal solo atiende a la interfaz propia.
- Todo dato importado se reconstruye con campos y tamaños permitidos; todo texto se escapa antes de mostrarse.
- A la IA nunca viajan nombres ni notas: solo lo que se escribe en cada formulario y cifras agregadas del grupo.
- Registro de errores local (sin claves, rutas de usuario ni datos de estudiantes) con botón para enviarlo por correo.

### Límites conocidos

- El cifrado depende de la cuenta de Windows: protege contra copiar los archivos a otro equipo o cuenta, no contra quien use la sesión ya desbloqueada.
- El PIN es un candado de la aplicación: quien tenga acceso a los archivos de la propia cuenta de Windows podría eliminar el PIN (pero no leer los datos fuera de esa cuenta).
- El respaldo `.json` exportado **no** está cifrado.
- Si no hay cifrado del sistema disponible, la app lo avisa en Seguridad y guarda sin cifrar.

## Estructura

- `main.js`: datos cifrados, candado, llamadas a la IA, registro de errores, endurecimiento de la ventana.
- `security.js`: funciones de seguridad puras (PIN, hash, redacción, enlaces, cifrado).
- `preload.js`: puente mínimo entre interfaz y proceso principal.
- `src/`: interfaz (`about.config.js` = contacto y texto de "Acerca de").
- `tests/`: pruebas (Electron simulado + jsdom).

## Notas

- La nota mínima de aprobación es `PASS` (70) al inicio de `src/app.js`.
- Para otro proveedor de IA: agrega un bloque en `callAI` (main.js), la lista en `security.js` (`PROVIDERS`) y `PROVIDERS` en `src/app.js`.
