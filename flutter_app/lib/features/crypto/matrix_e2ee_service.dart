import 'package:matrix/encryption/utils/key_verification.dart';
import 'package:matrix/matrix.dart';

/// Matrix-compatible Olm / Megolm End-to-End Encryption Service.
///
/// NOTE: Full native verification on Android, iOS, and Windows requires
/// building with platform libolm/vodozemac binaries (Roadmap Stages 4 & 7).
class MatrixE2EEService {
  final Client client;

  MatrixE2EEService(this.client);

  bool get isEncryptionReady => client.encryptionEnabled;

  /// Returns device Ed25519 / Curve25519 fingerprint for out-of-band SAS comparison.
  String? get ownDeviceFingerprint => client.fingerprintKey;

  Future<void> bootstrapCrossSigningAndBackup({
    required String recoveryPassphrase,
  }) async {
    final encryption = client.encryption;
    if (encryption == null) {
      throw StateError('Matrix E2EE module is not initialized.');
    }
    await encryption.bootstrap(
      onUpdate: (_) {},
    );
    // Secure Server-Side Key Backup (SSSS) encrypted locally with recovery passphrase
    await encryption.keyManager.storeInSSSS(recoveryPassphrase);
  }

  Future<KeyVerification> startDeviceVerification(
    String targetUserId,
    String targetDeviceId,
  ) async {
    final deviceKeys = client.userDeviceKeys[targetUserId]?.deviceKeys[targetDeviceId];
    if (deviceKeys == null) {
      throw StateError('Target device keys not yet synced from homeserver.');
    }
    return deviceKeys.startVerification();
  }

  Future<void> sendEncryptedText(Room room, String plaintext) async {
    if (!room.encrypted) {
      throw StateError('Refusing to send message in an unencrypted room.');
    }
    await room.sendTextEvent(plaintext);
  }
}
