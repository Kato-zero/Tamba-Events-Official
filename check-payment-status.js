const { sb, getUser, configured } = require("./_lib");

const OK = ["successful", "success", "completed", "paid"];
const BAD = ["failed", "declined", "rejected", "cancelled", "canceled", "expired", "error"];

const enc = encodeURIComponent;
const newCode = () => {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "TZ-";
  for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
};

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ success: false, message: "Method not allowed" });

  try {
    if (!configured()) return res.status(500).json({ success: false, message: "Payment configuration is missing" });

    const user = await getUser(req);
    if (!user) return res.status(401).json({ success: false, message: "Please sign in again." });

    const ref = String(req.query.referenceId || "").trim();
    if (!ref) return res.status(400).json({ success: false, message: "referenceId is required" });

    const rows = await sb(`payments?reference_id=eq.${enc(ref)}&user_id=eq.${enc(user.id)}&select=*`);
    const pay = rows && rows[0];
    if (!pay) return res.status(404).json({ success: false, message: "Payment not found" });

    // Already finished on an earlier poll
    if (pay.status === "successful" && pay.ticket_id) {
      const t = await sb(`tickets?id=eq.${enc(pay.ticket_id)}&select=*`);
      return res.status(200).json({ success: true, state: "successful", ticket: t[0] });
    }
    if (pay.status === "failed") return res.status(200).json({ success: true, state: "failed" });
    if (pay.status === "refund_due") {
      return res.status(200).json({ success: true, state: "refund_due", message: "Tickets sold out before your payment cleared." });
    }
    if (pay.status === "issuing") return res.status(200).json({ success: true, state: "pending" });

    // Ask Lipila
    const lr = await fetch("https://blz.lipila.io/api/v1/collections/check-status?referenceId=" + enc(ref), {
      headers: { accept: "application/json", "x-api-key": process.env.LIPILA_API_KEY }
    });
    const text = await lr.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { rawResponse: text }; }
    console.log("Lipila status:", lr.status, text);

    if (!lr.ok) return res.status(200).json({ success: true, state: "pending" }); // transient, keep polling

    const raw = data.status || data.state || (data.data && (data.data.status || data.data.state)) || "";
    const s = String(raw).toLowerCase();

    if (BAD.includes(s)) {
      await sb(`payments?reference_id=eq.${enc(ref)}`, { method: "PATCH", body: { status: "failed" } });
      return res.status(200).json({ success: true, state: "failed" });
    }
    if (!OK.includes(s)) return res.status(200).json({ success: true, state: "pending" });

    // Paid. Claim the order so two polls can't issue two tickets.
    const claimed = await sb(`payments?reference_id=eq.${enc(ref)}&status=eq.pending`, {
      method: "PATCH", body: { status: "issuing" }, prefer: "return=representation"
    });
    if (!claimed || !claimed.length) return res.status(200).json({ success: true, state: "pending" });

    try {
      const evs = await sb(`events?id=eq.${enc(pay.event_id)}&select=*`);
      const ev = evs && evs[0];
      const tiers = ev ? (ev.tiers || []).map(t => ({ ...t })) : [];
      const tier = tiers.find(t => t.name === pay.tier_name);

      if (!ev || !tier || tier.qty - tier.sold < pay.qty) {
        await sb(`payments?reference_id=eq.${enc(ref)}`, { method: "PATCH", body: { status: "refund_due" } });
        return res.status(200).json({ success: true, state: "refund_due", message: "Tickets sold out before your payment cleared." });
      }

      tier.sold += pay.qty;
      await sb(`events?id=eq.${enc(ev.id)}`, { method: "PATCH", body: { tiers } });

      const ticket = {
        id: "tk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        code: newCode(),
        user_id: user.id,
        event_id: ev.id,
        event_title: ev.title,
        tier: pay.tier_name,
        qty: pay.qty,
        total: pay.amount,
        method: pay.method,
        buyer_name: pay.buyer_name,
        buyer_phone: pay.buyer_phone,
        buyer_email: pay.buyer_email,
        date: ev.date,
        time: ev.time,
        venue: ev.venue,
        city: ev.city
      };
      const made = await sb("tickets", { method: "POST", body: ticket, prefer: "return=representation" });
      const t = Array.isArray(made) ? made[0] : made;

      await sb(`payments?reference_id=eq.${enc(ref)}`, { method: "PATCH", body: { status: "successful", ticket_id: t.id } });
      return res.status(200).json({ success: true, state: "successful", ticket: t });
    } catch (err) {
      console.error("TICKET ISSUE ERROR:", err);
      // release the claim so the next poll retries
      await sb(`payments?reference_id=eq.${enc(ref)}`, { method: "PATCH", body: { status: "pending" } }).catch(() => {});
      return res.status(200).json({ success: true, state: "pending" });
    }
  } catch (error) {
    console.error("STATUS CHECK ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to check payment status: " + error.message });
  }
};
