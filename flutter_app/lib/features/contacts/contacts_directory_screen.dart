import 'package:flutter/material.dart';

class ContactsDirectoryScreen extends StatefulWidget {
  const ContactsDirectoryScreen({super.key});

  @override
  State<ContactsDirectoryScreen> createState() => _ContactsDirectoryScreenState();
}

class _ContactsDirectoryScreenState extends State<ContactsDirectoryScreen> {
  final _searchController = TextEditingController();

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Username Directory',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          Text(
            'Search users by unique @username without sharing phone numbers.',
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 13,
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _searchController,
            decoration: const InputDecoration(
              hintText: 'Search @username...',
              prefixIcon: Icon(Icons.search),
            ),
          ),
        ],
      ),
    );
  }
}
