import { UserSettings } from './types';
import { DatabaseManager } from './db';
import { EncryptionManager } from './encryption';

export interface SettingsUpdateRequest {
  leverage_cap?: number;
  default_leverage?: number;
  size_presets?: number[];
  slippage_bps?: number;
  tp_presets?: number[];
  sl_presets?: number[];
  daily_loss_cap?: number | null;
}

export interface SettingsValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: SettingsUpdateRequest;
}

export class SettingsManager {
  private db: DatabaseManager;
  private encryption: EncryptionManager;

  private static readonly DEFAULT_SETTINGS: Omit<UserSettings, 'user_id'> = {
    leverage_cap: 20,
    default_leverage: 3,
    size_presets: [50, 100, 250],
    slippage_bps: 50, // 0.5%
    tp_presets: [2, 4, 8], // 2%, 4%, 8%
    sl_presets: [1, 2], // 1%, 2%
    daily_loss_cap: null,
    pin_hash: null,
  };

  private static readonly VALIDATION_RULES = {
    leverage_cap: { min: 1, max: 125 },
    default_leverage: { min: 1, max: 20 },
    size_presets: { min: 1, max: 10000, maxItems: 10 },
    slippage_bps: { min: 1, max: 1000 }, // 0.01% to 10%
    tp_presets: { min: 0.1, max: 100, maxItems: 10 }, // 0.1% to 100%
    sl_presets: { min: 0.1, max: 50, maxItems: 10 }, // 0.1% to 50%
    daily_loss_cap: { min: 1, max: 100000 },
  };

  constructor(db: DatabaseManager, encryption: EncryptionManager) {
    this.db = db;
    this.encryption = encryption;
  }

  // Get user settings with defaults
  async getUserSettings(userId: number): Promise<UserSettings> {
    let settings = await this.db.getUserSettings(userId);
    
    if (!settings) {
      settings = await this.createDefaultSettings(userId);
    }
    
    return this.mergeWithDefaults(settings);
  }

  // Create default settings for new user
  async createDefaultSettings(userId: number): Promise<UserSettings> {
    const defaultSettings: UserSettings = {
      user_id: userId,
      ...SettingsManager.DEFAULT_SETTINGS,
    };
    
    await this.db.createDefaultSettings(userId);
    return defaultSettings;
  }

  // Update user settings with validation
  async updateSettings(
    userId: number, 
    updates: SettingsUpdateRequest
  ): Promise<{ success: boolean; errors: string[]; warnings: string[] }> {
    // Validate the updates
    const validation = this.validateSettings(updates);
    if (!validation.isValid) {
      return {
        success: false,
        errors: validation.errors,
        warnings: validation.warnings,
      };
    }

    try {
      // Apply sanitized updates
      await this.db.updateUserSettings(userId, validation.sanitized!);
      
      return {
        success: true,
        errors: [],
        warnings: validation.warnings,
      };
    } catch (error) {
      console.error('Failed to update settings:', error);
      return {
        success: false,
        errors: ['Failed to save settings. Please try again.'],
        warnings: [],
      };
    }
  }

  // Validate settings updates
  private validateSettings(updates: SettingsUpdateRequest): SettingsValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const sanitized: SettingsUpdateRequest = {};

    // Validate leverage_cap
    if (updates.leverage_cap !== undefined) {
      const { min, max } = SettingsManager.VALIDATION_RULES.leverage_cap;
      if (updates.leverage_cap < min || updates.leverage_cap > max) {
        errors.push(`Leverage cap must be between ${min}x and ${max}x`);
      } else {
        sanitized.leverage_cap = Math.floor(updates.leverage_cap);
        if (updates.leverage_cap > 20) {
          warnings.push('High leverage increases liquidation risk');
        }
      }
    }

    // Validate default_leverage
    if (updates.default_leverage !== undefined) {
      const { min, max } = SettingsManager.VALIDATION_RULES.default_leverage;
      if (updates.default_leverage < min || updates.default_leverage > max) {
        errors.push(`Default leverage must be between ${min}x and ${max}x`);
      } else {
        sanitized.default_leverage = Math.floor(updates.default_leverage);
      }
    }

    // Validate size_presets
    if (updates.size_presets !== undefined) {
      if (!Array.isArray(updates.size_presets)) {
        errors.push('Size presets must be an array');
      } else {
        const { min, max, maxItems } = SettingsManager.VALIDATION_RULES.size_presets;
        
        if (updates.size_presets.length > maxItems) {
          errors.push(`Maximum ${maxItems} size presets allowed`);
        } else {
          const validPresets = updates.size_presets
            .filter(preset => typeof preset === 'number' && preset >= min && preset <= max)
            .sort((a, b) => a - b);
          
          if (validPresets.length !== updates.size_presets.length) {
            warnings.push(`Some size presets were filtered out (must be ${min}-${max})`);
          }
          
          sanitized.size_presets = validPresets;
        }
      }
    }

    // Validate slippage_bps
    if (updates.slippage_bps !== undefined) {
      const { min, max } = SettingsManager.VALIDATION_RULES.slippage_bps;
      if (updates.slippage_bps < min || updates.slippage_bps > max) {
        errors.push(`Slippage must be between ${min} bps (0.01%) and ${max} bps (10%)`);
      } else {
        sanitized.slippage_bps = Math.floor(updates.slippage_bps);
        if (updates.slippage_bps > 200) {
          warnings.push('High slippage tolerance may result in poor fills');
        }
      }
    }

    // Validate tp_presets
    if (updates.tp_presets !== undefined) {
      if (!Array.isArray(updates.tp_presets)) {
        errors.push('Take profit presets must be an array');
      } else {
        const { min, max, maxItems } = SettingsManager.VALIDATION_RULES.tp_presets;
        
        if (updates.tp_presets.length > maxItems) {
          errors.push(`Maximum ${maxItems} take profit presets allowed`);
        } else {
          const validPresets = updates.tp_presets
            .filter(preset => typeof preset === 'number' && preset >= min && preset <= max)
            .sort((a, b) => a - b);
          
          if (validPresets.length !== updates.tp_presets.length) {
            warnings.push(`Some TP presets were filtered out (must be ${min}%-${max}%)`);
          }
          
          sanitized.tp_presets = validPresets;
        }
      }
    }

    // Validate sl_presets
    if (updates.sl_presets !== undefined) {
      if (!Array.isArray(updates.sl_presets)) {
        errors.push('Stop loss presets must be an array');
      } else {
        const { min, max, maxItems } = SettingsManager.VALIDATION_RULES.sl_presets;
        
        if (updates.sl_presets.length > maxItems) {
          errors.push(`Maximum ${maxItems} stop loss presets allowed`);
        } else {
          const validPresets = updates.sl_presets
            .filter(preset => typeof preset === 'number' && preset >= min && preset <= max)
            .sort((a, b) => a - b);
          
          if (validPresets.length !== updates.sl_presets.length) {
            warnings.push(`Some SL presets were filtered out (must be ${min}%-${max}%)`);
          }
          
          sanitized.sl_presets = validPresets;
        }
      }
    }

    // Validate daily_loss_cap
    if (updates.daily_loss_cap !== undefined) {
      if (updates.daily_loss_cap === null) {
        sanitized.daily_loss_cap = null;
      } else {
        const { min, max } = SettingsManager.VALIDATION_RULES.daily_loss_cap;
        if (updates.daily_loss_cap < min || updates.daily_loss_cap > max) {
          errors.push(`Daily loss cap must be between $${min} and $${max}`);
        } else {
          sanitized.daily_loss_cap = Math.round(updates.daily_loss_cap * 100) / 100;
          if (updates.daily_loss_cap > 1000) {
            warnings.push('Consider setting a lower daily loss limit for better risk management');
          }
        }
      }
    }

    // Cross-validation
    if (sanitized.default_leverage && sanitized.leverage_cap) {
      if (sanitized.default_leverage > sanitized.leverage_cap) {
        errors.push('Default leverage cannot exceed leverage cap');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized: errors.length === 0 ? sanitized : undefined,
    };
  }

  // Set or update user PIN
  async setPin(userId: number, newPin: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isValidPin(newPin)) {
      return {
        success: false,
        error: 'PIN must be 4-8 digits',
      };
    }

    try {
      const hashedPin = this.encryption.hashPin(newPin);
      await this.db.updateUserSettings(userId, { pin_hash: hashedPin });
      
      return { success: true };
    } catch (error) {
      console.error('Failed to set PIN:', error);
      return {
        success: false,
        error: 'Failed to set PIN. Please try again.',
      };
    }
  }

  // Verify user PIN
  async verifyPin(userId: number, pin: string): Promise<boolean> {
    try {
      const settings = await this.getUserSettings(userId);
      
      if (!settings.pin_hash) {
        return false; // No PIN set
      }
      
      return this.encryption.verifyPin(pin, settings.pin_hash);
    } catch (error) {
      console.error('PIN verification error:', error);
      return false;
    }
  }

  // Check if user has PIN set
  async hasPinSet(userId: number): Promise<boolean> {
    try {
      const settings = await this.getUserSettings(userId);
      return !!settings.pin_hash;
    } catch (error) {
      console.error('Error checking PIN status:', error);
      return false;
    }
  }

  // Remove user PIN
  async removePin(userId: number, currentPin: string): Promise<{ success: boolean; error?: string }> {
    const isValid = await this.verifyPin(userId, currentPin);
    
    if (!isValid) {
      return {
        success: false,
        error: 'Invalid current PIN',
      };
    }

    try {
      await this.db.updateUserSettings(userId, { pin_hash: null });
      return { success: true };
    } catch (error) {
      console.error('Failed to remove PIN:', error);
      return {
        success: false,
        error: 'Failed to remove PIN. Please try again.',
      };
    }
  }

  // Get formatted settings for display
  formatSettingsForDisplay(settings: UserSettings): string {
    const lines: string[] = [];
    
    lines.push('⚙️ **Current Settings**\n');
    
    lines.push(`🎚️ **Leverage**`);
    lines.push(`• Default: ${settings.default_leverage}x`);
    lines.push(`• Maximum: ${settings.leverage_cap}x`);
    
    lines.push(`\n💰 **Size Presets**`);
    settings.size_presets.forEach((preset, index) => {
      lines.push(`• ${preset}u`);
    });
    
    lines.push(`\n📊 **Risk Management**`);
    lines.push(`• Slippage Tolerance: ${(settings.slippage_bps / 100).toFixed(2)}%`);
    
    if (settings.daily_loss_cap) {
      lines.push(`• Daily Loss Cap: $${settings.daily_loss_cap}`);
    } else {
      lines.push(`• Daily Loss Cap: Disabled`);
    }
    
    lines.push(`\n🎯 **Take Profit Presets**`);
    settings.tp_presets.forEach(tp => {
      lines.push(`• ${tp}%`);
    });
    
    lines.push(`\n🛑 **Stop Loss Presets**`);
    settings.sl_presets.forEach(sl => {
      lines.push(`• ${sl}%`);
    });
    
    lines.push(`\n🔐 **Security**`);
    lines.push(`• PIN Protection: ${settings.pin_hash ? 'Enabled' : 'Disabled'}`);
    
    return lines.join('\n');
  }

  // Get quick settings summary for inline display
  getSettingsSummary(settings: UserSettings): string {
    return [
      `Leverage: ${settings.default_leverage}x (max ${settings.leverage_cap}x)`,
      `Slippage: ${(settings.slippage_bps / 100).toFixed(2)}%`,
      `Daily Cap: ${settings.daily_loss_cap ? `$${settings.daily_loss_cap}` : 'None'}`,
      `PIN: ${settings.pin_hash ? 'Set' : 'None'}`
    ].join(' | ');
  }

  // Reset to default settings
  async resetToDefaults(userId: number): Promise<{ success: boolean; error?: string }> {
    try {
      // Keep PIN if it was set
      const currentSettings = await this.getUserSettings(userId);
      const resetSettings = {
        ...SettingsManager.DEFAULT_SETTINGS,
        pin_hash: currentSettings.pin_hash, // Preserve PIN
      };
      
      await this.db.updateUserSettings(userId, resetSettings);
      
      return { success: true };
    } catch (error) {
      console.error('Failed to reset settings:', error);
      return {
        success: false,
        error: 'Failed to reset settings. Please try again.',
      };
    }
  }

  // Merge settings with defaults (handle missing fields)
  private mergeWithDefaults(settings: UserSettings): UserSettings {
    return {
      user_id: settings.user_id,
      leverage_cap: settings.leverage_cap ?? SettingsManager.DEFAULT_SETTINGS.leverage_cap,
      default_leverage: settings.default_leverage ?? SettingsManager.DEFAULT_SETTINGS.default_leverage,
      size_presets: settings.size_presets ?? SettingsManager.DEFAULT_SETTINGS.size_presets,
      slippage_bps: settings.slippage_bps ?? SettingsManager.DEFAULT_SETTINGS.slippage_bps,
      tp_presets: settings.tp_presets ?? SettingsManager.DEFAULT_SETTINGS.tp_presets,
      sl_presets: settings.sl_presets ?? SettingsManager.DEFAULT_SETTINGS.sl_presets,
      daily_loss_cap: settings.daily_loss_cap ?? SettingsManager.DEFAULT_SETTINGS.daily_loss_cap,
      pin_hash: settings.pin_hash ?? SettingsManager.DEFAULT_SETTINGS.pin_hash,
    };
  }

  // Validate PIN format
  private isValidPin(pin: string): boolean {
    return /^\d{4,8}$/.test(pin);
  }

  // Export settings for backup
  async exportSettings(userId: number): Promise<any> {
    const settings = await this.getUserSettings(userId);
    
    // Return settings without sensitive data
    return {
      leverage_cap: settings.leverage_cap,
      default_leverage: settings.default_leverage,
      size_presets: settings.size_presets,
      slippage_bps: settings.slippage_bps,
      tp_presets: settings.tp_presets,
      sl_presets: settings.sl_presets,
      daily_loss_cap: settings.daily_loss_cap,
      has_pin: !!settings.pin_hash,
    };
  }

  // Import settings from backup
  async importSettings(
    userId: number, 
    settingsData: any
  ): Promise<{ success: boolean; errors: string[]; warnings: string[] }> {
    try {
      const updates: SettingsUpdateRequest = {
        leverage_cap: settingsData.leverage_cap,
        default_leverage: settingsData.default_leverage,
        size_presets: settingsData.size_presets,
        slippage_bps: settingsData.slippage_bps,
        tp_presets: settingsData.tp_presets,
        sl_presets: settingsData.sl_presets,
        daily_loss_cap: settingsData.daily_loss_cap,
      };

      return await this.updateSettings(userId, updates);
    } catch (error) {
      console.error('Failed to import settings:', error);
      return {
        success: false,
        errors: ['Invalid settings data format'],
        warnings: [],
      };
    }
  }
}