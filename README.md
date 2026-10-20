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
| `TELNYX_API_KEY`    | Telnyx auto-replies              |
| `TWILIO_ACCOUNT_SID`| Twilio auto-replies              |
| `TWILIO_AUTH_TOKEN` | Twilio auto-replies              |

The Twilio variables are required when you have numbers on Twilio that use
`auto_reply` routes, and also when a `forward_email` route may receive MMS
images: Twilio media URLs require HTTP Basic auth, so the Worker needs the
Twilio credentials to fetch and attach incoming images. Telnyx media URLs are
publicly accessible, so no carrier credentials are needed to forward images
from Telnyx.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis-Industries/telnyx-text-to-email)

## Mapping Numbers to Email
Phone numbers and emails are mapped in [Workers KV](https://developers.cloudflare.com/kv/), following the format below. The script searches for the sending number in the KV namespace and extracts the email to forward the message to.

| Key | Value |
| ------------- | ------------- |
| route:+11234567890  | {"mode":"forward_email","email":"jdoe@acme.com"}  |


`cachedNumberToEmail` is scoped to the module

`getNumberToEmailMap()` returns immediately after the first call because it is scoped to the module. It will return the already-parsed JSON
