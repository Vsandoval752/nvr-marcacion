/**
 * Intermediario de marcaciones NVR (Google Apps Script)
 *
 * 1) POST: recibe cada marcación de la página móvil y la reenvía al webhook
 *    de la automatización "3 · Recibir Marcación (celular)" de Airtable
 *    (los navegadores bloquean por CORS el envío directo a hooks.airtable.com).
 * 2) GET ?accion=trabajadores: devuelve la lista vigente de trabajadores
 *    ACTIVOS y fiscalizables, leída de la tabla TRABAJADORES de Airtable.
 *    Solo entrega ID y nombre (nunca DNI, PIN ni otros datos).
 * 3) subirFotosPendientes(): cada minuto (activador de tiempo) busca en
 *    MARCACIONES las fotos que quedaron en 'Foto Pendiente (base64)', las sube
 *    al campo 'Foto Evidencia' y vacía el campo pendiente.
 *
 * Configuración: en el editor, Configuración del proyecto (engranaje) →
 * Propiedades de script → agregar AIRTABLE_PAT con un token de Airtable con
 * permisos data.records:read y data.records:write sobre la base NVR.
 * Activador: Activadores (reloj) → Añadir activador → función
 * subirFotosPendientes → Según tiempo → Temporizador por minutos → Cada minuto.
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
const TABLA_MARCACIONES = 'tblRBocluXIxX6NsL';
const FM = {
  id: 'fldXxcdRZLQBKMGtI',
  foto: 'fldRpNct3x3fp808P',
  fotoPendiente: 'fldwnqhwZD7lGSrON',
  sellado: 'fldPCBaG3yQn5gjrG',
  obs: 'fldgKu3EpnEd9oINL'
};

/** Sube las fotos de evidencia que quedaron pendientes en MARCACIONES. */
function subirFotosPendientes() {
  const pat = PropertiesService.getScriptProperties().getProperty('AIRTABLE_PAT');
  if (!pat) throw new Error('Falta la propiedad AIRTABLE_PAT');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 'Otra ejecución en curso';
  try {
    const formula = encodeURIComponent('LEN({' + FM.fotoPendiente + '})>0');
    const campos = [FM.id, FM.fotoPendiente, FM.obs].map(f => 'fields%5B%5D=' + f).join('&');
    const url = 'https://api.airtable.com/v0/' + BASE_ID + '/' + TABLA_MARCACIONES +
      '?returnFieldsByFieldId=true&pageSize=20&filterByFormula=' + formula + '&' + campos;
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + pat }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Airtable respondió ' + res.getResponseCode());
    const registros = JSON.parse(res.getContentText()).records || [];
    let subidas = 0;
    registros.forEach(r => {
      const f = r.fields || {};
      const b64 = String(f[FM.fotoPendiente] || '');
      if (b64.length < 2000) return;
      const nombre = (f[FM.id] || r.id) + '.jpg';
      const up = UrlFetchApp.fetch(
        'https://content.airtable.com/v0/' + BASE_ID + '/' + r.id + '/' + FM.foto + '/uploadAttachment', {
          method: 'post',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + pat },
          payload: JSON.stringify({ contentType: 'image/jpeg', file: b64, filename: nombre }),
          muteHttpExceptions: true
        });
      if (up.getResponseCode() !== 200) {
        console.log('No se pudo subir ' + nombre + ': ' + up.getResponseCode() + ' ' + up.getContentText().slice(0, 200));
        return;
      }
      const obs = String(f[FM.obs] || '')
        .replace(/\n?⚠ Foto en espera:[^\n]*/g, '')
        .replace(/\n?⚠ Foto no subida aún:[^\n]*/g, '');
      const campos = {};
      campos[FM.fotoPendiente] = null;
      campos[FM.sellado] = new Date().toISOString();
      campos[FM.obs] = (obs ? obs + '\n' : '') + '📷 Foto de evidencia subida ' +
        Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM/yyyy HH:mm');
      UrlFetchApp.fetch('https://api.airtable.com/v0/' + BASE_ID + '/' + TABLA_MARCACIONES + '/' + r.id +
        '?returnFieldsByFieldId=true', {
          method: 'patch',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + pat },
          payload: JSON.stringify({ fields: campos }),
          muteHttpExceptions: true
        });
      subidas++;
    });
    return 'Fotos subidas: ' + subidas;
  } finally {
    lock.releaseLock();
  }
}

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
