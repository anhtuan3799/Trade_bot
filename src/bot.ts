import * as dotenv from "dotenv";
import { MexcFuturesClient } from "mexc-futures-sdk";
import axios from "axios";

dotenv.config();

const WEB_TOKEN = process.env.MEXC_AUTH_TOKEN ?? "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
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
  initialPositionPercent: 0.1, // Đã sửa từ 0.15 xuống 0.1 (10%)
  maxTotalPositionPercent: 0.3, // Giảm từ 0.6 xuống 0.3 để phù hợp với 3 lần DCA
  takeProfitLevels: [
    { priceChangePercent: 3.0, closeRatio: 0.4 },
    { priceChangePercent: 6.0, closeRatio: 0.4 },
    { priceChangePercent: 10.0, closeRatio: 0.2 }
  ],
  stopLossLevels: [
    { priceChangePercent: 2.0, closeRatio: 0.5 },
    { priceChangePercent: 4.0, closeRatio: 0.5 }
  ],
  maxVolume24h: 10000000,
  minVolume24h: 100000,
  fakePumpMinPercent: 15,
  volumeSpikeThreshold: 2.5,
  maxActivePositions: 3,
  maxTrackingCoins: 10,
  minAccountBalancePercent: 0.1, // Giảm từ 0.15 xuống 0.1
  emaPeriod: 21,
  resistanceLookback: 20,
  volumeDropThreshold: 0.6,
  dcaLevels: [ // Giảm từ 4 xuống 3 mức DCA
    { priceChangePercent: 0.8, addRatio: 0.1, condition: 'MICRO_PULLBACK' }, // Giảm addRatio từ 0.15 xuống 0.1
    { priceChangePercent: 1.5, addRatio: 0.1, condition: 'RESISTANCE_TOUCH' },
    { priceChangePercent: 2.5, addRatio: 0.1, condition: 'STRONG_RESISTANCE' }
  ],
  positiveDcaLevels: [ // Giảm từ 4 xuống 3 mức DCA dương
    { profitPercent: 2.0, addRatio: 0.1, extendTpPercent: 2.0 }, // Giảm addRatio từ 0.15 xuống 0.1
    { profitPercent: 4.0, addRatio: 0.1, extendTpPercent: 3.0 },
    { profitPercent: 7.0, addRatio: 0.1, extendTpPercent: 4.0 }
  ],
  maxDcaTimes: 3, // Giảm từ 6 xuống 3
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
    minPumpPercent: 15,
    pumpCandles: 10,
    fastPumpCandles: 5,
    fastPumpRetraceRequired: 5,
    slowPumpRetraceRequired: 3,
    volumeSpikeRatio: 2.5,
    requiredSignals: 1,
    minListingDays: 14
  },
  trackingConfig: {
    pumpThreshold: 15,
    reversalConfirmationPct: -5,
    strongReversalPct: -8,
    volumeSpikeRatio: 2.5,
    maxTrackingTime: 30 * 60 * 1000
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
  riskLevel: string; // Thêm riskLevel vào PositionData
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

  constructor() {
    console.log('🤖 FAKE PUMP STRATEGY BOT - ENHANCED REVERSAL MODE');
    console.log('🎯 ENTRY: Pump 15% + Reversal từ đỉnh');
    console.log('📊 VOLUME: < 10M USDT - BẮT BUỘC');
    console.log('💰 VÀO LỆNH: 10% so với tổng tài sản ban đầu'); // Đã cập nhật từ 15% xuống 10%
    console.log('🔄 DCA: Tối đa 3 lần (cả âm và dương)'); // Đã cập nhật
    console.log('🎯 TP/SL CHIẾN LƯỢC:');
    console.log('   TP: ' + STRATEGY_CONFIG.takeProfitLevels.map(tp => `-${tp.priceChangePercent}% (${tp.closeRatio * 100}%)`).join(', '));
    console.log('   SL: Tùy theo Risk Level');
    console.log('⏰ ĐIỀU KIỆN: Coin trên 14 ngày & Risk Level không phải HIGH');
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
      // MEDIUM: Stop Loss duy nhất ở 4%
      return [
        {
          priceChangePercent: 4.0,
          closeRatio: 1.0, // Đóng toàn bộ
          executed: false,
          quantity: initialQty,
          absolutePrice: actualPrice * (1 + 4.0 / 100)
        }
      ];
    } else if (riskLevel === 'LOW') {
      // LOW: 2 mức stop loss: 7% (50%) và 10% (50%)
      return [
        {
          priceChangePercent: 7.0,
          closeRatio: 0.5, // 50% lệnh
          executed: false,
          quantity: initialQty * 0.5,
          absolutePrice: actualPrice * (1 + 7.0 / 100)
        },
        {
          priceChangePercent: 10.0,
          closeRatio: 0.5, // 50% lệnh còn lại
          executed: false,
          quantity: initialQty * 0.5,
          absolutePrice: actualPrice * (1 + 10.0 / 100)
        }
      ];
    } else {
      // HIGH hoặc mặc định: sử dụng stop loss từ config
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

  private async sendTPSLUpdateAlert(position: PositionData): Promise<void> {
    try {
      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

      const message = 
        `🔄 **CẬP NHẬT TP/SL**: ${position.symbol}\n` +
        `💰 Giá trung bình: $${position.averagePrice.toFixed(6)}\n` +
        `📊 Khối lượng: ${position.totalQty.toFixed(2)} contracts\n` +
        `🔄 Số lần DCA: ${position.dcaCount}\n` +
        `🎯 Risk Level: ${position.riskLevel}\n\n` +
        `🎯 **TAKE PROFIT**:\n` +
        position.takeProfitLevels.map((level, i) => 
          `• TP${i+1}: ${level.priceChangePercent.toFixed(1)}% ($${level.absolutePrice?.toFixed(6)}) - ${(level.closeRatio * 100).toFixed(0)}%`
        ).join('\n') + '\n\n' +
        `🛡️ **STOP LOSS**:\n` +
        position.stopLossLevels.map((level, i) => 
          `• SL${i+1}: ${level.priceChangePercent.toFixed(1)}% ($${level.absolutePrice?.toFixed(6)}) - ${(level.closeRatio * 100).toFixed(0)}%`
        ).join('\n');

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      });
      
    } catch (error) {
      console.error('Lỗi gửi thông báo TP/SL:', error);
    }
  }

  private async sendEntryAlert(position: PositionData, currentPrice: number): Promise<void> {
    try {
      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

      const tp1Price = currentPrice * (1 - STRATEGY_CONFIG.takeProfitLevels[0].priceChangePercent / 100);
      const tp2Price = currentPrice * (1 - STRATEGY_CONFIG.takeProfitLevels[1].priceChangePercent / 100);
      const tp3Price = currentPrice * (1 - STRATEGY_CONFIG.takeProfitLevels[2].priceChangePercent / 100);
      
      const slText = position.riskLevel === 'MEDIUM' 
        ? `• SL: +4.0% ($${(currentPrice * 1.04).toFixed(6)}) - 100%`
        : position.riskLevel === 'LOW'
        ? `• SL1: +7.0% ($${(currentPrice * 1.07).toFixed(6)}) - 50%\n• SL2: +10.0% ($${(currentPrice * 1.10).toFixed(6)}) - 50%`
        : `• SL1: +${STRATEGY_CONFIG.stopLossLevels[0].priceChangePercent}% ($${(currentPrice * (1 + STRATEGY_CONFIG.stopLossLevels[0].priceChangePercent / 100)).toFixed(6)}) - ${(STRATEGY_CONFIG.stopLossLevels[0].closeRatio * 100).toFixed(0)}%\n• SL2: +${STRATEGY_CONFIG.stopLossLevels[1].priceChangePercent}% ($${(currentPrice * (1 + STRATEGY_CONFIG.stopLossLevels[1].priceChangePercent / 100)).toFixed(6)}) - ${(STRATEGY_CONFIG.stopLossLevels[1].closeRatio * 100).toFixed(0)}%`;

      const message = 
        `🎯 **VÀO LỆNH SHORT**: ${position.symbol}\n` +
        `💰 Entry: $${currentPrice.toFixed(6)}\n` +
        `📊 Khối lượng: ${position.totalQty.toFixed(2)} contracts\n` +
        `🎯 Signal: ${position.signalType}\n` +
        `📈 Confidence: ${position.confidence}%\n` +
        `⚠️ Risk Level: ${position.riskLevel}\n\n` +
        `🎯 **CHIẾN LƯỢC TP/SL**:\n` +
        `• TP1: -${STRATEGY_CONFIG.takeProfitLevels[0].priceChangePercent}% ($${tp1Price.toFixed(6)}) - ${(STRATEGY_CONFIG.takeProfitLevels[0].closeRatio * 100).toFixed(0)}%\n` +
        `• TP2: -${STRATEGY_CONFIG.takeProfitLevels[1].priceChangePercent}% ($${tp2Price.toFixed(6)}) - ${(STRATEGY_CONFIG.takeProfitLevels[1].closeRatio * 100).toFixed(0)}%\n` +
        `• TP3: -${STRATEGY_CONFIG.takeProfitLevels[2].priceChangePercent}% ($${tp3Price.toFixed(6)}) - ${(STRATEGY_CONFIG.takeProfitLevels[2].closeRatio * 100).toFixed(0)}%\n` +
        `${slText}`;

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      });
      
    } catch (error) {
      console.error('Lỗi gửi thông báo vào lệnh:', error);
    }
  }

  private async handlePumpTracking(symbol: string, candles: SimpleCandle[], currentPrice: number): Promise<boolean> {
    const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
    
    if (reversalSignal.shouldTrack && !reversalSignal.isTracked) {
      const listingAgeDays = await this.getListingAgeDays(symbol);
      
      const volume24h = this.calculateRealVolume24h(candles);
      if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
        console.log(`⚠️ Bỏ qua ${symbol} do volume 24h quá cao: ${(volume24h / 1000000).toFixed(2)}M`);
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
        riskLevel: 'MEDIUM',
        listingAgeDays
      });

      const binanceSymbol = symbol.replace('_USDT', 'USDT');
      const isMexcExclusive = !this.binanceSymbolsCache.has(binanceSymbol);
      
      console.log(`🎯 Tracking: ${symbol} (Pump +${reversalSignal.initialPumpPct.toFixed(2)}%, Volume: ${(volume24h / 1000000).toFixed(2)}M)`);
      return true;
    }

    if (reversalSignal.isTracked && reversalSignal.hasReversal) {
      const trackData = this.pumpTrackingCoins.get(symbol)!;
      
      if (reversalSignal.riskLevel === 'HIGH') {
        console.log(`⚠️ Bỏ qua ${symbol} do risk level HIGH`);
        return false;
      }

      const volume24h = this.calculateRealVolume24h(candles);
      if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
        console.log(`⚠️ Bỏ qua ${symbol} do volume 24h quá cao: ${(volume24h / 1000000).toFixed(2)}M`);
        this.pumpTrackingCoins.delete(symbol);
        return false;
      }

      const listingAgeDays = await this.getListingAgeDays(symbol);
      if (listingAgeDays < 14) {
        console.log(`⚠️ Bỏ qua ${symbol} do coin mới (${listingAgeDays.toFixed(1)} ngày)`);
        this.pumpTrackingCoins.delete(symbol);
        return false;
      }

      if (!trackData.notifiedReversal) {
        const binanceSymbol = symbol.replace('_USDT', 'USDT');
        const isMexcExclusive = !this.binanceSymbolsCache.has(binanceSymbol);
        
        const patterns_text = [];
        if (reversalSignal.bearishPatterns.includes('Shooting Star')) patterns_text.push('Shooting Star');
        if (reversalSignal.bearishPatterns.includes('Bearish Engulfing')) patterns_text.push('Bearish Engulfing');
        if (reversalSignal.bearishPatterns.includes('Evening Star')) patterns_text.push('Evening Star');        
        trackData.notifiedReversal = true;
        trackData.riskLevel = reversalSignal.riskLevel;
        
        console.log(`🔔 SHORT SIGNAL: ${symbol} (Giảm ${reversalSignal.dropFromPeak.toFixed(2)}%, Confidence: ${reversalSignal.confidence}%, Volume: ${(volume24h / 1000000).toFixed(2)}M)`);
        
        return true;
      }
    }

    if (reversalSignal.isTracked) {
      const trackData = this.pumpTrackingCoins.get(symbol)!;
      const trackingDuration = Date.now() - trackData.addedAt;
      if (trackingDuration > STRATEGY_CONFIG.trackingConfig.maxTrackingTime || reversalSignal.dropFromPeak > 30) {
        this.pumpTrackingCoins.delete(symbol);
        console.log(`✅ Dừng tracking: ${symbol}`);
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
      const tempSymbol = 'TEMP_SYMBOL';
      const reversalSignal = this.detectPumpAlertReversalSignal(tempSymbol, candles, currentPrice);
      
      if (reversalSignal.hasReversal && reversalSignal.confidence >= 50 && reversalSignal.riskLevel !== 'HIGH') {
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

  async fetch1MinKlineData(symbol: string, limit = 20): Promise<SimpleCandle[]> {
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
      const candles = await this.fetch1MinKlineData(symbol, 20);
      if (candles.length < 15) {
        return this.getDefaultEnhancedIndicatorResult();
      }

      const currentPrice = await this.getCurrentPrice(symbol);

      const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
      
      const fakePumpDetection = this.detectFakePump(candles);
      const pumpHigh = fakePumpDetection.pumpHigh;
      const retraceFromHigh = reversalSignal.dropFromPeak;

      const listingAgeDays = await this.getListingAgeDays(symbol);

      const dailyVolatility = this.calculateDailyVolatility(candles);
      const volume24h = this.calculateRealVolume24h(candles);
      
      const hasVolumeConfirmation = volume24h >= STRATEGY_CONFIG.minVolume24h && volume24h <= STRATEGY_CONFIG.maxVolume24h;
      
      const volumes = candles.map(k => k.volume);
      const volumeSpike = this.calculateVolumeSpike(volumes);
      const ema = this.calculateEMA(candles, STRATEGY_CONFIG.emaPeriod);
      const marketMomentum = this.calculateMarketMomentum(candles);
      const atr = this.calculateATR(candles);
      const resistanceLevel = this.findResistanceLevel(candles, STRATEGY_CONFIG.resistanceLookback);
      const supportLevel = this.findSupportLevel(candles, STRATEGY_CONFIG.resistanceLookback);

      const entrySignal = this.detectEntrySignal(candles, currentPrice, volume24h);

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
      
      let adjustedPercent = percent;
      if (confidence >= 80) {
        adjustedPercent = percent * 1.2;
      } else if (confidence <= 50) {
        adjustedPercent = percent * 0.7;
      }
      
      const capital = this.initialBalance * adjustedPercent;
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

  private recalculateTPSLAfterDCA(position: PositionData, currentPrice: number): void {
    const { tpLevels, slLevels } = this.calculateSmartTPSLAfterDCA(position, currentPrice);
    
    position.takeProfitLevels = tpLevels;
    position.stopLossLevels = slLevels;
    
    position.currentTpLevels = tpLevels.map(tp => tp.priceChangePercent);
    position.currentSlLevels = slLevels.map(sl => sl.priceChangePercent);
    
    position.sltpRecalculated = true;
    
    console.log(`🔄 TP/SL Updated for ${position.symbol}: DCA ${position.dcaCount}`);
    console.log(`   TP Levels: ${position.currentTpLevels.map(tp => tp.toFixed(1) + '%').join(', ')}`);
    console.log(`   SL Levels: ${position.currentSlLevels.map(sl => sl.toFixed(1) + '%').join(', ')}`);
  }

  private doubleTakeProfitLevels(position: PositionData): void {
    if (position.tpDoubled) return;

    console.log(`🎯🔥 DOUBLE TP ACTIVATED: ${position.symbol} - Strong downtrend detected!`);

    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      if (!position.takeProfitLevels[i].executed) {
        position.takeProfitLevels[i].priceChangePercent *= 2;
        if (position.takeProfitLevels[i].absolutePrice) {
          position.takeProfitLevels[i].absolutePrice = position.averagePrice * 
            (1 - position.takeProfitLevels[i].priceChangePercent / 100);
        }
        console.log(`   TP${i+1}: ${position.takeProfitLevels[i].priceChangePercent/2}% -> ${position.takeProfitLevels[i].priceChangePercent}%`);
      }
    }

    position.tpDoubled = true;
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

      console.log(`🎯 ENTRY: ${symbol} | ${openQty} contracts | ${currentPrice} | SHORT | ${signalType}`);

      const orderResponse = await client.submitOrder({
        symbol: formattedSymbol,
        price: currentPrice,
        vol: openQty,
        side: orderSide,
        type: 1,
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
            // Bỏ qua lỗi
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
          // Bỏ qua lỗi
        }
      }

      const positionId = this.orderManager.generatePositionId();
      
      this.totalOrders++;
      
      this.startRealTimeMonitoring(symbol, positionId);
      
      return {success: true, positionId, realPositionId};

    } catch (err: any) {
      console.error(`❌ OPEN ERROR: ${symbol}`, err.message);
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

      console.log(`🔔 CLOSE: ${symbol} | ${closeQty} contracts | ${reason}`);

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
        console.log(`✅ CLOSED: ${symbol} | ${reason}`);
        
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
      console.error(`❌ CLOSE ERROR: ${symbol}`, err.message);
      
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
      // Bỏ qua lỗi
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
      // Bỏ qua lỗi
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
        await this.checkPositiveDCA(symbol, position, currentPrice);
        await this.checkTrailingStopLoss(symbol, position, currentPrice);

      } catch (error) {
        // Bỏ qua lỗi
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
    if (position.positiveDcaCount >= STRATEGY_CONFIG.positiveDcaLevels.length) return;

    try {
      const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
      
      if (profitData.priceChangePercent >= 0) return;

      for (let i = 0; i < position.positiveDcaLevels.length; i++) {
        const level = position.positiveDcaLevels[i];
        
        if (!level.executed) {
          const shouldExecute = Math.abs(profitData.priceChangePercent) >= level.profitPercent;

          if (shouldExecute) {
            const positiveDcaQty = await this.calculatePositionSize(
              symbol, 
              STRATEGY_CONFIG.initialPositionPercent * level.addRatio,
              position.confidence || 50
            );
            
            if (positiveDcaQty > 0) {
              const dcaOrderId = `positive_dca_${symbol}_${level.profitPercent}_${Date.now()}`;
              this.pendingDcaOrders.set(dcaOrderId, {
                symbol,
                level: i,
                quantity: positiveDcaQty,
                timestamp: Date.now()
              });
              
              const success = await this.addToPosition(symbol, positiveDcaQty, 'SHORT', `POSITIVE_DCA_${level.profitPercent}%`);
              
              if (success) {
                const newTotalQty = position.totalQty + positiveDcaQty;
                position.averagePrice = (position.averagePrice * position.totalQty + currentPrice * positiveDcaQty) / newTotalQty;
                position.totalQty = newTotalQty;
                position.positionSize = newTotalQty;
                
                position.positiveDcaCount++;
                level.executed = true;
                position.lastPositiveDcaTime = Date.now();
                position.totalDcaVolume += positiveDcaQty;

                this.recalculateTPSLAfterDCA(position, currentPrice);
                
                if (position.trailingStopLoss) {
                  position.trailingStopLoss.activated = false;
                  position.trailingStopLoss.activationPrice = 0;
                  position.trailingStopLoss.currentStopPrice = 0;
                  position.trailingStopLoss.highestProfit = 0;
                  position.trailingStopLoss.peakProfitReached = false;
                }
                
                console.log(`🚀 POSITIVE DCA: ${symbol} | +${positiveDcaQty} contracts | Profit: ${Math.abs(profitData.priceChangePercent).toFixed(2)}%`);

                await this.sendTPSLUpdateAlert(position);

                this.pendingDcaOrders.delete(dcaOrderId);
                break;
              } else {
                this.pendingDcaOrders.delete(dcaOrderId);
              }
            }
          }
        }
      }
    } catch (error) {
      // Bỏ qua lỗi
    }
  }

  private extendTakeProfitLevels(position: PositionData, extendPercent: number): void {
    if (extendPercent > 0) {
      console.log(`🎯 TP Extended: ${position.symbol} | +${extendPercent}%`);
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
    if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes) return;

    try {
      const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);

      for (let i = 0; i < position.dcaLevels.length; i++) {
        const level = position.dcaLevels[i];
        
        if (!level.executed) {
          const shouldExecute = priceChange >= level.priceChangePercent;

          if (shouldExecute) {
            const dcaQty = await this.calculatePositionSize(
              symbol, 
              STRATEGY_CONFIG.initialPositionPercent * level.addRatio,
              position.confidence || 50
            );
            
            if (dcaQty > 0) {
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
                position.lastDcaTime = Date.now();
                position.totalDcaVolume += dcaQty;

                this.recalculateTPSLAfterDCA(position, currentPrice);
                
                if (position.trailingStopLoss) {
                  position.trailingStopLoss.activated = false;
                  position.trailingStopLoss.activationPrice = 0;
                  position.trailingStopLoss.currentStopPrice = 0;
                  position.trailingStopLoss.highestProfit = 0;
                  position.trailingStopLoss.peakProfitReached = false;
                }
                
                console.log(`💰 DCA: ${symbol} | +${dcaQty} contracts | DCA Count: ${position.dcaCount}`);

                await this.sendTPSLUpdateAlert(position);

                this.pendingDcaOrders.delete(dcaOrderId);
                break;
              } else {
                this.pendingDcaOrders.delete(dcaOrderId);
              }
            }
          }
        }
      }
    } catch (error) {
      // Bỏ qua lỗi
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
        console.log(`🛡️ TRAILING SL: ${symbol} | Activated at ${Math.abs(profitData.priceChangePercent).toFixed(2)}% profit`);
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
          console.log(`🛑 TRAILING SL: ${symbol} | Triggered at ${currentPrice}`);
          
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
            console.log(`🎯 TP${i+1}: ${symbol} | ${level.priceChangePercent}% target hit`);
            
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
            console.log(`🛑 SL${i+1}: ${symbol} | ${level.priceChangePercent}% stop hit`);
            
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
    
    if (result.success && positionId && position) {
      // Giảm log chi tiết
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

          const candles = await this.fetch1MinKlineData(symbol, 20);
          if (candles.length < 10) return;

          const currentPrice = await this.getCurrentPrice(symbol);
          if (currentPrice <= 0) return;

          await this.handlePumpTracking(symbol, candles, currentPrice);

        } catch (error) {
          // Bỏ qua lỗi
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
          
          const meetsVolume = indicators.volume24h >= STRATEGY_CONFIG.minVolume24h && indicators.volume24h <= STRATEGY_CONFIG.maxVolume24h;
          const hasReversal = indicators.reversalSignal && indicators.confidence >= 50;
          const isNotHighRisk = indicators.riskLevel !== 'HIGH';

          if (!meetsVolume || !hasReversal || !isNotHighRisk) {
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

    if (candidateList.length > 0) {
      console.log(`✅ Found ${candidateList.length} potential coins (Volume < 10M)`);
    }
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
      console.log(`📊 Tracking: ${symbol} | Pump: ${coinData.pumpPercent.toFixed(1)}% | Confidence: ${coinData.confidence}% | Volume: ${(coinData.volume24h / 1000000).toFixed(2)}M`);
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
        
        if (!indicators.reversalSignal || indicators.confidence < 50 || indicators.riskLevel === 'HIGH') {
          this.trackingCoins.delete(symbol);
          continue;
        }

        if (indicators.volume24h > STRATEGY_CONFIG.maxVolume24h) {
          console.log(`⚠️ Bỏ qua ${symbol} do volume 24h quá cao: ${(indicators.volume24h / 1000000).toFixed(2)}M`);
          this.trackingCoins.delete(symbol);
          continue;
        }

        const listingAgeDays = await this.getListingAgeDays(symbol);
        if (listingAgeDays < 14) {
          console.log(`⚠️ Bỏ qua ${symbol} do coin mới (${listingAgeDays.toFixed(1)} ngày)`);
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
          console.log(`🎯 SIGNAL: ${symbol} | ${coinData.signalType} | Confidence: ${coinData.confidence}% | Volume: ${(coinData.volume24h / 1000000).toFixed(2)}M`);
          
          coinData.status = 'READY_TO_ENTER';
        }

        if (coinData.status === 'READY_TO_ENTER') {
          console.log(`🚀 ENTERING: ${symbol} | ${coinData.signalType}`);
          
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
        // Bỏ qua lỗi
      }
    }
  }

  async enterPosition(symbol: string, signalType: string, confidence: number, riskLevel: string): Promise<void> {
    if (riskLevel === 'HIGH') {
      console.log(`⚠️ Bỏ qua vào lệnh ${symbol} do risk level HIGH`);
      return;
    }

    const listingAgeDays = await this.getListingAgeDays(symbol);
    if (listingAgeDays < 14) {
      console.log(`⚠️ Bỏ qua vào lệnh ${symbol} do coin mới (${listingAgeDays.toFixed(1)} ngày)`);
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

      const maxDcaVolume = await this.calculatePositionSize(symbol, 0.3, confidence);

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
        riskLevel: riskLevel // Thêm riskLevel vào position
      };

      this.positions.set(symbol, position);

      await this.sendEntryAlert(position, actualPrice);

    } catch (error) {
      console.error(`❌ ENTRY ERROR: ${symbol}`, error);
    }
  }

  async scanDcaOpportunities(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDcaScan < 60000) return;
    
    this.lastDcaScan = now;

    if (this.positions.size === 0) return;

    for (const [symbol, position] of this.positions.entries()) {
      try {
        if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes) continue;

        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;

        await this.checkImmediateDCA(symbol, position, currentPrice);

      } catch (error) {
        // Bỏ qua lỗi
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
        // Bỏ qua lỗi
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
    
    console.log(`\n📊 STATUS: Balance: $${this.accountBalance.toFixed(2)} | Positions: ${this.positions.size} | PnL: $${this.totalProfit.toFixed(2)} | Tracking: ${this.pumpTrackingCoins.size}`);
    
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
        
        console.log(`   ${symbol}: ${status} $${profitData.profit.toFixed(2)} (${profitData.priceChangePercent.toFixed(1)}%) | Closed: ${closedPercent}% | Risk: ${position.riskLevel}${extraInfo}`);
        
        if (position.currentTpLevels && position.currentSlLevels) {
          console.log(`     TP: ${position.currentTpLevels.map(tp => tp.toFixed(1) + '%').join(', ')}`);
          console.log(`     SL: ${position.currentSlLevels.map(sl => sl.toFixed(1) + '%').join(', ')}`);
        }
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
    console.log('🎯 ENTRY: Pump 15% + Reversal');
    console.log('📊 VOLUME: < 10M USDT - BẮT BUỘC');
    console.log('💰 POSITION: 10% of initial balance'); // Đã cập nhật từ 15% xuống 10%
    console.log('🔄 DCA: Tối đa 3 lần (cả âm và dương)'); // Đã cập nhật
    console.log('🎯 TP/SL CHIẾN LƯỢC:');
    console.log('   TP: ' + STRATEGY_CONFIG.takeProfitLevels.map(tp => `-${tp.priceChangePercent}% (${tp.closeRatio * 100}%)`).join(', '));
    console.log('   SL: Tùy theo Risk Level');
    console.log('⏰ CONDITIONS: Coin age > 14 days & Risk Level not HIGH');
    
    await this.fetchBinanceSymbols();
    
    this.accountBalance = await this.getUSDTBalance();
    this.initialBalance = this.accountBalance;
    
    if (this.accountBalance <= 0) {
      console.error('❌ Cannot get balance');
      return;
    }
    
    console.log(`💰 Initial Balance: $${this.initialBalance.toFixed(2)}\n`);
    
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
        
        await this.scanAndSelectTopCoins();
        this.updateTrackingList();
        await this.trackTopCoinsRealTime();
        await this.managePositions();
        
        await this.scanDcaOpportunities();
        
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
