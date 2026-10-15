/**
 * Intermediario de marcaciones NVR (Google Apps Script)
 *
 * Recibe cada marcación que envía la página móvil y la reenvía al webhook
 * de la automatización "3 · Recibir Marcación (celular)" de Airtable.
 * Es necesario porque los navegadores bloquean (CORS) los envíos directos
 * desde una página web hacia hooks.airtable.com.
 *
 * Instalación: script.google.com → Proyecto nuevo → pegar este código →
 * Implementar → Nueva implementación → Tipo: Aplicación web →
 * Ejecutar como: Yo · Quién tiene acceso: Cualquier persona → Implementar.
 * Copiar la "URL de la aplicación web" (termina en /exec).
 */
const AIRTABLE_WEBHOOK =
  'https://hooks.airtable.com/workflows/v1/genericWebhook/apppL15wYnCp2ltzD/wfl5VfZSYLc8u9zra/wtrd9vunMywVNaPIP';

const MAX_BYTES = 95000; // límite del webhook de Airtable: 100 KB por envío

function doPost(e) {
  const body = e && e.postData ? e.postData.contents : '';
  if (!body) return responder({ ok: false, error: 'Envío vacío' });
  if (body.length > MAX_BYTES) return responder({ ok: false, error: 'Foto demasiado grande' });

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return responder({ ok: false, error: 'Formato inválido' });
  }
  if (!data || data.v !== 1 || !data.tipo) {
    return responder({ ok: false, error: 'Formato no reconocido' });
  }

  data.recibidoPorIntermediario = new Date().toISOString();

  const res = UrlFetchApp.fetch(AIRTABLE_WEBHOOK, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  });
  const status = res.getResponseCode();
  return responder({ ok: status >= 200 && status < 300, status: status });
}

function doGet() {
  return responder({ ok: true, servicio: 'Intermediario de marcaciones NVR' });
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
