import 'package:flutter/material.dart';

class InboxScreen extends StatelessWidget {
  final bool standalone;

  const InboxScreen({super.key, this.standalone = false});

  @override
  Widget build(BuildContext context) {
    const pane = _InboxPane();
    if (!standalone) {
      return pane;
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('RRchat 1'),
        actions: [
          IconButton(
            tooltip: 'Sign Out',
            icon: const Icon(Icons.logout),
            onPressed: () => Navigator.of(context).pushReplacementNamed('/auth'),
          ),
        ],
      ),
      body: pane,
    );
  }
}

class _InboxPane extends StatelessWidget {
  const _InboxPane();

  @override
  Widget build(BuildContext context) {
    final mutedColor = Theme.of(context).colorScheme.onSurfaceVariant;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'No synced Matrix rooms yet. Connect to your private RRchat 1 Matrix Synapse homeserver to sync Olm/Megolm encrypted conversations.',
          textAlign: TextAlign.center,
          style: TextStyle(color: mutedColor),
        ),
      ),
    );
  }
}
