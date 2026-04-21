/* ═══════════════════════════════════════════════════════════════
   CUENTACAFÉ — SERVICE WORKER v3.0
   Estrategia: Cache-First para assets, Network-First para datos
   Compatible con Android Chrome / Samsung Internet / Firefox
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const SW_VERSION = '3.0.0';
const CACHE_NAME = `cuentacafe-shell-v${SW_VERSION}`;
const RUNTIME_CACHE = `cuentacafe-runtime-v${SW_VERSION}`;
const OFFLINE_URL = './index.html';

/* ── ARCHIVOS DEL APP SHELL (se cachean en la instalación) ── */
const APP_SHELL_URLS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

/* ── RECURSOS EXTERNOS DE GOOGLE FONTS (se cachean en runtime) ── */
const FONT_URLS_PATTERNS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

/* ══════════ INSTALACIÓN ══════════ */
self.addEventListener('install', event => {
  console.log(`[SW] Instalando CuentaCafé v${SW_VERSION}...`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Cacheando App Shell...');
        // Cachear cada archivo individualmente para mayor robustez
        return Promise.allSettled(
          APP_SHELL_URLS.map(url =>
            cache.add(url).catch(err => {
              console.warn(`[SW] No se pudo cachear ${url}:`, err.message);
            })
          )
        );
      })
      .then(() => {
        console.log('[SW] App Shell cacheado correctamente ✅');
        return self.skipWaiting(); // Activar inmediatamente sin esperar
      })
      .catch(err => {
        console.error('[SW] Error durante la instalación:', err);
      })
  );
});

/* ══════════ ACTIVACIÓN + LIMPIEZA DE CACHES VIEJOS ══════════ */
self.addEventListener('activate', event => {
  console.log(`[SW] Activando CuentaCafé v${SW_VERSION}...`);
  event.waitUntil(
    Promise.all([
      // Limpiar caches de versiones anteriores
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name.startsWith('cuentacafe-') && name !== CACHE_NAME && name !== RUNTIME_CACHE)
            .map(name => {
              console.log(`[SW] Eliminando cache viejo: ${name}`);
              return caches.delete(name);
            })
        );
      }),
      // Tomar control de todas las pestañas abiertas
      self.clients.claim()
    ]).then(() => {
      console.log('[SW] Service Worker activo y controlando todas las pestañas ✅');
      // Notificar a los clientes que hay una nueva versión
      self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'SW_ACTIVATED', version: SW_VERSION });
        });
      });
    })
  );
});

/* ══════════ ESTRATEGIA DE FETCH ══════════ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Solo interceptar requests GET
  if (request.method !== 'GET') return;

  // Ignorar requests de extensiones y no-http
  if (!request.url.startsWith('http')) return;
  if (url.protocol === 'chrome-extension:') return;

  // ── Fuentes de Google: Cache First con fallback de red ──
  if (FONT_URLS_PATTERNS.some(pattern => url.hostname.includes(pattern))) {
    event.respondWith(cacheFirstWithFallback(request, RUNTIME_CACHE));
    return;
  }

  // ── App Shell (archivos propios): Cache First ──
  const isAppShell = APP_SHELL_URLS.some(shellUrl => {
    const normalized = shellUrl.replace('./', '');
    return url.pathname.endsWith(normalized) || url.pathname.includes(normalized);
  });

  if (isAppShell) {
    event.respondWith(cacheFirstWithFallback(request, CACHE_NAME));
    return;
  }

  // ── Requests de la misma origen: Stale-While-Revalidate ──
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // ── Recursos externos: Network First con timeout ──
  event.respondWith(networkFirstWithTimeout(request, 4000));
});

/* ══════════ ESTRATEGIAS DE CACHE ══════════ */

/**
 * Cache First: busca en caché, si no está descarga de la red y guarda.
 */
async function cacheFirstWithFallback(request, cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) {
      // Revalidar en background sin bloquear
      revalidateInBackground(request, cache);
      return cached;
    }
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
      cache.put(request, networkResponse.clone());
    } else if (networkResponse && networkResponse.type === 'opaque') {
      // Recursos cross-origin opacos (como fuentes): cachear igual
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.warn('[SW] Cache First falló:', request.url, error.message);
    // Último recurso: intentar devolver el HTML principal
    const fallback = await caches.match(OFFLINE_URL);
    if (fallback) return fallback;
    return new Response('Offline — Aplicación no disponible', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/**
 * Stale-While-Revalidate: responde con caché inmediatamente, actualiza en background.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then(networkResponse => {
      if (networkResponse && networkResponse.status === 200) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  return cached || await fetchPromise || caches.match(OFFLINE_URL);
}

/**
 * Network First con timeout: intenta la red primero, con timeout, luego caché.
 */
async function networkFirstWithTimeout(request, timeoutMs) {
  const cache = await caches.open(RUNTIME_CACHE);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), timeoutMs)
  );

  try {
    const networkResponse = await Promise.race([
      fetch(request),
      timeoutPromise
    ]);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Sin conexión', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/**
 * Revalidación en background sin bloquear la respuesta al usuario.
 */
function revalidateInBackground(request, cache) {
  fetch(request)
    .then(response => {
      if (response && response.status === 200) {
        cache.put(request, response);
      }
    })
    .catch(() => { /* silencioso */ });
}

/* ══════════ MENSAJES DESDE LA APP ══════════ */
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.ports[0]?.postMessage({ version: SW_VERSION, cacheName: CACHE_NAME });
      break;

    case 'CLEAR_CACHE':
      caches.keys()
        .then(names => Promise.all(names.map(n => caches.delete(n))))
        .then(() => {
          event.ports[0]?.postMessage({ success: true });
          console.log('[SW] Todos los caches limpiados por solicitud del usuario');
        });
      break;

    case 'PRECACHE_URLS':
      if (Array.isArray(payload?.urls)) {
        caches.open(CACHE_NAME).then(cache => {
          cache.addAll(payload.urls).catch(console.warn);
        });
      }
      break;

    default:
      break;
  }
});

/* ══════════ NOTIFICACIONES PUSH (preparado para futuro) ══════════ */
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'Nueva notificación de CuentaCafé',
      icon: './icon-192.png',
      badge: './favicon-32.png',
      vibrate: [200, 100, 200],
      data: { url: data.url || './' },
      actions: [
        { action: 'open', title: 'Abrir' },
        { action: 'dismiss', title: 'Cerrar' }
      ]
    };
    event.waitUntil(
      self.registration.showNotification(data.title || 'CuentaCafé ☕', options)
    );
  } catch (e) {
    console.warn('[SW] Error en push notification:', e);
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(c => c.url.includes('cuentacafe'));
        if (existing) return existing.focus();
        return self.clients.openWindow(url);
      })
  );
});

console.log(`[SW] CuentaCafé Service Worker v${SW_VERSION} cargado ✅`);
