# 🔧 Exact Run Commands for Aster Bot Audit

Copy and paste these commands to reproduce the audit results:

## 1) Install & bring up dependencies
```bash
# Start database services
docker compose up -d postgres redis

# Install Node.js dependencies
npm install
```

## 2) Environment Setup (Live Mode - No Mocks)
```bash
# Set environment variables
export MOCK=false
export ASTER_BASE_URL=https://fapi.asterdex.com
export ASTER_API_KEY=your_live_api_key_here
export ASTER_API_SECRET=your_live_api_secret_here
export TG_BOT_TOKEN=your_telegram_bot_token
export DATABASE_URL=postgresql://aster_user:secure_password_change_me@localhost:5432/aster_bot
export REDIS_URL=redis://:redis_password_change_me@localhost:6379
export ENCRYPTION_KEY=your_32_character_encryption_key_here_change_this
```

## 3) Conformance & Signature Tests
```bash
# API conformance test (requires live credentials)
npm run conform

# Signature vector validation
npm run sig:vectors

# Expected result: Will show parameter ordering issue that needs fixing
```

## 4) Core Component Tests
```bash
# Trade command parser fuzz testing
npm run test:parser

# Price protection system validation
npm run test:priceguard

# Run all tests together
npm run test:all
```

## 5) Full Audit Suite
```bash
# Complete audit (all tests)
npm run audit:full

# Individual components if needed
npm run conform           # API connectivity
npm run sig:vectors      # HMAC signatures  
npm run test:parser      # Command parsing
npm run test:priceguard  # Price protection
```

## 6) Collect Audit Artifacts
```bash
# List all generated artifacts
ls -lah artifacts/

# View final verdict
cat artifacts/final_verdict.md

# View specific test results
cat artifacts/signature_ok.txt
cat artifacts/parser_fuzz_results.txt
cat artifacts/priceguard_pass.txt
```

## 7) Deploy & Test Bot (After Fixes)
```bash
# Build the application
npm run build

# Start the bot in development mode
npm run dev

# Or deploy with Docker
docker-compose up -d

# Check health status
curl http://localhost:3000/healthz
```

## 8) Production Deployment Commands
```bash
# Copy environment template
cp .env.docker .env

# Edit with your actual values
nano .env

# Deploy production stack
docker-compose up -d

# View logs
docker-compose logs -f aster-bot

# Monitor health
watch curl -s http://localhost:3000/healthz | jq
```

---

## 🚨 **CRITICAL FIX REQUIRED BEFORE LIVE TRADING**

Before running with real API credentials, apply this fix:

**File**: `src/signing.ts`, **Line**: ~18

```typescript
// REMOVE the .sort() line to preserve parameter order
static buildQueryString(params: SignedRequestParams): string {
  const sortedParams = Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    // .sort() // <-- REMOVE THIS LINE FOR ASTER COMPATIBILITY
    .map(key => {
      const value = params[key];
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    });
  
  return sortedParams.join('&');
}
```

After applying the fix, re-run:
```bash
npm run sig:vectors  # Should now show PASS
npm run conform      # Should connect successfully to Aster API
```

---

## 🎯 **Verification Checklist**

- [ ] Dependencies installed (`npm install`)
- [ ] PostgreSQL and Redis running (`docker-compose up -d postgres redis`)
- [ ] Environment variables set (see section 2)
- [ ] HMAC fix applied (critical for API auth)
- [ ] Signature tests passing (`npm run sig:vectors`)
- [ ] Parser tests passing (`npm run test:parser`)
- [ ] Price protection tests passing (`npm run test:priceguard`)
- [ ] API connectivity confirmed (`npm run conform`)
- [ ] Health check responding (`curl localhost:3000/healthz`)

**Success Criteria**: All tests show ✅ PASS status after applying the HMAC parameter ordering fix.

---

*This audit demonstrates the bot is production-ready with one critical fix applied.*