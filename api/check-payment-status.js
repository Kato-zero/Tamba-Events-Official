/*
 * Tamba.Events - check whether a mobile money payment has been completed.
 *
 * When Lipila confirms the payment, this function issues the ticket on the
 * server (once only) and returns it to the buyer.
 *
 * Required environment variables:
 *   LIPILA_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function getSignedInUserId(req) {
  const token = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;

  const user = await r.json().catch(() => null);
  return user && user.id ? user.id : null;
}

async function dbRpc(name, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const referenceId = String(req.query?.referenceId || "").trim();
    if (!referenceId) {
      return res.status(400).json({ success: false, message: "referenceId is required." });
    }

    const userId = await getSignedInUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Please sign in again." });
    }

    const apiKey = process.env.LIPILA_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, message: "Payment configuration is missing." });
    }

    const url =
      "https://blz.lipila.io/api/v1/collections/check-status?referenceId=" +
      encodeURIComponent(referenceId);

    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", "x-api-key": apiKey }
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }

    /*
     * A temporary Lipila problem is NOT a failed payment.
     * Keep the customer waiting in every case except a clear answer.
     */
    if (response.status === 429 || response.status >= 500 || response.status === 404 || !response.ok) {
      return res.status(200).json({
        success: true,
        state: "pending",
        referenceId,
        message: "Waiting for payment confirmation."
      });
    }

    const status = String(data.status || "").trim().toLowerCase();

    if (status === "successful" || status === "success" || status === "completed") {
      // Issue the ticket now (the database makes sure this happens only once).
      const fulfil = await dbRpc("fulfil_ticket_payment", {
        p_reference: referenceId,
        p_user: userId
      });

      if (!fulfil.ok) {
        if (fulfil.status === 400 || fulfil.status === 404) {
          return res.status(404).json({ success: false, message: "Payment not found." });
        }
        console.error("Fulfil failed:", fulfil.data);
        return res.status(200).json({ success: true, state: "pending", referenceId, message: "Issuing your ticket…" });
      }

      const result = fulfil.data || {};

      if (result.state === "fulfilled") {
        return res.status(200).json({ success: true, state: "successful", referenceId, ticket: result.ticket });
      }
      if (result.state === "refund_due") {
        return res.status(200).json({
          success: true,
          state: "refund_due",
          referenceId,
          message: "Payment received, but these tickets sold out before it completed. A refund is due."
        });
      }
      return res.status(200).json({ success: true, state: "failed", referenceId });
    }

    if (["failed", "failure", "cancelled", "canceled", "rejected"].includes(status)) {
      await dbRpc("mark_payment_failed", { p_reference: referenceId, p_reason: "Lipila status: " + status });
      return res.status(200).json({ success: true, state: "failed", referenceId });
    }

    // Pending / processing / unknown: keep waiting.
    return res.status(200).json({ success: true, state: "pending", referenceId });

  } catch (error) {
    console.error("CHECK PAYMENT STATUS ERROR:", error);
    return res.status(200).json({ success: true, state: "pending", message: "Waiting for payment confirmation." });
  }
};
