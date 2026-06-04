// ส่ง payload ขึ้น Hub ผ่าน HTTPS (ต้องใช้ Node 18+ ที่มี fetch ในตัว)
async function pushBatch(hub, hospitalCode, patients) {
  const res = await fetch(hub.url.replace(/\/+$/, '') + '/api/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hospitalCode}:${hub.apiKey}`,
    },
    body: JSON.stringify({ patients }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`hub ${res.status}: ${body.error || text}`);
  return body;
}

module.exports = { pushBatch };
