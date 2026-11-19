const { sb, getUser, configured } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    if (!configured()) {
      console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or LIPILA_API_KEY");
      return res.status(500).json({ success: false, message: "Payment configuration is missing." });
    }

    const user = await getUser(req);
    if (!user) return res.status(401).json({ success: false, message: "Please sign in again to pay for tickets." });

    const b = req.body || {};
    const eventId = String(b.event_id || "");
    const tierName = String(b.tier_name || "");
    const qty = Math.floor(Number(b.qty));
    const customerName = String(b.customer_name || "").trim();
    const method = String(b.method || "");

    if (!eventId || !tierName) return res.status(400).json({ success: false, message: "Missing event or ticket type." });
    if (!Number.isFinite(qty) || qty < 1 || qty > 10) return res.status(400).json({ success: false, message: "Invalid quantity." });
    if (customerName.length < 2) return res.status(400).json({ success: false, message: "Customer name is required." });

    // Phone -> 260XXXXXXXXX
    let acct = String(b.phone || "").replace(/\D/g, "");
    if (acct.startsWith("0")) acct = "260" + acct.slice(1);
    if (!acct.startsWith("260")) acct = "260" + acct;
    if (acct.length !== 12) return res.status(400).json({ success: false, message: "Invalid Zambian phone number." });

    // Price is worked out here, never trusted from the browser
    const events = await sb(`events?id=eq.${encodeURIComponent(eventId)}&select=*`);
    const ev = events && events[0];
    if (!ev || ev.status === "suspended") return res.status(404).json({ success: false, message: "Event not found." });
    if (ev.date < new Date().toISOString().slice(0, 10)) return res.status(400).json({ success: false, message: "This event has ended." });

    const tier = (ev.tiers || []).find(t => t.name === tierName);
    if (!tier) return res.status(400).json({ success: false, message: "Ticket type not found." });
    if (tier.qty - tier.sold < qty) return res.status(400).json({ success: false, message: "Not enough tickets left." });

    const amount = Number(tier.price) * qty;
    if (amount < 50) return res.status(400).json({ success: false, message: "Mobile money payments start at K50." });

    const referenceId = "TMB-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();

    // Remember the order so check-payment-status can issue the ticket later
    await sb("payments", {
      method: "POST",
      body: {
        reference_id: referenceId,
        user_id: user.id,
        event_id: eventId,
        tier_name: tierName,
        qty,
        amount,
        method,
        buyer_name: customerName,
        buyer_phone: acct,
        buyer_email: String(b.email || user.email || ""),
        status: "pending"
      }
    });

    const lipila = await fetch("https://blz.lipila.io/api/v1/collections/mobile-money", {
      method: "POST",
      headers: { accept: "application/json", "Content-Type": "application/json", "x-api-key": process.env.LIPILA_API_KEY },
      body: JSON.stringify({
        referenceId,
        amount,
        narration: "Tamba.Events ticket payment",
        accountNumber: acct,
        currency: "ZMW",
        referenceData: customerName
      })
    });

    const text = await lipila.text();
    console.log("Lipila create:", lipila.status, text);

    if (!lipila.ok) {
      await sb(`payments?reference_id=eq.${encodeURIComponent(referenceId)}`, { method: "PATCH", body: { status: "failed" } }).catch(() => {});
      let detail = text;
      try { const j = JSON.parse(text); detail = j.message || j.error || text; } catch {}
      return res.status(502).json({ success: false, message: "Lipila rejected the payment request: " + String(detail).slice(0, 200) });
    }

    return res.status(200).json({ success: true, referenceId });
  } catch (error) {
    console.error("CREATE PAYMENT ERROR:", error);
    return res.status(500).json({ success: false, message: "Payment function failed: " + error.message });
  }
};
