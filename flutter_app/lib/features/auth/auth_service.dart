import 'dart:convert';
import 'dart:math';
import 'package:cryptography/cryptography.dart';
import '../storage/secure_vault.dart';

/// Client-side authentication helper enforcing strong password policy,
/// Argon2id key derivation (for local key wrapping / server verifier),
/// and zero-phone username validation.
class AuthService {
  final SecureVault _vault;

  AuthService(this._vault);

  static bool isUsernameValid(String username) {
    final clean = username.trim().toLowerCase();
    final regex = RegExp(r'^[a-z0-9][a-z0-9_.-]{1,30}[a-z0-9]$');
    return regex.hasMatch(clean);
  }

  static String? validatePasswordStrength(String password, String username) {
    if (password.length < 12) {
      return 'Password must be at least 12 characters.';
    }
    if (!RegExp(r'[A-Z]').hasMatch(password) ||
        !RegExp(r'[a-z]').hasMatch(password) ||
        !RegExp(r'[0-9]').hasMatch(password) ||
        !RegExp(r'[^A-Za-z0-9]').hasMatch(password)) {
      return 'Password must include uppercase, lowercase, digit, and symbol.';
    }
    if (username.trim().length >= 3 &&
        password.toLowerCase().contains(username.trim().toLowerCase())) {
      return 'Password must not contain your username.';
    }
    return null;
  }

  /// Derives a 256-bit key using Argon2id (64 MiB memory, 3 iterations).
  Future<List<int>> deriveArgon2idKey({
    required String password,
    required List<int> salt,
  }) async {
    final argon2id = Argon2id(
      memory: 65536,
      parallelism: 1,
      iterations: 3,
      hashLength: 32,
    );
    final secretKey = await argon2id.deriveKeyFromPassword(
      password: password,
      nonce: salt,
    );
    return secretKey.extractBytes();
  }

  String generateRandomPickleKey() {
    final rng = Random.secure();
    final bytes = List<int>.generate(32, (_) => rng.nextInt(256));
    return base64UrlEncode(bytes);
  }

  Future<void> logout() => _vault.wipeAll();
}
