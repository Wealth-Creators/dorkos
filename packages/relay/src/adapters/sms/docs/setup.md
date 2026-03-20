# SMS Adapter Setup

Connect your DorkOS agents to SMS via the [Twilio Messaging API](https://www.twilio.com/docs/sms).

## Requirements

- A [Twilio account](https://www.twilio.com) (free trial works for testing)
- A Twilio phone number capable of sending/receiving SMS
- A publicly accessible HTTPS URL for receiving inbound messages (or an ngrok tunnel for local dev)

---

## Step 1 — Get your Twilio credentials

1. Log in to the [Twilio Console](https://console.twilio.com).
2. On the **Dashboard** home page, find the **Account Info** section.
3. Copy your **Account SID** (starts with `AC`) and **Auth Token**.

> **Keep your Auth Token secret.** It grants full API access to your account. If compromised, rotate it immediately in the Console.

---

## Step 2 — Get a phone number

1. In the Console, go to **Phone Numbers → Manage → Active Numbers**.
2. If you already have a number, copy it in E.164 format (e.g. `+14155552671`).
3. If you need a number, click **Buy a Number**:
   - Filter by country and capabilities (make sure **SMS** is checked)
   - Purchase a number

---

## Step 3 — Configure the adapter

Fill in the fields in the DorkOS adapter configuration:

| Field | Value |
|---|---|
| **Account SID** | From the Console dashboard (starts with `AC`) |
| **Auth Token** | From the Console dashboard |
| **Twilio Phone Number** | Your number in E.164 format (e.g. `+14155552671`) |
| **Webhook Port** | Local port for the inbound server (default `8445`) |
| **Public Webhook URL** | Your public HTTPS URL (see Step 4) |

---

## Step 4 — Configure Twilio to forward inbound SMS

Twilio needs to know where to POST inbound messages.

### Getting a public URL

For **production**: use your server's public domain (e.g. `https://your-server.com/sms`).

For **local development**: use a tunnel tool:
- **ngrok**: `ngrok http 8445` → copies your tunnel URL
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8445`

### Setting the webhook in Twilio

1. Go to **Phone Numbers → Manage → Active Numbers**.
2. Click your number.
3. Scroll to the **Messaging** section.
4. Set **A MESSAGE COMES IN** to your public URL (e.g. `https://abc.ngrok.io`).
5. Set the method to **HTTP POST**.
6. Click **Save**.

> Twilio signs every webhook request with an `X-Twilio-Signature` header. When you set a **Public Webhook URL** in the adapter config, DorkOS validates this signature to reject spoofed requests.

---

## Step 5 — Test it

1. Send an SMS to your Twilio number from any mobile phone.
2. In DorkOS, check **Relay → Trace** — you should see a message arrive on `relay.human.sms.{your_number}`.
3. Create a binding from that subject to an agent to start routing conversations.

---

## Subject Hierarchy

| Pattern | Meaning |
|---|---|
| `relay.human.sms.{digits}` | DM from the E.164 number `+{digits}` |

Example: a message from `+14155552671` arrives on `relay.human.sms.14155552671`.

---

## Notes

- **SMS has no streaming**: agent replies are buffered and sent as a single SMS when the response is complete (or when a `done` event is received). This avoids multiple partial messages.
- **1 600-character limit**: Twilio supports up to 1 600 characters for concatenated SMS (10 segments). Longer responses are truncated with `…`.
- **Markdown is stripped**: SMS is plain text. All markdown formatting is converted before sending.
- **No group chats**: SMS is always a 1:1 channel. All subjects use the `dm` channel type.
