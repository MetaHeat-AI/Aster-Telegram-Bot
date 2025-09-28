// Helper script to get Channel ID from private group
// Run this after adding your bot to the StableSolid beta test group

const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// Listen for any message in groups/channels
bot.on('message', (ctx) => {
  console.log('=== CHAT INFO ===');
  console.log('Chat ID:', ctx.chat.id);
  console.log('Chat Type:', ctx.chat.type);
  console.log('Chat Title:', ctx.chat.title);
  console.log('==================');
  
  if (ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') {
    console.log('\n🎯 FOUND GROUP CHAT!');
    console.log('Use this Channel ID in your .env file:');
    console.log(`REQUIRED_CHANNEL_ID=${ctx.chat.id}`);
    console.log('\nPress Ctrl+C to stop this script.');
  }
});

console.log('🤖 Bot started. Waiting for messages...');
console.log('📝 Steps:');
console.log('1. Add this bot to your StableSolid beta test group');
console.log('2. Make the bot an admin');
console.log('3. Send any message in the group');
console.log('4. Copy the Channel ID that appears here');
console.log('5. Add it to your .env file');
console.log('\nListening for messages...\n');

bot.launch();