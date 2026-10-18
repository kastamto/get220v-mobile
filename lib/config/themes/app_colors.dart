import 'package:flutter/material.dart';

class AppColors {
  AppColors._();
  
  // Brand Get220v (get220v.com): navy + emas petir, sama dengan ikon & splash
  static const brandNavy = Color(0xFF0C1445);
  static const accentGold = Color(0xFFF5B82E);

  // Nama lama dipertahankan supaya pemakai lain tidak perlu diubah
  static const primaryBlue = brandNavy; // warna utama tema terang
  static const secondaryBlue = accentGold;
  static const darkPrimaryBlue = accentGold; // warna utama tema gelap (emas di atas gelap)
  
  // Surface Colors
  static const white = Color(0xFFFFFFFF);
  static const scaffoldBackground = Color(0xFFFAFAFA);
  static const surfaceLight = Color(0xFFF4F6F8);
  static const black = Color(0xFF000000);
  
  // Text Colors
  static const textPrimary = Color(0xDE000000);
  static const textSecondary = Color(0xC2000000);
  static const textTertiary = Color(0x8A000000);
  static const textDisabled = Color(0x61000000);
  static const textWhite = Color(0xFFFFFFFF);
  static const textDark = Color(0xFF282828);
  
  // Icon Colors
  static const iconSecondary = Color(0xC2000000);
  static const iconTertiary = Color(0x8a000000);
  static const iconDisabled = Color(0x61000000);
  
  // Border Colors
  static const bordersLight = Color(0x1F000000);
  static const borderError = Color(0xFFD12730);
  
  // State Colors
  static const textError = Color(0xFFD12730);
  static const notificationInfo = Color(0xFF323232);
  static const notificationWarning = Color(0xFFdc6d1b);
  static const notificationSuccess = Color(0xFF008000);
  static const notificationError = Color(0xFFD12730);
  
  // Overlay Colors
  static const bgOverlay = Color(0x61000000);
  static const cameraBackground = Color(0xFF828282);
  
  // Selection and Focus Colors
  static const selectionColor = Color(0x330C1445);
  static const focusColor = primaryBlue;
  
  // Material swatch navy Get220v
  static const MaterialColor primarySwatch = MaterialColor(0xFF0C1445, <int, Color>{
    50: Color(0xFFE6E8F2),
    100: Color(0xFFC0C5DF),
    200: Color(0xFF969FC9),
    300: Color(0xFF6C78B3),
    400: Color(0xFF4D5BA3),
    500: Color(0xFF2E3F93),
    600: Color(0xFF26368A),
    700: Color(0xFF1C2A7C),
    800: Color(0xFF13206D),
    900: brandNavy,
  });
  
  // Dark Theme
  static const MaterialColor darkPrimarySwatch = MaterialColor(0xFFF5B82E, <int, Color>{
    50: Color(0xFFFEF6E5),
    100: Color(0xFFFCE8BE),
    200: Color(0xFFFAD993),
    300: Color(0xFFF8CA68),
    400: Color(0xFFF7BF47),
    500: accentGold,
    600: Color(0xFFF4AE28),
    700: Color(0xFFF2A522),
    800: Color(0xFFF09D1C),
    900: Color(0xFFEE8D11),
  });
  
  static Color get appPrimaryColor => primaryBlue;
}
