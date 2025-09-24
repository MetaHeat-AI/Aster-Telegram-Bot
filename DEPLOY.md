# 🚀 Deployment Guide - Aster DEX Telegram Bot

## Quick Deploy Options

### Option 1: Railway (Recommended)

1. **Create Railway Account**: https://railway.app
2. **Connect GitHub**: Link your repository
3. **Deploy**:
   ```bash
   # Push to GitHub first
   git add .
   git commit -m "Ready for deployment"
   git push origin main
   ```
4. **Set Environment Variables** in Railway dashboard:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token
   ASTER_API_KEY=49e1782f9a5d23c238c1419f4c4e07c836e6f8f6660707383febb665ef69af7c
   ASTER_API_SECRET=8a7a7a428a79170504df039b6f85add19f13876c710666bc04380a872c66ffa4
   DATABASE_URL=postgresql://... (Railway will provide)
   ENCRYPTION_KEY=your_32_char_key_here_1234567890ab
   NODE_ENV=production
   ```

### Option 2: Render

1. **Create Render Account**: https://render.com
2. **Connect GitHub**: Import your repository
3. **Configure**:
   - Service Name: `aster-trading-bot`
   - Environment: `Node`
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
4. **Add Environment Variables** (same as above)

### Option 3: Heroku

1. **Install Heroku CLI**: https://devcenter.heroku.com/articles/heroku-cli
2. **Deploy**:
   ```bash
   heroku create aster-trading-bot
   heroku addons:create heroku-postgresql:hobby-dev
   
   # Set environment variables
   heroku config:set TELEGRAM_BOT_TOKEN=your_bot_token
   heroku config:set ASTER_API_KEY=your_api_key
   heroku config:set ASTER_API_SECRET=your_api_secret
   heroku config:set ENCRYPTION_KEY=your_32_char_key
   heroku config:set NODE_ENV=production
   
   git push heroku main
   ```

## 🤖 Telegram Bot Setup

1. **Message @BotFather** on Telegram
2. **Create Bot**:
   ```
   /newbot
   Bot Name: Aster DEX Trading Bot
   Username: @asterdex_trading_bot (must be unique)
   ```
3. **Copy Bot Token** (format: `1234567890:ABCdefGHIjklMNOpqrSTUvwxyz`)
4. **Configure Bot** (optional):
   ```
   /setdescription - Set bot description
   /setabouttext - Set about text
   /setuserpic - Upload bot avatar
   /setcommands - Set command list:
   
   start - Start the bot and see main menu
   link - Link your Aster DEX API credentials  
   buy - Quick buy order (e.g., /buy BTCUSDT 100u)
   sell - Quick sell order (e.g., /sell BTCUSDT 50%)
   positions - View open positions
   balance - Check account balance
   settings - Configure trading preferences
   help - Show help information
   ```

## 🔐 Security Setup

### Generate Encryption Key
```bash
node -e "console.log(crypto.randomBytes(16).toString('hex'))"
```

### Environment Variables Checklist
- [ ] `TELEGRAM_BOT_TOKEN` - From @BotFather
- [ ] `ASTER_API_KEY` - Your Aster DEX API key
- [ ] `ASTER_API_SECRET` - Your Aster DEX API secret  
- [ ] `DATABASE_URL` - PostgreSQL connection string
- [ ] `ENCRYPTION_KEY` - 32-character random key
- [ ] `NODE_ENV=production`

## 🗄️ Database Setup

### Automatic (Railway/Render)
Railway and Render automatically provide PostgreSQL. The bot will create tables on first run.

### Manual PostgreSQL Setup
```sql
-- Connect to your PostgreSQL instance
CREATE DATABASE aster_bot;

-- Tables will be created automatically by the bot
-- See src/db.ts for schema details
```

## 🚀 Going Live

1. **Deploy** using one of the options above
2. **Test** your bot by messaging it on Telegram
3. **Link API credentials** using `/link` command
4. **Start trading** with commands like `/buy BTCUSDT 100u`

## 📊 Monitoring

- **Health Check**: `https://your-app.railway.app/health`
- **Logs**: Check your platform's logging dashboard
- **Database**: Monitor connection and query performance

## 🔧 Troubleshooting

### Bot Not Responding
1. Check environment variables are set
2. Verify bot token with @BotFather  
3. Check application logs

### Database Connection Issues
1. Verify DATABASE_URL format
2. Check PostgreSQL service status
3. Test connection manually

### API Issues
1. Verify Aster API credentials
2. Check API rate limits
3. Test with conformance suite: `npm run conform`

## 🆙 Updates

To update your deployed bot:
```bash
git add .
git commit -m "Update bot features"
git push origin main
```

Your platform will automatically redeploy the changes.