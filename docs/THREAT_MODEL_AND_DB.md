# RRchat 1 — Threat Model, Database Schema & API Contract

## 1. PostgreSQL Production Database Schema (Companion to Matrix Synapse)
While the interactive web prototype uses an isolated JSON-backed local persistence store (`data/rrchat_state.json`) and Matrix Synapse manages federated room DAGs in `/infra/synapse/`, the production RRchat 1 PostgreSQL schema enforces strict separation between identity metadata, opaque E2EE blobs, and private user fields:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  bio VARCHAR(160) DEFAULT '',
  password_hash TEXT NOT NULL,              -- Argon2id (m=65536, t=3, p=1)
  contact_number_hash TEXT,                 -- Private SHA-256 salted digest; never public
  vault_pin_hash TEXT,                      -- Private SHA-256 salted PIN digest
  identity_3d_json JSONB NOT NULL,          -- Avatar form/finish/aura/badge/theme
  totp_enabled BOOLEAN DEFAULT FALSE,
  totp_secret_enc TEXT,
  suspended BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE devices (
  device_id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(64) NOT NULL,
  platform VARCHAR(16) NOT NULL,            -- Android | iOS | Windows | Web
  identity_pub_jwk JSONB NOT NULL,          -- ECDSA P-256 public key
  ecdh_pub_jwk JSONB NOT NULL,              -- ECDH P-256 public key
  fingerprint CHAR(64) NOT NULL,
  verified_by_user BOOLEAN DEFAULT FALSE,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE rooms (
  id UUID PRIMARY KEY,
  room_type VARCHAR(16) NOT NULL,           -- direct | group (Smart Room)
  title VARCHAR(64),
  topic VARCHAR(140),
  invite_only BOOLEAN DEFAULT TRUE,
  slow_mode_seconds INT,
  disappearing_ttl_seconds INT,
  encrypted_room_keys JSONB NOT NULL,       -- Per-device wrapped AES-256-GCM keys
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id),
  sender_device_id UUID REFERENCES devices(device_id),
  kind VARCHAR(16) NOT NULL,                -- text | image | video | file | voice | payment | call
  ciphertext_b64 TEXT NOT NULL,             -- Strictly AES-256-GCM ciphertext; zero plaintext
  iv_b64 TEXT NOT NULL,
  attachment_ciphertext_b64 TEXT,
  attachment_iv_b64 TEXT,
  edited_at TIMESTAMPTZ,
  deleted BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE call_logs (
  id UUID PRIMARY KEY,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  caller_id UUID REFERENCES users(id),
  call_mode VARCHAR(8) NOT NULL,            -- audio | video
  status VARCHAR(16) NOT NULL,              -- completed | missed | declined | canceled
  duration_seconds INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE abuse_reports (
  id UUID PRIMARY KEY,
  reporter_id UUID REFERENCES users(id),
  target_id UUID REFERENCES users(id),
  reason VARCHAR(300) NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 2. STRIDE Threat Model & Mitigations

| Threat Category | Attack Vector | RRchat 1 Control | Honest Residual Risk |
| :--- | :--- | :--- | :--- |
| **Spoofing** | Impersonating `@username` or MITM key substitution | Argon2id + RFC 6238 TOTP + QR SHA-256 device key verification + Security Radar unverified-device alerts | Users who skip QR / fingerprint comparison rely on Trust-On-First-Use (TOFU). |
| **Tampering** | Server or network modifying message ciphertext | AES-256-GCM authenticated encryption tags; plaintext payloads rejected at `/api/rooms/:id/messages` (`400`) | Compromised client binary or malicious browser extension on endpoint device. |
| **Repudiation** | Denying admin/moderation or login actions | Timestamped login alerts, Security Radar logs, and abuse report resolution audit records | End-user chat messages remain deniable via symmetric room keys. |
| **Information Disclosure** | Server breach, admin snooping, notification leaks, or screenshot capture | Client-side encryption, Vault App PIN, Emergency Privacy Mode session revocation, redacted notification previews, private fields excluded from public search | **Ghost Chat timers cannot prevent screenshots, screen recording, or copy/paste by a recipient.** Opt-in AI sends only explicitly submitted text to Gemini. |
| **Denial of Service** | Brute-force logins or flooding | Sliding-window rate limiter, IP/account brute-force lockouts, Smart Room slow-mode, Caddy TLS reverse proxy + UFW/nftables | Volumetric Layer-3/4 DDoS requires upstream edge scrubbing (Cloudflare / hosting provider). |
| **Elevation of Privilege** | Admin attempting to read E2EE conversations or non-moderator kicking users | Admin routes (`/api/admin/*`) strictly query metadata/reports/health with zero key/message decryption capability; room kick/settings enforce `room.adminIds` | Local single-instance admin console requires role-based operator scoping in multi-admin enterprise rollouts. |
