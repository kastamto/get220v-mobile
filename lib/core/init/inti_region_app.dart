import 'package:flutter/material.dart';
import 'package:flutter_native_splash/flutter_native_splash.dart';
import 'package:thingsboard_app/constants/app_constants.dart';
import 'package:thingsboard_app/core/context/tb_context_widget.dart';
import 'package:thingsboard_app/core/select_region/model/region.dart';
import 'package:thingsboard_app/core/select_region/select_region_screen.dart';
import 'package:thingsboard_app/locator.dart';
import 'package:thingsboard_app/utils/services/endpoint/i_endpoint_service.dart';
import 'package:thingsboard_app/utils/services/local_database/i_local_database_service.dart';
import 'package:thingsboard_app/widgets/tb_progress_indicator.dart';

class Get220vInitRegionApp extends TbPageWidget {
  Get220vInitRegionApp(super.tbContext, {super.key});

  @override
  State<StatefulWidget> createState() => _Get220vInitAppState();
}

class _Get220vInitAppState extends TbPageState<Get220vInitRegionApp> {
  @override
  Widget build(BuildContext context) {
    return FutureBuilder(
      future: getIt<ILocalDatabaseService>().getSelectedRegion(),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return Scaffold(
            body: Container(
              alignment: Alignment.center,
              color: Colors.white,
              child: const TbProgressIndicator(size: 50.0),
            ),
          );
        }

         if ((snapshot.hasError || snapshot.data == null) &&
            !Get220vAppConstants.ignoreRegionSelection) {
                FlutterNativeSplash.remove();
          return SelectRegionScreen(tbContext);
        }
        if (Get220vAppConstants.ignoreRegionSelection) {
          getIt<IEndpointService>().setEndpoint(
            Get220vAppConstants.thingsBoardApiEndpoint,
          );
           getIt<IEndpointService>().setRegion(Region.custom);
        }
 final future = initTbContext();
        return FutureBuilder(
            future: future,
            builder: (context, snapshot) {
              return Scaffold(
                body: Container(
                  alignment: Alignment.center,
                  color: Colors.white,
                  child: !snapshot.hasData ? const SizedBox() :  const TbProgressIndicator(size: 50.0),
                ),
              );
            });
      },
    );
  }
}
