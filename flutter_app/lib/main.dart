import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app/theme.dart';
import 'features/auth/auth_screen.dart';
import 'features/navigation/home_shell.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: RRChatApp()));
}

class RRChatApp extends StatefulWidget {
  const RRChatApp({super.key});

  @override
  State<RRChatApp> createState() => _RRChatAppState();
}

class _RRChatAppState extends State<RRChatApp> {
  ThemeMode _themeMode = ThemeMode.dark;

  void _toggleTheme() {
    setState(() {
      _themeMode = _themeMode == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RRchat 1',
      debugShowCheckedModeBanner: false,
      theme: RRChatTheme.lightTheme,
      darkTheme: RRChatTheme.darkTheme,
      themeMode: _themeMode,
      initialRoute: '/auth',
      routes: {
        '/auth': (_) => const AuthScreen(),
        '/inbox': (_) => HomeShell(
              onToggleTheme: _toggleTheme,
              isDarkMode: _themeMode == ThemeMode.dark,
            ),
      },
    );
  }
}
