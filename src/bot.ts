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
  initialPositionPercent: 0.07,
  maxTotalPositionPercent: 0.21,
  takeProfitLevels: [
    { priceChangePercent: 2.0, closeRatio: 0.4 },
    { priceChangePercent: 4.0, closeRatio: 0.4 },
    { priceChangePercent: 10.0, closeRatio: 0.2 }
  ],
  stopLossLevels: [
    { priceChangePercent: 2.5, closeRatio: 0.5 },
    { priceChangePercent: 4.0, closeRatio: 0.5 }
  ],
  minDailyVolatility: 3.0,
  minVolume24h: 5000000,
  trendStrengthThreshold: 0.6,
  volumeSpikeThreshold: 1.2,
  maxActivePositions: 3,
  maxTrackingCoins: 10,
  minAccountBalancePercent: 0.15,
  emaPeriod: 21,
  resistanceLookback: 20,
  marketSentiment: {
    volumeDivergenceThreshold: 0.7,
    priceRejectionThreshold: 1.5,
    fearGreedThreshold: 0.6,
    momentumDivergence: true,
    marketStructureBreak: true
  },
  dcaLevels: [
    { priceChangePercent: 1.0, addRatio: 0.07, condition: 'MICRO_PULLBACK' },
    { priceChangePercent: 2.5, addRatio: 0.07, condition: 'STRONG_RESISTANCE' }
  ],
  maxDcaTimes: 2,
  dcaConditions: {
    volumeDropThreshold: 0.7,
    emaResistance: true,
    fibonacciLevels: [0.382, 0.5, 0.618],
    aggressiveDCA: {
      enabled: true,
      minTrendStrength: 0.7,
      maxTimeBetweenDCA: 180000,
      volumeConfirmation: true,
      minPriceDrop: 0.5
    }
  },
  fakePumpDetection: {
    enabled: true,
    minPumpPercent: 4,
    maxDropFromPump: 8,
    volumeDivergenceThreshold: 1.2,
    timeFrame: 4,
    momentumDivergence: true,
    emaRejection: true,
    maxRetracement: 0.382,
    minPumpCandles: 3,
    requireUptrend: false
  },
  strongDowntrend: {
    minTrendStrength: 0.75,
    minVolumeSpike: 1.5,
    accelerationThreshold: -0.001,
    emaAlignment: true
  },
  trailingStopLoss: {
    enabled: true,
    activationProfitPercent: 1.5,
    trailDistancePercent: 0.8,
    maxTrailDistancePercent: 4.0
  },
  positiveDCA: {
    enabled: true,
    minPullbackPercent: 0.3,
    maxPullbackPercent: 5.0,
    volumeDropThreshold: 0.8,
    momentumThreshold: 0.03,
    emaResistance: true,
    fibonacciRetracement: true,
    pullbackDCA: {
      enabled: true,
      minTrendStrength: 0.6,
      maxConsecutiveDCA: 2,
      timeBetweenDCA: 180000,
      volumeMultiplier: 1.0,
      requireVolumeConfirmation: true,
      maxTotalDcaPercent: 0.21
    }
  },
  trendStrengthCheck: {
    minTrendStrength: 0.5,
    emaAlignment: true,
    maxMomentum: -0.003,
    minVolumeSpike: 1.1,
    trendAccelerationThreshold: -0.0005,
    reversalDetection: {
      momentumDivergence: true,
      pricePattern: true,
      volumeConfirmation: true,
      minReversalStrength: 0.6
    }
  },
  entryFilters: {
    max24hDropPercent: 20,
    maxRecentDropPercent: 15,
    minDistanceToSupportPercent: 1,
    maxDowntrendDurationHours: 72
  }
};

const LOWCAP_KILL_LONG_CONFIG = {
  enabled: true,
  minPumpPercent: 8,
  maxPumpPercent: 100,
  volumeSpikeThreshold: 2.0,
  killLongDropPercent: 2.0,
  momentumOverbought: 0.03,
  maxMarketCapRank: 500,
  minLiquidity: 300000,
  positionSizePercent: 0.07,
  takeProfit: 10.0,
  stopLoss: 5.0,
  maxPositions: 2,
  timeframe: "Min5",
  lookbackCandles: 20,
  rejectionCandleThreshold: 1.5,
  emaRejectionThreshold: 0.03,
  minATRPercent: 1.5,
  maxPositionAge: 3600000,
  maxDropFromPump: 20,
  minVolumeRetention: 0.6
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
  quantity?: number;
}

interface StopLossLevel {
  priceChangePercent: number;
  closeRatio: number;
  executed: boolean;
  quantity?: number;
}

interface DcaLevel {
  priceChangePercent: number;
  addRatio: number;
  executed: boolean;
  condition: 'RESISTANCE' | 'EMA_RESISTANCE' | 'FIBONACCI' | 'BASIC' | 'POSITIVE_PULLBACK' | 'MICRO_PULLBACK' | 'RESISTANCE_TOUCH' | 'STRONG_RESISTANCE';
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
  pendingDcaOrders: Map<string, { level: number; quantity: number; timestamp: number }>;
  sltpRecalculated: boolean;
  originalTakeProfitLevels?: TakeProfitLevel[];
  originalStopLossLevels?: StopLossLevel[];
  lastDcaTime?: number;
  consecutiveDcaCount: number;
  lastConsecutiveDcaTime?: number;
  aggressiveDcaMode: boolean;
  totalDcaVolume: number;
  maxDcaVolume: number;
}

interface KillLongSignal {
  symbol: string;
  currentPrice: number;
  pumpPercent: number;
  volumeSpike: number;
  marketMomentum: number;
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
  marketMomentum: number;
  fearGreedIndex: number;
  volumeDivergence: number;
  priceMomentum: number;
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
  public positions: Map<string, PositionData> = new Map();
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
  private lastDcaCheck: Map<string, number> = new Map();

  constructor() {
    console.log('🤖 DUAL MODE STRATEGY BOT - FAKE PUMP + STRONG DOWNTREND + LOWCAP KILL LONG');
    console.log('🎯 UPDATED CONFIG: Initial Position 7%, 2 DCA Levels (7% each)');
    console.log('💰 POSITION SIZE: 7% account | DCA: 2x 7%');
    console.log('📈 TOTAL EXPOSURE: 21% account (7% + 14% DCA)');
    console.log('🛡️ ENTRY FILTERS: Active - Avoid large drops, long downtrends');
    console.log('🎯 IMPROVED FAKE PUMP: 3+ candles, <8% drop, NO uptrend required');
    console.log('🎯 IMPROVED LOWCAP: <20% drop, >60% volume retention');
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

  private calculateMarketMomentum(candles: SimpleCandle[]): number {
    if (candles.length < 10) return 0;

    const recentPrices = candles.slice(-10).map(c => c.close);
    const midPrices = candles.slice(-20, -10).map(c => c.close);
    
    const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const midAvg = midPrices.reduce((a, b) => a + b, 0) / midPrices.length;
    
    return midAvg > 0 ? (recentAvg - midAvg) / midAvg : 0;
  }

  private calculateFearGreedIndex(candles: SimpleCandle[], volumeSpike: number): number {
    if (candles.length < 20) return 0.5;

    const recentCandles = candles.slice(-5);
    const previousCandles = candles.slice(-10, -5);
    
    const recentVolatility = Math.max(...recentCandles.map(c => c.high)) - Math.min(...recentCandles.map(c => c.low));
    const previousVolatility = Math.max(...previousCandles.map(c => c.high)) - Math.min(...previousCandles.map(c => c.low));
    const volatilityRatio = previousVolatility > 0 ? recentVolatility / previousVolatility : 1;
    
    const recentVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;
    const previousVolume = previousCandles.reduce((sum, c) => sum + c.volume, 0) / previousCandles.length;
    const volumeRatio = previousVolume > 0 ? recentVolume / previousVolume : 1;
    
    const rejectionCandles = recentCandles.filter(candle => {
      const upperShadow = candle.high - Math.max(candle.open, candle.close);
      const bodySize = Math.abs(candle.close - candle.open);
      return upperShadow > (bodySize * 1.5);
    }).length;
    
    const rejectionRatio = rejectionCandles / recentCandles.length;
    
    let fearGreed = 0.5;
    
    fearGreed -= rejectionRatio * 0.3;
    
    if (volumeRatio > 1.5) {
      fearGreed += 0.2;
    }
    
    if (volatilityRatio > 1.5) {
      fearGreed -= 0.2;
    }
    
    return Math.max(0, Math.min(1, fearGreed));
  }

  private calculateVolumeDivergence(candles: SimpleCandle[]): number {
    if (candles.length < 10) return 1;

    const priceChanges: number[] = [];
    const volumeChanges: number[] = [];
    
    for (let i = 1; i < Math.min(6, candles.length); i++) {
      const priceChange = ((candles[candles.length - i].close - candles[candles.length - i - 1].close) / candles[candles.length - i - 1].close) * 100;
      const volumeChange = candles[candles.length - i].volume - candles[candles.length - i - 1].volume;
      
      priceChanges.push(priceChange);
      volumeChanges.push(volumeChange);
    }
    
    const avgPriceChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
    const avgVolumeChange = volumeChanges.reduce((a, b) => a + b, 0) / volumeChanges.length;
    
    if (avgPriceChange > 0.5 && avgVolumeChange < 0) {
      return 0.3;
    } else if (avgPriceChange < -0.5 && avgVolumeChange > 0) {
      return 0.7;
    }
    
    return 0.5;
  }

  private calculatePriceMomentum(candles: SimpleCandle[]): number {
    if (candles.length < 8) return 0;

    const recentGains: number[] = [];
    const recentLosses: number[] = [];
    
    for (let i = candles.length - 1; i > candles.length - 8; i--) {
      if (i <= 0) break;
      
      const change = ((candles[i].close - candles[i - 1].close) / candles[i - 1].close) * 100;
      
      if (change > 0) {
        recentGains.push(change);
      } else {
        recentLosses.push(Math.abs(change));
      }
    }
    
    const avgGain = recentGains.length > 0 ? recentGains.reduce((a, b) => a + b, 0) / recentGains.length : 0;
    const avgLoss = recentLosses.length > 0 ? recentLosses.reduce((a, b) => a + b, 0) / recentLosses.length : 0;
    
    if (avgLoss === 0) return avgGain > 0 ? 1 : 0;
    
    return (avgGain - avgLoss) / (avgGain + avgLoss);
  }

  private detectMomentumDivergence(candles: SimpleCandle[]): boolean {
    if (candles.length < 15) return false;

    const recentHigh = Math.max(...candles.slice(-8).map(c => c.high));
    const previousHigh = Math.max(...candles.slice(-15, -8).map(c => c.high));
    
    const recentMomentum = this.calculatePriceMomentum(candles.slice(-8));
    const previousMomentum = this.calculatePriceMomentum(candles.slice(-15, -8));
    
    return recentHigh > previousHigh && recentMomentum < previousMomentum;
  }

  private shouldAvoidEntryDueToLargeDrop(candles: SimpleCandle[], currentPrice: number): { avoid: boolean; reason: string } {
    if (candles.length < 24) {
      return { avoid: false, reason: 'INSUFFICIENT_DATA' };
    }

    const price24hAgo = candles[candles.length - 24]?.close;
    if (price24hAgo && price24hAgo > 0) {
      const drop24h = ((price24hAgo - currentPrice) / price24hAgo) * 100;
      if (drop24h > STRATEGY_CONFIG.entryFilters.max24hDropPercent) {
        return { 
          avoid: true, 
          reason: `LARGE_24H_DROP_${drop24h.toFixed(1)}%` 
        };
      }
    }

    const recentHigh = Math.max(...candles.slice(-12).map(c => c.high));
    if (recentHigh > 0) {
      const dropFromHigh = ((recentHigh - currentPrice) / recentHigh) * 100;
      if (dropFromHigh > STRATEGY_CONFIG.entryFilters.maxRecentDropPercent) {
        return { 
          avoid: true, 
          reason: `LARGE_RECENT_DROP_${dropFromHigh.toFixed(1)}%` 
        };
      }
    }

    return { avoid: false, reason: 'OK' };
  }

  private calculateDowntrendDuration(candles: SimpleCandle[]): { durationHours: number; isTooLong: boolean } {
    if (candles.length < 48) {
      return { durationHours: 0, isTooLong: false };
    }

    let downtrendStartIndex = -1;
    
    for (let i = candles.length - 1; i >= 5; i--) {
      const current = candles[i];
      const previous = candles[i - 5];
      
      if (current.close < previous.close * 0.95) {
        downtrendStartIndex = i;
        break;
      }
    }

    if (downtrendStartIndex === -1) {
      return { durationHours: 0, isTooLong: false };
    }

    const durationCandles = candles.length - downtrendStartIndex;
    const durationHours = durationCandles * 5 / 60;
    
    const isTooLong = durationHours > STRATEGY_CONFIG.entryFilters.maxDowntrendDurationHours;
    
    return { durationHours, isTooLong };
  }

  private isTooCloseToSupport(currentPrice: number, supportLevel: number): boolean {
    if (supportLevel <= 0) return false;
    
    const distanceToSupport = ((currentPrice - supportLevel) / currentPrice) * 100;
    return distanceToSupport < STRATEGY_CONFIG.entryFilters.minDistanceToSupportPercent;
  }

  private applyEntryFilters(
    candles: SimpleCandle[], 
    currentPrice: number, 
    supportLevel: number,
    trendDirection: string
  ): { shouldEnter: boolean; reason: string } {
    
    const dropCheck = this.shouldAvoidEntryDueToLargeDrop(candles, currentPrice);
    if (dropCheck.avoid) {
      return { shouldEnter: false, reason: dropCheck.reason };
    }

    if (trendDirection === 'DOWNTREND') {
      const downtrendDuration = this.calculateDowntrendDuration(candles);
      if (downtrendDuration.isTooLong) {
        return { 
          shouldEnter: false, 
          reason: `LONG_DOWNTREND_${downtrendDuration.durationHours.toFixed(1)}H` 
        };
      }
    }

    if (this.isTooCloseToSupport(currentPrice, supportLevel)) {
      return { shouldEnter: false, reason: 'TOO_CLOSE_TO_SUPPORT' };
    }

    return { shouldEnter: true, reason: 'PASSED_ALL_FILTERS' };
  }

  private detectPumpSignals(
    candles: SimpleCandle[],
    currentPrice: number,
    volume24h: number,
    marketMomentum: number,
    ema: number,
    atr: number,
    marketCapRank: number,
    trendDirection: string
  ): { 
    hasFakePump: boolean; 
    fakePumpStrength: number; 
    fakePumpReason: string;
    hasKillLong: boolean;
    killLongStrength: number; 
    killLongReason: string;
    pumpPercent: number;
    combinedSignal: boolean;
    signalType: string;
  } {
    if (candles.length < 10) {
      return {
        hasFakePump: false, fakePumpStrength: 0, fakePumpReason: 'INSUFFICIENT_DATA',
        hasKillLong: false, killLongStrength: 0, killLongReason: 'INSUFFICIENT_DATA',
        pumpPercent: 0, combinedSignal: false, signalType: 'NO_SIGNAL'
      };
    }

    const lookbackPeriod = Math.max(STRATEGY_CONFIG.fakePumpDetection.minPumpCandles, LOWCAP_KILL_LONG_CONFIG.lookbackCandles);
    const pumpCandles = candles.slice(-lookbackPeriod);
    
    const pumpHigh = Math.max(...pumpCandles.map(c => c.high));
    const pumpLow = Math.min(...pumpCandles.map(c => c.low));
    const pumpPercent = ((pumpHigh - pumpLow) / pumpLow) * 100;
    const dropFromHigh = ((pumpHigh - currentPrice) / pumpHigh) * 100;

    const recentVolume = pumpCandles.slice(-4).reduce((sum, c) => sum + c.volume, 0) / 4;
    const previousVolume = pumpCandles.slice(-8, -4).reduce((sum, c) => sum + c.volume, 0) / 4;
    const volumeSpike = previousVolume > 0 ? recentVolume / previousVolume : 1;
    const volumeRetention = recentVolume / previousVolume;

    const lastCandle = candles[candles.length - 1];
    const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isRejectionCandle = upperShadow > (bodySize * 1.2);

    const distanceToEMA = ema > 0 ? Math.abs(currentPrice - ema) / ema : 0;
    const isEMARejection = distanceToEMA <= 0.03 && currentPrice < ema;

    let fakePumpScore = 0;
    let fakePumpReasons: string[] = [];

    if (pumpPercent >= STRATEGY_CONFIG.fakePumpDetection.minPumpPercent) {
      fakePumpScore += 25;
      fakePumpReasons.push(`PUMP_${pumpPercent.toFixed(1)}%`);
    }

    if (dropFromHigh <= STRATEGY_CONFIG.fakePumpDetection.maxDropFromPump) {
      fakePumpScore += 20;
      fakePumpReasons.push(`DROP_${dropFromHigh.toFixed(1)}%`);
    }

    if (volumeSpike > STRATEGY_CONFIG.fakePumpDetection.volumeDivergenceThreshold) {
      fakePumpScore += 20;
      fakePumpReasons.push(`VOLUME_SPIKE_${volumeSpike.toFixed(2)}`);
    }

    if (isRejectionCandle) {
      fakePumpScore += 15;
      fakePumpReasons.push('REJECTION_CANDLE');
    }

    if (isEMARejection) {
      fakePumpScore += 15;
      fakePumpReasons.push('EMA_REJECTION');
    }

    if (marketMomentum < 0.02) {
      fakePumpScore += 10;
      fakePumpReasons.push(`MOMENTUM_${marketMomentum.toFixed(3)}`);
    }

    const hasFakePump = fakePumpScore >= 50;
    const fakePumpStrength = Math.min(fakePumpScore / 100, 1);

    let killLongScore = 0;
    let killLongReasons: string[] = [];

    const isLowCap = marketCapRank <= LOWCAP_KILL_LONG_CONFIG.maxMarketCapRank;
    const hasEnoughLiquidity = volume24h >= LOWCAP_KILL_LONG_CONFIG.minLiquidity;

    if (isLowCap && hasEnoughLiquidity) {
      killLongScore += 20;
      killLongReasons.push(`LOWCAP_RANK_${marketCapRank}`);

      if (pumpPercent >= LOWCAP_KILL_LONG_CONFIG.minPumpPercent && 
          pumpPercent <= LOWCAP_KILL_LONG_CONFIG.maxPumpPercent) {
        killLongScore += 20;
        killLongReasons.push(`PUMP_${pumpPercent.toFixed(1)}%`);
      }

      if (dropFromHigh >= LOWCAP_KILL_LONG_CONFIG.killLongDropPercent && 
          dropFromHigh <= LOWCAP_KILL_LONG_CONFIG.maxDropFromPump) {
        killLongScore += 20;
        killLongReasons.push(`DROP_${dropFromHigh.toFixed(1)}%`);
      }

      if (volumeSpike >= LOWCAP_KILL_LONG_CONFIG.volumeSpikeThreshold) {
        killLongScore += 15;
        killLongReasons.push(`VOLUME_${volumeSpike.toFixed(2)}`);
      }

      if (marketMomentum >= LOWCAP_KILL_LONG_CONFIG.momentumOverbought) {
        killLongScore += 10;
        killLongReasons.push(`MOMENTUM_${marketMomentum.toFixed(3)}`);
      }

      if (isRejectionCandle) {
        killLongScore += 10;
        killLongReasons.push('REJECTION_CANDLE');
      }

      if (volumeRetention >= LOWCAP_KILL_LONG_CONFIG.minVolumeRetention) {
        killLongScore += 5;
        killLongReasons.push(`VOL_RETENTION_${(volumeRetention * 100).toFixed(1)}%`);
      }
    }

    const hasKillLong = killLongScore >= 60;
    const killLongStrength = Math.min(killLongScore / 100, 1);

    const combinedSignal = hasFakePump || hasKillLong;
    let signalType = 'NO_SIGNAL';
    
    if (hasKillLong) {
      signalType = `LOWCAP_KILL_LONG_${killLongReasons.join('_')}`;
    } else if (hasFakePump) {
      signalType = `FAKE_PUMP_${fakePumpReasons.join('_')}`;
    }

    return {
      hasFakePump,
      fakePumpStrength,
      fakePumpReason: fakePumpReasons.join(','),
      hasKillLong,
      killLongStrength,
      killLongReason: killLongReasons.join(','),
      pumpPercent,
      combinedSignal,
      signalType
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
    marketMomentum: number,
    trendDirection: string
  ): number {
    const volatilityScore = Math.min((volatility / STRATEGY_CONFIG.minDailyVolatility) * 20, 40);
    const volumeScore = Math.min((volume24h / STRATEGY_CONFIG.minVolume24h) * 15, 30);
    const trendScore = trendStrength * 30;
    
    let additionalScore = 0;
    if (volumeSpike > STRATEGY_CONFIG.volumeSpikeThreshold) {
      additionalScore += 10;
    }
    
    if (trendDirection === 'DOWNTREND' && marketMomentum < 0.05) {
      additionalScore += 10;
    }

    return volatilityScore + volumeScore + trendScore + additionalScore;
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

  private detectPullbackInDowntrend(
    candles: SimpleCandle[],
    currentPrice: number,
    marketMomentum: number,
    trendDirection: string,
    trendStrength: number,
    ema: number
  ): { hasPullback: boolean; pullbackStrength: number; reason: string; pullbackPercent: number } {
    
    if (trendDirection !== 'DOWNTREND' || trendStrength < STRATEGY_CONFIG.positiveDCA.pullbackDCA.minTrendStrength) {
      return { hasPullback: false, pullbackStrength: 0, reason: 'TREND_NOT_STRONG', pullbackPercent: 0 };
    }

    if (candles.length < 10) {
      return { hasPullback: false, pullbackStrength: 0, reason: 'INSUFFICIENT_DATA', pullbackPercent: 0 };
    }

    const recentLow = Math.min(...candles.slice(-5).map(c => c.low));
    const recentHigh = Math.max(...candles.slice(-3).map(c => c.high));
    
    const pullbackPercent = ((currentPrice - recentLow) / recentLow) * 100;
    
    if (pullbackPercent < STRATEGY_CONFIG.positiveDCA.minPullbackPercent || 
        pullbackPercent > STRATEGY_CONFIG.positiveDCA.maxPullbackPercent) {
      return { hasPullback: false, pullbackStrength: 0, reason: `PULLBACK_OUT_OF_RANGE_${pullbackPercent.toFixed(1)}%`, pullbackPercent };
    }

    if (marketMomentum > STRATEGY_CONFIG.positiveDCA.momentumThreshold) {
      return { hasPullback: false, pullbackStrength: 0, reason: `MOMENTUM_TOO_HIGH_${marketMomentum.toFixed(3)}`, pullbackPercent };
    }

    const currentVolume = candles[candles.length - 1]?.volume || 0;
    const avgVolume = candles.slice(-10).reduce((sum, c) => sum + c.volume, 0) / 10;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    
    if (STRATEGY_CONFIG.positiveDCA.pullbackDCA.requireVolumeConfirmation && volumeRatio > STRATEGY_CONFIG.positiveDCA.volumeDropThreshold) {
      return { hasPullback: false, pullbackStrength: 0, reason: `HIGH_VOLUME_PULLBACK_${volumeRatio.toFixed(2)}`, pullbackPercent };
    }

    const emaDistance = Math.abs(currentPrice - ema) / ema;
    const isNearEMA = emaDistance <= 0.02 && currentPrice < ema;

    const lastCandle = candles[candles.length - 1];
    const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isRejectionCandle = upperShadow > (bodySize * 1.2);

    let pullbackScore = 0;
    let reasons: string[] = [];

    if (pullbackPercent >= 0.5 && pullbackPercent <= 2.0) {
      pullbackScore += 30;
      reasons.push(`PERFECT_PULLBACK_${pullbackPercent.toFixed(1)}%`);
    } else {
      pullbackScore += 20;
      reasons.push(`PULLBACK_${pullbackPercent.toFixed(1)}%`);
    }

    if (trendStrength >= 0.8) {
      pullbackScore += 25;
      reasons.push(`STRONG_TREND_${(trendStrength * 100).toFixed(0)}%`);
    } else if (trendStrength >= 0.6) {
      pullbackScore += 15;
      reasons.push(`MEDIUM_TREND_${(trendStrength * 100).toFixed(0)}%`);
    }

    if (marketMomentum < 0) {
      pullbackScore += 15;
      reasons.push(`NEGATIVE_MOMENTUM_${marketMomentum.toFixed(3)}`);
    }

    if (isNearEMA) {
      pullbackScore += 15;
      reasons.push('EMA_RESISTANCE');
    }

    if (isRejectionCandle) {
      pullbackScore += 15;
      reasons.push('REJECTION_CANDLE');
    }

    const hasPullback = pullbackScore >= 70;
    const pullbackStrength = Math.min(pullbackScore / 100, 1);

    return {
      hasPullback,
      pullbackStrength,
      reason: reasons.join(','),
      pullbackPercent
    };
  }

  private detectPositiveDCASignal(
    candles: SimpleCandle[],
    currentPrice: number,
    ema: number,
    marketMomentum: number,
    trendDirection: string,
    trendStrength: number,
    volumeSpike: number
  ): { hasPositiveDCA: boolean; dcaReason: string; pullbackPercent: number } {
    
    if (!STRATEGY_CONFIG.positiveDCA.enabled || trendDirection !== 'DOWNTREND') {
      return { hasPositiveDCA: false, dcaReason: 'TREND_NOT_DOWNTREND', pullbackPercent: 0 };
    }

    if (candles.length < 20) {
      return { hasPositiveDCA: false, dcaReason: 'INSUFFICIENT_DATA', pullbackPercent: 0 };
    }

    const recentLow = Math.min(...candles.slice(-10).map(c => c.low));
    const recentHigh = Math.max(...candles.slice(-5).map(c => c.high));
    
    const pullbackPercent = ((currentPrice - recentLow) / recentLow) * 100;
    
    if (pullbackPercent < STRATEGY_CONFIG.positiveDCA.minPullbackPercent || 
        pullbackPercent > STRATEGY_CONFIG.positiveDCA.maxPullbackPercent) {
      return { hasPositiveDCA: false, dcaReason: `PULLBACK_OUT_OF_RANGE_${pullbackPercent.toFixed(1)}%`, pullbackPercent };
    }

    const currentVolume = candles[candles.length - 1]?.volume || 0;
    const avgVolume = candles.slice(-10).reduce((sum, c) => sum + c.volume, 0) / 10;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    
    if (volumeRatio > STRATEGY_CONFIG.positiveDCA.volumeDropThreshold) {
      return { hasPositiveDCA: false, dcaReason: `HIGH_VOLUME_PULLBACK_${volumeRatio.toFixed(2)}`, pullbackPercent };
    }

    if (marketMomentum > STRATEGY_CONFIG.positiveDCA.momentumThreshold) {
      return { hasPositiveDCA: false, dcaReason: `MOMENTUM_TOO_HIGH_${marketMomentum.toFixed(3)}`, pullbackPercent };
    }

    if (STRATEGY_CONFIG.positiveDCA.emaResistance) {
      const emaDistance = Math.abs(currentPrice - ema) / ema;
      if (emaDistance <= 0.02 && currentPrice < ema) {
        return { hasPositiveDCA: true, dcaReason: 'EMA_RESISTANCE_PULLBACK', pullbackPercent };
      }
    }

    if (STRATEGY_CONFIG.positiveDCA.fibonacciRetracement) {
      const majorLow = Math.min(...candles.slice(-50).map(c => c.low));
      const majorHigh = Math.max(...candles.slice(-50).map(c => c.high));
      const fibLevels = this.calculateFibonacciLevels(majorHigh, majorLow);
      
      const fib382Distance = Math.abs(currentPrice - fibLevels.level382) / fibLevels.level382;
      const fib500Distance = Math.abs(currentPrice - fibLevels.level500) / fibLevels.level500;
      const fib618Distance = Math.abs(currentPrice - fibLevels.level618) / fibLevels.level618;

      if (fib382Distance <= 0.015 || fib500Distance <= 0.015 || fib618Distance <= 0.015) {
        return { hasPositiveDCA: true, dcaReason: 'FIBONACCI_PULLBACK', pullbackPercent };
      }
    }

    const lastCandle = candles[candles.length - 1];
    const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isRejectionCandle = upperShadow > (bodySize * 1.5);

    if (isRejectionCandle && pullbackPercent >= 2.0) {
      return { hasPositiveDCA: true, dcaReason: 'REJECTION_CANDLE_PULLBACK', pullbackPercent };
    }

    return { hasPositiveDCA: false, dcaReason: 'NO_POSITIVE_DCA_SIGNAL', pullbackPercent };
  }

  private checkTrendStrengthAndReversal(
    candles: SimpleCandle[],
    currentPrice: number,
    ema: number,
    marketMomentum: number,
    trendDirection: string,
    trendStrength: number,
    volumeSpike: number,
    trendAcceleration: number
  ): { trendStillStrong: boolean; reversalSign: boolean; reason: string; trendStrengthScore: number } {
    
    if (trendDirection !== 'DOWNTREND') {
      return { trendStillStrong: false, reversalSign: true, reason: 'TREND_NOT_DOWNTREND', trendStrengthScore: 0 };
    }

    let trendStrengthScore = 0;
    let reasons: string[] = [];
    let reversalSigns: string[] = [];

    if (trendStrength >= STRATEGY_CONFIG.trendStrengthCheck.minTrendStrength) {
      trendStrengthScore += 25;
      reasons.push(`TREND_STRENGTH_${(trendStrength * 100).toFixed(0)}%`);
    } else {
      reversalSigns.push(`WEAK_TREND_${(trendStrength * 100).toFixed(0)}%`);
    }

    const emaAlignment = this.checkEmaAlignment(candles);
    if (emaAlignment) {
      trendStrengthScore += 20;
      reasons.push('EMA_ALIGNMENT');
    } else {
      reversalSigns.push('EMA_ALIGNMENT_BROKEN');
    }

    if (trendAcceleration <= STRATEGY_CONFIG.trendStrengthCheck.trendAccelerationThreshold) {
      trendStrengthScore += 15;
      reasons.push(`ACCELERATING_DOWN_${trendAcceleration.toFixed(4)}`);
    }

    if (volumeSpike >= STRATEGY_CONFIG.trendStrengthCheck.minVolumeSpike) {
      trendStrengthScore += 15;
      reasons.push(`HIGH_VOLUME_${volumeSpike.toFixed(2)}`);
    }

    const priceToEMARatio = ema > 0 ? (currentPrice / ema) : 1;
    if (priceToEMARatio < 0.98) {
      trendStrengthScore += 15;
      reasons.push(`PRICE_BELOW_EMA_${(priceToEMARatio * 100).toFixed(1)}%`);
    } else if (priceToEMARatio > 1.02) {
      reversalSigns.push(`PRICE_ABOVE_EMA_${(priceToEMARatio * 100).toFixed(1)}%`);
    }

    if (marketMomentum <= STRATEGY_CONFIG.trendStrengthCheck.maxMomentum) {
      trendStrengthScore += 10;
      reasons.push(`MOMENTUM_OK_${marketMomentum.toFixed(3)}`);
    } else {
      reversalSigns.push(`MOMENTUM_HIGH_${marketMomentum.toFixed(3)}`);
    }

    if (STRATEGY_CONFIG.trendStrengthCheck.reversalDetection.momentumDivergence) {
      const hasBullishDivergence = this.detectMomentumDivergence(candles);
      if (hasBullishDivergence) {
        reversalSigns.push('MOMENTUM_BULLISH_DIVERGENCE');
        trendStrengthScore -= 20;
      }
    }

    if (STRATEGY_CONFIG.trendStrengthCheck.reversalDetection.pricePattern) {
      const hasReversalPattern = this.checkReversalPricePattern(candles);
      if (hasReversalPattern) {
        reversalSigns.push('REVERSAL_PRICE_PATTERN');
        trendStrengthScore -= 15;
      }
    }

    if (STRATEGY_CONFIG.trendStrengthCheck.reversalDetection.volumeConfirmation) {
      const hasReversalVolume = this.checkReversalVolume(candles);
      if (hasReversalVolume) {
        reversalSigns.push('REVERSAL_VOLUME');
        trendStrengthScore -= 10;
      }
    }

    const resistanceLevel = this.findResistanceLevel(candles, 10);
    const resistanceDistance = resistanceLevel > 0 ? Math.abs(currentPrice - resistanceLevel) / resistanceLevel : 0;
    if (resistanceDistance <= 0.01 && currentPrice > resistanceLevel) {
      reversalSigns.push(`BROKE_RESISTANCE_${resistanceDistance.toFixed(3)}`);
      trendStrengthScore -= 15;
    }

    const trendStillStrong = trendStrengthScore >= 60;
    const reversalSign = reversalSigns.length >= 2 || trendStrengthScore < 40;

    let reason = '';
    if (trendStillStrong) {
      reason = `TREND_STRONG: ${reasons.join(', ')}`;
    } else if (reversalSign) {
      reason = `REVERSAL_SIGNS: ${reversalSigns.join(', ')}`;
    } else {
      reason = `WEAK_TREND: ${reasons.join(', ')} | ${reversalSigns.join(', ')}`;
    }

    return {
      trendStillStrong,
      reversalSign,
      reason,
      trendStrengthScore
    };
  }

  private checkReversalPricePattern(candles: SimpleCandle[]): boolean {
    if (candles.length < 5) return false;

    const recentCandles = candles.slice(-5);
    
    const lastCandle = recentCandles[recentCandles.length - 1];
    const prevCandle = recentCandles[recentCandles.length - 2];
    
    const isBullishEngulfing = 
      prevCandle.close < prevCandle.open &&
      lastCandle.close > lastCandle.open &&
      lastCandle.open < prevCandle.close &&
      lastCandle.close > prevCandle.open;

    const isHammer = 
      lastCandle.close > lastCandle.open &&
      (lastCandle.close - lastCandle.open) * 3 <= (lastCandle.open - lastCandle.low) &&
      (lastCandle.high - lastCandle.close) <= (lastCandle.close - lastCandle.open);

    const isMorningStar = recentCandles.length >= 3 && 
      recentCandles[recentCandles.length - 3].close < recentCandles[recentCandles.length - 3].open &&
      Math.abs(recentCandles[recentCandles.length - 2].close - recentCandles[recentCandles.length - 2].open) < 
        (recentCandles[recentCandles.length - 3].open - recentCandles[recentCandles.length - 3].close) * 0.3 &&
      recentCandles[recentCandles.length - 1].close > recentCandles[recentCandles.length - 1].open &&
      recentCandles[recentCandles.length - 1].close > recentCandles[recentCandles.length - 3].open;

    return isBullishEngulfing || isHammer || isMorningStar;
  }

  private checkReversalVolume(candles: SimpleCandle[]): boolean {
    if (candles.length < 6) return false;

    const recentCandles = candles.slice(-6);
    const volumeSpike = this.calculateVolumeSpike(recentCandles.map(c => c.volume));
    
    const lastCandle = recentCandles[recentCandles.length - 1];
    const isBullishCandle = lastCandle.close > lastCandle.open;
    
    return isBullishCandle && volumeSpike > 1.5;
  }

  private detectEntrySignal(
    candles: SimpleCandle[], 
    currentPrice: number, 
    ema: number, 
    marketMomentum: number,
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

    const entryFilter = this.applyEntryFilters(candles, currentPrice, support, trendDirection);
    if (!entryFilter.shouldEnter) {
      return { hasSignal: false, signalType: `FILTERED:${entryFilter.reason}`, side: 'SHORT' };
    }

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    const strongDowntrend = this.detectStrongDowntrend(
      candles, trendStrength, trendDirection, volumeSpike, currentPrice, ema
    );

    if (strongDowntrend.isStrongDowntrend) {
      return {
        hasSignal: true,
        signalType: `STRONG_DOWNTREND_${strongDowntrend.reason}`,
        side: 'SHORT',
        isDcaSignal: false
      };
    }

    const positiveDCA = this.detectPositiveDCASignal(
      candles, currentPrice, ema, marketMomentum, trendDirection, trendStrength, volumeSpike
    );

    if (positiveDCA.hasPositiveDCA) {
      return {
        hasSignal: true,
        signalType: `POSITIVE_DCA_${positiveDCA.dcaReason}`,
        side: 'SHORT',
        isDcaSignal: true
      };
    }

    if (trendDirection === 'DOWNTREND') {
      const isNearResistance = currentPrice >= resistance * 0.98;
      const isNearEMA = ema > 0 && currentPrice >= ema * 0.99;
      const isMomentumOK = marketMomentum < 0.02;
      const isBearishCandle = lastCandle.close < lastCandle.open && lastCandle.close < prevCandle.close;
      
      if ((isNearResistance || isNearEMA) && isMomentumOK && isBearishCandle) {
        return { hasSignal: true, signalType: 'DOWNTREND_PULLBACK', side: 'SHORT' };
      }
    }

    if (currentPrice < support && trendDirection === 'DOWNTREND' && marketMomentum < 0.05) {
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
    marketMomentum: number;
    fearGreedIndex: number;
    volumeDivergence: number;
    priceMomentum: number;
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
      const marketMomentum = this.calculateMarketMomentum(candles);
      const fearGreedIndex = this.calculateFearGreedIndex(candles, volumeSpike);
      const volumeDivergence = this.calculateVolumeDivergence(candles);
      const priceMomentum = this.calculatePriceMomentum(candles);
      const atr = this.calculateATR(candles);
      const resistanceLevel = this.findResistanceLevel(candles, STRATEGY_CONFIG.resistanceLookback);
      const supportLevel = this.findSupportLevel(candles, STRATEGY_CONFIG.resistanceLookback);

      const trendAcceleration = this.calculateTrendAcceleration(candles);
      const emaAlignment = this.checkEmaAlignment(candles);

      const marketCapRank = await this.estimateMarketCapRank(symbol, volume24h, currentPrice);
      
      const pumpSignals = this.detectPumpSignals(
        candles, currentPrice, volume24h, marketMomentum, 
        ema, atr, marketCapRank, trendAnalysis.direction
      );

      const entryFilter = this.applyEntryFilters(candles, currentPrice, supportLevel, trendAnalysis.direction);
      const shouldEnter = entryFilter.shouldEnter && pumpSignals.combinedSignal;

      const strengthScore = this.calculateStrengthScore(
        dailyVolatility,
        volume24h,
        trendAnalysis.strength,
        volumeSpike,
        marketMomentum,
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
        marketMomentum,
        fearGreedIndex,
        volumeDivergence,
        priceMomentum,
        atr,
        resistanceLevel,
        supportLevel,
        hasEntrySignal: shouldEnter,
        signalType: pumpSignals.signalType,
        entrySide: 'SHORT',
        volatilityScore,
        volumeScore,
        trendScore,
        fakePumpSignal: pumpSignals.hasFakePump,
        fakePumpStrength: pumpSignals.fakePumpStrength,
        fakePumpReason: pumpSignals.fakePumpReason,
        strongDowntrendSignal: false,
        trendAcceleration,
        emaAlignment,
        hasKillLongSignal: pumpSignals.hasKillLong,
        killLongStrength: pumpSignals.killLongStrength,
        killLongReason: pumpSignals.killLongReason,
        pumpPercent: pumpSignals.pumpPercent,
        isLowCap: marketCapRank <= LOWCAP_KILL_LONG_CONFIG.maxMarketCapRank,
        marketCapRank
      };
    } catch (error) {
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
      marketMomentum: 0,
      fearGreedIndex: 0.5,
      volumeDivergence: 0.5,
      priceMomentum: 0,
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

      console.log(`🔔 OPEN ORDER: ${symbol} | ${openQty} contracts | Price: ${currentPrice} | Side: SHORT | Signal: ${signalType}`);

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

      if (!realPositionId) {
        try {
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          const positionInfo = await this.getPositionForSymbol(symbol);
          if (positionInfo) {
            realPositionId = positionInfo.id?.toString() || 
                            positionInfo.positionId?.toString();
          }
        } catch (error) {
          // Silent error
        }
      }

      const positionId = this.orderManager.generatePositionId();
      
      this.totalOrders++;
      
      this.startRealTimeMonitoring(symbol, positionId);
      
      return {success: true, positionId, realPositionId};

    } catch (err: any) {
      return {success: false};
    }
  }

  private async closeAllPositionsForSymbol(symbol: string, position: PositionData, reason: string): Promise<void> {
    try {
      const remainingQty = position.positionSize - position.closedAmount;
      if (remainingQty <= 0) {
        return;
      }

      const contractInfo = await this.getContractInfo(symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      if (currentPrice <= 0) return;

      let closeQty = this.roundVolume(remainingQty, contractInfo.volumePrecision);
      
      if (closeQty <= 0) return;
      
      const formattedSymbol = symbol.replace('USDT', '_USDT');
      const targetPositionId = position.realPositionId ? parseInt(position.realPositionId) : 0;

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

      if (orderResponse.success === true && orderResponse.code === 0) {
        position.closedAmount = position.positionSize;
        this.cleanupPosition(symbol);
      }

    } catch (error: any) {
      // Silent error
    }
  }

  async closePosition(symbol: string, quantity: number, side: 'SHORT', reason: string, positionId?: string): Promise<boolean> {
    try {
      const position = this.positions.get(symbol);

      const targetPositionId = position?.realPositionId ? parseInt(position.realPositionId) : 0;

      if (!position) {
        return false;
      }

      const contractInfo = await this.getContractInfo(symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      if (currentPrice <= 0) return false;
      
      let closeQty = this.roundVolume(quantity, contractInfo.volumePrecision);
      
      if (closeQty <= 0) return false;
      
      const formattedSymbol = symbol.replace('USDT', '_USDT');

      console.log(`🔔 CLOSE ORDER: ${symbol} | ${closeQty} contracts | Price: ${currentPrice} | Reason: ${reason}`);
      
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

      if (orderResponse.success === false || orderResponse.code !== 0) {
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
        await this.checkTrailingStopLoss(symbol, position, currentPrice);

      } catch (error) {
        // Silent error
      }
    }, 5000);

    if (!this.realTimeMonitorInterval) {
      this.realTimeMonitorInterval = monitorInterval;
    }
  }

  private recalculateSLTPAfterDCA(position: PositionData): void {
    if (position.isLowCap) return;
    
    if (!position.originalTakeProfitLevels) {
      position.originalTakeProfitLevels = JSON.parse(JSON.stringify(position.takeProfitLevels));
    }
    if (!position.originalStopLossLevels) {
      position.originalStopLossLevels = JSON.parse(JSON.stringify(position.stopLossLevels));
    }

    const remainingQty = position.totalQty - position.closedAmount;
    
    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      if (!position.takeProfitLevels[i].executed) {
        const levelQty = remainingQty * position.takeProfitLevels[i].closeRatio;
        position.takeProfitLevels[i].quantity = levelQty;
      }
    }

    for (let i = 0; i < position.stopLossLevels.length; i++) {
      if (!position.stopLossLevels[i].executed) {
        const levelQty = remainingQty * position.stopLossLevels[i].closeRatio;
        position.stopLossLevels[i].quantity = levelQty;
      }
    }

    position.sltpRecalculated = true;
  }

  private recalculateSLTPAfterPartialClose(position: PositionData): void {
    if (position.isLowCap) return;
    
    const remainingQty = position.totalQty - position.closedAmount;
    
    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      if (!position.takeProfitLevels[i].executed && position.originalTakeProfitLevels) {
        const originalRatio = position.originalTakeProfitLevels[i].closeRatio;
        position.takeProfitLevels[i].quantity = remainingQty * originalRatio;
      }
    }
    
    for (let i = 0; i < position.stopLossLevels.length; i++) {
      if (!position.stopLossLevels[i].executed && position.originalStopLossLevels) {
        const originalRatio = position.originalStopLossLevels[i].closeRatio;
        position.stopLossLevels[i].quantity = remainingQty * originalRatio;
      }
    }
  }

  private async checkTrailingStopLoss(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (!STRATEGY_CONFIG.trailingStopLoss.enabled || !position.trailingStopLoss || position.dcaCount === 0) {
      return;
    }

    const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);

    if (!position.trailingStopLoss.activated && profitData.priceChangePercent <= -STRATEGY_CONFIG.trailingStopLoss.activationProfitPercent) {
      position.trailingStopLoss.activated = true;
      position.trailingStopLoss.activationPrice = currentPrice;
      position.trailingStopLoss.currentStopPrice = currentPrice * (1 + STRATEGY_CONFIG.trailingStopLoss.trailDistancePercent / 100);
      position.trailingStopLoss.highestProfit = profitData.priceChangePercent;
    }
    
    if (position.trailingStopLoss.activated) {
      if (profitData.priceChangePercent < position.trailingStopLoss.highestProfit) {
        position.trailingStopLoss.highestProfit = profitData.priceChangePercent;
        const newStopPrice = currentPrice * (1 + STRATEGY_CONFIG.trailingStopLoss.trailDistancePercent / 100);
        if (newStopPrice < position.trailingStopLoss.currentStopPrice) {
          position.trailingStopLoss.currentStopPrice = newStopPrice;
        }
      }

      if (currentPrice >= position.trailingStopLoss.currentStopPrice) {
        const remainingQty = position.positionSize - position.closedAmount;
        if (remainingQty > 0) {
          console.log(`🛑 TRAILING SL TRIGGERED: ${symbol} | Current: ${currentPrice} | Stop: ${position.trailingStopLoss.currentStopPrice}`);
          
          const closeSuccess = await this.closePosition(symbol, remainingQty, 'SHORT', `TRAILING_SL`, position.positionId);
          if (closeSuccess) {
            position.closedAmount += remainingQty;
            
            if (position.closedAmount >= position.positionSize) {
              this.cleanupPosition(symbol);
              return;
            }
          } else {
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
          let closeQty = level.quantity || remainingQty * level.closeRatio;
          
          const contractInfo = await this.getContractInfo(symbol);
          closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
          closeQty = Math.min(closeQty, remainingQty);
          
          if (closeQty > 0) {
            console.log(`🎯 TP ${i+1} TRIGGERED: ${symbol} | Target: ${level.priceChangePercent}% | Current: ${profitData.priceChangePercent.toFixed(2)}%`);
            
            const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `TP${i+1}`, position.positionId);
            if (closeSuccess) {
              position.closedAmount += closeQty;
              level.executed = true;

              this.recalculateSLTPAfterPartialClose(position);
              
              if (position.closedAmount >= position.positionSize) {
                this.cleanupPosition(symbol);
                return;
              }
            } else {
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
          let closeQty = level.quantity || remainingQty * level.closeRatio;
          
          const contractInfo = await this.getContractInfo(symbol);
          closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
          closeQty = Math.min(closeQty, remainingQty);
          
          if (closeQty > 0) {
            console.log(`🛑 SL ${i+1} TRIGGERED: ${symbol} | Stop: ${level.priceChangePercent}% | Current: ${profitData.priceChangePercent.toFixed(2)}%`);
            
            const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `SL${i+1}`, position.positionId);
            if (closeSuccess) {
              position.closedAmount += closeQty;
              level.executed = true;

              this.recalculateSLTPAfterPartialClose(position);
              
              if (position.closedAmount >= position.positionSize) {
                this.cleanupPosition(symbol);
                return;
              }
            } else {
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
        }
      }
    } catch (error) {
      // Silent error
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
      return [];
    }
  }

  async scanLowCapCoins(): Promise<void> {
    if (!LOWCAP_KILL_LONG_CONFIG.enabled) return;

    const now = Date.now();
    if (now - this.lastLowCapScan < this.lowCapScanInterval) return;

    this.lastLowCapScan = now;
    
    const symbols = await this.getAllFuturePairs();

    const batchSize = 3;

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
            marketMomentum: indicators.marketMomentum,
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

          return killLongSignal;

        } catch (error) {
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(signal => {
        if (signal) {
          this.lowCapKillLongSignals.set(signal.symbol, signal);
          console.log(`🎯 LOWCAP KILL LONG: ${signal.symbol} | Pump: ${signal.pumpPercent.toFixed(1)}% | Strength: ${(signal.killLongStrength * 100).toFixed(0)}%`);
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

        console.log(`🚀 ENTERING LOWCAP KILL LONG: ${symbol} | Pump: ${signal.pumpPercent.toFixed(1)}%`);

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
              { priceChangePercent: -LOWCAP_KILL_LONG_CONFIG.takeProfit, closeRatio: 1.0, executed: false, quantity: positionSize }
            ],
            stopLossLevels: [
              { priceChangePercent: LOWCAP_KILL_LONG_CONFIG.stopLoss, closeRatio: 1.0, executed: false, quantity: positionSize }
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
            pendingDcaOrders: new Map(),
            sltpRecalculated: false,
            consecutiveDcaCount: 0,
            aggressiveDcaMode: false,
            totalDcaVolume: 0,
            maxDcaVolume: 0
          };

          this.positions.set(symbol, position);
          this.lowCapKillLongSignals.delete(symbol);
          enteredCount++;

          console.log(`✅ LOWCAP KILL LONG POSITION: ${symbol} | Size: ${positionSize} | Entry: ${currentPrice}`);
        }

      } catch (error) {
        // Silent error
      }
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
            marketMomentum: indicators.marketMomentum,
            fearGreedIndex: indicators.fearGreedIndex,
            volumeDivergence: indicators.volumeDivergence,
            priceMomentum: indicators.priceMomentum,
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
        coinData.marketMomentum = indicators.marketMomentum;
        coinData.fearGreedIndex = indicators.fearGreedIndex;
        coinData.volumeDivergence = indicators.volumeDivergence;
        coinData.priceMomentum = indicators.priceMomentum;
        coinData.ema = indicators.ema;
        coinData.resistanceLevel = indicators.resistanceLevel;
        coinData.supportLevel = indicators.supportLevel;
        coinData.hasEntrySignal = indicators.hasEntrySignal;
        coinData.signalType= indicators.signalType;
        coinData.strengthScore = indicators.strengthScore;
        coinData.fakePumpSignal = indicators.fakePumpSignal;
        coinData.fakePumpStrength = indicators.fakePumpStrength;
        coinData.fakePumpReason = indicators.fakePumpReason;
        coinData.strongDowntrendSignal = indicators.strongDowntrendSignal;
        coinData.trendAcceleration = indicators.trendAcceleration;
        coinData.emaAlignment = indicators.emaAlignment;

        if (coinData.hasEntrySignal && coinData.status === 'TRACKING') {
          coinData.status = 'READY_TO_ENTER';
        }

        if (coinData.status === 'READY_TO_ENTER') {
          console.log(`🚀 ENTERING: ${symbol} | ${coinData.signalType}`);
          
          await this.enterPosition(symbol, coinData.signalType);
          coinData.status = 'ENTERED';
          enteredCount++;
          this.trackingCoins.delete(symbol);
        }
        const timeDiff = Date.now() - coinData.timestamp;
        if (timeDiff > 45 * 60 * 1000 && coinData.status === 'TRACKING') {
          this.trackingCoins.delete(symbol);
        }

      } catch (error) {
        // Silent error
      }
    }
  }

  async enterPosition(symbol: string, signalType: string): Promise<void> {
    if (this.positions.has(symbol)) return;

    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0 || !this.hasMinimumBalance()) return;

      let initialQty: number;
      
      let positionPercent = STRATEGY_CONFIG.initialPositionPercent;

      if (signalType.includes('FAKE_PUMP')) {
        positionPercent = STRATEGY_CONFIG.initialPositionPercent;
      } else if (signalType.includes('STRONG_DOWNTREND')) {
        positionPercent = STRATEGY_CONFIG.initialPositionPercent;
      } else if (signalType.includes('LOWCAP_KILL_LONG')) {
        positionPercent = LOWCAP_KILL_LONG_CONFIG.positionSizePercent;
      } else if (signalType.includes('POSITIVE_DCA')) {
        positionPercent = STRATEGY_CONFIG.initialPositionPercent;
      }

      initialQty = await this.calculatePositionSize(symbol, positionPercent);

      if (initialQty <= 0) return;

      const openResult = await this.openPosition(symbol, initialQty, 'SHORT', signalType);
      if (!openResult.success) return;

      const actualPrice = await this.getCurrentPrice(symbol);
      const isLowCap = signalType.includes('LOWCAP_KILL_LONG');
      
      const takeProfitLevels: TakeProfitLevel[] = isLowCap ? 
        [{ priceChangePercent: -LOWCAP_KILL_LONG_CONFIG.takeProfit, closeRatio: 1.0, executed: false, quantity: initialQty }] :
        STRATEGY_CONFIG.takeProfitLevels.map(level => ({ 
          ...level, 
          executed: false,
          quantity: initialQty * level.closeRatio
        }));
      
      const stopLossLevels: StopLossLevel[] = isLowCap ?
        [{ priceChangePercent: LOWCAP_KILL_LONG_CONFIG.stopLoss, closeRatio: 1.0, executed: false, quantity: initialQty }] :
        STRATEGY_CONFIG.stopLossLevels.map(level => ({ 
          ...level, 
          executed: false,
          quantity: initialQty * level.closeRatio
        }));

      let dcaLevels: DcaLevel[] = [];
      if (!isLowCap) {
        dcaLevels = STRATEGY_CONFIG.dcaLevels.map(level => ({ 
          ...level, 
          executed: false,
          condition: level.condition as any
        }));
      }

      const maxDcaVolume = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.positiveDCA.pullbackDCA.maxTotalDcaPercent);

      const position: PositionData = {
        symbol,
        entryPrice: actualPrice,
        positionSize: initialQty,
        takeProfitLevels,
        stopLossLevels,
        dcaLevels,
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
        pendingDcaOrders: new Map(),
        sltpRecalculated: false,
        consecutiveDcaCount: 0,
        aggressiveDcaMode: false,
        totalDcaVolume: 0,
        maxDcaVolume
      };

      this.positions.set(symbol, position);

      this.startDCARealTimeMonitoring(symbol, position);

      console.log(`✅ POSITION OPENED: ${symbol} | Size: ${initialQty} (${(positionPercent * 100).toFixed(1)}%) | Entry: ${actualPrice} | Signal: ${signalType}`);

    } catch (error) {
      // Silent error
    }
  }

  private cleanupPosition(symbol: string): void {
    this.positions.delete(symbol);
    this.activePositionMonitoring.delete(symbol);
    this.stopDCARealTimeMonitoring(symbol);
    this.lastDcaCheck.delete(symbol);
  }

  private startDCARealTimeMonitoring(symbol: string, position: PositionData): void {
    const monitorInterval = setInterval(async () => {
      if (!this.positions.has(symbol)) {
        clearInterval(monitorInterval);
        return;
      }

      try {
        const currentPosition = this.positions.get(symbol);
        if (!currentPosition || currentPosition.dcaCount >= STRATEGY_CONFIG.maxDcaTimes) {
          clearInterval(monitorInterval);
          return;
        }

        await this.executeRealTimeDCA(symbol, currentPosition);
      } catch (error) {
        // Silent error
      }
    }, 3000);
  }

  private stopDCARealTimeMonitoring(symbol: string): void {
    // The interval is automatically cleared when position is removed
  }

  async executeRealTimeDCA(symbol: string, position: PositionData): Promise<void> {
    const now = Date.now();
    const lastCheck = this.lastDcaCheck.get(symbol) || 0;
    if (now - lastCheck < 5000) {
      return;
    }
    this.lastDcaCheck.set(symbol, now);

    if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes || position.isLowCap) {
      return;
    }

    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0) return;

      const indicators = await this.calculateDualModeIndicators(symbol);
      
      await this.checkRegularDCA(symbol, position, currentPrice, indicators);
      await this.checkPullbackDCA(symbol, position, currentPrice, indicators);
      await this.checkAggressiveDCA(symbol, position, currentPrice, indicators);

    } catch (error) {
      // Silent error
    }
  }

  private async checkRegularDCA(
    symbol: string, 
    position: PositionData, 
    currentPrice: number,
    indicators: any
  ): Promise<void> {
    const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
    
    for (let i = 0; i < position.dcaLevels.length; i++) {
      const level = position.dcaLevels[i];
      if (!level.executed && priceChange >= level.priceChangePercent) {
        console.log(`🎯 REGULAR DCA SIGNAL: ${symbol} | Level ${i+1} | Price Change: ${priceChange.toFixed(2)}%`);
        
        const dcaQty = await this.calculatePositionSize(
          symbol, 
          STRATEGY_CONFIG.initialPositionPercent * level.addRatio
        );
        
        if (dcaQty > 0 && await this.executeDCAOrder(symbol, dcaQty, position, currentPrice, `REGULAR_DCA_LEVEL_${i+1}`)) {
          level.executed = true;
          return;
        }
      }
    }
  }

  private async checkPullbackDCA(
    symbol: string,
    position: PositionData,
    currentPrice: number,
    indicators: any
  ): Promise<void> {
    const pullbackSignal = this.detectPullbackInDowntrend(
      indicators.candles,
      currentPrice,
      indicators.marketMomentum,
      indicators.trendDirection,
      indicators.trendStrength,
      indicators.ema
    );

    if (pullbackSignal.hasPullback && pullbackSignal.pullbackStrength > 0.7) {
      console.log(`🎯 PULLBACK DCA SIGNAL: ${symbol} | Strength: ${(pullbackSignal.pullbackStrength * 100).toFixed(0)}%`);
      
      const pullbackQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent);

      await this.executeDCAOrder(symbol, pullbackQty, position, currentPrice, `PULLBACK_DCA_${pullbackSignal.reason}`);
    }
  }

  private async checkAggressiveDCA(
    symbol: string,
    position: PositionData,
    currentPrice: number,
    indicators: any
  ): Promise<void> {
    if (indicators.trendStrength > 0.8 && 
        indicators.trendDirection === 'DOWNTREND' &&
        position.dcaCount < 1) {
      
      const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
      
      if (priceChange >= 0.5 && priceChange <= 2.0) {
        console.log(`🎯 AGGRESSIVE DCA SIGNAL: ${symbol} | Trend Strength: ${(indicators.trendStrength * 100).toFixed(0)}%`);
        
        const aggressiveQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent);
        
        await this.executeDCAOrder(symbol, aggressiveQty, position, currentPrice, 'AGGRESSIVE_DCA_STRONG_TREND');
      }
    }
  }

  private async executeDCAOrder(
    symbol: string,
    dcaQty: number,
    position: PositionData,
    currentPrice: number,
    reason: string
  ): Promise<boolean> {
    if (!this.validateDCAConditions(symbol, position, dcaQty)) {
      return false;
    }

    console.log(`💰 EXECUTING DCA: ${symbol} | Quantity: ${dcaQty} | Reason: ${reason}`);
    
    const success = await this.addToPosition(symbol, dcaQty, 'SHORT', reason);
    
    if (success) {
      await this.updatePositionAfterDCA(symbol, position, dcaQty, currentPrice, reason);
      return true;
    }
    
    return false;
  }

  private validateDCAConditions(symbol: string, position: PositionData, dcaQty: number): boolean {
    if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes) {
      return false;
    }

    if (position.totalDcaVolume + dcaQty > position.maxDcaVolume) {
      return false;
    }

    const now = Date.now();
    if (position.lastDcaTime && (now - position.lastDcaTime) < 30000) {
      return false;
    }

    if (position.consecutiveDcaCount >= STRATEGY_CONFIG.positiveDCA.pullbackDCA.maxConsecutiveDCA) {
      return false;
    }

    return true;
  }

  private async updatePositionAfterDCA(
    symbol: string,
    position: PositionData,
    dcaQty: number,
    currentPrice: number,
    reason: string
  ): Promise<void> {
    const newTotalQty = position.totalQty + dcaQty;
    position.averagePrice = (position.averagePrice * position.totalQty + currentPrice * dcaQty) / newTotalQty;
    position.totalQty = newTotalQty;
    position.positionSize = newTotalQty;
    
    position.dcaCount++;
    position.lastDcaTime = Date.now();
    position.totalDcaVolume += dcaQty;

    if (position.trailingStopLoss) {
      position.trailingStopLoss.activated = false;
      position.trailingStopLoss.activationPrice = 0;
      position.trailingStopLoss.currentStopPrice = 0;
      position.trailingStopLoss.highestProfit = 0;
    }

    this.recalculateSLTPAfterDCA(position);
    
    console.log(`✅ DCA ${position.dcaCount} EXECUTED: ${symbol} | New Avg: ${position.averagePrice.toFixed(6)} | Reason: ${reason}`);
  }

  async scanDcaOpportunities(): Promise<void> {
    // This is now handled by real-time DCA monitor
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
              let closeQty = level.quantity || remainingQty * level.closeRatio;
              
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
              let closeQty = level.quantity || remainingQty * level.closeRatio;
              
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
        // Silent error
      }
    }

    closedPositions.forEach(symbol => {
      this.cleanupPosition(symbol);
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
        
        console.log(`   ${symbol}: ${status} $${profitData.profit.toFixed(2)} (${profitData.priceChangePercent.toFixed(1)}%) | Closed: ${closedPercent}%${dcaInfo}${trailingInfo}`);
      }
    }
    console.log('');
  }

  async run(): Promise<void> {
    console.log('🚀 Starting DUAL MODE STRATEGY BOT');
    console.log('🎯 UPDATED CONFIG: Initial Position 7%, 2 DCA Levels (7% each)');
    console.log('💰 POSITION SIZE: 7% account | DCA: 2x 7%');
    console.log('📈 TOTAL EXPOSURE: 21% account (7% + 14% DCA)');
    console.log('🛡️ ENTRY FILTERS: Active - Avoid large drops, long downtrends');
    console.log('🎯 IMPROVED FAKE PUMP: 3+ candles, <8% drop, NO uptrend required');
    console.log('🎯 IMPROVED LOWCAP: <20% drop, >60% volume retention');
    
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
