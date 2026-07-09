// ส่ง raw rows ขึ้น Hub ผ่าน HTTPS (Node 18+ มี fetch ในตัว)
// body กลาง: { job, items: [ { key, datasets: { name: rows[] } }, ... ] }
async function pushItems(hub, hospitalCode, job, items) {
  const res = await fetch(hub.url.replace(/\/+$/, '') + '/api/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hospitalCode}:${hub.apiKey}`,
    },
    body: JSON.stringify({ job, items }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`hub ${res.status}: ${body.error || text}`);
    err.status = res.status;   // ให้ผู้เรียกตัดสินใจ retry ได้ (429/5xx = ชั่วคราว, 4xx อื่น = ถาวร)
    throw err;
  }
  return body;
}

module.exports = { pushItems };
