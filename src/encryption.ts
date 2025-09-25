import crypto from 'crypto';

export class EncryptionManager {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  private static readonly SALT_LENGTH = 32;

  private encryptionKey: Buffer;

  constructor(encryptionKey: string) {
    if (encryptionKey.length < 32) {
      throw new Error('Encryption key must be at least 32 characters long');
    }
    
    // Use the first 32 characters as the key
    this.encryptionKey = Buffer.from(encryptionKey.substring(0, 32), 'utf8');
  }

  encrypt(plaintext: string): string {
    try {
      // Generate random IV and salt
      const iv = crypto.randomBytes(EncryptionManager.IV_LENGTH);
      const salt = crypto.randomBytes(EncryptionManager.SALT_LENGTH);
      
      // Derive key using PBKDF2
      const derivedKey = crypto.pbkdf2Sync(this.encryptionKey, salt, 100000, 32, 'sha512');
      
      // Create cipher
      const cipher = crypto.createCipheriv(EncryptionManager.ALGORITHM, derivedKey, iv);
      
      // Encrypt the plaintext
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      // Get the authentication tag
      const tag = cipher.getAuthTag();
      
      // Combine all components: salt + iv + tag + encrypted
      const combined = Buffer.concat([
        salt,
        iv,
        tag,
        Buffer.from(encrypted, 'hex')
      ]);
      
      return combined.toString('base64');
    } catch (error) {
      console.error('Encryption failed:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  decrypt(encryptedData: string): string {
    try {
      // Parse the base64 data
      const combined = Buffer.from(encryptedData, 'base64');
      
      // Extract components
      const salt = combined.subarray(0, EncryptionManager.SALT_LENGTH);
      const iv = combined.subarray(
        EncryptionManager.SALT_LENGTH, 
        EncryptionManager.SALT_LENGTH + EncryptionManager.IV_LENGTH
      );
      const tag = combined.subarray(
        EncryptionManager.SALT_LENGTH + EncryptionManager.IV_LENGTH,
        EncryptionManager.SALT_LENGTH + EncryptionManager.IV_LENGTH + EncryptionManager.TAG_LENGTH
      );
      const encrypted = combined.subarray(
        EncryptionManager.SALT_LENGTH + EncryptionManager.IV_LENGTH + EncryptionManager.TAG_LENGTH
      );
      
      // Derive key using same salt
      const derivedKey = crypto.pbkdf2Sync(this.encryptionKey, salt, 100000, 32, 'sha512');
      
      // Create decipher
      const decipher = crypto.createDecipheriv(EncryptionManager.ALGORITHM, derivedKey, iv);
      decipher.setAuthTag(tag);
      
      // Decrypt
      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error('Failed to decrypt data - data may be corrupted or key is incorrect');
    }
  }

  // Hash a PIN for storage (using bcrypt-like approach with crypto)
  hashPin(pin: string): string {
    const salt = crypto.randomBytes(16);
    const hash = crypto.pbkdf2Sync(pin, salt, 100000, 64, 'sha512');
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  // Verify a PIN against its hash
  verifyPin(pin: string, hashedPin: string): boolean {
    try {
      const [saltHex, hashHex] = hashedPin.split(':');
      if (!saltHex || !hashHex) return false;
      
      const salt = Buffer.from(saltHex, 'hex');
      const hash = Buffer.from(hashHex, 'hex');
      const computedHash = crypto.pbkdf2Sync(pin, salt, 100000, 64, 'sha512');
      
      return crypto.timingSafeEqual(hash, computedHash);
    } catch (error) {
      console.error('PIN verification failed:', error);
      return false;
    }
  }

  // Generate a secure random string
  static generateSecureRandom(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  // Generate a random PIN
  static generatePin(length: number = 6): string {
    const digits = '0123456789';
    let pin = '';
    
    for (let i = 0; i < length; i++) {
      const randomIndex = crypto.randomInt(0, digits.length);
      pin += digits[randomIndex];
    }
    
    return pin;
  }

  // Securely compare two strings (constant-time comparison)
  static secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    
    return crypto.timingSafeEqual(bufA, bufB);
  }

  // Generate a client ID for idempotency
  static generateClientId(prefix: string = 'aster'): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `${prefix}_${timestamp}_${random}`;
  }

  // Create a secure session token
  static generateSessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  // Validate encryption key strength
  static validateEncryptionKey(key: string): boolean {
    if (key.length < 32) return false;
    
    // Check for minimum entropy (basic check)
    const uniqueChars = new Set(key).size;
    if (uniqueChars < 16) return false;
    
    return true;
  }

  // Test encryption/decryption functionality
  static test(encryptionKey: string): boolean {
    try {
      const manager = new EncryptionManager(encryptionKey);
      const testData = 'test_api_key_12345';
      
      const encrypted = manager.encrypt(testData);
      const decrypted = manager.decrypt(encrypted);
      
      if (decrypted !== testData) {
        console.error('Encryption test failed: decrypted data does not match original');
        return false;
      }
      
      // Test PIN functionality
      const testPin = '123456';
      const hashedPin = manager.hashPin(testPin);
      const pinValid = manager.verifyPin(testPin, hashedPin);
      const pinInvalid = manager.verifyPin('654321', hashedPin);
      
      if (!pinValid || pinInvalid) {
        console.error('PIN hashing test failed');
        return false;
      }
      
      console.log('✅ Encryption tests passed');
      return true;
    } catch (error) {
      console.error('Encryption test failed:', error);
      return false;
    }
  }
}

// Utility functions for common encryption operations
export class CryptoUtils {
  // Mask sensitive data for logging
  static maskSensitiveData(data: string, visibleChars: number = 4): string {
    if (data.length <= visibleChars * 2) {
      return '*'.repeat(data.length);
    }
    
    const start = data.substring(0, visibleChars);
    const end = data.substring(data.length - visibleChars);
    const middle = '*'.repeat(data.length - visibleChars * 2);
    
    return `${start}${middle}${end}`;
  }

  // Generate a secure API key (for testing purposes only)
  static generateMockApiKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  // Generate a secure API secret (for testing purposes only)  
  static generateMockApiSecret(): string {
    return crypto.randomBytes(64).toString('base64');
  }

  // Validate API key format (basic validation)
  static isValidApiKeyFormat(apiKey: string): boolean {
    // Basic format check - should be hexadecimal and reasonable length
    return /^[a-fA-F0-9]{32,128}$/.test(apiKey);
  }

  // Validate API secret format (basic validation)
  static isValidApiSecretFormat(apiSecret: string): boolean {
    // Basic format check - should be base64 and reasonable length
    return /^[A-Za-z0-9+/=]{32,}$/.test(apiSecret);
  }

  // Redact sensitive information from error messages
  static sanitizeError(error: Error): Error {
    const sensitivePatterns = [
      /api[_\-]?key/i,
      /secret/i,
      /password/i,
      /token/i,
      /signature/i
    ];
    
    let message = error.message;
    
    sensitivePatterns.forEach(pattern => {
      message = message.replace(pattern, '[REDACTED]');
    });
    
    const sanitizedError = new Error(message);
    sanitizedError.name = error.name;
    sanitizedError.stack = error.stack;
    
    return sanitizedError;
  }

  // Rate limiting key generation
  static generateRateLimitKey(userId: number, action: string): string {
    return `ratelimit:${userId}:${action}`;
  }

  // Idempotency key generation
  static generateIdempotencyKey(userId: number, command: string, params: string): string {
    const hash = crypto.createHash('sha256')
      .update(`${userId}:${command}:${params}`)
      .digest('hex');
    
    return `idempotent:${hash}`;
  }
}