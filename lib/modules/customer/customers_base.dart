import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/framework.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:thingsboard_app/config/routes/router.dart';
import 'package:thingsboard_app/core/entity/entities_base.dart';
import 'package:thingsboard_app/generated/l10n.dart';
import 'package:thingsboard_app/locator.dart';
import 'package:thingsboard_app/thingsboard_client.dart';
import 'package:thingsboard_app/utils/services/tb_client_service/i_tb_client_service.dart';

mixin CustomersBase on EntitiesBase<Customer, PageLink> {
  @override
  String title(BuildContext context) => S.of(context).customers;

  @override
  String noItemsFoundText(BuildContext context) =>
      S.of(context).noCustomersFound;
  final tbClient = getIt<ITbClientService>().client;
  @override
  Future<PageData<Customer>> fetchEntities(
    PageLink pageLink, {
    bool refresh = false,
  }) {
    return tbClient.getCustomerService().getCustomers(pageLink);
  }

  @override
  void onEntityTap(Customer customer, WidgetRef ref) {
    getIt<Get220vAppRouter>().navigateTo(
      '/customers/customer/${customer.id!.id}',
    );
  }
}
