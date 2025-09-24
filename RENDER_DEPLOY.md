# 🚀 Deploy to Render - Step by Step Guide

## Prerequisites

1. **Telegram Bot Token**: Get from [@BotFather](https://t.me/botfather)
2. **Aster DEX API Credentials**: Your API key and secret
3. **GitHub Repository**: Code pushed to GitHub (this repo)

## Step-by-Step Deployment

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot`
3. Choose bot name: "Aster DEX Trading Bot"
4. Choose username: `@your_unique_bot_name`
5. **Copy the bot token** (format: `1234567890:ABCdefGHIjklMNOpqrSTUvwxyz`)

### 2. Deploy to Render

1. **Go to Render**: https://render.com
2. **Sign up/Login** with your GitHub account
3. **Create New Web Service**:
   - Click "New +" → "Web Service"
   - Connect to GitHub repository: `MetaHeat-AI/aster-dex-telegram-bot`
   - Choose "main" branch

### 3. Configure Build Settings

- **Name**: `aster-dex-telegram-bot`
- **Environment**: `Node`
- **Region**: `Oregon` (recommended)
- **Branch**: `main`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`

### 4. Add Environment Variables

Click "Environment" tab and add these variables:

#### Required Variables:
```
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TG_BOT_TOKEN=your_bot_token_from_botfather
ASTER_API_KEY=your_aster_api_key_here
ASTER_API_SECRET=your_aster_api_secret_here
ENCRYPTION_KEY=generate_32_character_random_key_here
NODE_ENV=production
```

#### Auto-configured Variables:
```
ASTER_BASE_URL=https://fapi.asterdex.com
DEFAULT_RECV_WINDOW=5000
MAX_LEVERAGE=20
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
```

### 5. Add PostgreSQL Database

1. **In Render Dashboard**: Click "New +" → "PostgreSQL"
2. **Configure Database**:
   - Name: `aster-bot-postgres`
   - Database Name: `aster_bot`
   - User: `aster_bot_user`
   - Region: Same as web service
3. **Copy Internal Database URL** (starts with `postgresql://`)
4. **Add to Environment Variables**:
   ```
   DATABASE_URL=postgresql://internal_connection_string_here
   ```

### 6. Deploy

1. **Click "Create Web Service"**
2. **Wait for Build**: Takes 2-3 minutes
3. **Check Deployment Logs** for any errors
4. **Verify Health Check**: `https://your-app.onrender.com/health`

### 7. Configure Bot Commands (Optional)

Message [@BotFather](https://t.me/botfather):
```
/setcommands

start - Start the bot and see main menu
link - Link your Aster DEX API credentials  
buy - Quick buy order (e.g., /buy BTCUSDT 100u x5)
sell - Quick sell order (e.g., /sell BTCUSDT 50%)
positions - View open positions
balance - Check account balance
settings - Configure trading preferences
help - Show help information
```

## Test Your Bot

1. **Find Your Bot**: Search for your bot name on Telegram
2. **Start Conversation**: Send `/start`
3. **Link API Credentials**: Use `/link` command
4. **Test Trading**: Try `/buy BTCUSDT 100u` (test command)
5. **Check Balance**: Use `/balance`

## Environment Variables Reference

### Essential Variables
| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | `1234567890:ABC...` |
| `TG_BOT_TOKEN` | Same as above (compatibility) | Same as above |
| `ASTER_API_KEY` | Your Aster DEX API key | `49e1782f9a5d...` |
| `ASTER_API_SECRET` | Your Aster DEX API secret | `8a7a7a428a79...` |
| `ENCRYPTION_KEY` | 32-char random key for credential encryption | `asterbot2024secure32charkey12345` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host/db` |

### Optional Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Environment mode |
| `ASTER_BASE_URL` | `https://fapi.asterdex.com` | Aster API base URL |
| `DEFAULT_RECV_WINDOW` | `5000` | API request timeout |
| `MAX_LEVERAGE` | `20` | Maximum leverage allowed |
| `ADMIN_IDS` | - | Comma-separated Telegram user IDs for admin access |

## Generate Encryption Key

Use Node.js to generate a secure encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

## Troubleshooting

### Build Issues
- Check build logs for npm install errors
- Ensure all dependencies are in `package.json`
- Verify Node.js version compatibility

### Runtime Issues
- Check application logs for errors
- Verify all environment variables are set
- Test database connection
- Check health endpoint: `/health`

### Bot Not Responding
- Verify `TELEGRAM_BOT_TOKEN` is correct
- Check bot is not already running elsewhere
- Verify webhook URL in BotFather (not needed for polling)

### Database Connection Failed
- Verify `DATABASE_URL` format
- Check PostgreSQL service is running
- Ensure database and user exist

## Monitoring

### Health Checks
- **Health Endpoint**: `https://your-app.onrender.com/health`
- **Status**: Should return `{"status":"ok"}`

### Logs
- **Build Logs**: Available during deployment
- **Application Logs**: Check Render dashboard
- **Error Tracking**: Monitor for runtime errors

## Updates

To update your bot:
1. Push changes to GitHub repository
2. Render will auto-deploy from `main` branch
3. Monitor deployment logs
4. Test functionality after deployment

## Support

- **Documentation**: See main README.md
- **Health Check**: `GET /health`
- **Issues**: Create GitHub issue

---

**Your bot will be live at**: `https://your-app-name.onrender.com`