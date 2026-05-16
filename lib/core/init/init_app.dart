import 'package:flutter/material.dart';
import 'package:thingsboard_app/core/context/tb_context_widget.dart';
import 'package:thingsboard_app/widgets/tb_progress_indicator.dart';

class Get220vInitApp extends TbPageWidget {
  Get220vInitApp(super.tbContext, {super.key});

  @override
  State<StatefulWidget> createState() => _Get220vInitAppState();
}

class _Get220vInitAppState extends TbPageState<Get220vInitApp> {
  @override
  void initState() {
    super.initState();
    initTbContext();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      alignment: Alignment.center,
      color: Colors.white,
      child: const TbProgressIndicator(size: 50.0),
    );
  }
}
