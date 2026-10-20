# Text to Email

A Cloudflare Worker that receives inbound SMS/MMS from Telnyx **or** Twilio and
forwards each message to an email via Mailgun, or auto-replies to the sender via
the carrier that delivered it. Numbers can be split across the two carriers —
each number's webhook URL selects which carrier handles it.

## Prerequisites

- A Telnyx account and/or a Twilio account, each with an active SMS-capable
  phone number pointed at this Worker (see Webhook URLs below).
- A Mailgun account with a verified domain and API key for sending emails.
- A Cloudflare account to deploy the Worker.

## Webhook URLs

Point each carrier's inbound webhook at its own path:

| Carrier | Webhook URL                       |
| ------- | --------------------------------- |
| Telnyx  | `https://<worker>/` (or `/telnyx`) |
| Twilio  | `https://<worker>/twilio`         |

`/` remains Telnyx for backward compatibility with existing deployments.

## Environment variables

Set these as Worker secrets (or in `.dev.vars` for local dev, copied from
`.dev.vars.example`).

| Variable            | Used by                          |
| ------------------- | -------------------------------- |
| `MAILGUN_API_KEY`   | Mailgun email send (both carriers) |
| `MAILGUN_DOMAIN`    | Mailgun email send               |
| `FROM_EMAIL`        | Mailgun email send               |
| `TELNYX_API_KEY`      | Telnyx auto-replies              |
| `TWILIO_ACCOUNT_SID` | Twilio (auto-replies + media fetch) |
| `TWILIO_API_KEY_SID`  | Twilio (auto-replies + media fetch) |
| `TWILIO_API_KEY_SECRET` | Twilio (auto-replies + media fetch) |

The Twilio variables are required when you have numbers on Twilio that use
`auto_reply` routes, and also when a `forward_email` route may receive MMS
images: Twilio media URLs require HTTP Basic auth, so the Worker needs the
Twilio credentials to fetch and attach incoming images. Telnyx media URLs are
publicly accessible, so no carrier credentials are needed to forward images
from Telnyx.

Twilio authentication uses an **API Key** (SID + secret), not the account Auth
Token, so the credential can be a Restricted API Key scoped to only what this
Worker needs: read the Messaging Media subresource (image forwarding) and, if
you also use `auto_reply` routes, create/send Messages. Create a Restricted key
in the Twilio Console under Develop → Tools → API keys & tokens, granting the
Messaging read permission (for media) and the Messaging send permission (only
if using `auto_reply`).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis-Industries/telnyx-text-to-email)

## Mapping Numbers to Email

Phone numbers and emails are mapped in [Workers KV](https://developers.cloudflare.com/kv/).
Each inbound message is looked up by its destination number (the number that
received the SMS/MMS) under the key `route:<E.164>`, e.g. `route:+11234567890`.
The route value is JSON describing what to do with messages to that number.

Two route modes are supported:

| Mode             | Value                                            | Behavior                                                                 |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `forward_email`  | `{"mode":"forward_email","email":"jdoe@acme.com"}`| Forward the message (with any MMS images) to `email` via Mailgun.         |
| `auto_reply`     | `{"mode":"auto_reply","reply_text":"Thanks!"}`    | Reply to the sender with `reply_text` via the carrier that delivered it. |

Email forwarding is carrier-independent (Mailgun only). Auto-replies are sent
back through the carrier that delivered the inbound message — the receiving
number's webhook path (`/` or `/telnyx` for Telnyx, `/twilio` for Twilio) selects
which carrier sends the reply, so no route-level carrier config is needed.

| Key                  | Value                                                |
| -------------------- | ---------------------------------------------------- |
| `route:+11234567890` | `{"mode":"forward_email","email":"jdoe@acme.com"}`   |
| `route:+18005551212` | `{"mode":"auto_reply","reply_text":"Leave a message"}`|
