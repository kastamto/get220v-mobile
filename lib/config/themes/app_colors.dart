import 'package:flutter/material.dart';

class AppColors {
  AppColors._();
  
  // Primary Brand Colors (Get220v Theme)
  static const primaryBlue = Color(0xFF6F42C1);
  static const secondaryBlue = Color(0xFF007BFF);
  static const darkPrimaryBlue = Color(0xFF9F7FD4);
  
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
  static const selectionColor = Color(0x336F42C1);
  static const focusColor = primaryBlue;
  
  // Material Color Swatch for Get220v Purple
  static const MaterialColor primarySwatch = MaterialColor(0xFF6F42C1, <int, Color>{
    50: Color(0xFFEDE7F6),
    100: Color(0xFFD1C4E9),
    200: Color(0xFFB39DDB),
    300: Color(0xFF9575CD),
    400: Color(0xFF7E57C2),
    500: primaryBlue,
    600: Color(0xFF5E35B1),
    700: Color(0xFF512DA8),
    800: Color(0xFF4527A0),
    900: Color(0xFF311B92),
  });
  
  // Dark Theme
  static const MaterialColor darkPrimarySwatch = MaterialColor(0xFF6F42C1, <int, Color>{
    50: Color(0xFFEDE7F6),
    100: Color(0xFFD1C4E9),
    200: Color(0xFF9F7FD4),
    300: Color(0xFF9575CD),
    400: Color(0xFF7E57C2),
    500: darkPrimaryBlue,
    600: secondaryBlue,
    700: Color(0xFF512DA8),
    800: primaryBlue,
    900: Color(0xFF311B92),
  });
  
  static Color get appPrimaryColor => primaryBlue;
}
