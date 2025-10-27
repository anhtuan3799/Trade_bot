import * as dotenv from "dotenv";
import { MexcFuturesClient } from "mexc-futures-sdk";
import axios from "axios";

dotenv.config();

const WEB_TOKEN = process.env.MEXC_AUTH_TOKEN ?? "";
const LEVERAGE = 20;

const client = new MexcFuturesClient({
  authToken: WEB_TOKEN,
  baseURL: "https://contract.mexc.com/api/v1",
});

interface Order {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  positionId?: string;
  status: 'OPEN' | 'FILLED' | 'CANCELED' | 'REJECTED';
  createdAt: Date;
}

const STRATEGY_CONFIG = {
  initialPositionPercent: 0.1,
  maxTotalPositionPercent: 0.35,
  takeProfitLevels: [
    { priceChangePercent: 2.0, closeRatio: 0.4 },
    { priceChangePercent: 4.0, closeRatio: 0.4 },
    { priceChangePercent: 7.0, closeRatio: 0.2 }
  ],
  stopLossLevels: [
    { priceChangePercent: 1.5, closeRatio: 0.5 },
    { priceChangePercent: 3.0, closeRatio: 0.5 }
  ],
  minDailyVolatility: 5.0,
  minVolume24h: 10000000,
  trendStrengthThreshold: 0.8,
  volumeSpikeThreshold: 1.5,
  maxActivePositions: 3,
  maxTrackingCoins: 10,
  minAccountBalancePercent: 0.15,
  emaPeriod: 21,
  resistanceLookback: 20,
  rsiOverbought: 70,
  rsiOversold: 30,
  dcaLevels: [
    { priceChangePercent: 1.5, addRatio: 0.1, condition: 'RESISTANCE' },
    { priceChangePercent: 3.0, addRatio: 0.15, condition: 'EMA_RESISTANCE' },
    { priceChangePercent: 4.5, addRatio: 0.2, condition: 'FIBONACCI' }
  ],
  maxDcaTimes: 3,
  dcaConditions: {
    volumeDropThreshold: 0.7,
    emaResistance: true,
    fibonacciLevels: [0.382, 0.5, 0.618]
  },
  fakePumpDetection: {
    enabled: true,
    minPumpPercent: 8,
    volumeDivergenceThreshold: 0.6,
    timeFrame: 4,
    rsiDivergence: true,
    emaRejection: true,
    maxRetracement: 0.382
  },
  strongDowntrend: {
    minTrendStrength: 0.85,
    minVolumeSpike: 1.8,
    accelerationThreshold: -0.002,
    emaAlignment: true
  },

  trailingStopLoss: {
    enabled: true,
    activationProfitPercent: 1.0, 
    trailDistancePercent: 0.5,     
    maxTrailDistancePercent: 3.0  
  }
};


const LOWCAP_KILL_LONG_CONFIG = {
  enabled: true,
  minPumpPercent: 15,
  maxPumpPercent: 80,
  volumeSpikeThreshold: 2.5,
  killLongDropPercent: 3.0,
  rsiOverbought: 75,
  maxMarketCapRank: 300,
  minLiquidity: 500000,
  positionSizePercent: 0.08,
  takeProfit: 8.0,
  stopLoss: 4.0,
  maxPositions: 2,
  timeframe: "Min5",
  lookbackCandles: 24,
  rejectionCandleThreshold: 1.8,
  emaRejectionThreshold: 0.02,
  minATRPercent: 2.0,
  maxPositionAge: 3600000
};


interface MexcContract {
  symbol: string;
  displayName?: string;
  baseCoin?: string;
  quoteCoin?: string;
  contractSize: number;
  priceScale: number;
  volScale: number;
}

async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3, delay = 1000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;
      
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.response?.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error('All retry attempts failed');
}

interface ContractInfo {
  symbol: string;
  contractSize: number;
  pricePrecision: number;
  volumePrecision: number;
}

interface SimpleCandle {
  open: number;
  low: number;
  close: number;
  high: number;
  volume: number;
  timestamp: number;
}

interface TakeProfitLevel {
  priceChangePercent: number;
  closeRatio: number;
  executed: boolean;
}

interface StopLossLevel {
  priceChangePercent: number;
  closeRatio: number;
  executed: boolean;
}

interface DcaLevel {
  priceChangePercent: number;
  addRatio: number;
  executed: boolean;
  condition: 'RESISTANCE' | 'EMA_RESISTANCE' | 'FIBONACCI' | 'BASIC';
}

interface TrailingStopLoss {
  enabled: boolean;
  activationPrice: number; 
  currentStopPrice: number;
  highestProfit: number; 
  activated: boolean;
}

interface PositionData {
  symbol: string;
  entryPrice: number;
  positionSize: number;
  takeProfitLevels: TakeProfitLevel[];
  stopLossLevels: StopLossLevel[];
  dcaLevels: DcaLevel[];
  timestamp: number;
  initialQty: number;
  closedAmount: number;
  dcaCount: number;
  side: 'SHORT';
  averagePrice: number;
  totalQty: number;
  signalType: string;
  positionId: string;
  realPositionId?: string;
  lastCheckTime?: number;
  checkCount: number;
  isLowCap?: boolean;
  trailingStopLoss?: TrailingStopLoss;
  pendingDcaOrders: Map<string, { level: number; quantity: number; timestamp: number }>; // Theo dõi các lệnh DCA đang chờ
}

interface KillLongSignal {
  symbol: string;
  currentPrice: number;
  pumpPercent: number;
  volumeSpike: number;
  rsi: number;
  killLongStrength: number;
  timestamp: number;
  reason: string;
  resistanceLevel: number;
  supportLevel: number;
  atr: number;
  ema: number;
  trendDirection: string;
  isLowCap: boolean;
  marketCapRank?: number;
  hasKillLongSignal: boolean;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

interface CoinTrackingData {
  symbol: string;
  currentPrice: number;
  dailyVolatility: number;
  volume24h: number;
  trendStrength: number;
  trendDirection: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  timestamp: number;
  status: 'TRACKING' | 'READY_TO_ENTER' | 'ENTERED';
  volumeSpike: number;
  strengthScore: number;
  resistanceLevel: number;
  supportLevel: number;
  rsi: number;
  ema: number;
  atr: number;
  priceHistory: number[];
  volumeHistory: number[];
  hasEntrySignal: boolean;
  signalType: string;
  volatilityScore: number;
  volumeScore: number;
  trendScore: number;
  entrySide: 'SHORT';
  fakePumpSignal: boolean;
  fakePumpStrength: number;
  fakePumpReason: string;
  strongDowntrendSignal: boolean;
  trendAcceleration: number;
  emaAlignment: boolean;
  hasKillLongSignal?: boolean;
  killLongStrength?: number;
  killLongReason?: string;
  pumpPercent?: number;
  isLowCap?: boolean;
  marketCapRank?: number;
}

class OrderManager {
  private positionMap = new Map<string, string>();

  generatePositionId(): string {
    return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  openPosition(entryOrder: Order, slOrder?: Order, tpOrder?: Order): string {
    const positionId = this.generatePositionId();
    
    this.positionMap.set(positionId, entryOrder.orderId);
    
    entryOrder.positionId = positionId;
    if (slOrder) slOrder.positionId = positionId;
    if (tpOrder) tpOrder.positionId = positionId;
    
    return positionId;
  }

  getOrdersByPosition(positionId: string): Order[] {
    const orders: Order[] = [];
    return orders;
  }
}

class DualModeStrategyBot {
  private positions: Map<string, PositionData> = new Map();
  private trackingCoins: Map<string, CoinTrackingData> = new Map();
  private candidateCoins: Map<string, CoinTrackingData> = new Map();
  private lowCapKillLongSignals: Map<string, KillLongSignal> = new Map();
  private accountBalance: number = 0;
  private initialBalance: number = 0;
  private isRunning: boolean = false;
  private totalOrders: number = 0;
  private totalProfit: number = 0;
  private lastScanTime: number = 0;
  private contractInfoCache: Map<string, ContractInfo> = new Map();
  private lastStatusDisplay: number = 0;
  private statusDisplayInterval: number = 1800000;
  private binanceSymbolsCache: Set<string> = new Set();
  private lastBinanceUpdate: number = 0;
  private lastDcaScan: number = 0;
  private orderManager: OrderManager = new OrderManager();
  private lastLowCapScan: number = 0;
  private lowCapScanInterval: number = 120000; 
  private marketCapRankCache: Map<string, number> = new Map();
  
  private realTimeMonitorInterval: NodeJS.Timeout | null = null;
  private activePositionMonitoring: Set<string> = new Set();
  private pendingDcaOrders: Map<string, { symbol: string; level: number; quantity: number; timestamp: number }> = new Map();

  constructor() {
    console.log('🤖 DUAL MODE STRATEGY BOT - FAKE PUMP + STRONG DOWNTREND + LOWCAP KILL LONG');
    console.log('🎯 REAL-TIME POSITION MONITORING: ENABLED');
    console.log('🔍 LOWCAP KILL LONG DETECTION: ENABLED');
    console.log('💰 DCA ORDER TRACKING: ENABLED');
    console.log('🛡️ TRAILING STOP LOSS: ENABLED');
  }

  private async fetchBinanceSymbols(): Promise<Set<string>> {
    try {
      const now = Date.now();
      if (now - this.lastBinanceUpdate < 60 * 60 * 1000 && this.binanceSymbolsCache.size > 0) {
        return this.binanceSymbolsCache;
      }

      const binanceSymbols = new Set<string>();

      const spotResponse = await axios.get<any>('https://api.binance.com/api/v3/exchangeInfo');
      const futuresResponse = await axios.get<any>('https://fapi.binance.com/fapi/v1/exchangeInfo');

      if (spotResponse.data?.symbols) {
        spotResponse.data.symbols.forEach((symbolInfo: any) => {
          if (symbolInfo.symbol.endsWith('USDT')) {
            binanceSymbols.add(symbolInfo.symbol.replace('USDT', '').toUpperCase());
          }
        });
      }

      if (futuresResponse.data?.symbols) {
        futuresResponse.data.symbols.forEach((symbolInfo: any) => {
          if (symbolInfo.symbol.endsWith('USDT')) {
            binanceSymbols.add(symbolInfo.symbol.replace('USDT', '').toUpperCase());
          }
        });
      }

      this.binanceSymbolsCache = binanceSymbols;
      this.lastBinanceUpdate = now;
      
      return binanceSymbols;
    } catch (error) {
      console.log('⚠️ Failed to fetch Binance symbols, using cache');
      return this.binanceSymbolsCache;
    }
  }

  private isOnBinance(symbol: string): boolean {
    const baseSymbol = symbol.replace('USDT', '').toUpperCase();
    return this.binanceSymbolsCache.has(baseSymbol);
  }

  private async estimateMarketCapRank(symbol: string, volume24h: number, currentPrice: number): Promise<number> {
    const cacheKey = symbol;
    if (this.marketCapRankCache.has(cacheKey)) {
      return this.marketCapRankCache.get(cacheKey)!;
    }

    try {
      const volumeScore = Math.log10(volume24h);
      let estimatedRank = 0;
      
      if (volumeScore < 6) { 
        estimatedRank = Math.floor(Math.random() * 200) + 100; 
      } else if (volumeScore < 7) { 
        estimatedRank = Math.floor(Math.random() * 100) + 50; 
      } else {
        estimatedRank = Math.floor(Math.random() * 50); 
      }
      
      this.marketCapRankCache.set(cacheKey, estimatedRank);
      return estimatedRank;
      
    } catch (error) {
      const fallbackRank = Math.floor(Math.random() * 200) + 100;
      this.marketCapRankCache.set(cacheKey, fallbackRank);
      return fallbackRank;
    }
  }

  private detectLowCapKillLong(
    candles: SimpleCandle[],
    currentPrice: number,
    volume24h: number,
    rsi: number,
    ema: number,
    atr: number,
    marketCapRank: number
  ): { hasKillLongSignal: boolean; killLongStrength: number; reason: string; pumpPercent: number } {
    
    if (candles.length < LOWCAP_KILL_LONG_CONFIG.lookbackCandles) {
      return { hasKillLongSignal: false, killLongStrength: 0, reason: 'INSUFFICIENT_DATA', pumpPercent: 0 };
    }

    if (marketCapRank > LOWCAP_KILL_LONG_CONFIG.maxMarketCapRank) {
      return { hasKillLongSignal: false, killLongStrength: 0, reason: 'NOT_LOWCAP', pumpPercent: 0 };
    }

    if (volume24h < LOWCAP_KILL_LONG_CONFIG.minLiquidity) {
      return { hasKillLongSignal: false, killLongStrength: 0, reason: 'LOW_LIQUIDITY', pumpPercent: 0 };
    }

    const recentCandles = candles.slice(-LOWCAP_KILL_LONG_CONFIG.lookbackCandles);
    
    const pumpHigh = Math.max(...recentCandles.map(c => c.high));
    const pumpLow = Math.min(...recentCandles.map(c => c.low));
    
    const pumpPercent = ((pumpHigh - pumpLow) / pumpLow) * 100;
    
    if (pumpPercent < LOWCAP_KILL_LONG_CONFIG.minPumpPercent || 
        pumpPercent > LOWCAP_KILL_LONG_CONFIG.maxPumpPercent) {
      return { hasKillLongSignal: false, killLongStrength: 0, reason: `PUMP_PERCENT_${pumpPercent.toFixed(1)}`, pumpPercent };
    }

    const recentVolume = recentCandles.slice(-4).reduce((sum, c) => sum + c.volume, 0) / 4;
    const previousVolume = recentCandles.slice(-8, -4).reduce((sum, c) => sum + c.volume, 0) / 4;
    const volumeSpike = previousVolume > 0 ? recentVolume / previousVolume : 1;
    
    if (volumeSpike < LOWCAP_KILL_LONG_CONFIG.volumeSpikeThreshold) {
      return { hasKillLongSignal: false, killLongStrength: 0, reason: `LOW_VOLUME_SPIKE_${volumeSpike.toFixed(1)}`, pumpPercent };
    }

    if (rsi < LOWCAP_KILL_LONG_CONFIG.rsiOverbought) {
      return { hasKillLongSignal: false, killLongStrength: 0, reason: `RSI_NOT_OVERBOUGHT_${rsi.toFixed(1)}`, pumpPercent };
    }

    const dropFromHigh = ((pumpHigh - currentPrice) / pumpHigh) * 100;
    
    if (dropFromHigh < LOWCAP_KILL_LONG_CONFIG.killLongDropPercent) {
      return { hasKillLongSignal: false, killLongStrength: 0, reason: `INSUFFICIENT_DROP_${dropFromHigh.toFixed(1)}`, pumpPercent };
    }

    const lastCandle = candles[candles.length - 1];
    const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isRejectionCandle = upperShadow > (bodySize * LOWCAP_KILL_LONG_CONFIG.rejectionCandleThreshold);

    const distanceToEMA = ema > 0 ? Math.abs(currentPrice - ema) / ema : 0;
    const isEMARejection = distanceToEMA <= LOWCAP_KILL_LONG_CONFIG.emaRejectionThreshold && currentPrice < ema;

    const atrPercent = (atr / currentPrice) * 100;
    const hasGoodVolatility = atrPercent >= LOWCAP_KILL_LONG_CONFIG.minATRPercent;

    let killLongScore = 0;
    let reasons: string[] = [];

    if (dropFromHigh >= 3.0) {
      killLongScore += 25;
      reasons.push(`DROP_${dropFromHigh.toFixed(1)}%`);
    }

    if (volumeSpike >= LOWCAP_KILL_LONG_CONFIG.volumeSpikeThreshold) {
      killLongScore += 20;
      reasons.push(`VOLUME_SPIKE_${volumeSpike.toFixed(1)}`);
    }

    if (rsi >= LOWCAP_KILL_LONG_CONFIG.rsiOverbought) {
      killLongScore += 15;
      reasons.push(`RSI_${rsi.toFixed(1)}`);
    }

    if (isRejectionCandle) {
      killLongScore += 15;
      reasons.push('REJECTION_CANDLE');
    }

    if (isEMARejection) {
      killLongScore += 15;
      reasons.push('EMA_REJECTION');
    }

    if (hasGoodVolatility) {
      killLongScore += 10;
      reasons.push(`ATR_${atrPercent.toFixed(1)}%`);
    }

    const hasKillLongSignal = killLongScore >= 70;
    const killLongStrength = Math.min(killLongScore / 100, 1);

    return {
      hasKillLongSignal,
      killLongStrength,
      reason: reasons.join(','),
      pumpPercent
    };
  }

  private calculatePriceChangePercent(entryPrice: number, currentPrice: number): number {
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }

  private calculateEMA(candles: SimpleCandle[], period: number): number {
    if (candles.length < period || candles.length === 0) {
      return candles[candles.length - 1]?.close || 0;
    }

    const relevantCandles = candles.slice(-period);
    const multiplier = 2 / (period + 1);
    
    let ema = relevantCandles[0].close;
    
    for (let i = 1; i < relevantCandles.length; i++) {
      ema = (relevantCandles[i].close * multiplier) + (ema * (1 - multiplier));
    }
    
    return ema;
  }

  private calculateRSI(candles: SimpleCandle[], period: number = 14): number {
    if (candles.length < period + 1) return 50;

    const prices = candles.slice(-period - 1).map(c => c.close);
    let gains = 0;
    let losses = 0;

    for (let i = 1; i < prices.length; i++) {
      const difference = prices[i] - prices[i - 1];
      if (difference >= 0) {
        gains += difference;
      } else {
        losses -= difference;
      }
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  private calculateATR(candles: SimpleCandle[], period: number = 14): number {
    if (candles.length < period + 1) return 0;

    const trueRanges: number[] = [];
    
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];
      
      const tr1 = current.high - current.low;
      const tr2 = Math.abs(current.high - previous.close);
      const tr3 = Math.abs(current.low - previous.close);
      
      const trueRange = Math.max(tr1, tr2, tr3);
      trueRanges.push(trueRange);
    }

    const recentTRs = trueRanges.slice(-period);
    return recentTRs.reduce((sum, tr) => sum + tr, 0) / recentTRs.length;
  }

  private calculateDailyVolatility(candles: SimpleCandle[]): number {
    if (candles.length < 24) return 0;
    
    const recentCandles = candles.slice(-24);
    const dailyHigh = Math.max(...recentCandles.map(c => c.high));
    const dailyLow = Math.min(...recentCandles.map(c => c.low));
    const avgPrice = (dailyHigh + dailyLow) / 2;
    
    return avgPrice > 0 ? ((dailyHigh - dailyLow) / avgPrice) * 100 : 0;
  }

  private calculateTrendStrength(candles: SimpleCandle[]): { strength: number; direction: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' } {
    if (candles.length < 50) return { strength: 0, direction: 'SIDEWAYS' };

    const ema20 = this.calculateEMA(candles, 20);
    const ema50 = this.calculateEMA(candles, 50);
    const currentPrice = candles[candles.length - 1].close;

    const ema20Prev = this.calculateEMA(candles.slice(0, -5), 20);
    const ema50Prev = this.calculateEMA(candles.slice(0, -5), 50);

    const ema20Slope = ema20Prev > 0 ? (ema20 - ema20Prev) / ema20Prev : 0;
    const ema50Slope = ema50Prev > 0 ? (ema50 - ema50Prev) / ema50Prev : 0;

    let direction: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' = 'SIDEWAYS';
    
    if (ema20 > ema50 && currentPrice > ema20 && ema20Slope > 0.001) {
      direction = 'UPTREND';
    } else if (ema20 < ema50 && currentPrice < ema20 && ema20Slope < -0.001) {
      direction = 'DOWNTREND';
    }

    const priceEma20Ratio = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 0;
    const emaGap = ema20 > 0 && ema50 > 0 ? Math.abs(ema20 - ema50) / ((ema20 + ema50) / 2) : 0;
    const slopeStrength = Math.abs(ema20Slope);

    const strength = Math.min((priceEma20Ratio * 10 + emaGap * 20 + slopeStrength * 100) / 3, 1);

    return { strength, direction };
  }

  private calculateTrendAcceleration(candles: SimpleCandle[]): number {
    if (candles.length < 30) return 0;

    const recentPrices = candles.slice(-30).map(c => c.close);
    const midPrices = candles.slice(-60, -30).map(c => c.close);
    
    const recentSlope = this.calculateSlope(recentPrices);
    const midSlope = this.calculateSlope(midPrices);
    
    return recentSlope - midSlope;
  }

  private calculateSlope(prices: number[]): number {
    if (prices.length < 2) return 0;
    
    const n = prices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += prices[i];
      sumXY += i * prices[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  private checkEmaAlignment(candles: SimpleCandle[]): boolean {
    if (candles.length < 100) return false;

    const ema20 = this.calculateEMA(candles, 20);
    const ema50 = this.calculateEMA(candles, 50);
    const ema100 = this.calculateEMA(candles, 100);
    
    return ema20 < ema50 && ema50 < ema100;
  }

  private calculateRealVolume24h(candles: SimpleCandle[]): number {
    if (candles.length < 24) return 0;
    
    const hourlyVolumes: number[] = [];
    for (let i = 0; i < 24; i++) {
      const candle = candles[candles.length - 1 - i];
      if (candle) {
        hourlyVolumes.push(candle.volume);
      }
    }
    
    const avgHourlyVolume = hourlyVolumes.reduce((sum, vol) => sum + vol, 0) / hourlyVolumes.length;
    return avgHourlyVolume * 24;
  }

  private findResistanceLevel(candles: SimpleCandle[], lookback: number = 20): number {
    if (candles.length === 0) return 0;
    const recentCandles = candles.slice(-lookback);
    return Math.max(...recentCandles.map(c => c.high));
  }

  private findSupportLevel(candles: SimpleCandle[], lookback: number = 20): number {
    if (candles.length === 0) return 0;
    const recentCandles = candles.slice(-lookback);
    return Math.min(...recentCandles.map(c => c.low));
  }

  private calculateFibonacciLevels(
    high: number, 
    low: number
  ): { level382: number; level500: number; level618: number } {
    const difference = high - low;
    return {
      level382: high - difference * 0.382,
      level500: high - difference * 0.5,
      level618: high - difference * 0.618
    };
  }

  private hasMinimumBalance(): boolean {
    if (this.initialBalance === 0) return true;
    
    const minBalance = this.initialBalance * STRATEGY_CONFIG.minAccountBalancePercent;
    return this.accountBalance >= minBalance;
  }

  private calculateVolumeSpike(volumes: number[]): number {
    if (volumes.length < 8) return 1;
    const currentVolume = volumes[volumes.length - 1];
    const previousVolumes = volumes.slice(-8, -1);
    const avgVolume = previousVolumes.reduce((a, b) => a + b, 0) / previousVolumes.length;
    return avgVolume > 0 ? currentVolume / avgVolume : 1;
  }

  private calculateStrengthScore(
    volatility: number, 
    volume24h: number, 
    trendStrength: number,
    volumeSpike: number,
    rsi: number,
    trendDirection: string
  ): number {
    const volatilityScore = Math.min((volatility / STRATEGY_CONFIG.minDailyVolatility) * 20, 40);
    const volumeScore = Math.min((volume24h / STRATEGY_CONFIG.minVolume24h) * 15, 30);
    const trendScore = trendStrength * 30;
    
    let additionalScore = 0;
    if (volumeSpike > STRATEGY_CONFIG.volumeSpikeThreshold) {
      additionalScore += 10;
    }
    
    if (trendDirection === 'DOWNTREND' && rsi > STRATEGY_CONFIG.rsiOversold) {
      additionalScore += 10;
    }

    return volatilityScore + volumeScore + trendScore + additionalScore;
  }

  private detectFakePump(
    candles: SimpleCandle[], 
    currentPrice: number,
    ema: number,
    rsi: number,
    volume24h: number
  ): { isFakePump: boolean; pumpStrength: number; reason: string } {
    
    if (candles.length < 24) {
      return { isFakePump: false, pumpStrength: 0, reason: 'INSUFFICIENT_DATA' };
    }

    const recentLow = Math.min(...candles.slice(-12).map(c => c.low));
    const recentHigh = Math.max(...candles.slice(-4).map(c => c.high));
    
    const pumpPercent = ((recentHigh - recentLow) / recentLow) * 100;
    
    if (pumpPercent < STRATEGY_CONFIG.fakePumpDetection.minPumpPercent) {
      return { isFakePump: false, pumpStrength: 0, reason: 'PUMP_TOO_SMALL' };
    }

    const volumeDuringPump = candles.slice(-4).reduce((sum, c) => sum + c.volume, 0) / 4;
    const volumeDuringDowntrend = candles.slice(-24, -4).reduce((sum, c) => sum + c.volume, 0) / 20;
    
    const volumeRatio = volumeDuringDowntrend > 0 ? volumeDuringPump / volumeDuringDowntrend : 1;
    
    const currentRSI = rsi;
    const rsiDuringPump = this.calculateRSI(candles.slice(-8));
    const isRSIDivergence = currentRSI < rsiDuringPump && currentPrice > recentHigh * 0.98;

    const distanceToEMA = ema > 0 ? Math.abs(currentPrice - ema) / ema : 0;
    const isEMARejection = distanceToEMA <= 0.02 && currentPrice < ema;

    const fibLevels = this.calculateFibonacciLevels(recentHigh, recentLow);
    const isAtFibResistance = 
      Math.abs(currentPrice - fibLevels.level382) / fibLevels.level382 <= 0.015 ||
      Math.abs(currentPrice - fibLevels.level500) / fibLevels.level500 <= 0.015;

    let pumpScore = 0;
    let reasons: string[] = [];

    if (volumeRatio < STRATEGY_CONFIG.fakePumpDetection.volumeDivergenceThreshold) {
      pumpScore += 30;
      reasons.push(`LOW_VOLUME_PUMP:${volumeRatio.toFixed(2)}`);
    }

    if (isRSIDivergence) {
      pumpScore += 25;
      reasons.push('RSI_DIVERGENCE');
    }

    if (isEMARejection) {
      pumpScore += 20;
      reasons.push('EMA_REJECTION');
    }

    if (isAtFibResistance) {
      pumpScore += 15;
      reasons.push('FIB_RESISTANCE');
    }

    const lastCandle = candles[candles.length - 1];
    const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isRejectionCandle = upperShadow > (bodySize * 1.5);

    if (isRejectionCandle) {
      pumpScore += 10;
      reasons.push('REJECTION_CANDLE');
    }

    const isFakePump = pumpScore >= 60;
    const pumpStrength = Math.min(pumpScore / 100, 1);

    return { 
      isFakePump, 
      pumpStrength, 
      reason: reasons.join(',') 
    };
  }

  private detectStrongDowntrend(
    candles: SimpleCandle[],
    trendStrength: number,
    trendDirection: string,
    volumeSpike: number,
    currentPrice: number,
    ema: number
  ): { isStrongDowntrend: boolean; trendStrength: number; reason: string } {
    
    if (trendDirection !== 'DOWNTREND') {
      return { isStrongDowntrend: false, trendStrength: 0, reason: 'NOT_DOWNTREND' };
    }

    let trendScore = 0;
    let reasons: string[] = [];

    if (trendStrength >= STRATEGY_CONFIG.strongDowntrend.minTrendStrength) {
      trendScore += 35;
      reasons.push(`STRONG_TREND:${(trendStrength * 100).toFixed(0)}%`);
    }

    if (volumeSpike >= STRATEGY_CONFIG.strongDowntrend.minVolumeSpike) {
      trendScore += 25;
      reasons.push(`HIGH_VOLUME:${volumeSpike.toFixed(2)}`);
    }

    const acceleration = this.calculateTrendAcceleration(candles);
    if (acceleration <= STRATEGY_CONFIG.strongDowntrend.accelerationThreshold) {
      trendScore += 20;
      reasons.push(`ACCELERATING:${acceleration.toFixed(4)}`);
    }

    const emaAlignment = this.checkEmaAlignment(candles);
    if (emaAlignment) {
      trendScore += 20;
      reasons.push('EMA_ALIGNMENT');
    }

    const isStrongDowntrend = trendScore >= 70;
    const normalizedStrength = Math.min(trendScore / 100, 1);

    return {
      isStrongDowntrend,
      trendStrength: normalizedStrength,
      reason: reasons.join(',')
    };
  }

  private detectEntrySignal(
    candles: SimpleCandle[], 
    currentPrice: number, 
    ema: number, 
    rsi: number,
    trendDirection: string,
    support: number,
    resistance: number,
    atr: number,
    volume24h: number,
    trendStrength: number,
    volumeSpike: number
  ): { hasSignal: boolean; signalType: string; side: 'SHORT'; isDcaSignal?: boolean } {
    
    if (candles.length < 2) {
      return { hasSignal: false, signalType: '', side: 'SHORT' };
    }

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    if (STRATEGY_CONFIG.fakePumpDetection.enabled) {
      const fakePump = this.detectFakePump(candles, currentPrice, ema, rsi, volume24h);
      
      if (fakePump.isFakePump) {
        console.log(`🎯 FAKE PUMP DETECTED: ${fakePump.reason} | Strength: ${(fakePump.pumpStrength * 100).toFixed(0)}%`);
        return { 
          hasSignal: true, 
          signalType: `FAKE_PUMP_${fakePump.reason}`, 
          side: 'SHORT',
          isDcaSignal: false 
        };
      }
    }

    const strongDowntrend = this.detectStrongDowntrend(
      candles, trendStrength, trendDirection, volumeSpike, currentPrice, ema
    );

    if (strongDowntrend.isStrongDowntrend) {
      console.log(`🎯 STRONG DOWNTREND DETECTED: ${strongDowntrend.reason} | Strength: ${(strongDowntrend.trendStrength * 100).toFixed(0)}%`);
      return {
        hasSignal: true,
        signalType: `STRONG_DOWNTREND_${strongDowntrend.reason}`,
        side: 'SHORT',
        isDcaSignal: false
      };
    }

    if (trendDirection === 'DOWNTREND') {
      const isNearResistance = currentPrice >= resistance * 0.98;
      const isNearEMA = ema > 0 && currentPrice >= ema * 0.99;
      const isRSIOK = rsi > STRATEGY_CONFIG.rsiOversold;
      const isBearishCandle = lastCandle.close < lastCandle.open && lastCandle.close < prevCandle.close;
      
      if ((isNearResistance || isNearEMA) && isRSIOK && isBearishCandle) {
        return { hasSignal: true, signalType: 'DOWNTREND_PULLBACK', side: 'SHORT' };
      }
    }

    if (trendDirection === 'DOWNTREND') {
      const priceFromResistance = Math.abs(currentPrice - resistance) / resistance;
      const isStrongPullback = priceFromResistance <= 0.03;
      
      const volumes = candles.map(c => c.volume);
      const currentVolumeSpike = this.calculateVolumeSpike(volumes);
      const isLowVolume = currentVolumeSpike < 0.8;
    
      if (isStrongPullback && isLowVolume) {
        return { 
          hasSignal: true, 
          signalType: 'DCA_PULLBACK_OPPORTUNITY', 
          side: 'SHORT',
          isDcaSignal: true 
        };
      }
    }

    if (currentPrice < support && trendDirection === 'DOWNTREND' && rsi > 30) {
      return { hasSignal: true, signalType: 'BREAKDOWN_SUPPORT', side: 'SHORT' };
    }

    return { hasSignal: false, signalType: '', side: 'SHORT' };
  }

  async getContractInfo(symbol: string): Promise<ContractInfo> {
    const cacheKey = symbol.replace('USDT', '_USDT');
    
    if (this.contractInfoCache.has(cacheKey)) {
      return this.contractInfoCache.get(cacheKey)!;
    }

    try {
      const response = await withRetry(async () => {
        const result = await axios.get<any>("https://contract.mexc.com/api/v1/contract/detail");
        return result;
      });
      
      const data = response.data;
      let contractInfo: ContractInfo;
      
      if (Array.isArray(data.data)) {
        const contracts = data.data;
        const info = contracts.find((c: any) => c.symbol === cacheKey);
        
        if (info) {
          contractInfo = {
            symbol: cacheKey,
            contractSize: info.contractSize || 1,
            pricePrecision: info.priceScale || 5,
            volumePrecision: info.volScale || 0
          };
        } else {
          contractInfo = this.getFallbackContractInfo(symbol, cacheKey);
        }
      } else if (data.data && typeof data.data === 'object') {
        const info = data.data as any;
        contractInfo = {
          symbol: cacheKey,
          contractSize: info.contractSize || 1,
          pricePrecision: info.priceScale || 5,
          volumePrecision: info.volScale || 0
        };
      } else {
        contractInfo = this.getFallbackContractInfo(symbol, cacheKey);
      }

      this.contractInfoCache.set(cacheKey, contractInfo);
      return contractInfo;

    } catch (error: any) {
      console.log(`⚠️ Failed to get contract info for ${symbol}, using fallback`);
      return this.getFallbackContractInfo(symbol, cacheKey);
    }
  }

  private getFallbackContractInfo(symbol: string, cacheKey: string): ContractInfo {
    let contractSize = 1;
    let pricePrecision = 5;
    let volumePrecision = 0;

    if (symbol.includes('1000')) {
      contractSize = 0.001;
    } else if (symbol.includes('BTC') || symbol.includes('ETH')) {
      contractSize = 0.0001;
    }

    return {
      symbol: cacheKey,
      contractSize,
      pricePrecision,
      volumePrecision
    };
  }

  async fetchKlineData(symbol: string, interval = "Min5", limit = 288): Promise<SimpleCandle[]> {
    const formattedSymbol = symbol.replace('USDT', '_USDT');
    const url = `https://contract.mexc.com/api/v1/contract/kline/${formattedSymbol}`;
    
    try {
      const response = await withRetry(async () => {
        return await axios.get<any>(url, {
          params: { interval, limit },
        });
      });
      
      const data = response.data;
      if (data.success === true && data.code === 0 && data.data) {
        const obj = data.data;
        if (Array.isArray(obj.time)) {
          const candles: SimpleCandle[] = obj.time.map((t: number, idx: number) => ({
            open: parseFloat(obj.open?.[idx] || obj.close?.[idx] || '0'),
            low: parseFloat(obj.low[idx] || '0'),
            close: parseFloat(obj.close[idx] || '0'),
            high: parseFloat(obj.high[idx] || '0'),
            volume: obj.vol?.[idx] || 0,
            timestamp: t
          }));
          return candles;
        }
      }
      return [];
    } catch (err: any) {
      console.log(`⚠️ Failed to fetch kline data for ${symbol}`);
      return [];
    }
  }

  async calculateDualModeIndicators(symbol: string): Promise<{
    dailyVolatility: number;
    volume24h: number;
    trendStrength: number;
    trendDirection: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
    currentPrice: number;
    volumeSpike: number;
    strengthScore: number;
    candles: SimpleCandle[];
    ema: number;
    rsi: number;
    atr: number;
    resistanceLevel: number;
    supportLevel: number;
    hasEntrySignal: boolean;
    signalType: string;
    entrySide: 'SHORT';
    volatilityScore: number;
    volumeScore: number;
    trendScore: number;
    fakePumpSignal: boolean;
    fakePumpStrength: number;
    fakePumpReason: string;
    strongDowntrendSignal: boolean;
    trendAcceleration: number;
    emaAlignment: boolean;
    hasKillLongSignal?: boolean;
    killLongStrength?: number;
    killLongReason?: string;
    pumpPercent?: number;
    isLowCap?: boolean;
    marketCapRank?: number;
  }> {
    try {
      const candles = await this.fetchKlineData(symbol, "Min5", 288);
      if (candles.length < 24) {
        return this.getDefaultIndicatorResult();
      }

      const currentPrice = candles[candles.length - 1].close;

      const dailyVolatility = this.calculateDailyVolatility(candles);
      const volume24h = this.calculateRealVolume24h(candles);
      const trendAnalysis = this.calculateTrendStrength(candles);

      const volumes = candles.map(k => k.volume);
      const volumeSpike = this.calculateVolumeSpike(volumes);
      const ema = this.calculateEMA(candles, STRATEGY_CONFIG.emaPeriod);
      const rsi = this.calculateRSI(candles);
      const atr = this.calculateATR(candles);
      const resistanceLevel = this.findResistanceLevel(candles, STRATEGY_CONFIG.resistanceLookback);
      const supportLevel = this.findSupportLevel(candles, STRATEGY_CONFIG.resistanceLookback);

      const trendAcceleration = this.calculateTrendAcceleration(candles);
      const emaAlignment = this.checkEmaAlignment(candles);

      const marketCapRank = await this.estimateMarketCapRank(symbol, volume24h, currentPrice);
      const isLowCap = marketCapRank > LOWCAP_KILL_LONG_CONFIG.maxMarketCapRank;
      
      const killLongDetection = this.detectLowCapKillLong(
        candles, currentPrice, volume24h, rsi, ema, atr, marketCapRank
      );

      const entrySignal = this.detectEntrySignal(
        candles, currentPrice, ema, rsi, trendAnalysis.direction, 
        supportLevel, resistanceLevel, atr, volume24h, trendAnalysis.strength, volumeSpike
      );

      const fakePumpDetection = this.detectFakePump(candles, currentPrice, ema, rsi, volume24h);
      
      const strongDowntrendDetection = this.detectStrongDowntrend(
        candles, trendAnalysis.strength, trendAnalysis.direction, volumeSpike, currentPrice, ema
      );

      const strengthScore = this.calculateStrengthScore(
        dailyVolatility,
        volume24h,
        trendAnalysis.strength,
        volumeSpike,
        rsi,
        trendAnalysis.direction
      );

      const volatilityScore = Math.min((dailyVolatility / STRATEGY_CONFIG.minDailyVolatility) * 20, 40);
      const volumeScore = Math.min((volume24h / STRATEGY_CONFIG.minVolume24h) * 15, 30);
      const trendScore = trendAnalysis.strength * 30;

      return { 
        dailyVolatility,
        volume24h,
        trendStrength: trendAnalysis.strength,
        trendDirection: trendAnalysis.direction,
        currentPrice, 
        volumeSpike, 
        strengthScore,
        candles,
        ema,
        rsi,
        atr,
        resistanceLevel,
        supportLevel,
        hasEntrySignal: entrySignal.hasSignal || killLongDetection.hasKillLongSignal,
        signalType: killLongDetection.hasKillLongSignal ? 
          `LOWCAP_KILL_LONG_${killLongDetection.reason}` : 
          entrySignal.signalType,
        entrySide: 'SHORT',
        volatilityScore,
        volumeScore,
        trendScore,
        fakePumpSignal: fakePumpDetection.isFakePump,
        fakePumpStrength: fakePumpDetection.pumpStrength,
        fakePumpReason: fakePumpDetection.reason,
        strongDowntrendSignal: strongDowntrendDetection.isStrongDowntrend,
        trendAcceleration,
        emaAlignment,
        hasKillLongSignal: killLongDetection.hasKillLongSignal,
        killLongStrength: killLongDetection.killLongStrength,
        killLongReason: killLongDetection.reason,
        pumpPercent: killLongDetection.pumpPercent,
        isLowCap,
        marketCapRank
      };
    } catch (error) {
      console.log(`⚠️ Error calculating indicators for ${symbol}`);
      return this.getDefaultIndicatorResult();
    }
  }

  private getDefaultIndicatorResult() {
    return {
      dailyVolatility: 0,
      volume24h: 0,
      trendStrength: 0,
      trendDirection: 'SIDEWAYS' as const,
      currentPrice: 0,
      volumeSpike: 1,
      strengthScore: 0,
      candles: [],
      ema: 0,
      rsi: 50,
      atr: 0,
      resistanceLevel: 0,
      supportLevel: 0,
      hasEntrySignal: false,
      signalType: '',
      entrySide: 'SHORT' as const,
      volatilityScore: 0,
      volumeScore: 0,
      trendScore: 0,
      fakePumpSignal: false,
      fakePumpStrength: 0,
      fakePumpReason: 'ERROR',
      strongDowntrendSignal: false,
      trendAcceleration: 0,
      emaAlignment: false,
      hasKillLongSignal: false,
      killLongStrength: 0,
      killLongReason: 'ERROR',
      pumpPercent: 0,
      isLowCap: false,
      marketCapRank: 999
    };
  }

  async getUSDTBalance(): Promise<number> {
    try {
      const usdtAsset = await client.getAccountAsset('USDT') as any;
      return usdtAsset.data.availableBalance;
    } catch (e: any) {
      console.log('⚠️ Failed to get USDT balance');
      return 0;
    }
  }

  private async calculatePositionSize(symbol: string, percent: number): Promise<number> {
    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0) return 0;

      const contractInfo = await this.getContractInfo(symbol);
      const capital = this.accountBalance * percent;

      let vol = (capital * LEVERAGE) / (currentPrice * contractInfo.contractSize);
      
      const stepSize = Math.pow(10, -contractInfo.volumePrecision);
      vol = Math.floor(vol / stepSize) * stepSize;
      
      return vol;
    } catch (error) {
      return 0;
    }
  }

  private roundVolume(volume: number, volumePrecision: number): number {
    const stepSize = Math.pow(10, -volumePrecision);
    return Math.floor(volume / stepSize) * stepSize;
  }

  async openPosition(symbol: string, quantity: number, side: 'SHORT', signalType: string): Promise<{success: boolean, positionId?: string, realPositionId?: string}> {
    try {
      const contractInfo = await this.getContractInfo(symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      if (currentPrice <= 0) return {success: false};
      
      let openQty = this.roundVolume(quantity, contractInfo.volumePrecision);
      
      if (openQty <= 0) return {success: false};

      const formattedSymbol = symbol.replace('USDT', '_USDT');
      const orderSide = 3; 

      console.log(`🔔 OPEN ORDER: ${symbol} | ${openQty} contracts | Price: ${currentPrice} | Side: SHORT`);

      const orderResponse = await client.submitOrder({
        symbol: formattedSymbol,
        price: currentPrice,
        vol: openQty,
        side: orderSide,
        type: 5, 
        openType: 2,
        leverage: LEVERAGE,
        positionId: 0,
      }) as any;

      let orderId: string;
      let realPositionId: string | undefined;

      if (typeof orderResponse.data === 'string') {
        orderId = orderResponse.data;
      } else if (typeof orderResponse.data === 'object' && orderResponse.data !== null) {
        orderId = orderResponse.data.orderId?.toString() || `order_${Date.now()}`;
        realPositionId = orderResponse.data.positionId?.toString() || undefined;
      } else {
        orderId = `order_${Date.now()}`;
      }

      console.log(`✅ OPEN RESPONSE:`, orderResponse);

      if (!realPositionId) {
        try {
          await new Promise(resolve => setTimeout(resolve, 2000)); 
          
          const positionInfo = await this.getPositionForSymbol(symbol);
          if (positionInfo) {
            realPositionId = positionInfo.id?.toString() || 
                            positionInfo.positionId?.toString();
            console.log(`✅ GOT REAL POSITION ID FROM API: ${symbol} -> ${realPositionId}`);
          }
        } catch (error) {
          console.log(`⚠️ Could not fetch real positionId for ${symbol}`);
        }
      }

      const positionId = this.orderManager.generatePositionId();
      
      this.totalOrders++;
      
      this.startRealTimeMonitoring(symbol, positionId);
      
      return {success: true, positionId, realPositionId};

    } catch (err: any) {
      console.log(`❌ OPEN FAILED: ${symbol} | Error: ${err.message}`);
      return {success: false};
    }
  }

  private async closeAllPositionsForSymbol(symbol: string, position: PositionData, reason: string): Promise<void> {
    try {
      console.log(`🚨 CLOSE ALL TRIGGERED: ${symbol} | Reason: ${reason}`);
      
      const remainingQty = position.positionSize - position.closedAmount;
      if (remainingQty <= 0) {
        console.log(`✅ No remaining quantity to close for ${symbol}`);
        return;
      }

      const contractInfo = await this.getContractInfo(symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      if (currentPrice <= 0) return;

      let closeQty = this.roundVolume(remainingQty, contractInfo.volumePrecision);
      
      if (closeQty <= 0) return;
      
      const formattedSymbol = symbol.replace('USDT', '_USDT');
      const targetPositionId = position.realPositionId ? parseInt(position.realPositionId) : 0;

      console.log(`🔔 CLOSE ALL ORDER: ${symbol} | ${closeQty} contracts | Price: ${currentPrice} | Reason: ${reason} | Side: 2 (CLOSE SHORT)`);

      const orderResponse = await client.submitOrder({
        symbol: formattedSymbol,
        price: currentPrice,
        vol: closeQty,
        side: 2, 
        type: 5, 
        openType: 2,
        leverage: LEVERAGE,
        positionId: targetPositionId,
      }) as any;

      console.log(`✅ CLOSE ALL RESPONSE:`, orderResponse);

      if (orderResponse.success === true && orderResponse.code === 0) {
        position.closedAmount = position.positionSize;
        this.positions.delete(symbol);
        this.activePositionMonitoring.delete(symbol);
        
        console.log(`✅ CLOSE ALL SUCCESS: ${symbol} | Closed ${closeQty} contracts`);
      } else {
        console.log(`❌ CLOSE ALL FAILED: ${symbol} | Error: ${orderResponse.msg || 'Unknown error'}`);
      }

    } catch (error: any) {
      console.log(`❌ CLOSE ALL ERROR: ${symbol} | ${error.message}`);
    }
  }

  async closePosition(symbol: string, quantity: number, side: 'SHORT', reason: string, positionId?: string): Promise<boolean> {
    try {
      const position = this.positions.get(symbol);

      const targetPositionId = position?.realPositionId ? parseInt(position.realPositionId) : 0;

      if (!position) {
        console.log(`❌ CLOSE FAILED: No position found for ${symbol}`);
        return false;
      }

      const contractInfo = await this.getContractInfo(symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      if (currentPrice <= 0) return false;
      
      let closeQty = this.roundVolume(quantity, contractInfo.volumePrecision);
      
      if (closeQty <= 0) return false;
      
      const formattedSymbol = symbol.replace('USDT', '_USDT');

      console.log(`🔔 CLOSE ORDER: ${symbol} | ${closeQty} contracts | Price: ${currentPrice} | Reason: ${reason} | PositionID: ${targetPositionId} | Side: 2 (CLOSE SHORT)`);
      
      const orderResponse = await client.submitOrder({
        symbol: formattedSymbol,
        price: currentPrice,
        vol: closeQty,
        side: 2, 
        type: 5, 
        openType: 2,
        leverage: LEVERAGE,
        positionId: targetPositionId,
      }) as any;

      console.log(`✅ CLOSE RESPONSE:`, orderResponse);

      if (orderResponse.success === false || orderResponse.code !== 0) {
        console.log(`❌ CLOSE ORDER FAILED: ${symbol} | Error: ${orderResponse.msg || 'Unknown error'}`);
        await this.closeAllPositionsForSymbol(symbol, position, 'CLOSE_ALL_ON_ERROR');
        return false;
      }


      if (position) {
        const profit = await this.calculateProfitForQuantity(position, currentPrice, closeQty);
        this.totalProfit += profit;
      }
      
      return true;

    } catch (err: any) {

      const position = this.positions.get(symbol);
      if (position) {
        await this.closeAllPositionsForSymbol(symbol, position, 'CLOSE_ALL_ON_EXCEPTION');
      }
      
      return false;
    }
  }

  private startRealTimeMonitoring(symbol: string, positionId: string): void {
    if (this.activePositionMonitoring.has(symbol)) {
      return; 
    }

    this.activePositionMonitoring.add(symbol);

    const monitorInterval = setInterval(async () => {
      if (!this.positions.has(symbol)) {
        clearInterval(monitorInterval);
        this.activePositionMonitoring.delete(symbol);
        return;
      }

      try {
        const position = this.positions.get(symbol);
        if (!position) return;

        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) return;

        await this.checkImmediateSLTP(symbol, position, currentPrice);

        await this.checkImmediateDCA(symbol, position, currentPrice);

        await this.checkTrailingStopLoss(symbol, position, currentPrice);

      } catch (error) {
        console.log(`⚠️ Real-time monitoring error for ${symbol}`);
      }
    }, 5000); 

    if (!this.realTimeMonitorInterval) {
      this.realTimeMonitorInterval = monitorInterval;
    }
  }

  private async checkImmediateDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes || position.isLowCap) return;

    try {
      const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);

      for (let i = 0; i < position.dcaLevels.length; i++) {
        const level = position.dcaLevels[i];
        
        if (!level.executed) {
          const shouldExecute = priceChange >= level.priceChangePercent;

          if (shouldExecute) {
            const dcaQty = await this.calculatePositionSize(
              symbol, 
              STRATEGY_CONFIG.initialPositionPercent * level.addRatio
            );
            
            if (dcaQty > 0) {
              console.log(`💰 IMMEDIATE DCA ${position.dcaCount + 1} TRIGGERED: ${symbol} | Level: ${level.priceChangePercent}% | Current: ${priceChange.toFixed(2)}%`);

              const dcaOrderId = `dca_${symbol}_${level.priceChangePercent}_${Date.now()}`;
              this.pendingDcaOrders.set(dcaOrderId, {
                symbol,
                level: i,
                quantity: dcaQty,
                timestamp: Date.now()
              });
              
              const success = await this.addToPosition(symbol, dcaQty, 'SHORT', `DCA_${position.signalType}`);
              
              if (success) {
                const newTotalQty = position.totalQty + dcaQty;
                position.averagePrice = (position.averagePrice * position.totalQty + currentPrice * dcaQty) / newTotalQty;
                position.totalQty = newTotalQty;
                position.positionSize = newTotalQty;
                
                position.dcaCount++;
                level.executed = true;
                
                console.log(`✅ IMMEDIATE DCA ${position.dcaCount} EXECUTED: ${symbol} | Added ${dcaQty} contracts | Avg Price: ${position.averagePrice.toFixed(6)}`);

                this.pendingDcaOrders.delete(dcaOrderId);
                break;
              } else {
                console.log(`❌ IMMEDIATE DCA FAILED: ${symbol} | Could not add position`);
                this.pendingDcaOrders.delete(dcaOrderId);
              }
            }
          }
        }
      }
    } catch (error) {
      console.log(`⚠️ Immediate DCA error for ${symbol}`);
    }
  }

  private async checkTrailingStopLoss(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (!STRATEGY_CONFIG.trailingStopLoss.enabled || !position.trailingStopLoss) return;

    const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);

    if (!position.trailingStopLoss.activated && profitData.priceChangePercent <= -STRATEGY_CONFIG.trailingStopLoss.activationProfitPercent) {
      position.trailingStopLoss.activated = true;
      position.trailingStopLoss.activationPrice = currentPrice;
      position.trailingStopLoss.currentStopPrice = currentPrice * (1 + STRATEGY_CONFIG.trailingStopLoss.trailDistancePercent / 100);
      position.trailingStopLoss.highestProfit = profitData.priceChangePercent;
      
      console.log(`🛡️ TRAILING SL ACTIVATED: ${symbol} | Activation: ${STRATEGY_CONFIG.trailingStopLoss.activationProfitPercent}% | Current Stop: ${position.trailingStopLoss.currentStopPrice}`);
    }
    if (position.trailingStopLoss.activated) {
      if (profitData.priceChangePercent < position.trailingStopLoss.highestProfit) {
        position.trailingStopLoss.highestProfit = profitData.priceChangePercent;
        const newStopPrice = currentPrice * (1 + STRATEGY_CONFIG.trailingStopLoss.trailDistancePercent / 100);
        if (newStopPrice < position.trailingStopLoss.currentStopPrice) {
          position.trailingStopLoss.currentStopPrice = newStopPrice;
          console.log(`🛡️ TRAILING SL UPDATED: ${symbol} | New Stop: ${position.trailingStopLoss.currentStopPrice} | Profit: ${profitData.priceChangePercent.toFixed(2)}%`);
        }
      }

      if (currentPrice >= position.trailingStopLoss.currentStopPrice) {
        const remainingQty = position.positionSize - position.closedAmount;
        if (remainingQty > 0) {
          console.log(`🚨 TRAILING SL TRIGGERED: ${symbol} | Current: ${currentPrice} | Stop: ${position.trailingStopLoss.currentStopPrice} | Profit: ${profitData.priceChangePercent.toFixed(2)}%`);
          
          const closeSuccess = await this.closePosition(symbol, remainingQty, 'SHORT', `TRAILING_SL`, position.positionId);
          if (closeSuccess) {
            position.closedAmount += remainingQty;
            console.log(`✅ TRAILING SL EXECUTED: ${symbol} | Closed ${remainingQty} contracts`);
            
            if (position.closedAmount >= position.positionSize) {
              this.positions.delete(symbol);
              this.activePositionMonitoring.delete(symbol);
              return;
            }
          } else {
             console.log(`❌ TRAILING SL EXECUTION FAILED, CLOSE ALL ACTIVATED for ${symbol}`);
            return;
          }
        }
      }
    }
  }

  private async checkImmediateSLTP(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      const level = position.takeProfitLevels[i];
      if (!level.executed) {
        const shouldTP = profitData.priceChangePercent <= -level.priceChangePercent;

        if (shouldTP) {
          const remainingQty = position.positionSize - position.closedAmount;
          let closeQty = remainingQty * level.closeRatio;
          
          const contractInfo = await this.getContractInfo(symbol);
          closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
          closeQty = Math.min(closeQty, remainingQty);
          
          if (closeQty > 0) {
            console.log(`🎯 IMMEDIATE TP ${i+1} TRIGGERED: ${symbol} | Target: ${level.priceChangePercent}% | Current: ${profitData.priceChangePercent.toFixed(2)}%`);
            
            const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `TP${i+1}`, position.positionId);
            if (closeSuccess) {
              position.closedAmount += closeQty;
              level.executed = true;

              console.log(`✅ IMMEDIATE TP ${i+1} EXECUTED: ${symbol} | Closed ${closeQty}/${remainingQty} contracts`);

              if (position.closedAmount >= position.positionSize) {
                this.positions.delete(symbol);
                this.activePositionMonitoring.delete(symbol);
                return;
              }
            } else {
             console.log(`❌ TP ${i+1} EXECUTION FAILED, CLOSE ALL ACTIVATED for ${symbol}`);
              return;
            }
          }
        }
      }
    }

    for (let i = 0; i < position.stopLossLevels.length; i++) {
      const level = position.stopLossLevels[i];
      if (!level.executed) {
        const shouldSL = profitData.priceChangePercent >= level.priceChangePercent;

        if (shouldSL) {
          const remainingQty = position.positionSize - position.closedAmount;
          let closeQty = remainingQty * level.closeRatio;
          
          const contractInfo = await this.getContractInfo(symbol);
          closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
          closeQty = Math.min(closeQty, remainingQty);
          
          if (closeQty > 0) {
            console.log(`🛑 IMMEDIATE SL ${i+1} TRIGGERED: ${symbol} | Stop: ${level.priceChangePercent}% | Current: ${profitData.priceChangePercent.toFixed(2)}%`);
            
            const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `SL${i+1}`, position.positionId);
            if (closeSuccess) {
              position.closedAmount += closeQty;
              level.executed = true;

              console.log(`✅ IMMEDIATE SL ${i+1} EXECUTED: ${symbol} | Closed ${closeQty}/${remainingQty} contracts`);

              if (position.closedAmount >= position.positionSize) {
                this.positions.delete(symbol);
                this.activePositionMonitoring.delete(symbol);
                return;
              }
            } else {
              console.log(`❌ SL ${i+1} EXECUTION FAILED, CLOSE ALL ACTIVATED for ${symbol}`);
              return;
            }
          }
        }
      }
    }
  }

  async addToPosition(symbol: string, quantity: number, side: 'SHORT', signalType: string): Promise<boolean> {
    const position = this.positions.get(symbol);
    const positionId = position?.positionId;
    
    const result = await this.openPosition(symbol, quantity, side, signalType);
    
    if (result.success && positionId && position) {
      console.log(`✅ DCA ADDED to existing position: ${positionId}`);
    }
    
    return result.success;
  }

  async calculateProfitForQuantity(position: PositionData, currentPrice: number, quantity: number): Promise<number> {
    const contractInfo = await this.getContractInfo(position.symbol);
    return (position.averagePrice - currentPrice) * quantity * contractInfo.contractSize;
  }

  async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const formattedSymbol = symbol.replace('USDT', '_USDT');
      const ticker = await client.getTicker(formattedSymbol) as any;
      return ticker.data.lastPrice;
    } catch (error: any) {
      console.log(`⚠️ Failed to get current price for ${symbol}`);
      return 0;
    }
  }

  private async getCurrentPositions(symbol?: string): Promise<any[]> {
    try {
      const formattedSymbol = symbol ? symbol.replace('USDT', '_USDT') : undefined;
      
      const response = await client.getOpenPositions(formattedSymbol) as any;
      
      if (response.data && Array.isArray(response.data)) {
        return response.data;
      }
      return [];
    } catch (error) {
      console.log('⚠️ Failed to get current positions');
      return [];
    }
  }

  private async getPositionForSymbol(symbol: string): Promise<any> {
    try {
      const formattedSymbol = symbol.replace('USDT', '_USDT');
      const positions = await this.getCurrentPositions(formattedSymbol);
      
      if (positions && positions.length > 0) {
        return positions.find((p: any) => p.positionType === 2) || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  private async updateRealPositionIds(): Promise<void> {
    try {
      const currentPositions = await this.getCurrentPositions();
      
      for (const [symbol, position] of this.positions.entries()) {
        const formattedSymbol = symbol.replace('USDT', '_USDT');
        const realPosition = currentPositions.find(
          (p: any) => p.symbol === formattedSymbol && p.positionType === 2
        );
        
        if (realPosition && !position.realPositionId) {
          position.realPositionId = realPosition.id?.toString() || 
                                   realPosition.positionId?.toString();
          console.log(`✅ UPDATED REAL POSITION ID: ${symbol} -> ${position.realPositionId}`);
        }
      }
    } catch (error) {
      console.log('⚠️ Error updating real position IDs');
    }
  }

  async calculateProfitAndPriceChange(position: PositionData, currentPrice: number) {
    const contractInfo = await this.getContractInfo(position.symbol);
    const remainingQty = position.positionSize - position.closedAmount;
    
    const profit = (position.averagePrice - currentPrice) * remainingQty * contractInfo.contractSize;
    
    const totalValue = position.averagePrice * remainingQty * contractInfo.contractSize;
    const marginUsed = totalValue / LEVERAGE;
    const profitPercent = marginUsed > 0 ? (profit / marginUsed) * 100 : 0;
    
    const priceChangePercent = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
    
    return { 
      profit, 
      profitPercent, 
      priceChangePercent,
      remainingQty, 
      marginUsed 
    };
  }

  async getAllFuturePairs(): Promise<string[]> {
    try {
      await this.fetchBinanceSymbols();

      const response = await axios.get<any>("https://contract.mexc.com/api/v1/contract/detail");
      const data = response.data;
      let contracts: any[] = [];
      
      if (Array.isArray(data.data)) {
        contracts = data.data;
      } else if (data.data && typeof data.data === 'object') {
        contracts = [data.data];
      }
      
      const midCapSymbols = contracts
        .filter((contract: any) => {
          if (!contract.symbol || !contract.symbol.includes('USDT')) return false;
          const symbol = contract.symbol.replace('_USDT', 'USDT');
          return this.isOnBinance(symbol);
        })
        .map((contract: any) => contract.symbol.replace('_USDT', 'USDT'));

      return midCapSymbols;
    } catch (error: any) {
      console.log('⚠️ Failed to get future pairs');
      return [];
    }
  }

  async scanLowCapCoins(): Promise<void> {
    if (!LOWCAP_KILL_LONG_CONFIG.enabled) return;

    const now = Date.now();
    if (now - this.lastLowCapScan < this.lowCapScanInterval) return;

    this.lastLowCapScan = now;
    
    const symbols = await this.getAllFuturePairs();
    console.log(`🔍 Scanning ${symbols.length} symbols for LowCap Kill Long signals...`);

    const batchSize = 3;
    let signalsFound = 0;

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (symbol) => {
        try {
          if (this.positions.has(symbol) || this.trackingCoins.has(symbol) || this.lowCapKillLongSignals.has(symbol)) {
            return null;
          }

          const indicators = await this.calculateDualModeIndicators(symbol);
          if (!indicators.isLowCap || !indicators.hasKillLongSignal) {
            return null;
          }

          const killLongSignal: KillLongSignal = {
            symbol,
            currentPrice: indicators.currentPrice,
            pumpPercent: indicators.pumpPercent || 0,
            volumeSpike: indicators.volumeSpike,
            rsi: indicators.rsi,
            killLongStrength: indicators.killLongStrength || 0,
            timestamp: now,
            reason: indicators.killLongReason || '',
            resistanceLevel: indicators.resistanceLevel,
            supportLevel: indicators.supportLevel,
            atr: indicators.atr,
            ema: indicators.ema,
            trendDirection: indicators.trendDirection,
            isLowCap: true,
            marketCapRank: indicators.marketCapRank,
            hasKillLongSignal: true
          };

          signalsFound++;
          return killLongSignal;

        } catch (error) {
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(signal => {
        if (signal) {
          this.lowCapKillLongSignals.set(signal.symbol, signal);
          console.log(`🎯 LOWCAP KILL LONG DETECTED: ${signal.symbol} | Pump: ${signal.pumpPercent.toFixed(1)}% | Strength: ${(signal.killLongStrength * 100).toFixed(0)}% | Reason: ${signal.reason}`);
        }
      });
      if (this.lowCapKillLongSignals.size > 10) {
        const entries = Array.from(this.lowCapKillLongSignals.entries());
        entries.sort(([,a], [,b]) => b.killLongStrength - a.killLongStrength);
        const topSignals = entries.slice(0, 10);
        this.lowCapKillLongSignals = new Map(topSignals);
      }

      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (signalsFound > 0) {
      console.log(`✅ Found ${signalsFound} new LowCap Kill Long signals`);
    }
  }
  async enterLowCapKillLongPositions(): Promise<void> {
    if (this.lowCapKillLongSignals.size === 0) return;

    const currentLowCapPositions = Array.from(this.positions.values())
      .filter(p => p.isLowCap).length;

    if (currentLowCapPositions >= LOWCAP_KILL_LONG_CONFIG.maxPositions) return;

    let enteredCount = 0;

    for (const [symbol, signal] of this.lowCapKillLongSignals.entries()) {
      try {
        if (enteredCount >= LOWCAP_KILL_LONG_CONFIG.maxPositions - currentLowCapPositions) break;
        const indicators = await this.calculateDualModeIndicators(symbol);
        
        if (!indicators.hasKillLongSignal || !indicators.isLowCap) {
          this.lowCapKillLongSignals.delete(symbol);
          continue;
        }

        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;
        const positionSize = await this.calculatePositionSize(
          symbol, 
          LOWCAP_KILL_LONG_CONFIG.positionSizePercent
        );

        if (positionSize <= 0) continue;

        console.log(`🚀 ENTERING LOWCAP KILL LONG: ${symbol} | Pump: ${signal.pumpPercent.toFixed(1)}% | Strength: ${(signal.killLongStrength * 100).toFixed(0)}%`);

        const openResult = await this.openPosition(
          symbol, 
          positionSize, 
          'SHORT', 
          `LOWCAP_KILL_LONG_${signal.reason}`
        );

        if (openResult.success) {
          const position: PositionData = {
            symbol,
            entryPrice: currentPrice,
            positionSize: positionSize,
            takeProfitLevels: [
              { priceChangePercent: -LOWCAP_KILL_LONG_CONFIG.takeProfit, closeRatio: 1.0, executed: false }
            ],
            stopLossLevels: [
              { priceChangePercent: LOWCAP_KILL_LONG_CONFIG.stopLoss, closeRatio: 1.0, executed: false }
            ],
            dcaLevels: [],
            timestamp: Date.now(),
            initialQty: positionSize,
            closedAmount: 0,
            dcaCount: 0,
            side: 'SHORT',
            averagePrice: currentPrice,
            totalQty: positionSize,
            signalType: `LOWCAP_KILL_LONG_${signal.reason}`,
            positionId: openResult.positionId || this.orderManager.generatePositionId(),
            realPositionId: openResult.realPositionId,
            checkCount: 0,
            isLowCap: true,
            trailingStopLoss: STRATEGY_CONFIG.trailingStopLoss.enabled ? {
              enabled: true,
              activationPrice: 0,
              currentStopPrice: 0,
              highestProfit: 0,
              activated: false
            } : undefined,
            pendingDcaOrders: new Map()
          };

          this.positions.set(symbol, position);
          this.lowCapKillLongSignals.delete(symbol);
          enteredCount++;

          console.log(`✅ LOWCAP KILL LONG POSITION OPENED: ${symbol} | Size: ${positionSize} | Entry: ${currentPrice} | TP: ${LOWCAP_KILL_LONG_CONFIG.takeProfit}% | SL: ${LOWCAP_KILL_LONG_CONFIG.stopLoss}%`);
        }

      } catch (error) {
        console.log(`❌ Failed to enter LowCap Kill Long position for ${symbol}`);
      }
    }

    if (enteredCount > 0) {
      console.log(`✅ Entered ${enteredCount} LowCap Kill Long positions`);
    }
  }

  async scanAndSelectTopCoins(): Promise<void> {
    const now = Date.now();
    
    if (now - this.lastScanTime < 60000) {
      return;
    }

    this.lastScanTime = now;
    const symbols = await this.getAllFuturePairs();
    
    const candidateList: { symbol: string; coinData: CoinTrackingData }[] = [];

    const batchSize = 5;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const batchPromises = batch.map(async (symbol) => {
        try {
          if (this.positions.has(symbol) || this.trackingCoins.has(symbol)) {
            return null;
          }

          const indicators = await this.calculateDualModeIndicators(symbol);
          
          const meetsVolatility = indicators.dailyVolatility >= STRATEGY_CONFIG.minDailyVolatility;
          const meetsVolume = indicators.volume24h >= STRATEGY_CONFIG.minVolume24h;
          const meetsTrend = indicators.trendStrength >= STRATEGY_CONFIG.trendStrengthThreshold;
          const hasSignal = indicators.hasEntrySignal;

          if (!meetsVolatility || !meetsVolume || !hasSignal) {
            return null;
          }

          const currentPrice = await this.getCurrentPrice(symbol);
          
          const coinData: CoinTrackingData = {
            symbol,
            currentPrice,
            dailyVolatility: indicators.dailyVolatility,
            volume24h: indicators.volume24h,
            trendStrength: indicators.trendStrength,
            trendDirection: indicators.trendDirection,
            timestamp: now,
            status: 'TRACKING',
            volumeSpike: indicators.volumeSpike,
            strengthScore: indicators.strengthScore,
            resistanceLevel: indicators.resistanceLevel,
            supportLevel: indicators.supportLevel,
            rsi: indicators.rsi,
            ema: indicators.ema,
            atr: indicators.atr,
            priceHistory: indicators.candles.slice(-10).map(c => c.close),
            volumeHistory: indicators.candles.slice(-10).map(c => c.volume),
            hasEntrySignal: indicators.hasEntrySignal,
            signalType: indicators.signalType,
            volatilityScore: indicators.volatilityScore,
            volumeScore: indicators.volumeScore,
            trendScore: indicators.trendScore,
            entrySide: 'SHORT',
            fakePumpSignal: indicators.fakePumpSignal,
            fakePumpStrength: indicators.fakePumpStrength,
            fakePumpReason: indicators.fakePumpReason,
            strongDowntrendSignal: indicators.strongDowntrendSignal,
            trendAcceleration: indicators.trendAcceleration,
            emaAlignment: indicators.emaAlignment,
            hasKillLongSignal: indicators.hasKillLongSignal,
            killLongStrength: indicators.killLongStrength,
            killLongReason: indicators.killLongReason,
            pumpPercent: indicators.pumpPercent,
            isLowCap: indicators.isLowCap,
            marketCapRank: indicators.marketCapRank
          };

          return { symbol, coinData };
        } catch (error) {
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      const validResults = batchResults.filter(result => result !== null) as { symbol: string; coinData: CoinTrackingData }[];
      candidateList.push(...validResults);

      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    candidateList.sort((a, b) => b.coinData.strengthScore - a.coinData.strengthScore);
    const topCandidates = candidateList.slice(0, 15);

    this.candidateCoins.clear();
    topCandidates.forEach(candidate => {
      this.candidateCoins.set(candidate.symbol, candidate.coinData);
    });
  }

  private updateTrackingList(): void {
    const availableSlots = STRATEGY_CONFIG.maxTrackingCoins - this.trackingCoins.size;
    if (availableSlots <= 0 || this.candidateCoins.size === 0) return;

    const candidatesArray = Array.from(this.candidateCoins.entries())
      .filter(([symbol]) => !this.trackingCoins.has(symbol))
      .sort(([,a], [,b]) => b.strengthScore - a.strengthScore);

    const coinsToAdd = candidatesArray.slice(0, availableSlots);
    coinsToAdd.forEach(([symbol, coinData]) => {
      this.trackingCoins.set(symbol, coinData);
      this.candidateCoins.delete(symbol);
    });
  }

  async trackTopCoinsRealTime(): Promise<void> {
    if (this.trackingCoins.size === 0) return;

    let enteredCount = 0;
    let removedCount = 0;

    for (const [symbol, coinData] of this.trackingCoins.entries()) {
      try {
        if (!this.hasMinimumBalance() || this.positions.size >= STRATEGY_CONFIG.maxActivePositions) {
          continue;
        }

        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;

        coinData.currentPrice = currentPrice;

        const indicators = await this.calculateDualModeIndicators(symbol);
        coinData.dailyVolatility = indicators.dailyVolatility;
        coinData.volume24h = indicators.volume24h;
        coinData.trendStrength = indicators.trendStrength;
        coinData.trendDirection = indicators.trendDirection;
        coinData.volumeSpike = indicators.volumeSpike;
        coinData.rsi = indicators.rsi;
        coinData.ema = indicators.ema;
        coinData.resistanceLevel = indicators.resistanceLevel;
        coinData.supportLevel = indicators.supportLevel;
        coinData.hasEntrySignal = indicators.hasEntrySignal;
        coinData.signalType = indicators.signalType;
        coinData.strengthScore = indicators.strengthScore;
        coinData.fakePumpSignal = indicators.fakePumpSignal;
        coinData.fakePumpStrength = indicators.fakePumpStrength;
        coinData.fakePumpReason = indicators.fakePumpReason;
        coinData.strongDowntrendSignal = indicators.strongDowntrendSignal;
        coinData.trendAcceleration = indicators.trendAcceleration;
        coinData.emaAlignment = indicators.emaAlignment;

        if (coinData.hasEntrySignal && coinData.status === 'TRACKING') {
          console.log(`🎯 DUAL MODE SIGNAL: ${symbol} | ${coinData.signalType} | Vol: ${coinData.dailyVolatility.toFixed(1)}% | Vol24h: $${(coinData.volume24h/1000000).toFixed(1)}M | Trend: ${coinData.trendDirection} (${(coinData.trendStrength*100).toFixed(0)}%)`);
          
          coinData.status = 'READY_TO_ENTER';
        }

        if (coinData.status === 'READY_TO_ENTER') {
          console.log(`🚀 ENTERING ${coinData.signalType}: ${symbol} | Price: ${currentPrice}`);
          
          await this.enterPosition(symbol, coinData.signalType);
          coinData.status = 'ENTERED';
          enteredCount++;
          this.trackingCoins.delete(symbol);
          removedCount++;
        }
        const timeDiff = Date.now() - coinData.timestamp;
        if (timeDiff > 45 * 60 * 1000 && coinData.status === 'TRACKING') {
          this.trackingCoins.delete(symbol);
          removedCount++;
        }

      } catch (error) {
        console.log(`⚠️ Error tracking ${symbol}`);
      }
    }

    if (enteredCount > 0) {
      console.log(`✅ Entered ${enteredCount} DUAL MODE positions`);
    }
  }

  async enterPosition(symbol: string, signalType: string): Promise<void> {
    if (this.positions.has(symbol)) return;

    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0 || !this.hasMinimumBalance()) return;

      let initialQty: number;

      if (signalType.includes('FAKE_PUMP')) {
        initialQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent * 1.3);
      } else if (signalType.includes('STRONG_DOWNTREND')) {
        initialQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent * 1.1);
      } else if (signalType.includes('LOWCAP_KILL_LONG')) {
        initialQty = await this.calculatePositionSize(symbol, LOWCAP_KILL_LONG_CONFIG.positionSizePercent);
      } else {
        initialQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent);
      }

      if (initialQty <= 0) return;

      const openResult = await this.openPosition(symbol, initialQty, 'SHORT', signalType);
      if (!openResult.success) return;

      const actualPrice = await this.getCurrentPrice(symbol);
      const isLowCap = signalType.includes('LOWCAP_KILL_LONG');
      
      const position: PositionData = {
        symbol,
        entryPrice: actualPrice,
        positionSize: initialQty,
        takeProfitLevels: isLowCap ? 
          [{ priceChangePercent: -LOWCAP_KILL_LONG_CONFIG.takeProfit, closeRatio: 1.0, executed: false }] :
          STRATEGY_CONFIG.takeProfitLevels.map(level => ({ ...level, executed: false })),
        stopLossLevels: isLowCap ?
          [{ priceChangePercent: LOWCAP_KILL_LONG_CONFIG.stopLoss, closeRatio: 1.0, executed: false }] :
          STRATEGY_CONFIG.stopLossLevels.map(level => ({ ...level, executed: false })),
        dcaLevels: isLowCap ? [] : STRATEGY_CONFIG.dcaLevels.map(level => ({ 
          ...level, 
          executed: false,
          condition: level.condition as 'RESISTANCE' | 'EMA_RESISTANCE' | 'FIBONACCI' | 'BASIC'
        })),
        timestamp: Date.now(),
        initialQty,
        closedAmount: 0,
        dcaCount: 0,
        side: 'SHORT',
        averagePrice: actualPrice,
        totalQty: initialQty,
        signalType: signalType,
        positionId: openResult.positionId || this.orderManager.generatePositionId(),
        realPositionId: openResult.realPositionId,
        checkCount: 0,
        isLowCap,
        trailingStopLoss: STRATEGY_CONFIG.trailingStopLoss.enabled ? {
          enabled: true,
          activationPrice: 0,
          currentStopPrice: 0,
          highestProfit: 0,
          activated: false
        } : undefined,
        pendingDcaOrders: new Map()
      };

      this.positions.set(symbol, position);

    } catch (error) {
      console.log(`❌ ENTRY FAILED: ${symbol}`);
    }
  }

  async executeDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes || position.isLowCap) return;

    try {
      const indicators = await this.calculateDualModeIndicators(symbol);
      
      const dcaCheck = this.checkPositiveDcaConditions(
        symbol, 
        position, 
        currentPrice, 
        indicators,
        indicators.candles
      );

      if (!dcaCheck.shouldDCA) {
        return;
      }

      console.log(`🎯 DCA SIGNAL DETECTED: ${symbol} | Reason: ${dcaCheck.dcaReason} | Current Price: ${currentPrice} | Avg Price: ${position.averagePrice} | PositionID: ${position.positionId}`);

      for (let i = 0; i < position.dcaLevels.length; i++) {
        const level = position.dcaLevels[i];
        
        if (!level.executed) {
          const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
          
          const shouldExecute = priceChange >= level.priceChangePercent;

          if (shouldExecute) {
            const dcaQty = await this.calculatePositionSize(
              symbol, 
              STRATEGY_CONFIG.initialPositionPercent * level.addRatio
            );
            
            if (dcaQty > 0) {
              console.log(`💰 ATTEMPTING DCA ${position.dcaCount + 1}: ${symbol} | ${dcaQty} contracts | Level: ${level.priceChangePercent}% | Condition: ${level.condition} | PositionID: ${position.positionId}`);
              const dcaOrderId = `dca_${symbol}_${level.priceChangePercent}_${Date.now()}`;
              this.pendingDcaOrders.set(dcaOrderId, {
                symbol,
                level: i,
                quantity: dcaQty,
                timestamp: Date.now()
              });
              
              const success = await this.addToPosition(symbol, dcaQty, 'SHORT', `DCA_${position.signalType}`);
              
              if (success) {
                const newTotalQty = position.totalQty + dcaQty;
                position.averagePrice = (position.averagePrice * position.totalQty + currentPrice * dcaQty) / newTotalQty;
                position.totalQty = newTotalQty;
                position.positionSize = newTotalQty;
                
                position.dcaCount++;
                level.executed = true;
                
                console.log(`✅ DCA ${position.dcaCount} EXECUTED: ${symbol} | PositionID: ${position.positionId}`);
                console.log(`   ↳ Added ${dcaQty} contracts | Avg Price: ${position.averagePrice.toFixed(6)}`);
                console.log(`   ↳ Reason: ${dcaCheck.dcaReason} | Current Price: ${currentPrice}`);
                console.log(`   ↳ RSI: ${indicators.rsi.toFixed(1)} | Trend: ${indicators.trendDirection}`);

                this.pendingDcaOrders.delete(dcaOrderId);
                break;
              } else {
                console.log(`❌ DCA FAILED: ${symbol} | Could not add position | PositionID: ${position.positionId}`);
                this.pendingDcaOrders.delete(dcaOrderId);
              }
            }
          }
        }
      }
    } catch (error) {
      console.log(`⚠️ DCA Error for ${symbol}`);
    }
  }

  private checkPositiveDcaConditions(
    symbol: string,
    position: PositionData,
    currentPrice: number,
    indicators: any,
    candles: SimpleCandle[]
  ): { shouldDCA: boolean; dcaReason: string } {
    
    const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
    
    if (indicators.trendDirection !== 'DOWNTREND') {
      return { shouldDCA: false, dcaReason: 'TREND_CHANGED' };
    }

    const currentVolume = candles[candles.length - 1]?.volume || 0;
    const avgVolume = candles.slice(-10).reduce((sum, c) => sum + c.volume, 0) / 10;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    
    if (volumeRatio > 1) {
      return { shouldDCA: false, dcaReason: 'VOLUME_TOO_HIGH' };
    }

    const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
    const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
    const fibLevels = this.calculateFibonacciLevels(recentHigh, recentLow);

    const resistanceDistance = Math.abs(indicators.resistanceLevel - currentPrice) / indicators.resistanceLevel;
    if (resistanceDistance <= 0.02) {
      return { shouldDCA: true, dcaReason: 'RESISTANCE_TOUCH' };
    }

    const emaDistance = Math.abs(indicators.ema - currentPrice) / indicators.ema;
    if (emaDistance <= 0.015 && currentPrice < indicators.ema) {
      return { shouldDCA: true, dcaReason: 'EMA_RESISTANCE' };
    }

    const fib382Distance = Math.abs(fibLevels.level382 - currentPrice) / fibLevels.level382;
    const fib500Distance = Math.abs(fibLevels.level500 - currentPrice) / fibLevels.level500;
    const fib618Distance = Math.abs(fibLevels.level618 - currentPrice) / fibLevels.level618;

    if (fib382Distance <= 0.015 || fib500Distance <= 0.015 || fib618Distance <= 0.015) {
      return { shouldDCA: true, dcaReason: 'FIBONACCI_LEVEL' };
    }

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    
    const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isRejectionCandle = upperShadow > (bodySize * 2) && (bodySize / lastCandle.open) < 0.01;

    if (isRejectionCandle && priceChange > 2) {
      return { shouldDCA: true, dcaReason: 'PRICE_REJECTION' };
    }

    return { shouldDCA: false, dcaReason: 'NO_CONDITION_MET' };
  }

  async scanDcaOpportunities(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDcaScan < 30000) return;
    
    this.lastDcaScan = now;

    if (this.positions.size === 0) return;

    for (const [symbol, position] of this.positions.entries()) {
      try {
        if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes || position.isLowCap) continue;

        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;

        const indicators = await this.calculateDualModeIndicators(symbol);
        
        const dcaCheck = this.checkPositiveDcaConditions(
          symbol, 
          position, 
          currentPrice, 
          indicators,
          indicators.candles
        );

        if (dcaCheck.shouldDCA) {
          console.log(`🎯 DCA OPPORTUNITY: ${symbol} | Reason: ${dcaCheck.dcaReason} | PositionID: ${position.positionId}`);
          console.log(`   ↳ Current Price: ${currentPrice} | Avg Price: ${position.averagePrice}`);
          console.log(`   ↳ RSI: ${indicators.rsi.toFixed(1)} | Trend: ${indicators.trendDirection}`);
          
          await this.executeDCA(symbol, position, currentPrice);
        }

      } catch (error) {
        console.log(`⚠️ DCA Scan Error for ${symbol}`);
      }
    }
  }

  async managePositions(): Promise<void> {
    const positionsToManage = Array.from(this.positions.entries())
      .filter(([symbol]) => !this.activePositionMonitoring.has(symbol));

    if (positionsToManage.length === 0) return;

    const closedPositions: string[] = [];

    for (const [symbol, position] of positionsToManage) {
      try {
        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;

        const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);

        for (let i = 0; i < position.takeProfitLevels.length; i++) {
          const level = position.takeProfitLevels[i];
          if (!level.executed) {
            const shouldTP = profitData.priceChangePercent <= -level.priceChangePercent;

            if (shouldTP) {
              const remainingQty = position.positionSize - position.closedAmount;
              let closeQty = remainingQty * level.closeRatio;
              
              const contractInfo = await this.getContractInfo(symbol);
              closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
              closeQty = Math.min(closeQty, remainingQty);
              
              if (closeQty > 0) {
                const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `TP${i+1}`, position.positionId);
                if (closeSuccess) {
                  position.closedAmount += closeQty;
                  level.executed = true;

                  if (position.closedAmount >= position.positionSize) {
                    closedPositions.push(symbol);
                    break;
                  }
                } else {
                  closedPositions.push(symbol);
                  break;
                }
              }
            }
          }
        }

        for (let i = 0; i < position.stopLossLevels.length; i++) {
          const level = position.stopLossLevels[i];
          if (!level.executed) {
            const shouldSL = profitData.priceChangePercent >= level.priceChangePercent;

            if (shouldSL) {
              const remainingQty = position.positionSize - position.closedAmount;
              let closeQty = remainingQty * level.closeRatio;
              
              const contractInfo = await this.getContractInfo(symbol);
              closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
              closeQty = Math.min(closeQty, remainingQty);
              
              if (closeQty > 0) {
                const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `SL${i+1}`, position.positionId);
                if (closeSuccess) {
                  position.closedAmount += closeQty;
                  level.executed = true;

                  if (position.closedAmount >= position.positionSize) {
                    closedPositions.push(symbol);
                    break;
                  }
                } else {
                  closedPositions.push(symbol);
                  break;
                }
              }
            }
          }
        }

        if (position.closedAmount >= position.positionSize) {
          closedPositions.push(symbol);
        }

      } catch (error) {
        console.log(`⚠️ Error managing position ${symbol}`);
      }
    }

    closedPositions.forEach(symbol => {
      this.positions.delete(symbol);
      this.activePositionMonitoring.delete(symbol);
    });
  }

  async displayStatus(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStatusDisplay < this.statusDisplayInterval) {
      return;
    }

    this.lastStatusDisplay = now;
    console.log(`\n📊 [${new Date().toLocaleTimeString()}] STATUS:`);
    console.log(`   💰 Balance: ${this.accountBalance.toFixed(2)} USDT`);
    console.log(`   🔍 Tracking: ${this.trackingCoins.size} coins`);
    console.log(`   💼 Positions: ${this.positions.size}`);
    console.log(`   📈 Orders: ${this.totalOrders}`);
    console.log(`   💵 PnL: ${this.totalProfit.toFixed(2)} USDT`);
    console.log(`   🔄 Pending DCA Orders: ${this.pendingDcaOrders.size}`);
    
    if (this.positions.size > 0) {
      console.log(`\n💼 ACTIVE POSITIONS:`);
      for (const [symbol, position] of this.positions.entries()) {
        const currentPrice = await this.getCurrentPrice(symbol);
        const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
        const status = profitData.profit >= 0 ? 'PROFIT' : 'LOSS';
        const closedPercent = ((position.closedAmount / position.positionSize) * 100).toFixed(1);
        
        let trailingInfo = '';
        if (position.trailingStopLoss?.activated) {
          trailingInfo = ` | 🛡️ Trailing SL: ${position.trailingStopLoss.currentStopPrice}`;
        }
        
        let dcaInfo = '';
        if (position.dcaCount > 0) {
          dcaInfo = ` | DCA: ${position.dcaCount}/${STRATEGY_CONFIG.maxDcaTimes}`;
        }
        
        console.log(`   ${symbol}: ${status} $${profitData.profit.toFixed(2)} (${profitData.priceChangePercent.toFixed(1)}%) | Closed: ${closedPercent}%${dcaInfo}${trailingInfo} | ${position.signalType}`);
      }
    }
    
    if (this.pendingDcaOrders.size > 0) {
      console.log(`\n⏳ PENDING DCA ORDERS:`);
      for (const [orderId, order] of this.pendingDcaOrders.entries()) {
        const age = Date.now() - order.timestamp;
        console.log(`   ${order.symbol} | Level: ${order.level + 1} | Qty: ${order.quantity} | Age: ${(age / 1000).toFixed(0)}s`);
      }
    }
    console.log('');
  }

  async run(): Promise<void> {
    console.log('🚀 Starting DUAL MODE STRATEGY BOT');
    console.log('🎯 REAL-TIME POSITION MONITORING: ENABLED');
    console.log('💰 DCA ORDER TRACKING: ENABLED');
    console.log('🛡️ TRAILING STOP LOSS: ENABLED');
    
    await this.fetchBinanceSymbols();
    
    this.accountBalance = await this.getUSDTBalance();
    this.initialBalance = this.accountBalance;
    
    if (this.accountBalance <= 0) {
      console.error('❌ Cannot get balance');
      return;
    }
    
    console.log(`💰 Initial Balance: ${this.initialBalance.toFixed(2)} USDT\n`);
    
    this.isRunning = true;

    const positionIdUpdateInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(positionIdUpdateInterval);
        return;
      }
      await this.updateRealPositionIds();
    }, 300000);

    const mainLoop = async (): Promise<void> => {
      if (!this.isRunning) return;

      try {
        this.accountBalance = await this.getUSDTBalance();
        await this.scanAndSelectTopCoins();
        this.updateTrackingList();
        await this.trackTopCoinsRealTime();
        await this.managePositions();
        
        await this.scanDcaOpportunities();
        
        await this.scanLowCapCoins();
        await this.enterLowCapKillLongPositions();
        
        await this.displayStatus();

        setImmediate(mainLoop);

      } catch (error) {
        setTimeout(mainLoop, 5000);
      }
    };

    mainLoop();
  }

  stop(): void {
    this.isRunning = false;
    if (this.realTimeMonitorInterval) {
      clearInterval(this.realTimeMonitorInterval);
      this.realTimeMonitorInterval = null;
    }
    
    console.log(`\n🛑 Bot stopped | Total Orders: ${this.totalOrders} | Total PnL: ${this.totalProfit.toFixed(2)} USDT`);
    console.log(`📊 Pending DCA Orders cancelled: ${this.pendingDcaOrders.size}`);
  }
}
const bot = new DualModeStrategyBot();

process.on('SIGINT', () => {
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bot.stop();
  process.exit(0);
});

bot.run().catch(console.error);