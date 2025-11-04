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
  maxTotalPositionPercent: 0.4,
  takeProfitLevels: [
    { priceChangePercent: 2.0, closeRatio: 0.3 },
    { priceChangePercent: 4.0, closeRatio: 0.4 },
    { priceChangePercent: 6.0, closeRatio: 0.3 }
  ],
  stopLossLevels: [
    { priceChangePercent: 3.0, closeRatio: 0.5 },
    { priceChangePercent: 5.0, closeRatio: 0.5 }
  ],
  maxVolume24h: 10000000,
  minVolume24h: 100000,
  fakePumpMinPercent: 10,
  volumeSpikeThreshold: 2.5,
  maxActivePositions: 3,
  maxTrackingCoins: 10,
  minAccountBalancePercent: 0.1,
  emaPeriod: 21,
  resistanceLookback: 20,
  volumeDropThreshold: 0.6,
  dcaLevels: [
    { priceChangePercent: 0.5, addRatio: 0.1, condition: 'MICRO_PULLBACK' },
    { priceChangePercent: 1.0, addRatio: 0.1, condition: 'RESISTANCE_TOUCH' },
    { priceChangePercent: 1.5, addRatio: 0.1, condition: 'STRONG_RESISTANCE' }
  ],
  positiveDcaLevels: [
    { profitPercent: 0.2, addRatio: 0.1, extendTpPercent: 0.1 },
    { profitPercent: 0.4, addRatio: 0.1, extendTpPercent: 0.2 },
    { profitPercent: 0.6, addRatio: 0.1, extendTpPercent: 0.3 }
  ],
  maxDcaTimes: 1000,
  trailingStopLoss: {
    enabled: true,
    minProfitToActivate: 12.0,
    activationCondition: 'HALF_PROFIT',
    trailDistancePercent: 0.6,
    maxTrailDistancePercent: 4.0
  },
  strongDowntrendConfig: {
    minCandleBodyRatio: 0.7,
    minPriceDropPercent: 3.0,
    volumeSpikeRatio: 2.0,
    doubleTpOnStrongDowntrend: true
  },
  reversalDetection: {
    enabled: true,
    minPumpPercent: 10,
    pumpCandles: 10,
    fastPumpCandles: 5,
    fastPumpRetraceRequired: 5,
    slowPumpRetraceRequired: 3,
    volumeSpikeRatio: 2.5,
    requiredSignals: 1,
    minListingDays: 14
  },
  trackingConfig: {
    pumpThreshold: 10,
    reversalConfirmationPct: -4,
    strongReversalPct: -6,
    volumeSpikeRatio: 2.0,
    maxTrackingTime: 30 * 60 * 1000
  },
  lowCapStrategy: {
    enabled: true,
    maxVolume24h: 15000000,
    priceRange: {
      min: 0.0001,
      max: 5.0
    },
    maxDailyVolatility: 50,
    rsiOverbought: 65,
    volumeSpikeThreshold: 1.5,
    minTrendStrength: -0.1,
    
    // THÊM CÁC THÔNG SỐ MỚI ĐỂ TRÁNH VÀO LỆNH Ở ĐÁY
    resistanceBounce: {
      minDistanceFromResistance: 1.0,
      maxDistanceFromResistance: 10.0,
      minBouncePercent: 0.3,
    },
    
    // SỬA ĐỔI ĐIỀU KIỆN PULLBACK - TRÁNH ĐÁY
    pullbackConfirmation: {
      minRetracement: 2.0,
      maxRetracement: 15.0,
      volumeDropRatio: 0.7,
      requireResistanceTest: true,
    },
    
    riskRewardRatio: {
      min: 1.2,
      ideal: 1.8
    },
    maxTrackingCoins: 20,
    positionSizePercent: 0.1,
    minListingDays: 5,
    
    // THÊM ĐIỀU KIỆN XU HƯỚNG
    trendRequirements: {
      requireDowntrend: true,
      minDowntrendCandles: 3,
      priceBelowMA: true,
    }
  },
  dcaConfig: {
    negativeDcaPercent: 0.1,
    positiveDcaPercent: 0.1,
    maxTotalDcaPercent: 60.0,
    trendWeakThreshold: -0.1,
    negativeDcaMinPercent: 1.0,
    positiveDcaMinPercent: 0.5,
    minDcaInterval: 180000,
    minPriceMovement: 0.5,
    maxConsecutiveDca: 6,
    dcaCooldown: 300000
  }
};

interface MexcContract {
  symbol: string;
  displayName?: string;
  baseCoin?: string;
  quoteCoin?: string;
  contractSize: number;
  priceScale: number;
  volScale: number;
  listTime?: number;
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
  listTime?: number;
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
  absolutePrice?: number;
}

interface StopLossLevel {
  priceChangePercent: number;
  closeRatio: number;
  executed: boolean;
  quantity?: number;
  absolutePrice?: number;
}

interface DcaLevel {
  priceChangePercent: number;
  addRatio: number;
  executed: boolean;
  condition: 'RESISTANCE' | 'EMA_RESISTANCE' | 'FIBONACCI' | 'BASIC' | 'POSITIVE_PULLBACK' | 'MICRO_PULLBACK' | 'RESISTANCE_TOUCH' | 'STRONG_RESISTANCE';
}

interface PositiveDcaLevel {
  profitPercent: number;
  addRatio: number;
  extendTpPercent: number;
  executed: boolean;
}

interface TrailingStopLoss {
  enabled: boolean;
  activationPrice: number;
  currentStopPrice: number;
  highestProfit: number;
  activated: boolean;
  peakProfitReached: boolean;
}

interface PositionData {
  symbol: string;
  entryPrice: number;
  positionSize: number;
  takeProfitLevels: TakeProfitLevel[];
  stopLossLevels: StopLossLevel[];
  dcaLevels: DcaLevel[];
  positiveDcaLevels: PositiveDcaLevel[];
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
  trailingStopLoss?: TrailingStopLoss;
  pendingDcaOrders: Map<string, { level: number; quantity: number; timestamp: number }>;
  sltpRecalculated: boolean;
  originalTakeProfitLevels: TakeProfitLevel[];
  originalStopLossLevels: StopLossLevel[];
  lastDcaTime?: number;
  consecutiveDcaCount: number;
  aggressiveDcaMode: boolean;
  totalDcaVolume: number;
  maxDcaVolume: number;
  peakPrice?: number;
  confidence?: number;
  positiveDcaCount: number;
  extendedTpLevels: number[];
  lastPositiveDcaTime?: number;
  initialStopLossLevels?: StopLossLevel[];
  adjustedStopLossLevels?: StopLossLevel[];
  peakProfit?: number;
  tpDoubled?: boolean;
  currentTpLevels: number[];
  currentSlLevels: number[];
  riskLevel: string;
  dcaDisabled: boolean;
  totalDcaPercent: number;
  trendStrength: number;
  candles?: SimpleCandle[];
  lastDcaPrice?: number;
  lastNegativeDcaPrice?: number;
  lastPositiveDcaPrice?: number;
  lastNegativeDcaTime?: number;
  consecutiveNegativeDcaCount: number;
  consecutivePositiveDcaCount: number;
}

interface TrackingData {
  symbol: string;
  addedAt: number;
  peakPrice: number;
  peakTime: number;
  initialPumpPct: number;
  notifiedReversal: boolean;
  riskLevel: string;
  listingAgeDays: number;
}

interface CoinTrackingData {
  symbol: string;
  currentPrice: number;
  dailyVolatility: number;
  volume24h: number;
  timestamp: number;
  status: 'TRACKING' | 'READY_TO_ENTER' | 'ENTERED';
  volumeSpike: number;
  strengthScore: number;
  resistanceLevel: number;
  supportLevel: number;
  marketMomentum: number;
  ema: number;
  atr: number;
  priceHistory: number[];
  volumeHistory: number[];
  hasEntrySignal: boolean;
  signalType: string;
  entrySide: 'SHORT';
  fakePumpSignal: boolean;
  pumpPercent: number;
  hasVolumeConfirmation: boolean;
  reversalSignal: boolean;
  reversalType: string;
  reversalReasons: string[];
  pumpHigh: number;
  retraceFromHigh: number;
  listingAgeDays?: number;
  peakPrice: number;
  dropFromPeak: number;
  volumeRatio: number;
  hasBearishPattern: boolean;
  bearishPatterns: string[];
  ma5?: number;
  ma10?: number;
  priceUnderMA: boolean;
  consecutiveBearish: boolean;
  confidence: number;
  riskLevel: string;
  pumpDurationCandles: number;
  requiredRetracePercent: number;
}

interface LowCapTrackingData {
  symbol: string;
  addedAt: number;
  currentPrice: number;
  volume24h: number;
  dailyVolatility: number;
  rsi: number;
  trendStrength: number;
  volumeSpike: number;
  marketCondition: string;
  riskRewardRatio: number;
  pullbackLevel: number;
  status: 'TRACKING' | 'READY_TO_ENTER' | 'ENTERED';
  resistanceLevel: number;
  supportLevel: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  confidence: number;
  listingAgeDays?: number;
  resistanceInfo?: any;
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

class FakePumpStrategyBot {
  private positions: Map<string, PositionData> = new Map();
  private trackingCoins: Map<string, CoinTrackingData> = new Map();
  private candidateCoins: Map<string, CoinTrackingData> = new Map();
  private pumpTrackingCoins: Map<string, TrackingData> = new Map();
  private lowCapTrackingCoins: Map<string, LowCapTrackingData> = new Map();
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
  
  private realTimeMonitorInterval: NodeJS.Timeout | null = null;
  private activePositionMonitoring: Set<string> = new Set();
  private pendingDcaOrders: Map<string, { symbol: string; level: number; quantity: number; timestamp: number }> = new Map();
  private coinListingTimeCache: Map<string, number> = new Map();

  private concurrentRequests = 0;
  private maxConcurrentRequests = 8;
  private lastRequestTime = 0;
  private requestsPerSecond = 8;

  private lastLowCapDebugTime: number = 0;
  private lowCapDebugInterval: number = 30000;

  constructor() {
    console.log('🤖 FAKE PUMP STRATEGY BOT - ENHANCED REVERSAL MODE');
    console.log('🎯 STRATEGY: Pump 10% + Reversal từ đỉnh');
    console.log('📊 VOLUME: < 10M USDT - BẮT BUỘC');
    console.log('💰 VÀO LỆNH: 10% so với tổng tài sản');
    console.log('🔄 DCA: 10% mỗi lần (cả âm và dương)');
    console.log('🎯 TP/SL CHIẾN LƯỢC:');
    console.log('   TP: ' + STRATEGY_CONFIG.takeProfitLevels.map(tp => `-${tp.priceChangePercent}% (${tp.closeRatio * 100}%)`).join(', '));
    console.log('   SL: ' + STRATEGY_CONFIG.stopLossLevels.map(sl => `+${sl.priceChangePercent}% (${sl.closeRatio * 100}%)`).join(', '));
    console.log('⚠️  RISK: Cho phép vào lệnh cả RISK HIGH');
    console.log('⏰ ĐIỀU KIỆN: Coin trên 14 ngày');
    
    console.log('\n🎯 LOW-CAP STRATEGY ACTIVATED - VÀO LỆNH Ở KHÁNG CỤ');
    console.log('📊 VOLUME: < 15M USDT');
    console.log('💰 POSITION: 10% tài khoản');
    console.log('💰 PRICE RANGE: $0.0001 - $5.0');
    console.log('📉 CONDITIONS: RSI > 65 + Downtrend + Volume Spike 1.5x');
    console.log('⏰ TIMEFRAME: 5 Minute Candles for Analysis');
    console.log('⚡ ENTRY: After resistance bounce (1-10% từ kháng cự)');
    console.log('🎯 RISK/REWARD: Min 1.2:1');
    console.log('⏰ COIN AGE: > 5 days required');
    console.log('🛡️  CHIẾN LƯỢC MỚI: TRÁNH VÀO LỆNH Ở ĐÁY');
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minInterval = 1000 / this.requestsPerSecond;

    if (timeSinceLastRequest < minInterval) {
      await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastRequest));
    }

    while (this.concurrentRequests >= this.maxConcurrentRequests) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.concurrentRequests++;
    this.lastRequestTime = Date.now();
  }

  private async releaseRateLimit(): Promise<void> {
    this.concurrentRequests--;
  }

  private async processInParallel<T>(
    items: string[],
    processor: (item: string) => Promise<T | null>
  ): Promise<T[]> {
    const results: (T | null)[] = new Array(items.length).fill(null);
    
    const processItem = async (index: number): Promise<void> => {
      try {
        await this.rateLimit();
        results[index] = await processor(items[index]);
      } catch (error) {
        results[index] = null;
      } finally {
        await this.releaseRateLimit();
      }
    };

    const promises = items.map((_, index) => processItem(index));
    await Promise.all(promises);

    return results.filter((result): result is T => result !== null);
  }

  private async getCoinListingTime(symbol: string): Promise<number> {
    if (this.coinListingTimeCache.has(symbol)) {
      return this.coinListingTimeCache.get(symbol)!;
    }

    try {
      const candles = await this.fetchKlineData(symbol, "Day1", 30);
      
      if (candles.length === 0) {
        const defaultTime = Date.now() - (15 * 24 * 60 * 60 * 1000);
        this.coinListingTimeCache.set(symbol, defaultTime);
        return defaultTime;
      }

      const firstCandleTime = Math.min(...candles.map(c => c.timestamp));
      this.coinListingTimeCache.set(symbol, firstCandleTime);
      
      return firstCandleTime;
    } catch (error) {
      const defaultTime = Date.now() - (15 * 24 * 60 * 60 * 1000);
      this.coinListingTimeCache.set(symbol, defaultTime);
      return defaultTime;
    }
  }

  private async isCoinListedAtLeast14Days(symbol: string): Promise<boolean> {
    try {
      const listingTime = await this.getCoinListingTime(symbol);
      const currentTime = Date.now();
      const ageInMs = currentTime - listingTime;
      const ageInDays = ageInMs / (1000 * 60 * 60 * 24);
      
      return ageInDays >= STRATEGY_CONFIG.reversalDetection.minListingDays;
    } catch (error) {
      return false;
    }
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

  private calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) return 0;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  private calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const difference = prices[prices.length - i] - prices[prices.length - i - 1];
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

  private calculateMA(candles: SimpleCandle[], period: number): number {
    if (candles.length < period) return 0;
    const recentCandles = candles.slice(-period);
    const closes = recentCandles.map(c => c.close);
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  }

  private detectBearishCandlestickPatterns(currentCandle: SimpleCandle, previousCandle: SimpleCandle): { 
    patterns: string[]; 
    hasBearishPattern: boolean;
    isShootingStar: boolean;
    isBearishEngulfing: boolean;
    isEveningStar: boolean;
  } {
    const patterns: string[] = [];

    const upperShadow = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
    const lowerShadow = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
    const body = Math.abs(currentCandle.close - currentCandle.open);
    const totalRange = currentCandle.high - currentCandle.low;
    
    const isShootingStar = upperShadow > body * 2 && 
                          lowerShadow < body * 0.5 && 
                          currentCandle.close < currentCandle.open;
    
    const isBearishEngulfing = previousCandle && 
                              previousCandle.close > previousCandle.open &&
                              currentCandle.close < currentCandle.open &&
                              currentCandle.open >= previousCandle.close &&
                              currentCandle.close <= previousCandle.open;
    
    const isEveningStar = currentCandle.close < currentCandle.open && 
                         body / totalRange > 0.7 &&
                         previousCandle && previousCandle.close > previousCandle.open;

    if (isShootingStar) patterns.push('Shooting Star');
    if (isBearishEngulfing) patterns.push('Bearish Engulfing');
    if (isEveningStar) patterns.push('Evening Star');

    return { 
      patterns, 
      hasBearishPattern: patterns.length > 0,
      isShootingStar,
      isBearishEngulfing,
      isEveningStar
    };
  }

  private detectStrongDowntrend(candles: SimpleCandle[]): boolean {
    if (candles.length < 2) return false;

    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];

    const body = Math.abs(currentCandle.close - currentCandle.open);
    const totalRange = currentCandle.high - currentCandle.low;
    const bodyRatio = body / totalRange;

    const priceDropPercent = ((previousCandle.close - currentCandle.close) / previousCandle.close) * 100;

    const avgVolume = candles.slice(-10, -1).reduce((sum, c) => sum + c.volume, 0) / 9;
    const volumeRatio = currentCandle.volume / avgVolume;

    const isLongRedCandle = currentCandle.close < currentCandle.open && 
                           bodyRatio >= STRATEGY_CONFIG.strongDowntrendConfig.minCandleBodyRatio;

    const hasStrongPriceDrop = priceDropPercent >= STRATEGY_CONFIG.strongDowntrendConfig.minPriceDropPercent;

    const hasVolumeSpike = volumeRatio >= STRATEGY_CONFIG.strongDowntrendConfig.volumeSpikeRatio;

    return isLongRedCandle && hasStrongPriceDrop && hasVolumeSpike;
  }

  private calculateMarketMomentum(candles: SimpleCandle[]): number {
    if (candles.length < 10) return 0;

    const recentPrices = candles.slice(-10).map(c => c.close);
    const midPrices = candles.slice(-20, -10).map(c => c.close);
    
    const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const midAvg = midPrices.reduce((a, b) => a + b, 0) / midPrices.length;
    
    return midAvg > 0 ? (recentAvg - midAvg) / midAvg : 0;
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
    volumeSpike: number,
    marketMomentum: number
  ): number {
    const volatilityScore = Math.min(volatility * 2, 40);
    const volumeScore = volume24h >= STRATEGY_CONFIG.minVolume24h && volume24h <= STRATEGY_CONFIG.maxVolume24h ? 30 : 0;
    const fakePumpScore = 30;
    
    let additionalScore = 0;
    if (volumeSpike > STRATEGY_CONFIG.volumeSpikeThreshold) {
      additionalScore += 10;
    }
    
    if (marketMomentum < 0.05) {
      additionalScore += 10;
    }

    return volatilityScore + volumeScore + fakePumpScore + additionalScore;
  }

  private calculatePumpDuration(candles: SimpleCandle[], pumpHigh: number): number {
    if (candles.length < 4) return 0;
    
    const recentCandles = candles.slice(-4);
    
    let pumpStartIndex = -1;
    for (let i = recentCandles.length - 1; i >= 0; i--) {
      if (Math.abs(recentCandles[i].high - pumpHigh) / pumpHigh < 0.01) {
        pumpStartIndex = i;
        break;
      }
    }
    
    if (pumpStartIndex === -1) return 0;
    
    let pumpLow = recentCandles[pumpStartIndex].low;
    let startIndex = pumpStartIndex;
    
    for (let i = pumpStartIndex - 1; i >= 0; i--) {
      if (recentCandles[i].low < pumpLow) {
        pumpLow = recentCandles[i].low;
        startIndex = i;
      } else {
        break;
      }
    }
    
    return pumpStartIndex - startIndex + 1;
  }

  private detectPumpAlertReversalSignal(
    symbol: string,
    candles: SimpleCandle[], 
    currentPrice: number
  ): { 
    hasReversal: boolean; 
    reversalType: string; 
    reasons: string[];
    confidence: number;
    riskLevel: string;
    dropFromPeak: number;
    volumeRatio: number;
    hasBearishPattern: boolean;
    bearishPatterns: string[];
    priceUnderMA: boolean;
    consecutiveBearish: boolean;
    peakPrice: number;
    pumpDurationCandles: number;
    requiredRetracePercent: number;
    isTracked: boolean;
    shouldTrack: boolean;
    initialPumpPct: number;
  } {
    const numCandlesToCheck = 10;
    if (candles.length < numCandlesToCheck) {
      return { 
        hasReversal: false, 
        reversalType: '', 
        reasons: ['INSUFFICIENT_DATA'],
        confidence: 0,
        riskLevel: 'HIGH',
        dropFromPeak: 0,
        volumeRatio: 1,
        hasBearishPattern: false,
        bearishPatterns: [],
        priceUnderMA: false,
        consecutiveBearish: false,
        peakPrice: 0,
        pumpDurationCandles: 0,
        requiredRetracePercent: 0,
        isTracked: false,
        shouldTrack: false,
        initialPumpPct: 0
      };
    }

    const recentCandles = candles.slice(-numCandlesToCheck);
    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];
    
    const firstPrice = recentCandles[0].open;
    const highestPrice = Math.max(...recentCandles.map(k => k.high));
    const pumpPct = ((highestPrice - firstPrice) / firstPrice) * 100;
    
    const dropFromPeak = ((highestPrice - currentPrice) / highestPrice) * 100;
    
    const avgVolume = recentCandles.slice(0, -1).reduce((sum, k) => sum + k.volume, 0) / 9;
    const volumeRatio = currentCandle.volume / avgVolume;
    
    const patternAnalysis = this.detectBearishCandlestickPatterns(currentCandle, previousCandle);
    
    const ma5 = this.calculateMA(candles, 5);
    const ma10 = this.calculateMA(candles, 10);
    const priceUnderMA = currentPrice < ma5 && currentPrice < ma10;
    
    const last3Candles = recentCandles.slice(-3);
    const consecutiveBearish = last3Candles.every(k => k.close < k.open);
    
    const isTracked = this.pumpTrackingCoins.has(symbol);
    
    let shouldTrack = false;
    if (!isTracked && pumpPct >= STRATEGY_CONFIG.trackingConfig.pumpThreshold) {
      shouldTrack = true;
    }

    const reasons: string[] = [];
    let confidence = 0;
    let riskLevel = 'HIGH';
    let reversalType = '';
    let hasReversal = false;

    if (isTracked) {
      const trackData = this.pumpTrackingCoins.get(symbol)!;
      
      const hasReversalSignal = dropFromPeak >= Math.abs(STRATEGY_CONFIG.trackingConfig.reversalConfirmationPct);
      const hasStrongReversal = dropFromPeak >= Math.abs(STRATEGY_CONFIG.trackingConfig.strongReversalPct);
      const hasVolumeSpike = volumeRatio >= STRATEGY_CONFIG.trackingConfig.volumeSpikeRatio;
      const hasBearishPattern = patternAnalysis.hasBearishPattern;

      if (hasReversalSignal) {
        hasReversal = true;
        
        if (hasStrongReversal) confidence += 35;
        else confidence += 25;
        
        if (hasBearishPattern) confidence += 25;
        if (hasVolumeSpike) confidence += 20;
        if (priceUnderMA) confidence += 15;
        if (consecutiveBearish) confidence += 15;
        
        if (confidence >= 80) {
          reversalType = 'CỰC MẠNH 🔥';
          riskLevel = 'LOW';
        } else if (confidence >= 65) {
          reversalType = 'Ổn đi vol trung bình, có thể DCA ⚡';
          riskLevel = 'MEDIUM';
        } else if (confidence >= 50) {
          reversalType = 'Vol nhỏ thôi nha các bố ⚠️';
          riskLevel = 'HIGH';
        } else {
          hasReversal = false;
        }

        if (hasReversal) {
          reasons.push(`PUMP_${pumpPct.toFixed(1)}%`);
          reasons.push(`RETRACE_${dropFromPeak.toFixed(1)}%`);
          
          if (patternAnalysis.hasBearishPattern) reasons.push(...patternAnalysis.patterns.map(p => p.toUpperCase()));
          if (hasVolumeSpike) reasons.push(`VOLUME_SPIKE_${volumeRatio.toFixed(1)}x`);
          if (priceUnderMA) reasons.push('PRICE_UNDER_MA');
          if (consecutiveBearish) reasons.push('CONSECUTIVE_BEARISH');
        }
      }
    }

    return { 
      hasReversal, 
      reversalType,
      reasons,
      confidence,
      riskLevel,
      dropFromPeak,
      volumeRatio,
      hasBearishPattern: patternAnalysis.hasBearishPattern,
      bearishPatterns: patternAnalysis.patterns,
      priceUnderMA,
      consecutiveBearish,
      peakPrice: highestPrice,
      pumpDurationCandles: 0,
      requiredRetracePercent: 0,
      isTracked,
      shouldTrack,
      initialPumpPct: pumpPct
    };
  }

  private detectFakePump(
    candles: SimpleCandle[]
  ): { isFakePump: boolean; pumpPercent: number; pumpHigh: number } {
    
    if (candles.length < STRATEGY_CONFIG.reversalDetection.pumpCandles) {
      return { isFakePump: false, pumpPercent: 0, pumpHigh: 0 };
    }

    const recentCandles = candles.slice(-STRATEGY_CONFIG.reversalDetection.pumpCandles);
    const recentLow = Math.min(...recentCandles.map(c => c.low));
    const recentHigh = Math.max(...recentCandles.map(c => c.high));
    
    const pumpPercent = ((recentHigh - recentLow) / recentLow) * 100;
    
    if (pumpPercent < STRATEGY_CONFIG.reversalDetection.minPumpPercent) {
      return { isFakePump: false, pumpPercent, pumpHigh: recentHigh };
    }

    return { 
      isFakePump: true, 
      pumpPercent,
      pumpHigh: recentHigh
    };
  }

  private calculateSmartTPSLAfterDCA(position: PositionData, currentPrice: number): { tpLevels: TakeProfitLevel[], slLevels: StopLossLevel[] } {
    const remainingQty = position.totalQty - position.closedAmount;
    
    const tpMultiplier = 1 + (position.dcaCount * 0.1);
    const slMultiplier = 1 + (position.dcaCount * 0.05);
    
    const tpLevels: TakeProfitLevel[] = STRATEGY_CONFIG.takeProfitLevels.map((level, index) => {
      const adjustedPercent = level.priceChangePercent * tpMultiplier;
      const absolutePrice = position.averagePrice * (1 - adjustedPercent / 100);
      
      return {
        ...level,
        priceChangePercent: adjustedPercent,
        executed: false,
        quantity: remainingQty * level.closeRatio,
        absolutePrice: absolutePrice
      };
    });

    const slLevels: StopLossLevel[] = this.setupStopLossByRiskLevel(
      position.riskLevel,
      position.averagePrice,
      remainingQty
    );

    return { tpLevels, slLevels };
  }

  private setupStopLossByRiskLevel(
    riskLevel: string, 
    actualPrice: number, 
    initialQty: number
  ): StopLossLevel[] {
    if (riskLevel === 'MEDIUM') {
      return [
        {
          priceChangePercent: 4.0,
          closeRatio: 1.0,
          executed: false,
          quantity: initialQty,
          absolutePrice: actualPrice * (1 + 4.0 / 100)
        }
      ];
    } else if (riskLevel === 'LOW') {
      return [
        {
          priceChangePercent: 7.0,
          closeRatio: 0.5,
          executed: false,
          quantity: initialQty * 0.5,
          absolutePrice: actualPrice * (1 + 7.0 / 100)
        },
        {
          priceChangePercent: 10.0,
          closeRatio: 0.5,
          executed: false,
          quantity: initialQty * 0.5,
          absolutePrice: actualPrice * (1 + 10.0 / 100)
        }
      ];
    } else {
      return STRATEGY_CONFIG.stopLossLevels.map(level => {
        const absolutePrice = actualPrice * (1 + level.priceChangePercent / 100);
        return { 
          ...level, 
          executed: false,
          quantity: initialQty * level.closeRatio,
          absolutePrice
        };
      });
    }
  }

  private async handlePumpTracking(symbol: string, candles: SimpleCandle[], currentPrice: number): Promise<boolean> {
    const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
    
    if (reversalSignal.shouldTrack && !reversalSignal.isTracked) {
      const listingAgeDays = await this.getListingAgeDays(symbol);
      
      const volume24h = this.calculateRealVolume24h(candles);
      if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
        return false;
      }

      if (listingAgeDays < 14) {
        return false;
      }

      this.pumpTrackingCoins.set(symbol, {
        symbol,
        addedAt: Date.now(),
        peakPrice: reversalSignal.peakPrice,
        peakTime: Date.now(),
        initialPumpPct: reversalSignal.initialPumpPct,
        notifiedReversal: false,
        riskLevel: reversalSignal.riskLevel,
        listingAgeDays
      });

      return true;
    }

    if (reversalSignal.isTracked && reversalSignal.hasReversal) {
      const trackData = this.pumpTrackingCoins.get(symbol)!;
      
      const volume24h = this.calculateRealVolume24h(candles);
      if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
        this.pumpTrackingCoins.delete(symbol);
        return false;
      }

      const listingAgeDays = await this.getListingAgeDays(symbol);
      if (listingAgeDays < 14) {
        this.pumpTrackingCoins.delete(symbol);
        return false;
      }

      if (!trackData.notifiedReversal) {
        trackData.notifiedReversal = true;
        trackData.riskLevel = reversalSignal.riskLevel;
        
        return true;
      }
    }

    if (reversalSignal.isTracked) {
      const trackData = this.pumpTrackingCoins.get(symbol)!;
      const trackingDuration = Date.now() - trackData.addedAt;
      if (trackingDuration > STRATEGY_CONFIG.trackingConfig.maxTrackingTime || reversalSignal.dropFromPeak > 30) {
        this.pumpTrackingCoins.delete(symbol);
      }
    }

    return false;
  }

  private async getListingAgeDays(symbol: string): Promise<number> {
    try {
      const listingTime = await this.getCoinListingTime(symbol);
      const currentTime = Date.now();
      const ageInMs = currentTime - listingTime;
      return ageInMs / (1000 * 60 * 60 * 24);
    } catch (error) {
      return 0;
    }
  }

  private detectEntrySignal(
    symbol: string,
    candles: SimpleCandle[], 
    currentPrice: number, 
    volume24h: number
  ): { hasSignal: boolean; signalType: string; side: 'SHORT'; confidence: number; riskLevel: string } {
    
    if (candles.length < 15) {
      return { hasSignal: false, signalType: '', side: 'SHORT', confidence: 0, riskLevel: 'HIGH' };
    }

    const volumeCondition = volume24h >= STRATEGY_CONFIG.minVolume24h && volume24h <= STRATEGY_CONFIG.maxVolume24h;
    if (!volumeCondition) {
      return { hasSignal: false, signalType: '', side: 'SHORT', confidence: 0, riskLevel: 'HIGH' };
    }

    const fakePump = this.detectFakePump(candles);
    
    if (fakePump.isFakePump) {
      const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
      
      if (reversalSignal.hasReversal && reversalSignal.confidence >= 50) {
        return { 
          hasSignal: true, 
          signalType: `ENHANCED_REVERSAL_${reversalSignal.reversalType}`,
          side: 'SHORT',
          confidence: reversalSignal.confidence,
          riskLevel: reversalSignal.riskLevel
        };
      }
    }

    return { hasSignal: false, signalType: '', side: 'SHORT', confidence: 0, riskLevel: 'HIGH' };
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

  async fetch5MinKlineData(symbol: string, limit = 100): Promise<SimpleCandle[]> {
    return this.fetchKlineData(symbol, "Min5", limit);
  }

  async fetch1MinKlineData(symbol: string, limit = 50): Promise<SimpleCandle[]> {
    const formattedSymbol = symbol.replace('USDT', '_USDT');
    const url = `https://contract.mexc.com/api/v1/contract/kline/${formattedSymbol}`;
    
    try {
      const response = await withRetry(async () => {
        return await axios.get<any>(url, {
          params: { interval: 'Min1', limit },
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

  async calculateEnhancedIndicators(symbol: string): Promise<{
    dailyVolatility: number;
    volume24h: number;
    currentPrice: number;
    volumeSpike: number;
    strengthScore: number;
    candles: SimpleCandle[];
    ema: number;
    marketMomentum: number;
    atr: number;
    resistanceLevel: number;
    supportLevel: number;
    hasEntrySignal: boolean;
    signalType: string;
    entrySide: 'SHORT';
    fakePumpSignal: boolean;
    pumpPercent: number;
    hasVolumeConfirmation: boolean;
    reversalSignal: boolean;
    reversalType: string;
    reversalReasons: string[];
    pumpHigh: number;
    retraceFromHigh: number;
    listingAgeDays?: number;
    peakPrice: number;
    dropFromPeak: number;
    volumeRatio: number;
    hasBearishPattern: boolean;
    bearishPatterns: string[];
    ma5: number;
    ma10: number;
    priceUnderMA: boolean;
    consecutiveBearish: boolean;
    confidence: number;
    riskLevel: string;
    pumpDurationCandles: number;
    requiredRetracePercent: number;
  }> {
    try {
      const candles = await this.fetch1MinKlineData(symbol, 50);
      if (candles.length < 15) {
        return this.getDefaultEnhancedIndicatorResult();
      }

      const currentPrice = await this.getCurrentPrice(symbol);
      const volume24h = this.calculateRealVolume24h(candles);

      const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
      
      const fakePumpDetection = this.detectFakePump(candles);
      const pumpHigh = fakePumpDetection.pumpHigh;
      const retraceFromHigh = reversalSignal.dropFromPeak;

      const listingAgeDays = await this.getListingAgeDays(symbol);

      const dailyVolatility = this.calculateDailyVolatility(candles);
      
      const hasVolumeConfirmation = volume24h >= STRATEGY_CONFIG.minVolume24h && volume24h <= STRATEGY_CONFIG.maxVolume24h;
      
      const volumes = candles.map(k => k.volume);
      const volumeSpike = this.calculateVolumeSpike(volumes);
      const ema = this.calculateEMA(candles, STRATEGY_CONFIG.emaPeriod);
      const marketMomentum = this.calculateMarketMomentum(candles);
      const atr = this.calculateATR(candles);
      const resistanceLevel = this.findResistanceLevel(candles, STRATEGY_CONFIG.resistanceLookback);
      const supportLevel = this.findSupportLevel(candles, STRATEGY_CONFIG.resistanceLookback);

      const entrySignal = this.detectEntrySignal(symbol, candles, currentPrice, volume24h);

      const strengthScore = this.calculateStrengthScore(
        dailyVolatility,
        volume24h,
        volumeSpike,
        marketMomentum
      );

      const ma5 = this.calculateMA(candles, 5);
      const ma10 = this.calculateMA(candles, 10);

      return { 
        dailyVolatility,
        volume24h,
        currentPrice, 
        volumeSpike, 
        strengthScore,
        candles,
        ema,
        marketMomentum,
        atr,
        resistanceLevel,
        supportLevel,
        hasEntrySignal: entrySignal.hasSignal,
        signalType: entrySignal.signalType,
        entrySide: 'SHORT',
        fakePumpSignal: fakePumpDetection.isFakePump,
        pumpPercent: fakePumpDetection.pumpPercent,
        hasVolumeConfirmation,
        reversalSignal: reversalSignal.hasReversal,
        reversalType: reversalSignal.reversalType,
        reversalReasons: reversalSignal.reasons,
        pumpHigh,
        retraceFromHigh,
        listingAgeDays,
        peakPrice: reversalSignal.peakPrice,
        dropFromPeak: reversalSignal.dropFromPeak,
        volumeRatio: reversalSignal.volumeRatio,
        hasBearishPattern: reversalSignal.hasBearishPattern,
        bearishPatterns: reversalSignal.bearishPatterns,
        ma5,
        ma10,
        priceUnderMA: reversalSignal.priceUnderMA,
        consecutiveBearish: reversalSignal.consecutiveBearish,
        confidence: entrySignal.confidence,
        riskLevel: entrySignal.riskLevel,
        pumpDurationCandles: reversalSignal.pumpDurationCandles,
        requiredRetracePercent: reversalSignal.requiredRetracePercent
      };
    } catch (error) {
      return this.getDefaultEnhancedIndicatorResult();
    }
  }

  async calculateLowCapIndicators(symbol: string): Promise<{
    dailyVolatility: number;
    volume24h: number;
    currentPrice: number;
    volumeSpike: number;
    strengthScore: number;
    candles: SimpleCandle[];
    ema: number;
    marketMomentum: number;
    atr: number;
    resistanceLevel: number;
    supportLevel: number;
    hasEntrySignal: boolean;
    signalType: string;
    entrySide: 'SHORT';
    fakePumpSignal: boolean;
    pumpPercent: number;
    hasVolumeConfirmation: boolean;
    reversalSignal: boolean;
    reversalType: string;
    reversalReasons: string[];
    pumpHigh: number;
    retraceFromHigh: number;
    listingAgeDays?: number;
    peakPrice: number;
    dropFromPeak: number;
    volumeRatio: number;
    hasBearishPattern: boolean;
    bearishPatterns: string[];
    ma5: number;
    ma10: number;
    priceUnderMA: boolean;
    consecutiveBearish: boolean;
    confidence: number;
    riskLevel: string;
    pumpDurationCandles: number;
    requiredRetracePercent: number;
  }> {
    try {
      // Sử dụng nến 5 phút cho Low-Cap (thay vì 1 giờ)
      const candles = await this.fetch5MinKlineData(symbol, 100);
      if (candles.length < 24) {
        return this.getDefaultEnhancedIndicatorResult();
      }

      const currentPrice = await this.getCurrentPrice(symbol);
      const volume24h = this.calculateRealVolume24h(candles);

      const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
      
      const fakePumpDetection = this.detectFakePump(candles);
      const pumpHigh = fakePumpDetection.pumpHigh;
      const retraceFromHigh = reversalSignal.dropFromPeak;

      const listingAgeDays = await this.getListingAgeDays(symbol);

      const dailyVolatility = this.calculateDailyVolatility(candles);
      
      const hasVolumeConfirmation = volume24h >= STRATEGY_CONFIG.minVolume24h && volume24h <= STRATEGY_CONFIG.lowCapStrategy.maxVolume24h;
      
      const volumes = candles.map(k => k.volume);
      const volumeSpike = this.calculateVolumeSpike(volumes);
      const ema = this.calculateEMA(candles, STRATEGY_CONFIG.emaPeriod);
      const marketMomentum = this.calculateMarketMomentum(candles);
      const atr = this.calculateATR(candles);
      const resistanceLevel = this.findResistanceLevel(candles, STRATEGY_CONFIG.resistanceLookback);
      const supportLevel = this.findSupportLevel(candles, STRATEGY_CONFIG.resistanceLookback);

      const entrySignal = this.detectEntrySignal(symbol, candles, currentPrice, volume24h);

      const strengthScore = this.calculateStrengthScore(
        dailyVolatility,
        volume24h,
        volumeSpike,
        marketMomentum
      );

      const ma5 = this.calculateMA(candles, 5);
      const ma10 = this.calculateMA(candles, 10);

      return { 
        dailyVolatility,
        volume24h,
        currentPrice, 
        volumeSpike, 
        strengthScore,
        candles,
        ema,
        marketMomentum,
        atr,
        resistanceLevel,
        supportLevel,
        hasEntrySignal: entrySignal.hasSignal,
        signalType: entrySignal.signalType,
        entrySide: 'SHORT',
        fakePumpSignal: fakePumpDetection.isFakePump,
        pumpPercent: fakePumpDetection.pumpPercent,
        hasVolumeConfirmation,
        reversalSignal: reversalSignal.hasReversal,
        reversalType: reversalSignal.reversalType,
        reversalReasons: reversalSignal.reasons,
        pumpHigh,
        retraceFromHigh,
        listingAgeDays,
        peakPrice: reversalSignal.peakPrice,
        dropFromPeak: reversalSignal.dropFromPeak,
        volumeRatio: reversalSignal.volumeRatio,
        hasBearishPattern: reversalSignal.hasBearishPattern,
        bearishPatterns: reversalSignal.bearishPatterns,
        ma5,
        ma10,
        priceUnderMA: reversalSignal.priceUnderMA,
        consecutiveBearish: reversalSignal.consecutiveBearish,
        confidence: entrySignal.confidence,
        riskLevel: entrySignal.riskLevel,
        pumpDurationCandles: reversalSignal.pumpDurationCandles,
        requiredRetracePercent: reversalSignal.requiredRetracePercent
      };
    } catch (error) {
      return this.getDefaultEnhancedIndicatorResult();
    }
  }

  private getDefaultEnhancedIndicatorResult() {
    return {
      dailyVolatility: 0,
      volume24h: 0,
      currentPrice: 0,
      volumeSpike: 1,
      strengthScore: 0,
      candles: [],
      ema: 0,
      marketMomentum: 0,
      atr: 0,
      resistanceLevel: 0,
      supportLevel: 0,
      hasEntrySignal: false,
      signalType: '',
      entrySide: 'SHORT' as const,
      fakePumpSignal: false,
      pumpPercent: 0,
      hasVolumeConfirmation: false,
      reversalSignal: false,
      reversalType: '',
      reversalReasons: [],
      pumpHigh: 0,
      retraceFromHigh: 0,
      listingAgeDays: 0,
      peakPrice: 0,
      dropFromPeak: 0,
      volumeRatio: 1,
      hasBearishPattern: false,
      bearishPatterns: [],
      ma5: 0,
      ma10: 0,
      priceUnderMA: false,
      consecutiveBearish: false,
      confidence: 0,
      riskLevel: 'HIGH',
      pumpDurationCandles: 0,
      requiredRetracePercent: 0
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

  private async calculatePositionSize(symbol: string, percent: number, confidence: number = 50): Promise<number> {
    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0) return 0;

      const contractInfo = await this.getContractInfo(symbol);
      
      // Tính toán dựa trên số dư hiện tại
      let capital = this.accountBalance * percent;
      
      // Kiểm tra đảm bảo không vượt quá leverage cho phép
      const maxPositionValue = this.accountBalance * LEVERAGE;
      const requestedPositionValue = capital * LEVERAGE;
      
      if (requestedPositionValue > maxPositionValue) {
        console.log(`⚠️ [POSITION_SIZE] Giảm kích thước lệnh do vượt quá đòn bẩy cho phép`);
        capital = this.accountBalance * 0.05; // Giảm xuống 5% nếu vượt quá
      }
      
      let vol = (capital * LEVERAGE) / (currentPrice * contractInfo.contractSize);
      
      // Kiểm tra volume tối thiểu
      const minVol = Math.pow(10, -contractInfo.volumePrecision);
      if (vol < minVol) {
        console.log(`⚠️ [POSITION_SIZE] Volume quá nhỏ, sử dụng volume tối thiểu`);
        vol = minVol;
      }
      
      const stepSize = Math.pow(10, -contractInfo.volumePrecision);
      vol = Math.floor(vol / stepSize) * stepSize;
      
      console.log(`📊 [POSITION_CALC] ${symbol} | Percent: ${(percent*100).toFixed(1)}% | Capital: $${capital.toFixed(2)} | Volume: ${vol}`);
      
      return vol;
    } catch (error) {
      console.error(`❌ [POSITION_SIZE_ERROR] ${symbol}:`, error);
      return 0;
    }
  }

  private roundVolume(volume: number, volumePrecision: number): number {
    const stepSize = Math.pow(10, -volumePrecision);
    return Math.floor(volume / stepSize) * stepSize;
  }

  private recalculateTPSLAfterDCA(position: PositionData, currentPrice: number): void {
    const { tpLevels, slLevels } = this.calculateSmartTPSLAfterDCA(position, currentPrice);
    
    position.takeProfitLevels = tpLevels;
    position.stopLossLevels = slLevels;
    
    position.currentTpLevels = tpLevels.map(tp => tp.priceChangePercent);
    position.currentSlLevels = slLevels.map(sl => sl.priceChangePercent);
    
    position.sltpRecalculated = true;
  }

  private doubleTakeProfitLevels(position: PositionData): void {
    if (position.tpDoubled) return;

    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      if (!position.takeProfitLevels[i].executed) {
        position.takeProfitLevels[i].priceChangePercent *= 2;
        if (position.takeProfitLevels[i].absolutePrice) {
          position.takeProfitLevels[i].absolutePrice = position.averagePrice * 
            (1 - position.takeProfitLevels[i].priceChangePercent / 100);
        }
      }
    }

    position.tpDoubled = true;
  }

  private isTrendWeakening(symbol: string, position: PositionData, currentPrice: number): boolean {
    try {
      const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
      
      if (priceChange > 5.0) {
        return true;
      }
      
      const candles = position.candles || [];
      if (candles.length < 10) return false;
      
      const marketMomentum = this.calculateMarketMomentum(candles);
      if (marketMomentum > 0.1) {
        return true;
      }
      
      return false;
    } catch (error) {
      return false;
    }
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

      if (orderResponse && orderResponse.data) {
        if (typeof orderResponse.data === 'string') {
          orderId = orderResponse.data;
          try {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const positions = await this.getCurrentPositions();
            const position = positions.find((p: any) => 
              p.symbol === formattedSymbol && p.positionType === 2
            );
            if (position) {
              realPositionId = position.id?.toString() || position.positionId?.toString();
            }
          } catch (error) {
          }
        } else if (typeof orderResponse.data === 'object') {
          orderId = orderResponse.data.orderId?.toString() || `order_${Date.now()}`;
          realPositionId = orderResponse.data.positionId?.toString() || 
                          orderResponse.data.data?.positionId?.toString();
        } else {
          orderId = `order_${Date.now()}`;
        }
      } else {
        orderId = `order_${Date.now()}`;
      }

      if (!realPositionId) {
        try {
          await new Promise(resolve => setTimeout(resolve, 3000));
          const positions = await this.getCurrentPositions();
          const position = positions.find((p: any) => 
            p.symbol === formattedSymbol && p.positionType === 2
          );
          if (position) {
            realPositionId = position.id?.toString() || position.positionId?.toString();
          }
        } catch (error) {
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

  async closePosition(symbol: string, quantity: number, side: 'SHORT', reason: string, positionId?: string): Promise<boolean> {
    try {
      const position = this.positions.get(symbol);
      
      if (!position) {
        return false;
      }

      let targetPositionId = 0;
      if (position.realPositionId) {
        targetPositionId = parseInt(position.realPositionId);
      } else if (positionId) {
        const parsedId = parseInt(positionId);
        if (!isNaN(parsedId)) {
          targetPositionId = parsedId;
        }
      }

      const contractInfo = await this.getContractInfo(symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      if (currentPrice <= 0) return false;
      
      let closeQty = this.roundVolume(quantity, contractInfo.volumePrecision);
      
      if (closeQty <= 0) return false;
      
      const formattedSymbol = symbol.replace('USDT', '_USDT');

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

      if (orderResponse && orderResponse.code === 0) {
        if (position) {
          const profit = await this.calculateProfitForQuantity(position, currentPrice, closeQty);
          this.totalProfit += profit;
          position.closedAmount += closeQty;
          
          if (position.closedAmount >= position.positionSize) {
            this.positions.delete(symbol);
            this.activePositionMonitoring.delete(symbol);
          }
        }
        
        return true;
      } else {
        return false;
      }

    } catch (err: any) {
      const position = this.positions.get(symbol);
      if (position) {
        await this.closeAllPositionsForSymbol(symbol, position, 'CLOSE_ALL_ON_EXCEPTION');
      }
      
      return false;
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
      
      let targetPositionId = 0;
      if (position.realPositionId) {
        targetPositionId = parseInt(position.realPositionId);
      }

      const orderResponse = await client.submitOrder({
        symbol: formattedSymbol,
        price: currentPrice,
        vol: closeQty,
        side: 2,
        type: 1,
        openType: 2,
        leverage: LEVERAGE,
        positionId: targetPositionId,
      }) as any;

      if (orderResponse && orderResponse.code === 0) {
        position.closedAmount = position.positionSize;
        this.positions.delete(symbol);
        this.activePositionMonitoring.delete(symbol);
      }

    } catch (error: any) {
    }
  }

  private async getCurrentPositions(symbol?: string): Promise<any[]> {
    try {
      const formattedSymbol = symbol ? symbol.replace('USDT', '_USDT') : undefined;
      
      const response = await client.getOpenPositions(formattedSymbol) as any;
      
      if (response && response.data && Array.isArray(response.data)) {
        return response.data;
      }
      return [];
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
        
        if (!position.dcaDisabled) {
          await this.checkImmediateDCA(symbol, position, currentPrice);
          await this.checkPositiveDCA(symbol, position, currentPrice);
        }
        
        await this.checkTrailingStopLoss(symbol, position, currentPrice);

      } catch (error) {
      }
    }, 5000);

    if (!this.realTimeMonitorInterval) {
      this.realTimeMonitorInterval = monitorInterval;
    }
  }

  private recalculateSLTPAfterPartialClose(position: PositionData): void {    
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

  private async checkPositiveDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    try {
      const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
      
      if (profitData.priceChangePercent >= 0) return;

      // ĐIỀU KIỆN MỚI: Chỉ DCA dương khi lời từ 0.5% trở lên
      if (Math.abs(profitData.priceChangePercent) < STRATEGY_CONFIG.dcaConfig.positiveDcaMinPercent) {
        return;
      }

      // ĐIỀU KIỆN MỚI: Kiểm tra thời gian tối thiểu giữa các lần DCA dương (ít nhất 3 phút)
      const now = Date.now();
      const minPositiveDcaInterval = 180000; // 3 phút
      if (position.lastPositiveDcaTime && (now - position.lastPositiveDcaTime) < minPositiveDcaInterval) {
        return;
      }

      // ĐIỀU KIỆN MỚI: Kiểm tra khoảng cách giá tối thiểu (ít nhất 0.5%)
      if (position.lastPositiveDcaPrice) {
        const priceMovement = Math.abs((currentPrice - position.lastPositiveDcaPrice) / position.lastPositiveDcaPrice * 100);
        if (priceMovement < 0.5) {
          return; // Giá chưa di chuyển đủ xa
        }
      }

      // ĐIỀU KIỆN MỚI: Giới hạn số lần DCA dương liên tiếp
      if (position.consecutivePositiveDcaCount >= 2) {
        const cooldownTime = 300000; // 5 phút
        if (position.lastPositiveDcaTime && (now - position.lastPositiveDcaTime) < cooldownTime) {
          return;
        }
        position.consecutivePositiveDcaCount = 0; // Reset sau cool down
      }

      if (position.totalDcaPercent >= STRATEGY_CONFIG.dcaConfig.maxTotalDcaPercent) {
        position.dcaDisabled = true;
        return;
      }

      if (this.isTrendWeakening(symbol, position, currentPrice)) {
        position.dcaDisabled = true;
        console.log(`⏹️ [DCA_STOPPED] ${symbol} | Trend đang yếu đi, dừng DCA`);
        return;
      }

      const positiveDcaQty = await this.calculatePositionSize(
        symbol, 
        STRATEGY_CONFIG.dcaConfig.positiveDcaPercent,
        position.confidence || 50
      );
      
      if (positiveDcaQty > 0) {
        const dcaOrderId = `positive_dca_${symbol}_${Date.now()}`;
        this.pendingDcaOrders.set(dcaOrderId, {
          symbol,
          level: position.positiveDcaCount,
          quantity: positiveDcaQty,
          timestamp: now
        });
        
        const success = await this.addToPosition(symbol, positiveDcaQty, 'SHORT', `POSITIVE_DCA_${position.positiveDcaCount + 1}`);
        
        if (success) {
          const newTotalQty = position.totalQty + positiveDcaQty;
          position.averagePrice = (position.averagePrice * position.totalQty + currentPrice * positiveDcaQty) / newTotalQty;
          position.totalQty = newTotalQty;
          position.positionSize = newTotalQty;
          
          position.positiveDcaCount++;
          position.lastPositiveDcaTime = now;
          position.lastPositiveDcaPrice = currentPrice;
          position.consecutivePositiveDcaCount++;
          position.totalDcaVolume += positiveDcaQty;
          position.totalDcaPercent += STRATEGY_CONFIG.dcaConfig.positiveDcaPercent;

          this.recalculateTPSLAfterDCA(position, currentPrice);
          
          if (position.trailingStopLoss) {
            position.trailingStopLoss.activated = false;
            position.trailingStopLoss.activationPrice = 0;
            position.trailingStopLoss.currentStopPrice = 0;
            position.trailingStopLoss.highestProfit = 0;
            position.trailingStopLoss.peakProfitReached = false;
          }

          this.pendingDcaOrders.delete(dcaOrderId);
          
          console.log(`✅ [POSITIVE_DCA] ${symbol} | Lần ${position.positiveDcaCount} | Lời: ${Math.abs(profitData.priceChangePercent).toFixed(2)}% | Tổng DCA: ${position.totalDcaPercent.toFixed(2)}% | Giá: $${currentPrice.toFixed(6)}`);
        } else {
          this.pendingDcaOrders.delete(dcaOrderId);
        }
      }
    } catch (error) {
      console.error(`❌ [POSITIVE_DCA_ERROR] ${symbol}:`, error);
    }
  }

  private extendTakeProfitLevels(position: PositionData, extendPercent: number): void {
    if (extendPercent > 0) {
    }

    if (!position.originalTakeProfitLevels) {
      position.originalTakeProfitLevels = JSON.parse(JSON.stringify(position.takeProfitLevels));
    }

    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      if (!position.takeProfitLevels[i].executed) {
        const originalLevel = position.originalTakeProfitLevels[i];
        position.takeProfitLevels[i].priceChangePercent = originalLevel.priceChangePercent + extendPercent;
        if (position.takeProfitLevels[i].absolutePrice) {
          position.takeProfitLevels[i].absolutePrice = position.averagePrice * 
            (1 - position.takeProfitLevels[i].priceChangePercent / 100);
        }
      }
    }

    position.extendedTpLevels.push(extendPercent);
  }

  private async checkImmediateDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    try {
      const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);

      // ĐIỀU KIỆN MỚI: Chỉ DCA khi lỗ từ 1% trở lên
      if (priceChange > -STRATEGY_CONFIG.dcaConfig.negativeDcaMinPercent) {
        return;
      }

      // ĐIỀU KIỆN MỚI: Kiểm tra thời gian tối thiểu giữa các lần DCA (ít nhất 3 phút)
      const now = Date.now();
      const minDcaInterval = STRATEGY_CONFIG.dcaConfig.minDcaInterval; // 3 phút
      if (position.lastNegativeDcaTime && (now - position.lastNegativeDcaTime) < minDcaInterval) {
        return;
      }

      // ĐIỀU KIỆN MỚI: Kiểm tra khoảng cách giá tối thiểu (ít nhất 0.5%)
      if (position.lastNegativeDcaPrice) {
        const priceMovement = Math.abs((currentPrice - position.lastNegativeDcaPrice) / position.lastNegativeDcaPrice * 100);
        if (priceMovement < STRATEGY_CONFIG.dcaConfig.minPriceMovement) {
          return; // Giá chưa di chuyển đủ xa
        }
      }

      // ĐIỀU KIỆN MỚI: Giới hạn số lần DCA liên tiếp
      if (position.consecutiveNegativeDcaCount >= STRATEGY_CONFIG.dcaConfig.maxConsecutiveDca) {
        const cooldownTime = STRATEGY_CONFIG.dcaConfig.dcaCooldown; // 5 phút
        if (position.lastNegativeDcaTime && (now - position.lastNegativeDcaTime) < cooldownTime) {
          return;
        }
        position.consecutiveNegativeDcaCount = 0; // Reset sau cool down
      }

      if (position.totalDcaPercent >= STRATEGY_CONFIG.dcaConfig.maxTotalDcaPercent) {
        position.dcaDisabled = true;
        console.log(`⏹️ [DCA_LIMIT] ${symbol} | Đã đạt giới hạn DCA tối đa: ${position.totalDcaPercent.toFixed(2)}%`);
        return;
      }

      if (this.isTrendWeakening(symbol, position, currentPrice)) {
        position.dcaDisabled = true;
        console.log(`⏹️ [DCA_STOPPED] ${symbol} | Trend đang yếu đi, dừng DCA`);
        return;
      }

      const dcaQty = await this.calculatePositionSize(
        symbol, 
        STRATEGY_CONFIG.dcaConfig.negativeDcaPercent,
        position.confidence || 50
      );
      
      if (dcaQty > 0) {
        const dcaOrderId = `dca_${symbol}_${position.dcaCount}_${Date.now()}`;
        this.pendingDcaOrders.set(dcaOrderId, {
          symbol,
          level: position.dcaCount,
          quantity: dcaQty,
          timestamp: now
        });
        
        const success = await this.addToPosition(symbol, dcaQty, 'SHORT', `DCA_${position.dcaCount + 1}`);
        
        if (success) {
          const newTotalQty = position.totalQty + dcaQty;
          position.averagePrice = (position.averagePrice * position.totalQty + currentPrice * dcaQty) / newTotalQty;
          position.totalQty = newTotalQty;
          position.positionSize = newTotalQty;
          
          position.dcaCount++;
          position.lastNegativeDcaTime = now;
          position.lastNegativeDcaPrice = currentPrice;
          position.consecutiveNegativeDcaCount++;
          position.totalDcaVolume += dcaQty;
          position.totalDcaPercent += STRATEGY_CONFIG.dcaConfig.negativeDcaPercent;

          this.recalculateTPSLAfterDCA(position, currentPrice);
          
          if (position.trailingStopLoss) {
            position.trailingStopLoss.activated = false;
            position.trailingStopLoss.activationPrice = 0;
            position.trailingStopLoss.currentStopPrice = 0;
            position.trailingStopLoss.highestProfit = 0;
            position.trailingStopLoss.peakProfitReached = false;
          }

          this.pendingDcaOrders.delete(dcaOrderId);
          
          console.log(`✅ [NEGATIVE_DCA] ${symbol} | Lần ${position.dcaCount} | Lỗ: ${priceChange.toFixed(2)}% | Tổng DCA: ${position.totalDcaPercent.toFixed(2)}% | Giá: $${currentPrice.toFixed(6)}`);
        } else {
          this.pendingDcaOrders.delete(dcaOrderId);
        }
      }
    } catch (error) {
      console.error(`❌ [DCA_ERROR] ${symbol}:`, error);
    }
  }

  private async checkTrailingStopLoss(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (!STRATEGY_CONFIG.trailingStopLoss.enabled || !position.trailingStopLoss) {
      return;
    }

    const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
    
    if (profitData.priceChangePercent < position.trailingStopLoss.highestProfit) {
      position.trailingStopLoss.highestProfit = profitData.priceChangePercent;
      position.trailingStopLoss.peakProfitReached = true;
    }

    const hasMinimumProfit = Math.abs(profitData.priceChangePercent) >= STRATEGY_CONFIG.trailingStopLoss.minProfitToActivate;

    if (!position.trailingStopLoss.activated && position.trailingStopLoss.peakProfitReached && hasMinimumProfit) {
      const halfOfPeakProfit = position.trailingStopLoss.highestProfit / 2;
      const shouldActivate = profitData.priceChangePercent >= halfOfPeakProfit;

      if (shouldActivate) {
        position.trailingStopLoss.activated = true;
        position.trailingStopLoss.activationPrice = currentPrice;
        position.trailingStopLoss.currentStopPrice = currentPrice * (1 + STRATEGY_CONFIG.trailingStopLoss.trailDistancePercent / 100);
      }
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
          const closeSuccess = await this.closePosition(symbol, remainingQty, 'SHORT', `TRAILING_SL`, position.positionId);
          if (closeSuccess) {
            position.closedAmount += remainingQty;
            
            if (position.closedAmount >= position.positionSize) {
              this.positions.delete(symbol);
              this.activePositionMonitoring.delete(symbol);
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
    
    if (STRATEGY_CONFIG.strongDowntrendConfig.doubleTpOnStrongDowntrend && !position.tpDoubled) {
      const candles = await this.fetchKlineData(symbol, "Min5", 10);
      if (this.detectStrongDowntrend(candles)) {
        this.doubleTakeProfitLevels(position);
      }
    }

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

              this.recalculateSLTPAfterPartialClose(position);
              
              if (position.closedAmount >= position.positionSize) {
                this.positions.delete(symbol);
                this.activePositionMonitoring.delete(symbol);
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
            const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `SL${i+1}`, position.positionId);
            if (closeSuccess) {
              position.closedAmount += closeQty;
              level.executed = true;

              this.recalculateSLTPAfterPartialClose(position);
              
              if (position.closedAmount >= position.positionSize) {
                this.positions.delete(symbol);
                this.activePositionMonitoring.delete(symbol);
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
      
      const volumeLimitedSymbols = contracts
        .filter((contract: any) => {
          if (!contract.symbol || !contract.symbol.includes('USDT')) return false;
          const symbol = contract.symbol.replace('_USDT', 'USDT');
          return this.isOnBinance(symbol);
        })
        .map((contract: any) => contract.symbol.replace('_USDT', 'USDT'));

      return volumeLimitedSymbols;
    } catch (error: any) {
      return [];
    }
  }

  private detectRSIDivergence(
    prices: number[], 
    rsiValues: number[], 
    lookback: number = 10
  ): { hasBearishDivergence: boolean; strength: number } {
    if (prices.length < lookback || rsiValues.length < lookback) {
      return { hasBearishDivergence: false, strength: 0 };
    }

    const recentPrices = prices.slice(-lookback);
    const recentRSI = rsiValues.slice(-lookback);

    let pricePeaks: number[] = [];
    let rsiPeaks: number[] = [];

    for (let i = 2; i < recentPrices.length - 2; i++) {
      if (recentPrices[i] > recentPrices[i-1] && 
          recentPrices[i] > recentPrices[i-2] &&
          recentPrices[i] > recentPrices[i+1] &&
          recentPrices[i] > recentPrices[i+2]) {
        pricePeaks.push(recentPrices[i]);
      }

      if (recentRSI[i] > recentRSI[i-1] && 
          recentRSI[i] > recentRSI[i-2] &&
          recentRSI[i] > recentRSI[i+1] &&
          recentRSI[i] > recentRSI[i+2]) {
        rsiPeaks.push(recentRSI[i]);
      }
    }

    if (pricePeaks.length < 2 || rsiPeaks.length < 2) {
      return { hasBearishDivergence: false, strength: 0 };
    }

    const latestPricePeak = pricePeaks[pricePeaks.length - 1];
    const previousPricePeak = pricePeaks[pricePeaks.length - 2];
    const latestRSIPeak = rsiPeaks[rsiPeaks.length - 1];
    const previousRSIPeak = rsiPeaks[rsiPeaks.length - 2];

    const hasDivergence = latestPricePeak > previousPricePeak && latestRSIPeak < previousRSIPeak;
    
    let strength = 0;
    if (hasDivergence) {
      const priceChange = ((latestPricePeak - previousPricePeak) / previousPricePeak) * 100;
      const rsiChange = ((previousRSIPeak - latestRSIPeak) / previousRSIPeak) * 100;
      strength = Math.min(priceChange + rsiChange, 100);
    }

    return { hasBearishDivergence: hasDivergence, strength };
  }

  private calculateTrendStrength(candles: SimpleCandle[]): number {
    if (candles.length < 20) return 0;

    const ema20 = this.calculateEMA(candles, 20);
    const ema50 = this.calculateEMA(candles, 50);
    const currentPrice = candles[candles.length - 1].close;

    let trendScore = 0;

    if (ema20 < ema50 && currentPrice < ema20) {
      trendScore -= 2;
    }

    const recentCandles = candles.slice(-10);
    const ema20Start = this.calculateEMA(recentCandles.slice(0, 5), 20);
    const ema20End = this.calculateEMA(recentCandles.slice(5), 20);
    const emaSlope = ((ema20End - ema20Start) / ema20Start) * 100;

    trendScore += emaSlope * 10;

    const highs = candles.slice(-15).map(c => c.high);
    const lows = candles.slice(-15).map(c => c.low);

    const lowerHighs = highs.every((high, index) => 
      index === 0 || high <= highs[index - 1]
    );
    const lowerLows = lows.every((low, index) => 
      index === 0 || low <= lows[index - 1]
    );

    if (lowerHighs && lowerLows) {
      trendScore -= 3;
    }

    return Math.max(Math.min(trendScore, 5), -5);
  }

  private calculateRiskRewardRatio(
    entryPrice: number,
    stopLoss: number,
    takeProfit: number
  ): { ratio: number; riskPercent: number; rewardPercent: number } {
    const risk = Math.abs(entryPrice - stopLoss) / entryPrice * 100;
    const reward = Math.abs(takeProfit - entryPrice) / entryPrice * 100;
    const ratio = reward / risk;

    return {
      ratio,
      riskPercent: risk,
      rewardPercent: reward
    };
  }

  // THÊM HÀM PHÂN TÍCH KHÁNG CỤ MỚI
  private analyzeResistanceLevel(
    symbol: string, 
    candles: SimpleCandle[], 
    currentPrice: number
  ): {
    hasResistance: boolean;
    resistancePrice: number;
    distanceFromResistance: number;
    resistanceStrength: number;
    recentTests: number;
  } {
    if (candles.length < 20) {
      return { hasResistance: false, resistancePrice: 0, distanceFromResistance: 0, resistanceStrength: 0, recentTests: 0 };
    }

    const recentCandles = candles.slice(-30);
    const highs = recentCandles.map(c => c.high);
    
    // Tìm các đỉnh quan trọng
    const significantHighs: number[] = [];
    for (let i = 2; i < highs.length - 2; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && 
          highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
        significantHighs.push(highs[i]);
      }
    }

    if (significantHighs.length === 0) {
      return { hasResistance: false, resistancePrice: 0, distanceFromResistance: 0, resistanceStrength: 0, recentTests: 0 };
    }

    // Nhóm các đỉnh gần nhau
    const tolerance = 0.02; // 2%
    const resistanceLevels: {price: number, count: number, totalVolume: number}[] = [];
    
    significantHighs.forEach(high => {
      const existingLevel = resistanceLevels.find(level => 
        Math.abs(level.price - high) / level.price < tolerance
      );
      
      if (existingLevel) {
        existingLevel.count++;
      } else {
        resistanceLevels.push({ price: high, count: 1, totalVolume: 0 });
      }
    });

    // Sắp xếp theo strength (số lần test)
    resistanceLevels.sort((a, b) => b.count - a.count);
    
    if (resistanceLevels.length === 0) {
      return { hasResistance: false, resistancePrice: 0, distanceFromResistance: 0, resistanceStrength: 0, recentTests: 0 };
    }

    const strongestResistance = resistanceLevels[0];
    const distance = ((strongestResistance.price - currentPrice) / strongestResistance.price) * 100;

    return {
      hasResistance: strongestResistance.count >= 2, // Ít nhất 2 lần test
      resistancePrice: strongestResistance.price,
      distanceFromResistance: distance,
      resistanceStrength: strongestResistance.count,
      recentTests: strongestResistance.count
    };
  }

  // SỬA ĐỔI HÀM detectPullbackSignal - TRÁNH ĐÁY
  private detectPullbackSignal(
    symbol: string,
    candles: SimpleCandle[],
    currentPrice: number
  ): { 
    hasPullback: boolean; 
    pullbackPercent: number; 
    volumeConfirmation: boolean; 
    confidence: number;
    isAtSupport: boolean; // THÊM: Có đang ở vùng hỗ trợ không
    resistanceInfo: any; // THÊM: Thông tin kháng cự
  } {
    if (candles.length < 15) {
      return { 
        hasPullback: false, 
        pullbackPercent: 0, 
        volumeConfirmation: false, 
        confidence: 0,
        isAtSupport: false,
        resistanceInfo: null
      };
    }

    const recentCandles = candles.slice(-10);
    const currentCandle = recentCandles[recentCandles.length - 1];
    
    // PHÂN TÍCH KHÁNG CỤ TRƯỚC
    const resistanceInfo = this.analyzeResistanceLevel(symbol, candles, currentPrice);
    
    if (!resistanceInfo.hasResistance) {
      return {
        hasPullback: false,
        pullbackPercent: 0,
        volumeConfirmation: false,
        confidence: 0,
        isAtSupport: false,
        resistanceInfo
      };
    }

    // KIỂM TRA XEM CÓ ĐANG Ở VÙNG HỖ TRỢ (ĐÁY) KHÔNG - TRÁNH VÀO LỆNH Ở ĐÂY
    const supportLevel = this.findSupportLevel(candles, 10);
    const distanceToSupport = ((currentPrice - supportLevel) / currentPrice) * 100;
    const isAtSupport = distanceToSupport < 2.0; // Quá gần hỗ trợ -> đáy

    if (isAtSupport) {
      return {
        hasPullback: false,
        pullbackPercent: 0,
        volumeConfirmation: false,
        confidence: 0,
        isAtSupport: true,
        resistanceInfo
      };
    }

    // KIỂM TRA KHOẢNG CÁCH TỚI KHÁNG CỤ
    const meetsResistanceDistance = 
      resistanceInfo.distanceFromResistance >= STRATEGY_CONFIG.lowCapStrategy.resistanceBounce.minDistanceFromResistance &&
      resistanceInfo.distanceFromResistance <= STRATEGY_CONFIG.lowCapStrategy.resistanceBounce.maxDistanceFromResistance;

    if (!meetsResistanceDistance) {
      return {
        hasPullback: false,
        pullbackPercent: 0,
        volumeConfirmation: false,
        confidence: 0,
        isAtSupport: false,
        resistanceInfo
      };
    }

    // KIỂM TRA XU HƯỚNG GIẢM
    const trendCandles = candles.slice(-5);
    const downtrendCandles = trendCandles.filter((candle, index) => {
      if (index === 0) return false;
      return candle.close < trendCandles[index - 1].close;
    });
    
    const hasDowntrend = downtrendCandles.length >= STRATEGY_CONFIG.lowCapStrategy.trendRequirements.minDowntrendCandles;

    // KIỂM TRA GIÁ DƯỚI MA
    const ma20 = this.calculateMA(candles, 20);
    const priceBelowMA = currentPrice < ma20;

    const peakPrice = Math.max(...recentCandles.slice(0, -2).map(c => c.high));
    const pullbackPercent = ((peakPrice - currentPrice) / peakPrice) * 100;

    const currentVolume = currentCandle.volume;
    const avgVolume = recentCandles.slice(0, -1).reduce((sum, c) => sum + c.volume, 0) / (recentCandles.length - 1);
    const volumeRatio = currentVolume / avgVolume;
    const volumeConfirmation = volumeRatio < STRATEGY_CONFIG.lowCapStrategy.pullbackConfirmation.volumeDropRatio;

    const meetsPullbackConditions = 
      pullbackPercent >= STRATEGY_CONFIG.lowCapStrategy.pullbackConfirmation.minRetracement &&
      pullbackPercent <= STRATEGY_CONFIG.lowCapStrategy.pullbackConfirmation.maxRetracement;

    let confidence = 0;
    if (meetsPullbackConditions && resistanceInfo.hasResistance && hasDowntrend) {
      confidence += 30; // Điều kiện cơ bản
      
      if (volumeConfirmation) confidence += 20;
      if (priceBelowMA) confidence += 15;
      if (resistanceInfo.resistanceStrength >= 2) confidence += 15;
      if (resistanceInfo.distanceFromResistance > 3.0) confidence += 10;
      if (currentCandle.close < currentCandle.open) confidence += 10;
    }

    return {
      hasPullback: meetsPullbackConditions && confidence >= 70 && !isAtSupport,
      pullbackPercent,
      volumeConfirmation,
      confidence,
      isAtSupport,
      resistanceInfo
    };
  }

  private analyzeMarketCondition(indicators: any): string {
    const conditions = [];
    
    if (indicators.marketMomentum < -0.1) conditions.push('BEARISH');
    if (indicators.ema < indicators.currentPrice) conditions.push('BELOW_EMA');
    if (indicators.consecutiveBearish) conditions.push('CONSECUTIVE_BEARISH');
    
    return conditions.join('_');
  }

  private async debugLowCapAnalysis(): Promise<void> {
    const now = Date.now();
    if (now - this.lastLowCapDebugTime < this.lowCapDebugInterval) {
      return;
    }

    this.lastLowCapDebugTime = now;
    const symbols = await this.getAllFuturePairs();
    
    if (symbols.length === 0) {
      console.log('🔍 [LOWCAP_DEBUG] Không có symbol nào để phân tích');
      return;
    }

    const randomIndex = Math.floor(Math.random() * symbols.length);
    const randomSymbol = symbols[randomIndex];
    
    console.log(`\n🎯 [LOWCAP_DEBUG] PHÂN TÍCH CHI TIẾT COIN NGẪU NHIÊN: ${randomSymbol}`);
    console.log('🎯 CHIẾN LƯỢC MỚI: VÀO LỆNH Ở KHÁNG CỤ - TRÁNH ĐÁY');
    console.log('=' .repeat(80));

    try {
      const listingAgeDays = await this.getListingAgeDays(randomSymbol);
      console.log(`📅 [LOWCAP_DEBUG] Tuổi coin: ${listingAgeDays.toFixed(1)} ngày (yêu cầu: >${STRATEGY_CONFIG.lowCapStrategy.minListingDays} ngày)`);

      if (listingAgeDays < STRATEGY_CONFIG.lowCapStrategy.minListingDays) {
        console.log(`❌ [LOWCAP_DEBUG] Coin bị loại: Chưa đủ ${STRATEGY_CONFIG.lowCapStrategy.minListingDays} ngày`);
        return;
      }

      // Sử dụng nến 5 phút cho Low-Cap
      const indicators = await this.calculateLowCapIndicators(randomSymbol);
      const currentPrice = await this.getCurrentPrice(randomSymbol);
      const volume24h = indicators.volume24h;

      console.log(`💰 [LOWCAP_DEBUG] Giá hiện tại: $${currentPrice.toFixed(6)}`);
      console.log(`📊 [LOWCAP_DEBUG] Volume 24h: ${(volume24h / 1000000).toFixed(2)}M USDT (yêu cầu: <${STRATEGY_CONFIG.lowCapStrategy.maxVolume24h/1000000}M)`);
      console.log(`📈 [LOWCAP_DEBUG] Độ biến động: ${indicators.dailyVolatility.toFixed(2)}% (yêu cầu: <${STRATEGY_CONFIG.lowCapStrategy.maxDailyVolatility}%)`);
      console.log(`⏰ [LOWCAP_DEBUG] Timeframe phân tích: 5 Minute Candles`);

      // THÊM PHÂN TÍCH KHÁNG CỤ VÀO DEBUG
      const resistanceInfo = this.analyzeResistanceLevel(randomSymbol, indicators.candles, currentPrice);
      console.log(`\n🛡️ [LOWCAP_DEBUG] PHÂN TÍCH KHÁNG CỤ:`);
      console.log(`   Có kháng cự: ${resistanceInfo.hasResistance}`);
      console.log(`   Giá kháng cự: $${resistanceInfo.resistancePrice.toFixed(6)}`);
      console.log(`   Khoảng cách: ${resistanceInfo.distanceFromResistance.toFixed(2)}%`);
      console.log(`   Sức mạnh: ${resistanceInfo.resistanceStrength} lần test`);
      console.log(`   Yêu cầu: ${resistanceInfo.distanceFromResistance >= 1.0 && resistanceInfo.distanceFromResistance <= 10.0 ? 'ĐẠT ✅' : 'KHÔNG ĐẠT ❌'}`);

      // THÊM KIỂM TRA "CÓ Ở ĐÁY KHÔNG"
      const supportLevel = this.findSupportLevel(indicators.candles, 10);
      const distanceToSupport = ((currentPrice - supportLevel) / currentPrice) * 100;
      const isAtSupport = distanceToSupport < 2.0;
      console.log(`\n📉 [LOWCAP_DEBUG] PHÂN TÍCH ĐÁY/HỖ TRỢ:`);
      console.log(`   Hỗ trợ: $${supportLevel.toFixed(6)}`);
      console.log(`   Khoảng cách tới hỗ trợ: ${distanceToSupport.toFixed(2)}%`);
      console.log(`   Có đang ở đáy: ${isAtSupport ? 'CÓ ⚠️ NGUY HIỂM' : 'KHÔNG ✅ AN TOÀN'}`);

      console.log(`\n🔍 [LOWCAP_DEBUG] PHÂN TÍCH ĐIỀU KIỆN LOW-CAP:`);
      
      const lowCapAgeCondition = listingAgeDays >= STRATEGY_CONFIG.lowCapStrategy.minListingDays;
      console.log(`   📅 Low-cap age: ${lowCapAgeCondition} (${listingAgeDays.toFixed(1)} >= ${STRATEGY_CONFIG.lowCapStrategy.minListingDays} days)`);

      const priceCondition = currentPrice >= STRATEGY_CONFIG.lowCapStrategy.priceRange.min && 
                           currentPrice <= STRATEGY_CONFIG.lowCapStrategy.priceRange.max;
      console.log(`   💰 Price range: ${priceCondition} ($${currentPrice.toFixed(6)} trong $${STRATEGY_CONFIG.lowCapStrategy.priceRange.min}-$${STRATEGY_CONFIG.lowCapStrategy.priceRange.max})`);

      const lowCapVolumeCondition = volume24h <= STRATEGY_CONFIG.lowCapStrategy.maxVolume24h;
      console.log(`   📊 Low-cap volume: ${lowCapVolumeCondition} (${(volume24h/1000000).toFixed(2)}M <= ${STRATEGY_CONFIG.lowCapStrategy.maxVolume24h/1000000}M)`);

      const volatilityCondition = indicators.dailyVolatility <= STRATEGY_CONFIG.lowCapStrategy.maxDailyVolatility;
      console.log(`   📈 Volatility: ${volatilityCondition} (${indicators.dailyVolatility.toFixed(2)}% <= ${STRATEGY_CONFIG.lowCapStrategy.maxDailyVolatility}%)`);

      const lowCapBasicConditions = lowCapAgeCondition && priceCondition && lowCapVolumeCondition && volatilityCondition;
      console.log(`   ✅ Low-cap basic conditions: ${lowCapBasicConditions}`);

      if (!lowCapBasicConditions) {
        console.log(`\n❌ [LOWCAP_DEBUG] Coin không đạt điều kiện cơ bản:`);
        if (!lowCapAgeCondition) console.log(`   - Tuổi coin: ${listingAgeDays.toFixed(1)} < ${STRATEGY_CONFIG.lowCapStrategy.minListingDays}`);
        if (!priceCondition) console.log(`   - Giá: $${currentPrice.toFixed(6)} không trong khoảng $${STRATEGY_CONFIG.lowCapStrategy.priceRange.min}-$${STRATEGY_CONFIG.lowCapStrategy.priceRange.max}`);
        if (!lowCapVolumeCondition) console.log(`   - Volume: ${(volume24h/1000000).toFixed(2)}M > ${STRATEGY_CONFIG.lowCapStrategy.maxVolume24h/1000000}M`);
        if (!volatilityCondition) console.log(`   - Độ biến động: ${indicators.dailyVolatility.toFixed(2)}% > ${STRATEGY_CONFIG.lowCapStrategy.maxDailyVolatility}%`);
        return;
      }

      const prices = indicators.candles.map(c => c.close);
      const rsi = this.calculateRSI(prices, 14);
      const trendStrength = this.calculateTrendStrength(indicators.candles);
      const volumeSpike = indicators.volumeSpike;
      
      console.log(`\n📊 [LOWCAP_DEBUG] CHỈ BÁO KỸ THUẬT (5M):`);
      console.log(`   📊 RSI: ${rsi.toFixed(1)} (yêu cầu: >= ${STRATEGY_CONFIG.lowCapStrategy.rsiOverbought})`);
      console.log(`   📉 Trend strength: ${trendStrength.toFixed(1)} (yêu cầu: <= ${STRATEGY_CONFIG.lowCapStrategy.minTrendStrength})`);
      console.log(`   📊 Trend Analysis: RSI quá mua + Downtrend xác nhận`);
      console.log(`   📈 Volume spike: ${volumeSpike.toFixed(1)}x (yêu cầu: >= ${STRATEGY_CONFIG.lowCapStrategy.volumeSpikeThreshold})`);

      // THÊM ĐIỀU KIỆN XU HƯỚNG GIẢM
      const ma20 = this.calculateMA(indicators.candles, 20);
      const priceBelowMA = currentPrice < ma20;
      
      const trendCandles = indicators.candles.slice(-5);
      const downtrendCandles = trendCandles.filter((candle, index) => {
        if (index === 0) return false;
        return candle.close < trendCandles[index - 1].close;
      });
      const hasDowntrend = downtrendCandles.length >= STRATEGY_CONFIG.lowCapStrategy.trendRequirements.minDowntrendCandles;

      const rsiCondition = rsi >= STRATEGY_CONFIG.lowCapStrategy.rsiOverbought;
      const trendCondition = trendStrength <= STRATEGY_CONFIG.lowCapStrategy.minTrendStrength;
      const volumeSpikeCondition = volumeSpike >= STRATEGY_CONFIG.lowCapStrategy.volumeSpikeThreshold;
      const priceBelowMACondition = priceBelowMA;
      const downtrendCondition = hasDowntrend;

      const lowCapEntryConditions = rsiCondition && trendCondition && volumeSpikeCondition && priceBelowMACondition && downtrendCondition;
      console.log(`   ✅ Low-cap entry conditions: ${lowCapEntryConditions}`);

      if (!lowCapEntryConditions) {
        console.log(`\n❌ [LOWCAP_DEBUG] Coin không đạt điều kiện vào lệnh:`);
        if (!rsiCondition) console.log(`   - RSI: ${rsi.toFixed(1)} < ${STRATEGY_CONFIG.lowCapStrategy.rsiOverbought}`);
        if (!trendCondition) console.log(`   - Trend: ${trendStrength.toFixed(1)} > ${STRATEGY_CONFIG.lowCapStrategy.minTrendStrength}`);
        if (!volumeSpikeCondition) console.log(`   - Volume spike: ${volumeSpike.toFixed(1)}x < ${STRATEGY_CONFIG.lowCapStrategy.volumeSpikeThreshold}`);
        if (!priceBelowMACondition) console.log(`   - Price below MA20: ${priceBelowMA} (yêu cầu: true)`);
        if (!downtrendCondition) console.log(`   - Downtrend: ${hasDowntrend} (yêu cầu: true)`);
        return;
      }

      // PHÂN TÍCH PULLBACK VỚI ĐIỀU KIỆN MỚI
      const pullbackSignal = this.detectPullbackSignal(randomSymbol, indicators.candles, currentPrice);
      console.log(`\n🔍 [LOWCAP_DEBUG] PHÂN TÍCH PULLBACK VÀ KHÁNG CỤ:`);
      console.log(`   📉 Pullback: ${pullbackSignal.pullbackPercent.toFixed(2)}%`);
      console.log(`   📊 Volume confirmation: ${pullbackSignal.volumeConfirmation}`);
      console.log(`   🎯 Confidence: ${pullbackSignal.confidence}%`);
      console.log(`   🛡️  Có kháng cự: ${pullbackSignal.resistanceInfo.hasResistance}`);
      console.log(`   📍 Cách kháng cự: ${pullbackSignal.resistanceInfo.distanceFromResistance.toFixed(2)}%`);
      console.log(`   ⚠️  Có ở đáy: ${pullbackSignal.isAtSupport ? 'CÓ - NGUY HIỂM' : 'KHÔNG - AN TOÀN'}`);

      if (!pullbackSignal.hasPullback || pullbackSignal.isAtSupport) {
        console.log(`\n❌ [LOWCAP_DEBUG] Không đạt điều kiện pullback hoặc đang ở đáy`);
        return;
      }

      const resistance = pullbackSignal.resistanceInfo.resistancePrice;
      const support = indicators.supportLevel;
      const potentialEntry = currentPrice;
      const stopLoss = resistance * 1.03; // SL trên kháng cự
      const takeProfit = support * 0.9;   // TP dưới hỗ trợ
      const riskReward = this.calculateRiskRewardRatio(potentialEntry, stopLoss, takeProfit);

      console.log(`\n🎯 [LOWCAP_DEBUG] PHÂN TÍCH RISK/REWARD:`);
      console.log(`   🎯 Entry: $${potentialEntry.toFixed(6)}`);
      console.log(`   🛡️  Stop Loss: $${stopLoss.toFixed(6)} (trên kháng cự)`);
      console.log(`   ✅ Take Profit: $${takeProfit.toFixed(6)} (dưới hỗ trợ)`);
      console.log(`   📊 Risk/Reward: ${riskReward.ratio.toFixed(2)} (yêu cầu: >= ${STRATEGY_CONFIG.lowCapStrategy.riskRewardRatio.min})`);

      const rrCondition = riskReward.ratio >= STRATEGY_CONFIG.lowCapStrategy.riskRewardRatio.min;
      console.log(`   ✅ Risk/Reward condition: ${rrCondition}`);

      if (!rrCondition) {
        console.log(`\n❌ [LOWCAP_DEBUG] Coin không đạt Risk/Reward: ${riskReward.ratio.toFixed(2)} < ${STRATEGY_CONFIG.lowCapStrategy.riskRewardRatio.min}`);
        return;
      }

      console.log(`\n🎯 [LOWCAP_DEBUG] 🎉 COIN ĐẠT TẤT CẢ ĐIỀU KIỆN LOW-CAP!`);
      console.log(`   ✅ Basic conditions: ĐẠT`);
      console.log(`   ✅ Entry conditions: ĐẠT`);
      console.log(`   ✅ Resistance analysis: ĐẠT`);
      console.log(`   ✅ Not at bottom: ĐẠT`);
      console.log(`   ✅ Risk/Reward: ĐẠT (${riskReward.ratio.toFixed(2)})`);
      console.log(`   ⏰ Timeframe: 5 Minute Candles`);
      console.log(`   🚀 Có thể vào lệnh SHORT ở vùng kháng cự!`);

      // THÊM COIN VÀO DANH SÁCH TRACKING NẾU ĐẠT ĐIỀU KIỆN
      if (lowCapBasicConditions && lowCapEntryConditions && rrCondition && pullbackSignal.hasPullback && !pullbackSignal.isAtSupport) {
        const trackingData: LowCapTrackingData = {
          symbol: randomSymbol,
          addedAt: now,
          currentPrice,
          volume24h,
          dailyVolatility: indicators.dailyVolatility,
          rsi,
          trendStrength,
          volumeSpike,
          marketCondition: this.analyzeMarketCondition(indicators),
          riskRewardRatio: riskReward.ratio,
          pullbackLevel: pullbackSignal.pullbackPercent,
          status: 'TRACKING',
          resistanceLevel: resistance,
          supportLevel: support,
          confidence: Math.min(
            Math.abs(trendStrength) * 15 + 
            (volumeSpike * 5) + 
            (pullbackSignal.resistanceInfo.resistanceStrength * 10) +
            (pullbackSignal.confidence / 2),
            100
          ),
          listingAgeDays,
          resistanceInfo: pullbackSignal.resistanceInfo
        };

        this.lowCapTrackingCoins.set(randomSymbol, trackingData);
        console.log(`✅ [LOWCAP_ADDED] Đã thêm ${randomSymbol} vào danh sách tracking!`);
      }

    } catch (error) {
      console.log(`❌ [LOWCAP_DEBUG] Lỗi khi phân tích ${randomSymbol}:`, error);
    }

    console.log('=' .repeat(80));
  }

  async scanForLowCapCoins(): Promise<void> {
    if (!STRATEGY_CONFIG.lowCapStrategy.enabled) return;

    const now = Date.now();
    if (now - this.lastScanTime < 15000) return;

    this.lastScanTime = now;

    await this.debugLowCapAnalysis();

    const symbols = await this.getAllFuturePairs();

    const symbolsToProcess = symbols.filter(symbol => 
      !this.positions.has(symbol) && 
      !this.lowCapTrackingCoins.has(symbol) &&
      !this.pumpTrackingCoins.has(symbol) &&
      !this.trackingCoins.has(symbol)
    );

    if (symbolsToProcess.length === 0) return;

    let foundLowCap = 0;
    let processed = 0;

    await this.processInParallel(
      symbolsToProcess,
      async (symbol): Promise<void> => {
        try {
          processed++;
          if (processed % 50 === 0) {
            console.log(`📈 [LOWCAP_PROGRESS] Đã xử lý ${processed}/${symbolsToProcess.length} cặp...`);
          }

          const listingAgeDays = await this.getListingAgeDays(symbol);
          if (listingAgeDays < STRATEGY_CONFIG.lowCapStrategy.minListingDays) {
            return;
          }

          // Sử dụng nến 5 phút cho Low-Cap
          const indicators = await this.calculateLowCapIndicators(symbol);
          if (!indicators.candles || indicators.candles.length < 24) return;

          const currentPrice = indicators.currentPrice;
          const volume24h = indicators.volume24h;

          const meetsBasicConditions = 
            currentPrice >= STRATEGY_CONFIG.lowCapStrategy.priceRange.min &&
            currentPrice <= STRATEGY_CONFIG.lowCapStrategy.priceRange.max &&
            volume24h <= STRATEGY_CONFIG.lowCapStrategy.maxVolume24h &&
            indicators.dailyVolatility <= STRATEGY_CONFIG.lowCapStrategy.maxDailyVolatility;

          if (!meetsBasicConditions) return;

          const prices = indicators.candles.map(c => c.close);
          const rsi = this.calculateRSI(prices, 14);
          const trendStrength = this.calculateTrendStrength(indicators.candles);
          const volumeSpike = indicators.volumeSpike;

          // THÊM ĐIỀU KIỆN XU HƯỚNG GIẢM
          const ma20 = this.calculateMA(indicators.candles, 20);
          const priceBelowMA = currentPrice < ma20;
          
          const trendCandles = indicators.candles.slice(-5);
          const downtrendCandles = trendCandles.filter((candle, index) => {
            if (index === 0) return false;
            return candle.close < trendCandles[index - 1].close;
          });
          const hasDowntrend = downtrendCandles.length >= STRATEGY_CONFIG.lowCapStrategy.trendRequirements.minDowntrendCandles;

          const meetsEntryConditions = 
            rsi >= STRATEGY_CONFIG.lowCapStrategy.rsiOverbought &&
            trendStrength <= STRATEGY_CONFIG.lowCapStrategy.minTrendStrength &&
            volumeSpike >= STRATEGY_CONFIG.lowCapStrategy.volumeSpikeThreshold &&
            priceBelowMA && // THÊM: Giá phải dưới MA20
            hasDowntrend; // THÊM: Phải có xu hướng giảm

          if (meetsEntryConditions) {
            // PHÂN TÍCH KHÁNG CỤ TRƯỚC KHI QUYẾT ĐỊNH
            const resistanceInfo = this.analyzeResistanceLevel(symbol, indicators.candles, currentPrice);
            
            if (!resistanceInfo.hasResistance) {
              return; // KHÔNG có kháng cự rõ ràng -> bỏ qua
            }

            // KIỂM TRA KHOẢNG CÁCH TỚI KHÁNG CỤ
            const meetsResistanceDistance = 
              resistanceInfo.distanceFromResistance >= STRATEGY_CONFIG.lowCapStrategy.resistanceBounce.minDistanceFromResistance &&
              resistanceInfo.distanceFromResistance <= STRATEGY_CONFIG.lowCapStrategy.resistanceBounce.maxDistanceFromResistance;

            if (!meetsResistanceDistance) {
              return;
            }

            const pullbackSignal = this.detectPullbackSignal(symbol, indicators.candles, currentPrice);
            
            // CHỈ VÀO LỆNH KHI CÓ PULLBACK VÀ KHÔNG Ở VÙNG ĐÁY
            if (pullbackSignal.hasPullback && !pullbackSignal.isAtSupport) {
              const resistance = resistanceInfo.resistancePrice;
              const support = indicators.supportLevel;
              
              // ĐIỀU CHỈNH ENTRY: Vào ở currentPrice (sau khi đã bật lại từ kháng cự)
              const potentialEntry = currentPrice;
              const stopLoss = resistance * 1.03; // SL trên kháng cự một chút
              const takeProfit = support * 0.9;   // TP gần hỗ trợ
              
              const riskReward = this.calculateRiskRewardRatio(potentialEntry, stopLoss, takeProfit);

              if (riskReward.ratio >= STRATEGY_CONFIG.lowCapStrategy.riskRewardRatio.min) {
                const trackingData: LowCapTrackingData = {
                  symbol,
                  addedAt: now,
                  currentPrice,
                  volume24h,
                  dailyVolatility: indicators.dailyVolatility,
                  rsi,
                  trendStrength,
                  volumeSpike,
                  marketCondition: this.analyzeMarketCondition(indicators),
                  riskRewardRatio: riskReward.ratio,
                  pullbackLevel: pullbackSignal.pullbackPercent,
                  status: 'TRACKING',
                  resistanceLevel: resistance,
                  supportLevel: support,
                  confidence: Math.min(
                    Math.abs(trendStrength) * 15 + 
                    (volumeSpike * 5) + 
                    (resistanceInfo.resistanceStrength * 10) +
                    (pullbackSignal.confidence / 2),
                    100
                  ),
                  listingAgeDays,
                  resistanceInfo: resistanceInfo
                };

                this.lowCapTrackingCoins.set(symbol, trackingData);
                foundLowCap++;
                
                console.log(`✅ [LOWCAP_FOUND] ${symbol} | Price: $${currentPrice.toFixed(6)} | Volume: ${(volume24h/1000000).toFixed(2)}M`);
                console.log(`   📊 RSI: ${rsi.toFixed(1)} | Trend: ${trendStrength.toFixed(1)} | Volume Spike: ${volumeSpike.toFixed(1)}x`);
                console.log(`   🎯 R/R: ${riskReward.ratio.toFixed(2)} | Conf: ${trackingData.confidence.toFixed(1)}% | Age: ${listingAgeDays.toFixed(1)}d`);
                console.log(`   🛡️  Resistance: $${resistance.toFixed(6)} | Distance: ${resistanceInfo.distanceFromResistance.toFixed(1)}%`);
                console.log(`   📉 Pullback: ${pullbackSignal.pullbackPercent.toFixed(2)}% | Not at support ✅`);
              }
            }
          }

        } catch (error) {
          // Xử lý lỗi
        }
      }
    );

    if (foundLowCap > 0) {
      console.log(`✅ [LOWCAP_RESULT] Tìm thấy ${foundLowCap} coin Low-Cap tiềm năng (TRÁNH ĐÁY)`);
    }
  }

  async trackLowCapCoinsRealTime(): Promise<void> {
    if (this.lowCapTrackingCoins.size === 0) {
      console.log('⏭️ [LOWCAP_TRACKING] Không có coin Low-Cap nào đang theo dõi');
      return;
    }

    console.log(`🔍 [LOWCAP_TRACKING] Đang theo dõi ${this.lowCapTrackingCoins.size} coin Low-Cap (5M Analysis)...`);

    for (const [symbol, trackingData] of this.lowCapTrackingCoins.entries()) {
      try {
        if (!this.hasMinimumBalance() || this.positions.size >= STRATEGY_CONFIG.maxActivePositions) {
          continue;
        }

        // Sử dụng nến 5 phút cho Low-Cap
        const indicators = await this.calculateLowCapIndicators(symbol);
        const currentPrice = indicators.currentPrice;

        trackingData.currentPrice = currentPrice;
        trackingData.volume24h = indicators.volume24h;
        trackingData.dailyVolatility = indicators.dailyVolatility;

        const pullbackSignal = this.detectPullbackSignal(symbol, indicators.candles, currentPrice);

        console.log(`🔍 [LOWCAP_MONITOR] ${symbol}: Pullback ${pullbackSignal.pullbackPercent.toFixed(2)}%, Confidence ${pullbackSignal.confidence}%, At Support: ${pullbackSignal.isAtSupport}, Status ${trackingData.status}`);

        if (pullbackSignal.hasPullback && !pullbackSignal.isAtSupport && trackingData.status === 'TRACKING') {
          console.log(`🎯 [LOWCAP_PULLBACK] ${symbol} | Pullback: ${pullbackSignal.pullbackPercent.toFixed(2)}% | Confidence: ${pullbackSignal.confidence}% | Not at bottom ✅`);
          
          trackingData.status = 'READY_TO_ENTER';
          trackingData.pullbackLevel = pullbackSignal.pullbackPercent;
        }

        if (trackingData.status === 'READY_TO_ENTER' && pullbackSignal.confidence >= 70 && !pullbackSignal.isAtSupport) {
          console.log(`🚀 [LOWCAP_ENTERING] ${symbol} | Bắt đầu vào lệnh ở vùng kháng cự...`);
          await this.enterLowCapPosition(symbol, trackingData);
          trackingData.status = 'ENTERED';
        }

        const trackingTime = Date.now() - trackingData.addedAt;
        if (trackingTime > 3600000) {
          this.lowCapTrackingCoins.delete(symbol);
          console.log(`⏰ [LOWCAP_EXPIRED] ${symbol} - Đã theo dõi quá 1 giờ`);
        }

      } catch (error) {
        console.error(`❌ [LOWCAP_TRACKING_ERROR] Lỗi khi theo dõi ${symbol}:`, error);
      }
    }
  }

  async enterLowCapPosition(symbol: string, trackingData: LowCapTrackingData): Promise<void> {
    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0) return;

      // KIỂM TRA LẠI ĐIỀU KIỆN TRƯỚC KHI VÀO LỆNH
      const indicators = await this.calculateLowCapIndicators(symbol);
      const pullbackSignal = this.detectPullbackSignal(symbol, indicators.candles, currentPrice);
      
      // CHỈ VÀO LỆNH NẾU VẪN THỎA MÃN ĐIỀU KIỆN VÀ KHÔNG Ở ĐÁY
      if (!pullbackSignal.hasPullback || pullbackSignal.isAtSupport) {
        console.log(`⏹️ [LOWCAP_SKIP] ${symbol} | Điều kiện đã thay đổi - không vào lệnh`);
        this.lowCapTrackingCoins.delete(symbol);
        return;
      }

      const positionSize = await this.calculatePositionSize(
        symbol, 
        STRATEGY_CONFIG.lowCapStrategy.positionSizePercent,
        trackingData.confidence
      );

      if (positionSize <= 0) return;

      // SỬ DỤNG KHÁNG CỤ ĐỂ ĐẶT SL/TP
      const stopLoss = trackingData.resistanceLevel * 1.03; // SL trên kháng cự
      const takeProfit = trackingData.supportLevel * 0.9;   // TP dưới hỗ trợ

      const riskReward = this.calculateRiskRewardRatio(currentPrice, stopLoss, takeProfit);

      console.log(`🚀 [LOWCAP_ENTERING] ${symbol} | Price: $${currentPrice.toFixed(6)}`);
      console.log(`   🛡️  Resistance: $${trackingData.resistanceLevel.toFixed(6)}`);
      console.log(`   📍 Support: $${trackingData.supportLevel.toFixed(6)}`);
      console.log(`   🛑 SL: $${stopLoss.toFixed(6)} | ✅ TP: $${takeProfit.toFixed(6)} | R/R: ${riskReward.ratio.toFixed(2)}`);
      console.log(`   ⚠️  Vào lệnh ở vùng kháng cự - TRÁNH ĐÁY`);

      const openResult = await this.openPosition(symbol, positionSize, 'SHORT', `LOW_CAP_RESISTANCE`);

      if (openResult.success) {
        const takeProfitLevels: TakeProfitLevel[] = [
          {
            priceChangePercent: ((currentPrice - takeProfit) / currentPrice) * 100,
            closeRatio: 1.0,
            executed: false,
            quantity: positionSize,
            absolutePrice: takeProfit
          }
        ];

        const stopLossLevels: StopLossLevel[] = [
          {
            priceChangePercent: ((stopLoss - currentPrice) / currentPrice) * 100,
            closeRatio: 1.0,
            executed: false,
            quantity: positionSize,
            absolutePrice: stopLoss
          }
        ];

        const position: PositionData = {
          symbol,
          entryPrice: currentPrice,
          positionSize,
          takeProfitLevels,
          stopLossLevels,
          dcaLevels: [],
          positiveDcaLevels: [],
          timestamp: Date.now(),
          initialQty: positionSize,
          closedAmount: 0,
          dcaCount: 0,
          side: 'SHORT',
          averagePrice: currentPrice,
          totalQty: positionSize,
          signalType: `LOW_CAP_RESISTANCE`,
          positionId: openResult.positionId || this.orderManager.generatePositionId(),
          realPositionId: openResult.realPositionId,
          checkCount: 0,
          pendingDcaOrders: new Map(),
          sltpRecalculated: false,
          originalTakeProfitLevels: JSON.parse(JSON.stringify(takeProfitLevels)),
          originalStopLossLevels: JSON.parse(JSON.stringify(stopLossLevels)),
          consecutiveDcaCount: 0,
          aggressiveDcaMode: false,
          totalDcaVolume: 0,
          maxDcaVolume: positionSize * 4,
          confidence: trackingData.confidence,
          positiveDcaCount: 0,
          extendedTpLevels: [],
          currentTpLevels: takeProfitLevels.map(tp => tp.priceChangePercent),
          currentSlLevels: stopLossLevels.map(sl => sl.priceChangePercent),
          riskLevel: riskReward.ratio >= 2 ? 'LOW' : 'MEDIUM',
          dcaDisabled: false,
          totalDcaPercent: 0,
          trendStrength: trackingData.trendStrength,
          lastDcaPrice: currentPrice,
          lastNegativeDcaPrice: currentPrice,
          lastPositiveDcaPrice: currentPrice,
          lastNegativeDcaTime: Date.now(),
          lastPositiveDcaTime: Date.now(),
          consecutiveNegativeDcaCount: 0,
          consecutivePositiveDcaCount: 0
        };

        this.positions.set(symbol, position);
        this.lowCapTrackingCoins.delete(symbol);

        console.log(`✅ [LOWCAP_POSITION_OPENED] ${symbol} | Size: ${positionSize} | R/R: ${riskReward.ratio.toFixed(2)} | Entry at resistance ✅`);

      }

    } catch (error) {
      console.error(`❌ [LOWCAP_ENTRY_ERROR] Lỗi khi vào lệnh ${symbol}:`, error);
    }
  }

  async scanForPumpSignals(): Promise<void> {
    const now = Date.now();
    
    if (now - this.lastScanTime < 10000) {
      return;
    }

    this.lastScanTime = now;
    const symbols = await this.getAllFuturePairs();
    
    const symbolsToProcess = symbols.filter(symbol => 
      !this.positions.has(symbol) && 
      !this.pumpTrackingCoins.has(symbol) &&
      !this.trackingCoins.has(symbol)
    );

    if (symbolsToProcess.length === 0) {
      return;
    }

    await this.processInParallel(
      symbolsToProcess,
      async (symbol): Promise<void> => {
        try {
          const isOldEnough = await this.isCoinListedAtLeast14Days(symbol);
          if (!isOldEnough) {
            return;
          }

          const candles = await this.fetch1MinKlineData(symbol, 50);
          if (candles.length < 10) return;

          const currentPrice = await this.getCurrentPrice(symbol);
          if (currentPrice <= 0) return;

          const volume24h = this.calculateRealVolume24h(candles);

          if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
            return;
          }

          await this.handlePumpTracking(symbol, candles, currentPrice);

        } catch (error) {
        }
      }
    );
  }

  async scanAndSelectTopCoins(): Promise<void> {
    const now = Date.now();
    
    if (now - this.lastScanTime < 20000) {
      return;
    }

    this.lastScanTime = now;
    const symbols = await this.getAllFuturePairs();
    
    const symbolsToProcess = symbols.filter(symbol => 
      !this.positions.has(symbol) && !this.trackingCoins.has(symbol)
    );

    if (symbolsToProcess.length === 0) {
      return;
    }

    const candidateList = await this.processInParallel(
      symbolsToProcess,
      async (symbol): Promise<{ symbol: string; coinData: CoinTrackingData } | null> => {
        try {
          const isOldEnough = await this.isCoinListedAtLeast14Days(symbol);
          if (!isOldEnough) {
            return null;
          }

          const indicators = await this.calculateEnhancedIndicators(symbol);
          
          const meetsPumpVolume = indicators.volume24h >= STRATEGY_CONFIG.minVolume24h && indicators.volume24h <= STRATEGY_CONFIG.maxVolume24h;

          const hasReversal = indicators.reversalSignal && indicators.confidence >= 50;

          const validForPump = meetsPumpVolume && hasReversal;

          if (!validForPump) {
            return null;
          }

          const currentPrice = await this.getCurrentPrice(symbol);
          
          const coinData: CoinTrackingData = {
            symbol,
            currentPrice,
            dailyVolatility: indicators.dailyVolatility,
            volume24h: indicators.volume24h,
            timestamp: now,
            status: 'TRACKING',
            volumeSpike: indicators.volumeSpike,
            strengthScore: indicators.strengthScore,
            resistanceLevel: indicators.resistanceLevel,
            supportLevel: indicators.supportLevel,
            marketMomentum: indicators.marketMomentum,
            ema: indicators.ema,
            atr: indicators.atr,
            priceHistory: indicators.candles.slice(-10).map(c => c.close),
            volumeHistory: indicators.candles.slice(-10).map(c => c.volume),
            hasEntrySignal: indicators.hasEntrySignal,
            signalType: indicators.signalType,
            entrySide: 'SHORT',
            fakePumpSignal: indicators.fakePumpSignal,
            pumpPercent: indicators.pumpPercent,
            hasVolumeConfirmation: indicators.hasVolumeConfirmation,
            reversalSignal: indicators.reversalSignal,
            reversalType: indicators.reversalType,
            reversalReasons: indicators.reversalReasons,
            pumpHigh: indicators.pumpHigh,
            retraceFromHigh: indicators.retraceFromHigh,
            listingAgeDays: indicators.listingAgeDays,
            peakPrice: indicators.peakPrice,
            dropFromPeak: indicators.dropFromPeak,
            volumeRatio: indicators.volumeRatio,
            hasBearishPattern: indicators.hasBearishPattern,
            bearishPatterns: indicators.bearishPatterns,
            ma5: indicators.ma5,
            ma10: indicators.ma10,
            priceUnderMA: indicators.priceUnderMA,
            consecutiveBearish: indicators.consecutiveBearish,
            confidence: indicators.confidence,
            riskLevel: indicators.riskLevel,
            pumpDurationCandles: indicators.pumpDurationCandles,
            requiredRetracePercent: indicators.requiredRetracePercent
          };

          return { symbol, coinData };
        } catch (error) {
          return null;
        }
      }
    );

    candidateList.sort((a, b) => b.coinData.confidence - a.coinData.confidence);
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
      .sort(([,a], [,b]) => b.confidence - a.confidence);

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

        const indicators = await this.calculateEnhancedIndicators(symbol);
        
        if (!indicators.reversalSignal || indicators.confidence < 50) {
          this.trackingCoins.delete(symbol);
          continue;
        }

        if (indicators.volume24h > STRATEGY_CONFIG.maxVolume24h) {
          this.trackingCoins.delete(symbol);
          continue;
        }

        const listingAgeDays = await this.getListingAgeDays(symbol);
        if (listingAgeDays < 14) {
          this.trackingCoins.delete(symbol);
          continue;
        }

        coinData.dailyVolatility = indicators.dailyVolatility;
        coinData.volume24h = indicators.volume24h;
        coinData.volumeSpike = indicators.volumeSpike;
        coinData.marketMomentum = indicators.marketMomentum;
        coinData.ema = indicators.ema;
        coinData.resistanceLevel = indicators.resistanceLevel;
        coinData.supportLevel = indicators.supportLevel;
        coinData.hasEntrySignal = indicators.hasEntrySignal;
        coinData.signalType= indicators.signalType;
        coinData.strengthScore = indicators.strengthScore;
        coinData.fakePumpSignal = indicators.fakePumpSignal;
        coinData.pumpPercent = indicators.pumpPercent;
        coinData.hasVolumeConfirmation = indicators.hasVolumeConfirmation;
        coinData.reversalSignal = indicators.reversalSignal;
        coinData.reversalType = indicators.reversalType;
        coinData.reversalReasons = indicators.reversalReasons;
        coinData.pumpHigh = indicators.pumpHigh;
        coinData.retraceFromHigh = indicators.retraceFromHigh;
        coinData.listingAgeDays = indicators.listingAgeDays;
        coinData.peakPrice = indicators.peakPrice;
        coinData.dropFromPeak = indicators.dropFromPeak;
        coinData.volumeRatio = indicators.volumeRatio;
        coinData.hasBearishPattern = indicators.hasBearishPattern;
        coinData.bearishPatterns = indicators.bearishPatterns;
        coinData.ma5 = indicators.ma5;
        coinData.ma10 = indicators.ma10;
        coinData.priceUnderMA = indicators.priceUnderMA;
        coinData.consecutiveBearish = indicators.consecutiveBearish;
        coinData.confidence = indicators.confidence;
        coinData.riskLevel = indicators.riskLevel;
        coinData.pumpDurationCandles = indicators.pumpDurationCandles;
        coinData.requiredRetracePercent = indicators.requiredRetracePercent;

        if (coinData.hasEntrySignal && coinData.status === 'TRACKING') {
          coinData.status = 'READY_TO_ENTER';
        }

        if (coinData.status === 'READY_TO_ENTER') {
          await this.enterPosition(symbol, coinData.signalType, coinData.confidence, coinData.riskLevel);
          coinData.status = 'ENTERED';
          enteredCount++;
          this.trackingCoins.delete(symbol);
        }

        const timeDiff = Date.now() - coinData.timestamp;
        if (timeDiff > 30 * 60 * 1000 && coinData.status === 'TRACKING') {
          this.trackingCoins.delete(symbol);
        }

      } catch (error) {
      }
    }
  }

  async enterPosition(symbol: string, signalType: string, confidence: number, riskLevel: string): Promise<void> {
    const listingAgeDays = await this.getListingAgeDays(symbol);
    if (listingAgeDays < 14) {
      return;
    }

    if (this.positions.has(symbol)) return;

    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0 || !this.hasMinimumBalance()) return;

      const initialQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent, confidence);

      if (initialQty <= 0) return;

      const openResult = await this.openPosition(symbol, initialQty, 'SHORT', signalType);
      if (!openResult.success) return;

      const actualPrice = await this.getCurrentPrice(symbol);
      
      const takeProfitLevels: TakeProfitLevel[] = STRATEGY_CONFIG.takeProfitLevels.map(level => {
        const absolutePrice = actualPrice * (1 - level.priceChangePercent / 100);
        return { 
          ...level, 
          executed: false,
          quantity: initialQty * level.closeRatio,
          absolutePrice
        };
      });
      
      const stopLossLevels: StopLossLevel[] = this.setupStopLossByRiskLevel(riskLevel, actualPrice, initialQty);

      const dcaLevels: DcaLevel[] = STRATEGY_CONFIG.dcaLevels.map(level => ({ 
        ...level, 
        executed: false,
        condition: level.condition as 'RESISTANCE' | 'EMA_RESISTANCE' | 'FIBONACCI' | 'BASIC' | 'POSITIVE_PULLBACK' | 'MICRO_PULLBACK' | 'RESISTANCE_TOUCH' | 'STRONG_RESISTANCE'
      }));

      const positiveDcaLevels: PositiveDcaLevel[] = STRATEGY_CONFIG.positiveDcaLevels.map(level => ({
        ...level,
        executed: false
      }));

      const maxDcaVolume = await this.calculatePositionSize(symbol, 0.4, confidence); // 40% cho DCA

      const position: PositionData = {
        symbol,
        entryPrice: actualPrice,
        positionSize: initialQty,
        takeProfitLevels,
        stopLossLevels,
        dcaLevels,
        positiveDcaLevels,
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
        trailingStopLoss: STRATEGY_CONFIG.trailingStopLoss.enabled ? {
          enabled: true,
          activationPrice: 0,
          currentStopPrice: 0,
          highestProfit: 0,
          activated: false,
          peakProfitReached: false
        } : undefined,
        pendingDcaOrders: new Map(),
        sltpRecalculated: false,
        originalTakeProfitLevels: JSON.parse(JSON.stringify(takeProfitLevels)),
        originalStopLossLevels: JSON.parse(JSON.stringify(stopLossLevels)),
        consecutiveDcaCount: 0,
        aggressiveDcaMode: false,
        totalDcaVolume: 0,
        maxDcaVolume,
        confidence,
        peakPrice: actualPrice * 1.05,
        positiveDcaCount: 0,
        extendedTpLevels: [],
        initialStopLossLevels: JSON.parse(JSON.stringify(stopLossLevels)),
        adjustedStopLossLevels: JSON.parse(JSON.stringify(stopLossLevels)),
        peakProfit: 0,
        tpDoubled: false,
        currentTpLevels: takeProfitLevels.map(tp => tp.priceChangePercent),
        currentSlLevels: stopLossLevels.map(sl => sl.priceChangePercent),
        riskLevel: riskLevel,
        dcaDisabled: false,
        totalDcaPercent: 0,
        trendStrength: 0,
        lastDcaPrice: actualPrice,
        lastNegativeDcaPrice: actualPrice,
        lastPositiveDcaPrice: actualPrice,
        lastNegativeDcaTime: Date.now(),
        lastPositiveDcaTime: Date.now(),
        consecutiveNegativeDcaCount: 0,
        consecutivePositiveDcaCount: 0
      };

      this.positions.set(symbol, position);

      console.log(`✅ [POSITION_OPENED] ${symbol} | Size: ${initialQty} | Entry: $${actualPrice.toFixed(6)} | Risk: ${riskLevel}`);

    } catch (error) {
      console.error(`❌ [ENTRY_ERROR] Lỗi khi vào lệnh ${symbol}:`, error);
    }
  }

  async scanDcaOpportunities(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDcaScan < 60000) return;
    
    this.lastDcaScan = now;

    if (this.positions.size === 0) return;

    for (const [symbol, position] of this.positions.entries()) {
      try {
        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;

        await this.checkImmediateDCA(symbol, position, currentPrice);

      } catch (error) {
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
    
    console.log(`\n📊 STATUS: Balance: $${this.accountBalance.toFixed(2)} | Positions: ${this.positions.size} | PnL: $${this.totalProfit.toFixed(2)}`);
    console.log(`   Tracking: Pump: ${this.pumpTrackingCoins.size} | General: ${this.trackingCoins.size} | Low-Cap: ${this.lowCapTrackingCoins.size}`);
    
    if (this.lowCapTrackingCoins.size > 0) {
      console.log(`\n🎯 LOW-CAP TRACKING (${this.lowCapTrackingCoins.size} coins - 5M Analysis):`);
      for (const [symbol, trackData] of this.lowCapTrackingCoins.entries()) {
        console.log(`   ${symbol}: $${trackData.currentPrice.toFixed(6)} | RSI: ${trackData.rsi.toFixed(1)} | R/R: ${trackData.riskRewardRatio.toFixed(2)} | Conf: ${trackData.confidence.toFixed(1)}% | Age: ${trackData.listingAgeDays?.toFixed(1)} days`);
      }
    }
    
    if (this.positions.size > 0) {
      for (const [symbol, position] of this.positions.entries()) {
        const currentPrice = await this.getCurrentPrice(symbol);
        const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
        const status = profitData.profit >= 0 ? 'PROFIT' : 'LOSS';
        const closedPercent = ((position.closedAmount / position.positionSize) * 100).toFixed(1);
        
        let extraInfo = '';
        if (position.dcaCount > 0) {
          extraInfo += ` | DCA:${position.dcaCount}`;
        }
        if (position.positiveDcaCount > 0) {
          extraInfo += ` | +DCA:${position.positiveDcaCount}`;
        }
        if (position.tpDoubled) {
          extraInfo += ` | 2xTP`;
        }
        if (position.dcaDisabled) {
          extraInfo += ` | DCA_STOPPED`;
        }
        
        console.log(`   ${symbol}: ${status} $${profitData.profit.toFixed(2)} (${profitData.priceChangePercent.toFixed(1)}%) | Closed: ${closedPercent}% | Risk: ${position.riskLevel} | ${position.signalType}${extraInfo}`);
      }
    }

    if (this.pumpTrackingCoins.size > 0) {
      console.log(`\n🎯 PUMP TRACKING (${this.pumpTrackingCoins.size} coins):`);
      for (const [symbol, trackData] of this.pumpTrackingCoins.entries()) {
        const currentPrice = await this.getCurrentPrice(symbol);
        const dropFromPeak = ((trackData.peakPrice - currentPrice) / trackData.peakPrice) * 100;
        console.log(`   ${symbol}: Pump +${trackData.initialPumpPct.toFixed(1)}% | Drop: ${dropFromPeak.toFixed(1)}% | Risk: ${trackData.riskLevel}`);
      }
    }
    console.log('');
  }

  async run(): Promise<void> {
    console.log('🚀 FAKE PUMP STRATEGY BOT STARTED');
    console.log('🎯 STRATEGY: Pump 10% + Reversal');
    console.log('📊 VOLUME: < 10M USDT - BẮT BUỘC');
    console.log('💰 POSITION: 10% of account balance');
    console.log('🔄 DCA: 10% each time (both negative and positive)');
    console.log('   📍 Negative DCA: Loss ≥ 1%, 3 min interval, price movement ≥ 0.5%');
    console.log('   📍 Positive DCA: Profit ≥ 0.5%, 3 min interval, price movement ≥ 0.5%');
    console.log('   📍 Max 4 consecutive DCAs, 5 min cooldown');
    console.log('🎯 TP/SL CHIẾN LƯỢC:');
    console.log('   TP: ' + STRATEGY_CONFIG.takeProfitLevels.map(tp => `-${tp.priceChangePercent}% (${tp.closeRatio * 100}%)`).join(', '));
    console.log('   SL: ' + STRATEGY_CONFIG.stopLossLevels.map(sl => `+${sl.priceChangePercent}% (${sl.closeRatio * 100}%)`).join(', '));
    console.log('⚠️  RISK: Cho phép vào lệnh cả RISK HIGH');
    console.log('⏰ CONDITIONS: Coin age > 14 days');
    
    console.log('\n🎯 LOW-CAP STRATEGY ACTIVATED - VÀO LỆNH Ở KHÁNG CỤ');
    console.log('📊 VOLUME: < 15M USDT');
    console.log('💰 POSITION: 10% tài khoản');
    console.log('💰 PRICE RANGE: $0.0001 - $5.0');
    console.log('📉 CONDITIONS: RSI > 65 + Downtrend + Volume Spike 1.5x');
    console.log('⏰ TIMEFRAME: 5 Minute Candles for Analysis');
    console.log('⚡ ENTRY: After resistance bounce (1-10% từ kháng cự)');
    console.log('🎯 RISK/REWARD: Min 1.2:1');
    console.log('⏰ COIN AGE: > 5 days required');
    console.log('🛡️  CHIẾN LƯỢC MỚI: TRÁNH VÀO LỆNH Ở ĐÁY');

    console.log('\n🔍 [LOWCAP_DEBUG] Sẽ hiển thị phân tích chi tiết 1 coin ngẫu nhiên cho Low-Cap mỗi 30 giây\n');
    
    await this.fetchBinanceSymbols();
    
    this.accountBalance = await this.getUSDTBalance();
    this.initialBalance = this.accountBalance;
    
    if (this.accountBalance <= 0) {
      console.error('❌ [BALANCE_ERROR] Cannot get balance');
      return;
    }
    
    console.log(`💰 [BALANCE] Initial Balance: $${this.initialBalance.toFixed(2)}\n`);
    
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
        
        await this.scanForPumpSignals();
        await this.scanForLowCapCoins();
        
        await this.scanAndSelectTopCoins();
        this.updateTrackingList();
        await this.trackTopCoinsRealTime();
        await this.trackLowCapCoinsRealTime();
        await this.managePositions();
        
        await this.scanDcaOpportunities();
        
        await this.displayStatus();

        setImmediate(mainLoop);

      } catch (error) {
        console.error('❌ [MAIN_LOOP_ERROR] Lỗi trong vòng lặp chính:', error);
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
    
    console.log(`\n🛑 Bot stopped | Orders: ${this.totalOrders} | PnL: $${this.totalProfit.toFixed(2)}`);
  }
}

const bot = new FakePumpStrategyBot();

process.on('SIGINT', () => {
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bot.stop();
  process.exit(0);
});

bot.run().catch(console.error);
