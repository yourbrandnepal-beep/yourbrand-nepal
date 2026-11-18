import 'package:flutter/material.dart';
import '../../app/theme.dart';
import '../storage/secure_vault.dart';
import 'auth_service.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _totpController = TextEditingController();
  bool _isRegister = false;
  bool _requireTotp = false;
  String? _error;

  void _submit() {
    final username = _usernameController.text.trim().toLowerCase();
    final password = _passwordController.text;

    if (!AuthService.isUsernameValid(username)) {
      setState(() => _error = 'Username must be 3–32 lowercase alphanumeric characters.');
      return;
    }

    if (_isRegister) {
      final pwErr = AuthService.validatePasswordStrength(password, username);
      if (pwErr != null) {
        setState(() => _error = pwErr);
        return;
      }
    }

    setState(() => _error = null);
    // In Stage 3/4 native integration, this binds to the Matrix Client login/register flow.
    Navigator.of(context).pushReplacementNamed('/inbox');
  }

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    _totpController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Card(
            margin: const EdgeInsets.all(24),
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'RRchat 1',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _isRegister
                        ? 'Create a username-only private account'
                        : 'Sign in to your encrypted device vault',
                    style: const TextStyle(color: Colors.white70, fontSize: 13),
                  ),
                  const SizedBox(height: 24),
                  if (_error != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: RRChatTheme.danger.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: RRChatTheme.danger.withValues(alpha: 0.5)),
                      ),
                      child: Text(_error!, style: const TextStyle(fontSize: 12)),
                    ),
                    const SizedBox(height: 16),
                  ],
                  TextField(
                    controller: _usernameController,
                    decoration: const InputDecoration(
                      labelText: 'Username',
                      prefixText: '@',
                    ),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _passwordController,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'Password (12+ chars)',
                    ),
                  ),
                  if (_requireTotp) ...[
                    const SizedBox(height: 14),
                    TextField(
                      controller: _totpController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: '2FA Authenticator Code',
                      ),
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _submit,
                    style: FilledButton.styleFrom(
                      backgroundColor: RRChatTheme.accent,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: Text(_isRegister ? 'Create Encrypted Account' : 'Sign In'),
                  ),
                  const SizedBox(height: 12),
                  TextButton(
                    onPressed: () => setState(() {
                      _isRegister = !_isRegister;
                      _requireTotp = false;
                      _error = null;
                    }),
                    child: Text(_isRegister
                        ? 'Already have an account? Sign in'
                        : 'Need a private username? Register'),
                  ),
                  TextButton(
                    onPressed: () async {
                      await SecureVault().wipeAll();
                    },
                    child: const Text('Clear Local Secure Vault', style: TextStyle(fontSize: 12)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
