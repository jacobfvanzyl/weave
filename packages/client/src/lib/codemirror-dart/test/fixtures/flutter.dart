import 'package:flutter/material.dart';

part 'widgets/card.dart';

/// Displays the current account status.
@immutable
class AccountCard extends StatelessWidget {
  const AccountCard({super.key, required this.title, required this.count});

  final String title;
  final int count;

  @override
  Widget build(BuildContext context) {
    final label = count == 1 ? 'item' : 'items';
    final raw = r'raw \ string';
    final message = '''
      $title has ${count + 1} $label.
    ''';

    return Column(
      children: [
        if (count > 0)
          Text(message)
            ..toString(),
        for (final value in [1, 2, 3]) Text('$value'),
      ],
    );
  }
}

/* nested /* block */ comment */

typedef Loader<T extends Object> = Future<T> Function();

extension AccountRecord on (String, int) {
  bool get isReady => this.$2 > 0;
}
