const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Minimal PostgREST helper (service role, bypasses RLS)
async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof d === "string" ? d : JSON.stringify(d)}`);
  return d;
}

// Verifies the Bearer token the page sends and returns the Supabase user (or null)
async function getUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const r = await fetch(`${SB}/auth/v1/user`, {
    headers: { apikey: KEY, Authorization: "Bearer " + token }
  });
  if (!r.ok) return null;
  return r.json();
}

const configured = () => !!(SB && KEY && process.env.LIPILA_API_KEY);

module.exports = { sb, getUser, configured };
