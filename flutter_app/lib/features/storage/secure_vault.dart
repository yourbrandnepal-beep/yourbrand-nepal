import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Platform-hardened secret storage:
/// - Android: EncryptedSharedPreferences backed by Android Keystore (AES-256-GCM)
/// - iOS: Keychain (first_unlock_this_device, non-iCloud-synced)
/// - Windows: Windows Credential Manager / DPAPI
class SecureVault {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
      resetOnError: false,
    ),
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
      synchronizable: false,
    ),
    wOptions: WindowsOptions(),
  );

  static const _accessTokenKey = 'rrchat1_access_token';
  static const _deviceIdKey = 'rrchat1_device_id';
  static const _olmPickleKey = 'rrchat1_olm_pickle_secret';
  static const _dbCipherKey = 'rrchat1_sqlcipher_key';

  Future<void> saveSession({
    required String accessToken,
    required String deviceId,
    required String pickleSecret,
  }) async {
    await _storage.write(key: _accessTokenKey, value: accessToken);
    await _storage.write(key: _deviceIdKey, value: deviceId);
    await _storage.write(key: _olmPickleKey, value: pickleSecret);
  }

  Future<String?> readAccessToken() => _storage.read(key: _accessTokenKey);
  Future<String?> readDeviceId() => _storage.read(key: _deviceIdKey);
  Future<String?> readPickleSecret() => _storage.read(key: _olmPickleKey);
  Future<String?> readDatabaseKey() => _storage.read(key: _dbCipherKey);

  Future<void> writeDatabaseKey(String hexKey) =>
      _storage.write(key: _dbCipherKey, value: hexKey);

  Future<void> wipeAll() => _storage.deleteAll();
}
