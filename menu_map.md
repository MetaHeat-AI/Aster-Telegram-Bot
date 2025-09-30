# 🗺️ **StableSolid Bot Menu Structure Map**

## **Access Requirements Legend:**
- 🔓 **No Access Required** - Available to everyone
- 🔒 **Access Required** - Requires group membership OR referral code  
- 🔐 **API Required** - Requires linked API credentials

---

## **1. 🏠 Welcome Menu** `/start` 🔓
**Function:** First interaction, shows bot features
```
┌─ Secure Connect (link_api) 🔒
├─ Help (help) 🔓
├─ Trade (unified_trade) 🔒
└─ Functions (show_commands) 🔒
```

---

## **2. 🏠 Main Menu** `main_menu` 🔒
**Function:** Central hub for all bot features
```
┌─ 📈 Trade (unified_trade) 🔐
├─ 💰 Balance (balance) 🔐
├─ 📊 Positions (positions) 🔐
├─ 📊 Prices (price_menu) 🔒
├─ 📈 P&L Analysis (pnl_analysis) 🔐
├─ ⚙️ Settings (settings) 🔒
├─ 🔗 Link API (link_api) 🔒
└─ 📖 Help (help) 🔓
```

---

## **3. 📈 Trading Menu** `unified_trade` 🔒
**Function:** Choose trading type (spot/perps)
```
┌─ Spot Trading (trade_spot) 🔐
├─ Perps Trading (trade_perps) 🔐
├─ View Positions (positions) 🔐
├─ Check Balance (balance) 🔐
└─ Back to Home (back_to_home) 🔒
```

---

## **4. 🏪 Spot Trading Menu** `trade_spot` 🔐
**Function:** Buy/sell spot assets
```
┌─ [Dynamic: Symbol buttons] (spot_buy_SYMBOL) 🔐
├─ 🎯 Custom Pair (spot_custom_pair) 🔐
├─ 💱 Sell Assets (spot_sell_menu) 🔐
├─ 🏦 My Assets (spot_assets) 🔐
├─ 💰 Balance (balance) 🔐
├─ ⚡ Switch to Perps (trade_perps) 🔐
└─ 🔙 Back (unified_trade) 🔒
```

---

## **5. ⚡ Perps Trading Menu** `trade_perps` 🔐
**Function:** Long/short perpetual futures
```
┌─ [Dynamic: Long/Short buttons] (perps_buy/sell_SYMBOL) 🔐
├─ 🎯 Custom Pair (perps_custom_pair) 🔐
├─ 📊 Positions (positions) 🔐
├─ 💰 Balance (balance) 🔐
├─ 🏪 Switch to Spot (trade_spot) 🔐
└─ 🔙 Back (unified_trade) 🔒
```

---

## **6. 🎯 Spot Symbol Menu** `spot_buy_SYMBOL` 🔐
**Function:** Execute spot trades for specific asset
```
┌─ 🟢 $25 (spot_execute_buy_SYMBOL_25u) 🔐
├─ 🟢 $50 (spot_execute_buy_SYMBOL_50u) 🔐
├─ 🟢 $100 (spot_execute_buy_SYMBOL_100u) 🔐
├─ 🟢 $250 (spot_execute_buy_SYMBOL_250u) 🔐
├─ 💰 Custom Buy (spot_custom_amount_buy_SYMBOL) 🔐
├─ 🔴 Sell ASSET (spot_custom_amount_sell_SYMBOL) 🔐
├─ ⚡ Switch to Perps (trade_perps) 🔐
└─ 🔙 Back (trade_spot) 🔐
```

---

## **7. ⚡ Perps Symbol Menu** `perps_buy/sell_SYMBOL` 🔐
**Function:** Execute perps trades for specific asset
```
┌─ 📈 Long $25 5x (perps_execute_buy_SYMBOL_25u_5x) 🔐
├─ 📉 Short $25 5x (perps_execute_sell_SYMBOL_25u_5x) 🔐
├─ 📈 Long $50 10x (perps_execute_buy_SYMBOL_50u_10x) 🔐
├─ 📉 Short $50 10x (perps_execute_sell_SYMBOL_50u_10x) 🔐
├─ 📈 Long $100 5x (perps_execute_buy_SYMBOL_100u_5x) 🔐
├─ 📉 Short $100 5x (perps_execute_sell_SYMBOL_100u_5x) 🔐
├─ 💰 Custom Long (perps_custom_amount_buy_SYMBOL) 🔐
├─ 💰 Custom Short (perps_custom_amount_sell_SYMBOL) 🔐
├─ 🏪 Switch to Spot (trade_spot) 🔐
└─ 🔙 Back (trade_perps) 🔐
```

---

## **8. 🔗 API Linking Flow** `link_api` 🔒
**Function:** Connect user's AsterDEX API credentials
```
Step 1: API Key Input
┌─ ❌ Cancel (cancel_linking) 🔒

Step 2: API Secret Input  
┌─ ❌ Cancel (cancel_linking) 🔒

Step 3: Success
┌─ 📊 View Balance (balance) 🔐
└─ 🏠 Main Menu (main_menu) 🔒
```

---

## **9. 🔓 Unlink Confirmation** `unlink` 🔐
**Function:** Remove API credentials
```
┌─ ✅ Yes, Unlink (confirm_unlink) 🔐
└─ ❌ Cancel (cancel_unlink) 🔐
```

---

## **10. 📖 Help Menu** `help` 🔓
**Function:** Show available commands and support
```
└─ Back to Home (back_to_home) 🔒
```

---

## **11. ℹ️ Commands Menu** `show_commands` 🔒
**Function:** List all available bot commands
```
└─ Back to Home (back_to_home) 🔒
```

---

## **🔄 Navigation Helpers**

### **Back Navigation** (Used throughout)
```
🔙 Back ([previous_menu]) + 🏠 Home (main_menu)
```

### **Trading Navigation** (Used in trading flows)
```
⚡ Switch to Perps (trade_perps) / 🏪 Switch to Spot (trade_spot)
🔙 Back (unified_trade)
```

---

## **🚨 Access Control Issues to Fix**

### **❌ Problems Identified:**

1. **Welcome Menu Buttons** - Some buttons require access but welcome is public
   - `unified_trade` 🔒 - Should check access before showing trading menu
   - `show_commands` 🔒 - Commands menu needs access check

2. **Inconsistent Access Checks**
   - `help` button appears in main menu 🔒 but help itself is 🔓
   - Navigation between public/private menus needs better handling

3. **API Requirement Confusion**
   - Trading menus show 🔒 but actually need 🔐 (API linked)
   - Balance/Positions buttons accessible without API

### **✅ Recommended Fixes:**

1. **Welcome Menu:** Only show `help` and `link_api` to unauthorized users
2. **Access Gates:** Add proper access checks before showing restricted menus
3. **API Gates:** Separate API-required features from access-required features
4. **Fallback Flows:** Show appropriate messages when users lack required access/API

---

*Generated: $(date)*