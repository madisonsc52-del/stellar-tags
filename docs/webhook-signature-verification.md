# Webhook Signature Verification

Every webhook POST sent by Stellar Tags includes an HMAC-SHA256 signature so
merchants can confirm the request genuinely came from the platform and has not
been tampered with in transit.

## Headers

| Header | Description |
|---|---|
| `X-Webhook-Signature` | Hex-encoded HMAC-SHA256 of the raw JSON body, signed with the webhook secret. |
| `X-Stellar-Tags-Signature` | Alias for `X-Webhook-Signature` — kept for backward compatibility. |
| `X-Webhook-Timestamp` | ISO 8601 timestamp (`payload.timestamp`) included in the signed body. |

> Prefer `X-Webhook-Signature` for new integrations.

## How the signature is computed

```
HMAC-SHA256( key=<webhook_secret>, message=<raw JSON body> )
```

The raw JSON body is the exact byte sequence sent over the wire.  
The webhook secret is the value you supplied when registering your webhook URL.

## Verifying in Node.js

```js
const crypto = require('crypto');

/**
 * Returns true when the request body matches the signature.
 *
 * @param {string} secret      - The webhook secret you registered.
 * @param {string} rawBody     - The raw request body (Buffer or string).
 * @param {string} sigHeader   - Value of the X-Webhook-Signature header.
 */
function verifySignature(secret, rawBody, sigHeader) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison prevents timing-oracle attacks.
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(sigHeader, 'hex'),
  );
}

// Express example ─ use express.raw() to keep the body as a Buffer.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  if (!sig || !verifySignature(process.env.WEBHOOK_SECRET, req.body, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(req.body.toString());
  console.log('Verified webhook event:', payload.event);
  res.sendStatus(200);
});
```

## Verifying in Python

```python
import hashlib
import hmac
import json
from flask import Flask, request, abort

app = Flask(__name__)
WEBHOOK_SECRET = b"your_webhook_secret"

@app.route("/webhook", methods=["POST"])
def webhook():
    raw_body = request.get_data()  # keep raw bytes before parsing
    sig = request.headers.get("X-Webhook-Signature", "")

    expected = hmac.new(WEBHOOK_SECRET, raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        abort(401, "Invalid signature")

    payload = json.loads(raw_body)
    print("Verified event:", payload["event"])
    return "", 200
```

## Verifying in Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "net/http"
)

func verifySignature(secret, rawBody []byte, sigHeader string) bool {
    mac := hmac.New(sha256.New, secret)
    mac.Write(rawBody)
    expected := hex.EncodeToString(mac.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(sigHeader))
}

func webhookHandler(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    sig := r.Header.Get("X-Webhook-Signature")

    if !verifySignature([]byte("your_webhook_secret"), body, sig) {
        http.Error(w, "Invalid signature", http.StatusUnauthorized)
        return
    }
    // process payload ...
    w.WriteHeader(http.StatusOK)
}
```

## Security recommendations

- **Always verify** the signature before trusting the payload.
- Use **`timingSafeEqual`** (or `hmac.compare_digest` in Python, `hmac.Equal`
  in Go) — regular string equality is vulnerable to timing attacks.
- Rotate your webhook secret immediately if you suspect it has been leaked.
- Optionally reject requests whose `X-Webhook-Timestamp` is more than five
  minutes in the past to defend against replay attacks.

## Replay-attack guard (optional)

```js
function isRecentTimestamp(isoTimestamp, toleranceMs = 5 * 60 * 1000) {
  const age = Date.now() - new Date(isoTimestamp).getTime();
  return Math.abs(age) <= toleranceMs;
}

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  const payload = JSON.parse(req.body.toString());

  if (!isRecentTimestamp(payload.timestamp)) {
    return res.status(401).json({ error: 'Timestamp too old — possible replay attack' });
  }
  if (!verifySignature(process.env.WEBHOOK_SECRET, req.body, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log('Verified webhook event:', payload.event);
  res.sendStatus(200);
});
```
