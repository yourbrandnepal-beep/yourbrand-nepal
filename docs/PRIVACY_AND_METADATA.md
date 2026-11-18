# RRchat 1 — Privacy & Server Metadata Policy

## 1. Data Minimization
- No phone number, email address, or real name is required to register an `@username`.
- User conversations and private keys are never sold, monetized, or logged in server telemetry.

## 2. What Remains Encrypted vs. What the Server Processes
| Data Type | Server Access | Reason |
| --- | --- | --- |
| Message bodies & replies | **Unreadable ciphertext** | Encrypted client-side via AES-256-GCM |
| Files, images, voice notes | **Unreadable ciphertext** | Encrypted binary + encrypted filename/MIME |
| Device private keys | **Never uploaded** | Stored in local Keystore / Keychain / Web Vault |
| Room membership & timestamps | **Processed by server** | Required to route messages and enforce disappearing TTL |
| Masked IP subnet & User-Agent | **Processed transiently** | Used for rate-limiting, brute-force protection, and login alerts |

## 3. Notification Privacy
By default (`previewMode: "none"`), notifications avoid decrypting or displaying message content or sender names on lock screens.
