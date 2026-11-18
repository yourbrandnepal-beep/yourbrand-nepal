# RRchat 1 — Security & System Architecture

## 1. Cryptographic Design
- **Live Web Client Prototype (`/src/lib/crypto.ts`)**:
  - **Device Identity & Key Exchange**: Each device generates an `ECDSA P-256` signing keypair and an `ECDH P-256` key-agreement keypair via the browser WebCrypto API (`window.crypto.subtle`).
  - **Room Keys**: Each 1:1 or Smart Room uses a 256-bit `AES-GCM` symmetric key generated on the creator's device and wrapped individually for every active participant device via `ECDH P-256` + `HKDF-SHA256` (`RRchat1-RoomKeyWrap-v1`).
  - **Message & Media Encryption**: Every message (including edits), photo, video, file, and voice note binary + filename metadata is encrypted locally using `AES-256-GCM` with a fresh 96-bit CSPRNG IV before transmission.
  - **Zero-Plaintext API Boundary**: `/backend/app.ts` explicitly rejects any message creation or edit request containing `plaintext`, `body`, `text`, or `message` fields (`400 Bad Request`).
  - **Key Backup**: Private key vaults are encrypted locally using `PBKDF2-SHA256` (310,000 iterations) + `AES-256-GCM` before upload to `/api/keys/backup`.

- **Native Flutter Client (`/flutter_app/`)**:
  - Uses the audited `matrix` Dart SDK targeting **Olm** (1:1) and **Megolm** (group) ratcheting over Matrix Synapse, backed by `flutter_secure_storage` (Android Keystore, iOS Keychain, Windows DPAPI) and `sqflite_sqlcipher`.
  - **Honest Status**: Native Android, iOS, and Windows E2EE builds are scaffolded in `flutter_app/` (`RRChatTheme`, `HomeShell`, Matrix crypto stubs) and require Stage 7 native toolchain testing before claiming cross-platform E2EE completion.

## 2. Authentication & Next-Gen Privacy Features
- Unique lowercase usernames without requiring public phone numbers. Contact numbers, Vault PINs, gaming handles, Discord invites, and wallet balances remain strictly private.
- Passwords hashed with **Argon2id** (`m=65536 KiB, t=3, p=1`) via `@noble/hashes/argon2.js`.
- Optional **RFC 6238 TOTP 2FA** + 8 single-use recovery codes (stored hashed).
- **Private Vault**: Dedicated PIN-protected view (`PUT /api/vault/pin`, `POST /api/vault/verify`, `PATCH /api/rooms/:id/vault`).
- **Ghost Chat**: Disappearing message timers with explicit UI disclosure that timers cannot prevent screenshots, copying, or exported media.
- **Security Radar & Emergency Privacy Mode**: Real-time unknown/unverified device radar, Trusted Device approval, and one-click session revocation + screen lock (`POST /api/security/emergency-lock`).
- **3D Identity Studio**: Procedural 5-part Three.js avatar customization (`PUT /api/profile/identity3d`).
- **Opt-In RR AI Assistant**: Server-side Gemini proxy (`POST /api/ai/assist`, `POST /api/ai/transcribe`) strictly requiring explicit `consentGranted: true` on every invocation.
- **Admin & Moderation Console**: Metadata-only server health and abuse report resolution (`/api/admin/overview`) with zero plaintext or private key access.
