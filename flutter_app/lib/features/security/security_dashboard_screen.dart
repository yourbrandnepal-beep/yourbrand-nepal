import 'package:flutter/material.dart';

class SecurityDashboardScreen extends StatelessWidget {
  const SecurityDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: const [
        Text(
          'Security & Device Trust',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
        ),
        SizedBox(height: 16),
        Card(
          child: ListTile(
            leading: Icon(Icons.key),
            title: Text('Hardware Key Storage'),
            subtitle: Text('Android Keystore · iOS Keychain · Windows Credential Manager'),
          ),
        ),
        SizedBox(height: 10),
        Card(
          child: ListTile(
            leading: Icon(Icons.verified_user),
            title: Text('Matrix Olm/Megolm E2EE'),
            subtitle: Text('Pending native cross-platform testing (Stage 4 & Stage 7)'),
          ),
        ),
        SizedBox(height: 10),
        Card(
          child: ListTile(
            leading: Icon(Icons.notifications_off),
            title: Text('Notification Preview Redaction & Privacy Shield'),
            subtitle: Text('Hide sender and message body in OS notifications by default'),
          ),
        ),
        SizedBox(height: 10),
        Card(
          child: ListTile(
            leading: Icon(Icons.calculate_outlined),
            title: Text('Duress PIN & App Decoy'),
            subtitle: Text('Secondary PIN triggers decoy screen / session revocation. External copies cannot be erased remotely.'),
          ),
        ),
      ],
    );
  }
}
