/**
 * telnyx-text-to-email
 *
 * A Cloudflare Worker that receives inbound SMS/MMS webhooks from a messaging
 * provider (Telnyx or Twilio), looks up a per-number route in Workers KV, and
 * either forwards the message to an email (via Mailgun) or auto-replies to the
 * sender (via whichever carrier delivered the message).
 *
 * Architecture overview:
 *   1. Inbound  — Two webhook entry points, one per carrier. Each parses its
 *                 provider-specific payload into a single normalized message
 *                 shape so all downstream logic is provider-agnostic.
 *   2. Routing  — The destination number is looked up in KV. The route decides
 *                 the action (forward_email | auto_reply). Email forwarding is
 *                 identical for both carriers since it only reads the
 *                 normalized message.
 *   3. Outbound — Auto-replies are sent back through the carrier that delivered
 *                 the inbound message (the number's owner). The provider is
 *                 carried on the normalized message, so no route-level config
 *                 is required to pick a sender.
 *
 * Normalized message shape (the contract between inbound parsing and the rest):
 *   {
 *     provider:    "telnyx" | "twilio",
 *     from:        string,            // E.164, or "(Unknown)" for display only
 *     fromForReply: string | null,    // E.164, null when not replyable
 *     to:          string,            // E.164
 *     text:        string,
 *     media:      [{ url, contentType }],
 *     occurredAt:  string (ISO),
 *   }
 */

const ROUTE_KEY_PREFIX = "route:";
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function okResponse() {
  return new Response("OK", { status: 200 });
}

// ---------------------------------------------------------------------------
// Phone number helpers
// ---------------------------------------------------------------------------

// Normalize to E.164 (digits only, prefixed with +). Returns null when invalid.
function normalizePhoneNumber(phoneNumber) {
  if (typeof phoneNumber !== "string") return null;
  const trimmed = phoneNumber.trim();
  if (!trimmed.startsWith("+")) return null;
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (
    digitsOnly.length < E164_MIN_DIGITS ||
    digitsOnly.length > E164_MAX_DIGITS
  ) {
    return null;
  }
  return `+${digitsOnly}`;
}

// ---------------------------------------------------------------------------
// Inbound parsing — one normalizer per carrier
// ---------------------------------------------------------------------------

// Telnyx webhook: JSON body, event lives under data.event_type / data.payload.
// Only inbound "message.received" events are actionable.
async function parseTelnyxInbound(request) {
  const payload = await request.json();
  const data = payload.data;
  if (
    !data ||
    data.event_type !== "message.received" ||
    data.payload.direction !== "inbound"
  ) {
    return null;
  }

  const messagePayload = data.payload;

  // Destination: Telnyx exposes `to` as an array of { phone_number } objects.
  const to =
    (Array.isArray(messagePayload.to) && messagePayload.to[0]?.phone_number) ||
    messagePayload.to?.phone_number ||
    messagePayload.to;

  return {
    provider: "telnyx",
    from: messagePayload?.from?.phone_number || "(Unknown)",
    fromForReply: normalizePhoneNumber(messagePayload?.from?.phone_number),
    to: normalizePhoneNumber(to),
    text: messagePayload.text || "(No text)",
    media: (messagePayload.media || []).map((item) => ({
      url: item.url,
      contentType: item.content_type,
    })),
    occurredAt: data.occurred_at,
  };
}

// Twilio webhook: form-encoded body. Actionable messages are simply inbound
// messages; Twilio has no event-type envelope to filter on.
async function parseTwilioInbound(request) {
  const form = await request.formData();

  // Twilio lists media as MediaUrl0..N with parallel MediaContentType0..N.
  const media = [];
  let i = 0;
  while (form.has(`MediaUrl${i}`)) {
    media.push({
      url: form.get(`MediaUrl${i}`),
      contentType: form.get(`MediaContentType${i}`) || "",
    });
    i += 1;
  }

  return {
    provider: "twilio",
    from: form.get("From") || "(Unknown)",
    fromForReply: normalizePhoneNumber(form.get("From")),
    to: normalizePhoneNumber(form.get("To")),
    text: form.get("Body") || "(No text)",
    media,
    // Twilio doesn't send a server timestamp; use receipt time on the Worker.
    occurredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Routing — KV lookup keyed by destination number
// ---------------------------------------------------------------------------

async function getRoute(env, toPhone) {
  if (!toPhone) return null;
  const raw = await env.NUMBER_TO_EMAIL.get(`${ROUTE_KEY_PREFIX}${toPhone}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Invalid route config JSON:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email composition + Mailgun send (carrier-independent)
// ---------------------------------------------------------------------------

function buildEmailHtml(fromPhone, friendlyDate, text, mediaHtml) {
  return `<h2>New SMS Received</h2>
<p><strong>From:</strong> ${fromPhone}</p>
<p><strong>Received at:</strong> ${friendlyDate}</p>
<p><strong>Message:</strong> ${text}</p>
${mediaHtml}`;
}

function buildEmailText(fromPhone, friendlyDate, text) {
  return `New SMS Received\nFrom: ${fromPhone}\nReceived at: ${friendlyDate}\nMessage: ${text}`;
}

// Send an email via Mailgun with the SMS details and any embedded media.
async function sendMailgunEmail(
  env,
  toEmail,
  fromPhone,
  friendlyDate,
  text,
  mediaHtml,
) {
  if (!toEmail) {
    console.error("Missing recipient email for forward_email route");
    return;
  }
  const html = buildEmailHtml(fromPhone, friendlyDate, text, mediaHtml);
  const plainText = buildEmailText(fromPhone, friendlyDate, text);

  const mailgunData = {
    from: `SMS Alerts <${env.FROM_EMAIL}>`,
    to: toEmail,
    subject: `New SMS from ${fromPhone}`,
    html,
    text: plainText,
    "o:tag": "sms_forward",
  };

  const formData = new URLSearchParams(mailgunData);
  const mailgunResponse = await fetch(
    `https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa("api:" + env.MAILGUN_API_KEY)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    },
  );

  if (!mailgunResponse.ok) {
    console.error("Mailgun error:", await mailgunResponse.text());
  }
}

// ---------------------------------------------------------------------------
// Outbound replies — one sender per carrier
// ---------------------------------------------------------------------------

// Reply via Telnyx using the number that received the inbound as the sender.
async function sendTelnyxReply(env, fromNumber, toNumber, replyText) {
  if (!env.TELNYX_API_KEY) {
    console.error("Missing TELNYX_API_KEY for auto_reply route");
    return;
  }
  const telnyxResponse = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromNumber,
      to: toNumber,
      text: replyText,
    }),
  });

  if (!telnyxResponse.ok) {
    console.error("Telnyx reply error:", await telnyxResponse.text());
  }
}

// Reply via Twilio. Auth is Account SID + Auth Token as HTTP Basic.
async function sendTwilioReply(env, fromNumber, toNumber, replyText) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.error("Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN for auto_reply");
    return;
  }
  const twilioResponse = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(
          `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
        )}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: fromNumber,
        To: toNumber,
        Body: replyText,
      }),
    },
  );

  if (!twilioResponse.ok) {
    console.error("Twilio reply error:", await twilioResponse.text());
  }
}

// Dispatch the auto-reply to the carrier that delivered the inbound message.
// `fromNumber` is the receiving number (message.to), `toNumber` the sender.
async function sendReply(env, message, replyText) {
  const fromNumber = message.to;
  const toNumber = message.fromForReply;
  if (message.provider === "twilio") {
    await sendTwilioReply(env, fromNumber, toNumber, replyText);
  } else {
    await sendTelnyxReply(env, fromNumber, toNumber, replyText);
  }
}

// ---------------------------------------------------------------------------
// Media handling — fetch image attachments and embed them in the email
// ---------------------------------------------------------------------------

// Fetch each image attachment and convert it to a base64 data URI for inline
// embedding. Non-image attachments are skipped. Carrier-agnostic: works off
// the normalized media list.
async function processMedia(media) {
  let mediaHtml = "";
  for (const item of media) {
    if (!item.url) continue;
    // Prefer the content type from the webhook; when absent (Twilio sometimes
    // omits it) fall back to the response Content-Type after fetching.
    const contentType = item.contentType || "";
    if (contentType && !contentType.startsWith("image/")) continue;
    try {
      const response = await fetch(item.url);
      if (!response.ok) continue;
      const resolvedType =
        contentType || response.headers.get("Content-Type") || "";
      if (!resolvedType.startsWith("image/")) continue;

      const arrayBuffer = await response.arrayBuffer();
      const base64Image = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          "",
        ),
      );
      const dataUri = `data:${resolvedType};base64,${base64Image}`;
      mediaHtml += `<p><strong>Image:</strong><br><img src="${dataUri}" alt="MMS Image" style="max-width: 300px;"></p>`;
    } catch (error) {
      console.error("Failed to fetch media:", error);
      mediaHtml += `<p><strong>Image:</strong> Failed to load ${item.url}</p>`;
    }
  }
  return mediaHtml;
}

// ---------------------------------------------------------------------------
// Worker entry point — path-routed inbound webhooks
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Route by path so each carrier dashboard points at its own webhook URL.
    // "/" stays Telnyx for backward compatibility with existing deployments.
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // trim trailing slash

    let message;
    try {
      if (path === "" || path === "/telnyx") {
        message = await parseTelnyxInbound(request);
      } else if (path === "/twilio") {
        message = await parseTwilioInbound(request);
      } else {
        return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      console.error("Inbound parse error:", error);
      return okResponse();
    }

    // Non-actionable events (e.g. Telnyx status updates) normalize to null.
    if (!message) return okResponse();

    if (!message.to) {
      console.error("Missing or invalid destination phone number in payload");
      return okResponse();
    }

    // Look up the route for the number that received the message.
    const route = await getRoute(env, message.to);
    if (!route) {
      console.error(
        `No route configured for destination number: ${message.to}`,
      );
      return okResponse();
    }

    // Dispatch on route mode. Email forwarding is carrier-independent; replies
    // are sent through the carrier that delivered the inbound message.
    if (route.mode === "auto_reply") {
      if (!route.reply_text) {
        console.error("Missing reply_text for auto_reply route");
        return okResponse();
      }
      if (!message.fromForReply) {
        console.error("Cannot auto-reply due to invalid phone format");
        return okResponse();
      }
      await sendReply(env, message, route.reply_text);
    } else if (route.mode === "forward_email") {
      if (!route.email) {
        console.error(
          `Missing email in forward_email route for: ${message.to}`,
        );
        return okResponse();
      }
      const date = new Date(message.occurredAt);
      const friendlyDate = date.toLocaleString("en-US", {
        timeZone: "America/Chicago",
        timeZoneName: "short",
      });
      const mediaHtml = await processMedia(message.media);
      await sendMailgunEmail(
        env,
        route.email,
        message.from,
        friendlyDate,
        message.text,
        mediaHtml,
      );
    } else {
      console.error(`Unsupported route mode: ${route.mode}`);
    }

    return okResponse();
  },
};
