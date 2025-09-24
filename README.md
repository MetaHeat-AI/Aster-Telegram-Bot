# 🤖 Aster DEX Telegram Trading Bot

A production-grade Telegram bot for trading Aster DEX Perpetual futures with BONK-style UX. Features natural language trade parsing, advanced price protection, real-time notifications, and secure credential management.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3.3-blue.svg)

## ✨ Features

### 🚀 Core Trading
- **Quick Orders**: Natural language parsing (`/buy BTCUSDT 100u x5 sl1% tp3%`)
- **Position Management**: View, modify, and close positions
- **Balance Tracking**: Real-time account balance and P&L
- **Order History**: Complete trading history with analytics

### 🛡️ Advanced Protection  
- **Price Protection**: Slippage analysis and market impact detection
- **Filter Compliance**: Automatic price/quantity rounding per exchange rules
- **Risk Management**: Configurable stop-loss and take-profit presets
- **Position Limits**: Maximum leverage and size controls

### 🔐 Security & Privacy
- **Encrypted Credentials**: AES-256-GCM encryption for API keys
- **Secure Sessions**: JWT-based authentication with Redis
- **Rate Limiting**: Built-in protection against API abuse
- **Audit Logging**: Complete transaction and action logging

### 📱 User Experience
- **Intuitive Commands**: Simple slash commands for all functions
- **Real-time Notifications**: WebSocket-powered trade alerts
- **Customizable Settings**: Personalized trading preferences
- **Multi-language Support**: Extensible localization system

## 🚀 Quick Deploy to Render

### 1. Create Telegram Bot
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` 
3. Choose name: "Aster DEX Trading Bot"
4. Choose username: `@your_unique_bot_name`
5. Copy the bot token

### 2. Deploy to Render
1. **Fork this repository** to your GitHub account
2. **Connect to Render**: Go to [render.com](https://render.com) → "New" → "Web Service"
3. **Connect your GitHub repository**
4. **Add Environment Variables**:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
   TG_BOT_TOKEN=your_bot_token_from_botfather
   ASTER_API_KEY=your_aster_api_key
   ASTER_API_SECRET=your_aster_api_secret  
   ENCRYPTION_KEY=generate_32_char_random_key
   NODE_ENV=production
   ```
5. **Add PostgreSQL**: Render will auto-configure DATABASE_URL
6. **Deploy**: Render builds and deploys automatically!

## 🤖 Bot Commands

### Essential Commands
- `/start` - Welcome message and registration
- `/link` - Securely link Aster DEX API credentials
- `/balance` - View account balance and equity
- `/positions` - Show all open positions
- `/settings` - Configure trading preferences

### Trading Commands  
- `/buy BTCUSDT 100u` - Market buy with USDT amount
- `/buy BTCUSDT 100u x5` - Market buy with 5x leverage
- `/buy BTCUSDT 100u x5 sl1%` - With 1% stop loss
- `/buy BTCUSDT 100u x5 sl1% tp3%` - With stop loss and take profit
- `/sell BTCUSDT 50%` - Sell 50% of position
- `/close BTCUSDT` - Close entire position

## 🛠️ Technology Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Bot Framework**: Telegraf.js for Telegram integration  
- **Database**: PostgreSQL with connection pooling
- **Caching**: Redis for sessions and rate limiting
- **HTTP**: Express.js server with health checks
- **WebSocket**: Native ws library for real-time data

## 🔧 Local Development

```bash
git clone https://github.com/MetaHeat-AI/aster-dex-bot.git
cd aster-dex-bot
npm install
cp .env.example .env
# Configure environment variables in .env
npm run build
npm start
```

### Testing
```bash
# Run all tests
npm run test:all

# Live API conformance test  
npm run conform
```

## 🔍 API Integration

### Aster DEX Compatibility
This bot implements full Binance Futures API compatibility:
- REST endpoints: `https://fapi.asterdex.com/fapi/v1/*`
- WebSocket streams: `wss://fstream.asterdex.com/ws/*`  
- HMAC-SHA256 authentication
- Standard order types and time-in-force options

## 🛡️ Security

### Credential Protection
- API keys encrypted with AES-256-GCM before database storage
- Unique encryption salt per user
- No plaintext credentials in logs or memory dumps
- Secure key derivation with PBKDF2

### Session Security  
- JWT-based session management
- Redis session storage with TTL
- Rate limiting per user and globally
- Input sanitization and validation

## ⚠️ Disclaimer

This trading bot is for educational and personal use only. Trading cryptocurrencies involves substantial risk of loss. Users are responsible for:

- Securing their API credentials
- Understanding trading risks
- Complying with local regulations  
- Using appropriate position sizing
- Regular monitoring of trades

The developers are not liable for any financial losses incurred through use of this software.

---

**Built with ❤️ for the Aster DEX community**
