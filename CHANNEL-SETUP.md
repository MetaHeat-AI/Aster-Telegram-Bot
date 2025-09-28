# 🔒 Channel Membership Gate Setup

## Quick Setup Steps

### 1. Add Bot to Your Group
1. Go to your StableSolid beta test group: https://t.me/+T4KTNlGT4dEwMzc9
2. Add your bot to the group
3. Make the bot an **Administrator** with these permissions:
   - ✅ See messages
   - ✅ See members  
   - ❌ Can disable others

### 2. Get Channel ID
```bash
# Run this helper script
node get-channel-id.js

# Then send any message in your group
# Copy the Channel ID that appears
```

### 3. Configure Environment
```bash
# Add to your .env file
REQUIRED_CHANNEL_ID=-1001234567890  # Replace with your actual ID
```

### 4. Deploy & Test
- Deploy the updated bot
- Test with a user NOT in the group (should get access denied)
- Test with a user IN the group (should work normally)

## How It Works

- **Before every bot interaction**, checks if user is a group member
- **If not a member**: Shows friendly message with invite link
- **If member**: Continues with normal bot functionality
- **If check fails**: Shows retry message (handles API errors gracefully)

## Access Denied Message

Users will see:
```
🔒 Access Required

To use this bot, you need to be a member of our beta test group.

How to get access:
1. Join our StableSolid beta test group
2. Use this invite link: https://t.me/+T4KTNlGT4dEwMzc9
3. Come back and try the bot again

💡 Why? This ensures beta testers get important updates and can provide feedback.

🔄 After joining, type /start to begin!
```

## Notes
- No caching (as requested) - checks membership on every interaction
- Skips check for `/start` and `/help` commands
- Graceful error handling if Telegram API is unavailable
- Easy to disable by removing `REQUIRED_CHANNEL_ID` from environment