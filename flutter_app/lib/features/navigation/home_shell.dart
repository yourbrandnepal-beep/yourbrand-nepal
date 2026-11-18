import 'package:flutter/material.dart';
import '../contacts/contacts_directory_screen.dart';
import '../messaging/inbox_screen.dart';
import '../security/security_dashboard_screen.dart';

/// Responsive shell adapting between Mobile 5-tab bottom navigation
/// (Home, Calls, Contacts, AI, Profile) and Windows Desktop navigation rail.
class HomeShell extends StatefulWidget {
  final VoidCallback onToggleTheme;
  final bool isDarkMode;

  const HomeShell({
    super.key,
    required this.onToggleTheme,
    required this.isDarkMode,
  });

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _selectedIndex = 0;

  Widget _buildBody() {
    switch (_selectedIndex) {
      case 0:
        return const InboxScreen();
      case 1:
        return const Center(
          child: Text('Encrypted WebRTC Calls & Call Log (Stage 7 native verification)'),
        );
      case 2:
        return const ContactsDirectoryScreen();
      case 3:
        return const Center(
          child: Text('RR AI Assistant (Opt-In Consent Required Before Processing)'),
        );
      case 4:
      default:
        return const SecurityDashboardScreen();
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDesktop = MediaQuery.of(context).size.width >= 840;

    return Scaffold(
      appBar: AppBar(
        title: const Text('RRchat 1'),
        actions: [
          IconButton(
            tooltip: 'Toggle Dark / Light Mode',
            icon: Icon(widget.isDarkMode ? Icons.light_mode : Icons.dark_mode),
            onPressed: widget.onToggleTheme,
          ),
          IconButton(
            tooltip: 'Sign Out',
            icon: const Icon(Icons.logout),
            onPressed: () => Navigator.of(context).pushReplacementNamed('/auth'),
          ),
        ],
      ),
      body: isDesktop
          ? Row(
              children: [
                NavigationRail(
                  selectedIndex: _selectedIndex,
                  onDestinationSelected: (i) => setState(() => _selectedIndex = i),
                  labelType: NavigationRailLabelType.all,
                  destinations: const [
                    NavigationRailDestination(icon: Icon(Icons.home_outlined), label: Text('Home')),
                    NavigationRailDestination(icon: Icon(Icons.call_outlined), label: Text('Calls')),
                    NavigationRailDestination(icon: Icon(Icons.people_outline), label: Text('Contacts')),
                    NavigationRailDestination(icon: Icon(Icons.auto_awesome_outlined), label: Text('AI')),
                    NavigationRailDestination(icon: Icon(Icons.shield_outlined), label: Text('Profile')),
                  ],
                ),
                const VerticalDivider(width: 1),
                Expanded(child: _buildBody()),
              ],
            )
          : _buildBody(),
      bottomNavigationBar: isDesktop
          ? null
          : NavigationBar(
              selectedIndex: _selectedIndex,
              onDestinationSelected: (i) => setState(() => _selectedIndex = i),
              destinations: const [
                NavigationDestination(icon: Icon(Icons.home_outlined), label: 'Home'),
                NavigationDestination(icon: Icon(Icons.call_outlined), label: 'Calls'),
                NavigationDestination(icon: Icon(Icons.people_outline), label: 'Contacts'),
                NavigationDestination(icon: Icon(Icons.auto_awesome_outlined), label: 'AI'),
                NavigationDestination(icon: Icon(Icons.person_outline), label: 'Profile'),
              ],
            ),
    );
  }
}
