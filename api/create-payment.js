/*
 * Tamba.Events - start a payment for a ticket purchase.
 * Supports mobile money (MTN, Airtel, Zamtel) and card.
 *
 * The browser sends WHAT it wants to buy (event, ticket type, quantity).
 * The price is worked out by the database, never trusted from the browser.
 *
 * Card payments use Lipila's hosted card page: the customer types their card
 * details on Lipila's page, so card numbers never reach this site or its server.
 *
 * Required environment variables (Vercel -> Settings -> Environment Variables):
 *   LIPILA_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   SITE_URL   (e.g. https://tambaevents.example - where Lipila sends card buyers back)
 */

const LIPILA_MOMO_URL = "https://blz.lipila.io/api/v1/collections/mobile-money";
const LIPILA_CARD_URL = "https://blz.lipila.io/api/v1/collections/card";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Confirms the caller is a signed-in Tamba.Events user. Returns their user id or null.
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

// Calls a Supabase database function with the server (service role) key.
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

// Zambian mobile numbers: 260 + 9 digits (12 digits in total).
function toLipilaAccount(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "260" + digits.substring(1);
  if (!digits.startsWith("260")) digits = "260" + digits;
  return digits.length === 12 ? digits : null;
}

// "Mwansa Banda Phiri" -> { first: "Mwansa", last: "Banda Phiri" }
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || parts[0] || "" };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    if (!process.env.LIPILA_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("Payment configuration is incomplete");
      return res.status(500).json({ success: false, message: "Payment configuration is missing." });
    }

    /* 1. Who is paying? Must be signed in. */
    const userId = await getSignedInUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Please sign in again to pay for tickets." });
    }

    /* 2. What are they buying? (Price is NOT taken from the request.) */
    const body = req.body || {};
    const eventId = String(body.event_id || "").trim();
    const tierName = String(body.tier_name || "").trim();
    const qty = Math.floor(Number(body.qty) || 0);
    const buyerName = String(body.customer_name || "").trim();
    const buyerEmail = String(body.email || "").trim().toLowerCase();
    const method = String(body.method || "MTN").trim();
    const isCard = method.toLowerCase() === "card";

    if (!eventId || !tierName) {
      return res.status(400).json({ success: false, message: "Choose an event and ticket type." });
    }
    if (qty < 1 || qty > 10) {
      return res.status(400).json({ success: false, message: "Choose between 1 and 10 tickets." });
    }
    if (buyerName.length < 2) {
      return res.status(400).json({ success: false, message: "Enter your name." });
    }
    if (isCard && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
      return res.status(400).json({ success: false, message: "A valid email address is needed for card payments." });
    }

    const accountNumber = toLipilaAccount(body.phone);
    if (!accountNumber) {
      return res.status(400).json({ success: false, message: "Invalid Zambian phone number." });
    }
    const localPhone = accountNumber.replace(/^260/, "0");

    /* 3. Reserve the payment and get the server-calculated amount. */
    const referenceId =
      "TAMBA-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8).toUpperCase();

    const created = await dbRpc("create_ticket_payment", {
      p_reference: referenceId,
      p_user: userId,
      p_event_id: eventId,
      p_tier_name: tierName,
      p_qty: qty,
      p_buyer_name: buyerName,
      p_buyer_phone: localPhone,
      p_buyer_email: buyerEmail,
      p_method: isCard ? "Card" : method
    });

    if (!created.ok) {
      // These messages come from the database rules (sold out, under K50, etc.) and are safe to show.
      return res.status(400).json({
        success: false,
        message: (created.data && created.data.message) || "This ticket cannot be bought right now."
      });
    }

    const amount = Number(created.data.amount);

    /* 4a. Card: send the customer to Lipila's secure card page. */
    if (isCard) {
      const { first, last } = splitName(buyerName);
      const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");

      console.log("Creating card payment:", { referenceId, amount });

      const lipilaResponse = await fetch(LIPILA_CARD_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": process.env.LIPILA_API_KEY
        },
        body: JSON.stringify({
          customerInfo: {
            firstName: first,
            lastName: last,
            phoneNumber: accountNumber,
            email: buyerEmail,
            city: String(body.city || "Lusaka").trim(),
            country: "ZM",
            address: "",
            zip: ""
          },
          collectionRequest: {
            referenceId: referenceId,
            amount: amount,
            narration: "Tamba.Events ticket",
            currency: "ZMW",
            backUrl: siteUrl + "/",
            referenceData: buyerName
          }
        })
      });

      const cardText = await lipilaResponse.text();
      console.log("Lipila card status:", lipilaResponse.status);

      let cardData = {};
      try { cardData = JSON.parse(cardText); } catch { cardData = {}; }

      const redirectUrl = cardData.cardRedirectionUrl || (cardData.data && cardData.data.cardRedirectionUrl);

      if (!lipilaResponse.ok || !redirectUrl) {
        console.error("Lipila card request failed:", cardText);
        await dbRpc("mark_payment_failed", {
          p_reference: referenceId,
          p_reason: "Lipila card request failed (HTTP " + lipilaResponse.status + ")"
        });
        return res.status(502).json({
          success: false,
          message: "The card payment could not be started. Please try again in a moment."
        });
      }

      return res.status(200).json({
        success: true,
        referenceId: referenceId,
        amount: amount,
        cardRedirectionUrl: redirectUrl
      });
    }

    /* 4b. Mobile money: Lipila sends the prompt to the customer's phone. */
    console.log("Creating MoMo payment:", { referenceId, amount });

    const lipilaResponse = await fetch(LIPILA_MOMO_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": process.env.LIPILA_API_KEY
      },
      body: JSON.stringify({
        referenceId: referenceId,
        amount: amount,
        narration: "Tamba.Events ticket",
        accountNumber: accountNumber,
        currency: "ZMW",
        referenceData: buyerName
      })
    });

    const responseText = await lipilaResponse.text();
    console.log("Lipila MoMo status:", lipilaResponse.status);

    if (!lipilaResponse.ok) {
      console.error("Lipila rejected MoMo request:", responseText);
      await dbRpc("mark_payment_failed", {
        p_reference: referenceId,
        p_reason: "Lipila rejected the request (HTTP " + lipilaResponse.status + ")"
      });
      return res.status(502).json({
        success: false,
        message: "The mobile money request could not be sent. Please try again in a moment."
      });
    }

    return res.status(200).json({
      success: true,
      referenceId: referenceId,
      amount: amount,
      network: method
    });

  } catch (error) {
    console.error("CREATE PAYMENT ERROR:", error);
    return res.status(500).json({ success: false, message: "Payment could not be started. Please try again." });
  }
};
