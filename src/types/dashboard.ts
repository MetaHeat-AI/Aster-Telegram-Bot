// Dashboard-specific types
export interface DashboardData {
  totalBalance: string;
  availableBalance: string;
  positionValue: string;
  unrealizedPnL: string;
  realizedPnL: string;
  positionCount: number;
  spotPositions: number;
  perpPositions: number;
  todayPnL: string;
  todayPnLPercent: string;
  totalPnLPercent: string;
}

export interface PositionSummary {
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: 'SPOT' | 'PERP';
  size: string;
  entryPrice: string;
  currentPrice: string;
  unrealizedPnL: string;
  unrealizedPnLPercent: string;
  leverage?: string;
  marginType?: 'CROSS' | 'ISOLATED';
  value: string;
}

export interface PortfolioOverview {
  totalValue: string;
  cash: string;
  positions: string;
  pnl: {
    daily: string;
    weekly: string;
    monthly: string;
    total: string;
  };
  performance: {
    dailyPercent: string;
    weeklyPercent: string;
    monthlyPercent: string;
    totalPercent: string;
  };
  topGainer?: PositionSummary;
  topLoser?: PositionSummary;
}

export interface TradingSummary {
  todayTrades: number;
  weekTrades: number;
  monthTrades: number;
  winRate: string;
  avgWin: string;
  avgLoss: string;
  sharpeRatio?: string;
}