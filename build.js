#!/usr/bin/env node

// Simple build verification script for Render
console.log('🔧 Starting build process...');

// Check Node version
console.log('Node.js version:', process.version);
console.log('NPM version:', process.env.npm_version || 'unknown');

// Verify key files exist
const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'package.json',
  'tsconfig.json', 
  'src/bot.ts',
  'src/types.ts',
  'src/aster.ts'
];

console.log('\n📁 Checking required files...');
let allFilesExist = true;

for (const file of requiredFiles) {
  if (fs.existsSync(file)) {
    console.log(`✅ ${file}`);
  } else {
    console.log(`❌ Missing: ${file}`);
    allFilesExist = false;
  }
}

if (!allFilesExist) {
  console.error('\n❌ Build failed: Missing required files');
  process.exit(1);
}

console.log('\n🏗️ Running TypeScript build...');

// Run tsc build
const { spawn } = require('child_process');
const tsc = spawn('npx', ['tsc'], { stdio: 'inherit' });

tsc.on('close', (code) => {
  if (code === 0) {
    console.log('\n✅ Build completed successfully!');
    console.log('📦 Checking dist directory...');
    
    if (fs.existsSync('dist/bot.js')) {
      console.log('✅ dist/bot.js created');
      console.log('🎉 Ready for deployment!');
    } else {
      console.error('❌ dist/bot.js not found');
      process.exit(1);
    }
  } else {
    console.error(`\n❌ Build failed with code ${code}`);
    process.exit(code);
  }
});

tsc.on('error', (err) => {
  console.error('\n❌ Build process failed:', err.message);
  process.exit(1);
});