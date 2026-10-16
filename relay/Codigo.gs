/**
 * Intermediario de marcaciones NVR (Google Apps Script)
 *
 * 1) POST: recibe cada marcación de la página móvil y la reenvía al webhook
 *    de la automatización "3 · Recibir Marcación (celular)" de Airtable
 *    (los navegadores bloquean por CORS el envío directo a hooks.airtable.com).
 * 2) GET ?accion=trabajadores: devuelve la lista vigente de trabajadores
 *    ACTIVOS y fiscalizables, leída de la tabla TRABAJADORES de Airtable.
 *    Solo entrega ID y nombre (nunca DNI, PIN ni otros datos).
 *
 * Configuración: en el editor, Configuración del proyecto (engranaje) →
 * Propiedades de la secuencia de comandos → agregar AIRTABLE_PAT con un token
 * de Airtable que tenga permiso data.records:read sobre la base NVR.
 * Después de cambiar el código: Implementar → Gestionar implementaciones →
 * Editar (lápiz) → Versión: Nueva versión → Implementar.
 */
const AIRTABLE_WEBHOOK =
  'https://hooks.airtable.com/workflows/v1/genericWebhook/apppL15wYnCp2ltzD/wfl5VfZSYLc8u9zra/wtrd9vunMywVNaPIP';
const BASE_ID = 'apppL15wYnCp2ltzD';
const TABLA_TRABAJADORES = 'tblNooOQwbG0Xhqw9';
const F = {
  nombre: 'fldJITc5dnep2QYFH',
  id: 'fldVXnhgf9y1QhueD',
  estado: 'fldOLMg2LUdYjnJrN',
  noFiscalizable: 'fldbgei7WJ0OpSCV0',
  ingreso: 'fldxBKd5idECrGHFK',
  cese: 'fldq2SAfO6eJPV7dR'
};
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

function doGet(e) {
  const accion = e && e.parameter ? e.parameter.accion : '';
  if (accion === 'trabajadores') return responder(listarTrabajadores());
  return responder({ ok: true, servicio: 'Intermediario de marcaciones NVR' });
}

function listarTrabajadores() {
  const cache = CacheService.getScriptCache();
  const guardado = cache.get('trabajadores');
  if (guardado) return JSON.parse(guardado);

  const pat = PropertiesService.getScriptProperties().getProperty('AIRTABLE_PAT');
  if (!pat) return { ok: false, error: 'Falta la propiedad AIRTABLE_PAT en el intermediario' };

  const hoy = Utilities.formatDate(new Date(), 'America/Lima', 'yyyy-MM-dd');
  const campos = Object.keys(F).map(k => 'fields%5B%5D=' + F[k]).join('&');
  const lista = [];
  let offset = '';
  do {
    const url = 'https://api.airtable.com/v0/' + BASE_ID + '/' + TABLA_TRABAJADORES +
      '?returnFieldsByFieldId=true&pageSize=100&' + campos + (offset ? '&offset=' + offset : '');
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return { ok: false, error: 'Airtable respondió ' + res.getResponseCode() };
    }
    const json = JSON.parse(res.getContentText());
    (json.records || []).forEach(r => {
      const f = r.fields || {};
      const estado = f[F.estado] && (f[F.estado].name || f[F.estado]);
      if (estado !== 'ACTIVO') return;
      if (f[F.noFiscalizable]) return;
      if (f[F.ingreso] && f[F.ingreso] > hoy) return;
      if (f[F.cese] && f[F.cese] < hoy) return;
      if (!f[F.id] || !f[F.nombre]) return;
      lista.push([f[F.id], String(f[F.nombre]).trim()]);
    });
    offset = json.offset || '';
  } while (offset);

  lista.sort((a, b) => a[1].localeCompare(b[1]));
  const salida = { ok: true, fecha: hoy, trabajadores: lista };
  cache.put('trabajadores', JSON.stringify(salida), 600); // 10 minutos
  return salida;
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
