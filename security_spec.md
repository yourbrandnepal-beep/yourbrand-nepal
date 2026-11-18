# RRchat 1 Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **PII Isolation**: `/users/{userId}` (containing `email`) is readable and writable ONLY by the owning `request.auth.uid == userId` or verified admin; never exposed via blanket `isSignedIn()` reads.
2. **Public Directory Zero-PII**: `/publicNodes/{userId}` never stores emails, phone numbers, or secret keys, and `allow list` requires `resource.data.discoverable == true`.
3. **Master Gate Membership**: Any read (`get`) or write (`create`, `update`) on `/rooms/{roomId}/messages/{messageId}` requires membership in `/rooms/{roomId}/members/{request.auth.uid}` (`exists(...)`).
4. **Atomic Room Creation**: Creating `/rooms/{roomId}` requires atomically creating `/rooms/{roomId}/members/{request.auth.uid}` and `/users/{request.auth.uid}/roomLinks/{roomId}` (`existsAfter`) in the same write batch.
5. **E2EE Opacity & Strict Schemas**: `/rooms/{roomId}/messages/{messageId}` rejects unknown/shadow fields (`keys().hasOnly(...)`), enforces bounded `participantUids` (`size <= 25`), requires `senderUid == request.auth.uid`, and rejects unverified emails (`email_verified == true`).
6. **Temporal Integrity**: All `createdAt`, `updatedAt`, `joinedAt`, and `lastActiveAt` fields must equal `request.time`.
7. **Immutable Ownership & Terminal Recall**: `ownerId`, `senderUid`, `uid`, and `createdAt` cannot change on update; once `recalled == true` on a message, it cannot be un-recalled (`existing().recalled == false`).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Identity Spoofing on Profile Create**: `{ uid: "victim_uid", ... }` by attacker -> `PERMISSION_DENIED` (`uid != request.auth.uid`).
2. **Privilege Escalation / Ghost Field on Profile**: `{ uid: auth.uid, ..., isAdmin: true }` -> `PERMISSION_DENIED` (`keys().hasOnly(...)`).
3. **Cross-User PII Read**: Non-owner `get(/users/victim_uid)` -> `PERMISSION_DENIED`.
4. **Email Unverified Write**: Verified check fails when `request.auth.token.email_verified == false` -> `PERMISSION_DENIED`.
5. **Admin Spoof via Unverified Email**: Token with `email == "yourbrand.nepal@gmail.com"` and `email_verified == false` -> `PERMISSION_DENIED`.
6. **ID Poisoning**: Document ID > 128 chars or containing `../$` on `/rooms/{roomId}` -> `PERMISSION_DENIED` (`isValidId()`).
7. **Orphaned Room Create (Broken Atomicity)**: Create `/rooms/r1` without batched `/rooms/r1/members/{uid}` -> `PERMISSION_DENIED` (`existsAfter(...)`).
8. **Non-Member Message Injection**: Outsider creates `/rooms/r1/messages/m1` -> `PERMISSION_DENIED` (`isRoomMember` fails).
9. **Client-Forged Timestamp**: Message `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` -> `PERMISSION_DENIED`.
10. **Shadow Update / Type Poisoning on Message Recall**: Update `ciphertextB64: 12345` or mutate `senderUid` -> `PERMISSION_DENIED` (`isValidMessage` + `affectedKeys().hasOnly`).
11. **Terminal State Reversal**: Un-recall message (`existing().recalled == true` -> `incoming().recalled == false`) -> `PERMISSION_DENIED`.
12. **Blanket List Query Scraping**: List `/presence` without `sharePresence == true` or list `/users` across other UIDs -> `PERMISSION_DENIED`.
13. **ChatRooms Sync Metadata Isolation**: `/chatRooms/{chatRoomId}` enforces `request.auth.uid in existing().participantUids` on `list`, requires atomic membership (`existsAfter`) on `create`, prevents non-owners from mutating `participantUids` or `title`, and rejects oversized strings (`lastMessagePreview <= 160`).
