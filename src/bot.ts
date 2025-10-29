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
  maxVolume24h: 5000000,
  minVolume24h: 10000,
  fakePumpMinPercent: 15,
  volumeSpikeThreshold: 2.5,
  maxActivePositions: 3,
  maxTrackingCoins: 10,
  minAccountBalancePercent: 0.15,
  emaPeriod: 21,
  resistanceLookback: 20,
  volumeDropThreshold: 0.6,
  dcaLevels: [
    { priceChangePercent: 0.5, addRatio: 0.25, condition: 'MICRO_PULLBACK' },
    { priceChangePercent: 1.2, addRatio: 0.30, condition: 'RESISTANCE_TOUCH' },
    { priceChangePercent: 2.0, addRatio: 0.35, condition: 'EMA_RESISTANCE' },
    { priceChangePercent: 3.0, addRatio: 0.40, condition: 'STRONG_RESISTANCE' }
  ],
  // DCA DƯƠNG - NHỒI LỆNH KHI GIÁ GIẢM MẠNH
  positiveDcaLevels: [
    { profitPercent: 1.5, addRatio: 0.15, extendTpPercent: 2.0 },
    { profitPercent: 3.0, addRatio: 0.20, extendTpPercent: 3.0 },
    { profitPercent: 5.0, addRatio: 0.25, extendTpPercent: 4.0 },
    { profitPercent: 8.0, addRatio: 0.30, extendTpPercent: 5.0 }
  ],
  maxDcaTimes: 8,
  trailingStopLoss: {
    enabled: true,
    activationProfitPercent: 1.0,
    trailDistancePercent: 0.5,
    maxTrailDistancePercent: 3.0
  },
  reversalDetection: {
    enabled: true,
    minPumpPercent: 15,
    pumpCandles: 10,
    minRetraceFromPeak: 5,
    strongRetraceFromPeak: 8,
    volumeSpikeRatio: 2.5,
    requiredSignals: 1,
    minListingDays: 20
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

  constructor() {
    console.log('🤖 FAKE PUMP STRATEGY BOT - ENHANCED REVERSAL MODE');
    console.log('🎯 ENTRY: Pump 15% + Reversal 5% từ đỉnh (Telegram Bot Logic)');
    console.log('📊 PUMP: Trong 10 nến 5m');
    console.log('💰 DCA: Thêm vào khi giá đi ngược hướng');
    console.log('🚀 DCA DƯƠNG: Nhồi thêm lệnh khi giá giảm mạnh & dời TP xa hơn');
    console.log('⏰ FILTER: Coin phải list ít nhất 20 ngày');
    console.log('🛡️ Risk Management: Confidence-based position sizing');
  }

  private async getCoinListingTime(symbol: string): Promise<number> {
    if (this.coinListingTimeCache.has(symbol)) {
      return this.coinListingTimeCache.get(symbol)!;
    }

    try {
      const candles = await this.fetchKlineData(symbol, "Day1", 30);
      
      if (candles.length === 0) {
        const defaultTime = Date.now() - (10 * 24 * 60 * 60 * 1000);
        this.coinListingTimeCache.set(symbol, defaultTime);
        return defaultTime;
      }

      const firstCandleTime = Math.min(...candles.map(c => c.timestamp));
      this.coinListingTimeCache.set(symbol, firstCandleTime);
      
      return firstCandleTime;
    } catch (error) {
      const defaultTime = Date.now() - (10 * 24 * 60 * 60 * 1000);
      this.coinListingTimeCache.set(symbol, defaultTime);
      return defaultTime;
    }
  }

  private async isCoinListedAtLeast20Days(symbol: string): Promise<boolean> {
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
    hasBearishPattern: boolean 
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
      hasBearishPattern: patterns.length > 0 
    };
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

  private detectEnhancedReversalSignal(
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
  } {
    if (candles.length < 15) {
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
        peakPrice: 0
      };
    }

    const last10Candles = candles.slice(-10);
    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];
    
    const firstPrice = last10Candles[0].open;
    const highestPrice = Math.max(...last10Candles.map(k => k.high));
    const pumpPct = ((highestPrice - firstPrice) / firstPrice) * 100;
    
    const dropFromPeak = ((highestPrice - currentPrice) / highestPrice) * 100;
    
    const avgVolume10 = last10Candles.slice(0, -1).reduce((sum, k) => sum + k.volume, 0) / 9;
    const volumeRatio = currentCandle.volume / avgVolume10;
    
    const patternAnalysis = this.detectBearishCandlestickPatterns(currentCandle, previousCandle);
    
    const ma5 = this.calculateMA(candles, 5);
    const ma10 = this.calculateMA(candles, 10);
    const priceUnderMA = currentPrice < ma5 && currentPrice < ma10;
    
    const last3Candles = last10Candles.slice(-3);
    const consecutiveBearish = last3Candles.every(k => k.close < k.open);
    
    const reasons: string[] = [];
    let confidence = 0;
    let riskLevel = 'HIGH';

    const hasReversalSignal = dropFromPeak >= STRATEGY_CONFIG.reversalDetection.minRetraceFromPeak;
    const hasStrongReversal = dropFromPeak >= STRATEGY_CONFIG.reversalDetection.strongRetraceFromPeak;
    const hasVolumeSpike = volumeRatio >= STRATEGY_CONFIG.reversalDetection.volumeSpikeRatio;
    
    if (!hasReversalSignal) {
      return { 
        hasReversal: false, 
        reversalType: '', 
        reasons: ['INSUFFICIENT_RETRACE'],
        confidence: 0,
        riskLevel: 'HIGH',
        dropFromPeak,
        volumeRatio,
        hasBearishPattern: patternAnalysis.hasBearishPattern,
        bearishPatterns: patternAnalysis.patterns,
        priceUnderMA,
        consecutiveBearish,
        peakPrice: highestPrice
      };
    }

    if (hasStrongReversal) confidence += 35;
    else if (dropFromPeak >= STRATEGY_CONFIG.reversalDetection.minRetraceFromPeak) confidence += 25;
    
    if (patternAnalysis.hasBearishPattern) confidence += 25;
    if (hasVolumeSpike) confidence += 20;
    if (priceUnderMA) confidence += 15;
    if (consecutiveBearish) confidence += 15;
    
    let reversalType = '';
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
      return { 
        hasReversal: false, 
        reversalType: '', 
        reasons: ['LOW_CONFIDENCE'],
        confidence,
        riskLevel,
        dropFromPeak,
        volumeRatio,
        hasBearishPattern: patternAnalysis.hasBearishPattern,
        bearishPatterns: patternAnalysis.patterns,
        priceUnderMA,
        consecutiveBearish,
        peakPrice: highestPrice
      };
    }

    if (hasStrongReversal) reasons.push(`STRONG_RETRACE_${dropFromPeak.toFixed(1)}%`);
    else reasons.push(`RETRACE_${dropFromPeak.toFixed(1)}%`);
    
    if (patternAnalysis.hasBearishPattern) reasons.push(...patternAnalysis.patterns.map(p => p.toUpperCase()));
    if (hasVolumeSpike) reasons.push(`VOLUME_SPIKE_${volumeRatio.toFixed(1)}x`);
    if (priceUnderMA) reasons.push('PRICE_UNDER_MA');
    if (consecutiveBearish) reasons.push('CONSECUTIVE_BEARISH');

    return { 
      hasReversal: true, 
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
      peakPrice: highestPrice
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
      const reversalSignal = this.detectEnhancedReversalSignal(candles, currentPrice);
      
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
  }> {
    try {
      const candles = await this.fetchKlineData(symbol, "Min5", 288);
      if (candles.length < 15) {
        return this.getDefaultEnhancedIndicatorResult();
      }

      const currentPrice = candles[candles.length - 1].close;

      const reversalDetection = this.detectEnhancedReversalSignal(candles, currentPrice);
      
      const fakePumpDetection = this.detectFakePump(candles);
      const pumpHigh = fakePumpDetection.pumpHigh;
      const retraceFromHigh = reversalDetection.dropFromPeak;

      const listingTime = await this.getCoinListingTime(symbol);
      const currentTime = Date.now();
      const listingAgeDays = (currentTime - listingTime) / (1000 * 60 * 60 * 24);

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
        reversalSignal: reversalDetection.hasReversal,
        reversalType: reversalDetection.reversalType,
        reversalReasons: reversalDetection.reasons,
        pumpHigh,
        retraceFromHigh,
        listingAgeDays,
        peakPrice: reversalDetection.peakPrice,
        dropFromPeak: reversalDetection.dropFromPeak,
        volumeRatio: reversalDetection.volumeRatio,
        hasBearishPattern: reversalDetection.hasBearishPattern,
        bearishPatterns: reversalDetection.bearishPatterns,
        ma5,
        ma10,
        priceUnderMA: reversalDetection.priceUnderMA,
        consecutiveBearish: reversalDetection.consecutiveBearish,
        confidence: entrySignal.confidence,
        riskLevel: entrySignal.riskLevel
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
      riskLevel: 'HIGH'
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
      
      const capital = this.accountBalance * adjustedPercent;
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

  // CẢI THIỆN HÀM MỞ VỊ THẾ - XỬ LÝ POSITION ID TỪ RESPONSE
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
        type: 1,
        openType: 2,
        leverage: LEVERAGE,
        positionId: 0,
      }) as any;

      let orderId: string;
      let realPositionId: string | undefined;

      // XỬ LÝ RESPONSE ĐỂ LẤY POSITION ID THẬT
      if (orderResponse && orderResponse.data) {
        if (typeof orderResponse.data === 'string') {
          orderId = orderResponse.data;
          // Nếu data là string, có thể là orderId, cần lấy positionId từ API khác
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
            console.log(`⚠️ Could not get real position ID for ${symbol}`);
          }
        } else if (typeof orderResponse.data === 'object') {
          orderId = orderResponse.data.orderId?.toString() || `order_${Date.now()}`;
          // ƯU TIÊN LẤY POSITION ID TỪ RESPONSE
          realPositionId = orderResponse.data.positionId?.toString() || 
                          orderResponse.data.data?.positionId?.toString();
        } else {
          orderId = `order_${Date.now()}`;
        }
      } else {
        orderId = `order_${Date.now()}`;
      }

      // NẾU VẪN CHƯA CÓ POSITION ID, THỬ LẤY TỪ API VỊ THẾ
      if (!realPositionId) {
        try {
          await new Promise(resolve => setTimeout(resolve, 3000));
          const positions = await this.getCurrentPositions();
          const position = positions.find((p: any) => 
            p.symbol === formattedSymbol && p.positionType === 2
          );
          if (position) {
            realPositionId = position.id?.toString() || position.positionId?.toString();
            console.log(`✅ REAL POSITION ID FOUND VIA API: ${realPositionId} for ${symbol}`);
          }
        } catch (error) {
          console.log(`⚠️ Could not get real position ID via API for ${symbol}`);
        }
      }

      const positionId = this.orderManager.generatePositionId();
      
      this.totalOrders++;
      
      this.startRealTimeMonitoring(symbol, positionId);
      
      return {success: true, positionId, realPositionId};

    } catch (err: any) {
      console.error(`❌ OPEN POSITION ERROR: ${symbol}`, err.message);
      return {success: false};
    }
  }

  // CẢI THIỆN HÀM ĐÓNG VỊ THẾ - SỬ DỤNG POSITION ID THẬT
  async closePosition(symbol: string, quantity: number, side: 'SHORT', reason: string, positionId?: string): Promise<boolean> {
    try {
      const position = this.positions.get(symbol);
      
      if (!position) {
        console.log(`❌ No position found for ${symbol}`);
        return false;
      }

      // ƯU TIÊN SỬ DỤNG REAL POSITION ID
      let targetPositionId = 0;
      if (position.realPositionId) {
        targetPositionId = parseInt(position.realPositionId);
        console.log(`🎯 USING REAL POSITION ID: ${targetPositionId} for ${symbol}`);
      } else if (positionId) {
        // Fallback: thử parse positionId từ tham số
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

      console.log(`🔔 CLOSE ORDER: ${symbol} | ${closeQty} contracts | Price: ${currentPrice} | Reason: ${reason} | PositionID: ${targetPositionId}`);

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
        console.log(`✅ CLOSE ORDER SUCCESS: ${symbol}`);
        
        if (position) {
          const profit = await this.calculateProfitForQuantity(position, currentPrice, closeQty);
          this.totalProfit += profit;
          position.closedAmount += closeQty;
          
          if (position.closedAmount >= position.positionSize) {
            this.positions.delete(symbol);
            this.activePositionMonitoring.delete(symbol);
            console.log(`🗑️ POSITION REMOVED: ${symbol}`);
          }
        }
        
        return true;
      } else {
        console.log(`❌ CLOSE ORDER FAILED: ${symbol}`, orderResponse?.msg);
        return false;
      }

    } catch (err: any) {
      console.error(`❌ CLOSE POSITION ERROR: ${symbol}`, err.message);
      
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
      
      // SỬ DỤNG REAL POSITION ID
      let targetPositionId = 0;
      if (position.realPositionId) {
        targetPositionId = parseInt(position.realPositionId);
      }

      console.log(`🔄 CLOSING ALL POSITIONS: ${symbol} | Qty: ${closeQty} | Reason: ${reason} | PositionID: ${targetPositionId}`);

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
        console.log(`✅ ALL POSITIONS CLOSED: ${symbol}`);
      } else {
        console.log(`❌ FAILED TO CLOSE ALL POSITIONS: ${symbol}`);
      }

    } catch (error: any) {
      console.error(`❌ CLOSE ALL POSITIONS ERROR: ${symbol}`, error.message);
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
      console.error('❌ GET POSITIONS ERROR:', error.message);
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
      console.error(`❌ GET POSITION FOR SYMBOL ERROR: ${symbol}`, error.message);
      return null;
    }
  }

  // CẢI THIỆN HÀM CẬP NHẬT POSITION ID THẬT
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
          console.log(`🔄 UPDATED REAL POSITION ID: ${symbol} -> ${position.realPositionId}`);
        }
      }
    } catch (error: any) {
      console.error('❌ UPDATE REAL POSITION IDS ERROR:', error.message);
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
        // Không log lỗi
      }
    }, 5000);

    if (!this.realTimeMonitorInterval) {
      this.realTimeMonitorInterval = monitorInterval;
    }
  }

  // SỬA LỖI: ĐẢM BẢO originalTakeProfitLevels LUÔN ĐƯỢC ĐỊNH NGHĨA
  private recalculateSLTPAfterDCA(position: PositionData): void {    
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
    const remainingQty = position.totalQty - position.closedAmount;
    
    // SỬA LỖI: KIỂM TRA originalTakeProfitLevels CÓ TỒN TẠI KHÔNG
    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      if (!position.takeProfitLevels[i].executed && position.originalTakeProfitLevels) {
        const originalRatio = position.originalTakeProfitLevels[i].closeRatio;
        position.takeProfitLevels[i].quantity = remainingQty * originalRatio;
      }
    }
    
    // SỬA LỖI: KIỂM TRA originalStopLossLevels CÓ TỒN TẠI KHÔNG
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

                this.extendTakeProfitLevels(position, level.extendTpPercent);
                this.recalculateSLTPAfterDCA(position); // RECALCULATE SLTP SAU DCA DƯƠNG
                
                if (position.trailingStopLoss) {
                  position.trailingStopLoss.activated = false;
                  position.trailingStopLoss.activationPrice = 0;
                  position.trailingStopLoss.currentStopPrice = 0;
                  position.trailingStopLoss.highestProfit = 0;
                }
                
                console.log(`🚀 POSITIVE DCA ${position.positiveDcaCount} EXECUTED: ${symbol} | Added ${positiveDcaQty} contracts | Profit: ${Math.abs(profitData.priceChangePercent).toFixed(2)}% | Extended TP: +${level.extendTpPercent}%`);

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
      console.error(`❌ POSITIVE DCA ERROR: ${symbol}`, error);
    }
  }

  private extendTakeProfitLevels(position: PositionData, extendPercent: number): void {
    console.log(`🎯 EXTENDING TP LEVELS: ${position.symbol} | Adding +${extendPercent}% to all TP levels`);
    
    if (!position.originalTakeProfitLevels) {
      position.originalTakeProfitLevels = JSON.parse(JSON.stringify(position.takeProfitLevels));
    }

    for (let i = 0; i < position.takeProfitLevels.length; i++) {
      if (!position.takeProfitLevels[i].executed) {
        const originalLevel = position.originalTakeProfitLevels[i];
        position.takeProfitLevels[i].priceChangePercent = originalLevel.priceChangePercent + extendPercent;
        
        console.log(`   TP${i+1}: ${originalLevel.priceChangePercent}% -> ${position.takeProfitLevels[i].priceChangePercent}%`);
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

                this.recalculateSLTPAfterDCA(position);
                
                if (position.trailingStopLoss) {
                  position.trailingStopLoss.activated = false;
                  position.trailingStopLoss.activationPrice = 0;
                  position.trailingStopLoss.currentStopPrice = 0;
                  position.trailingStopLoss.highestProfit = 0;
                }
                
                console.log(`💰 DCA ${position.dcaCount} EXECUTED: ${symbol} | Added ${dcaQty} contracts | Avg Price: ${position.averagePrice}`);

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
      // Không log lỗi
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
            console.log(`🛑 SL ${i+1} TRIGGERED: ${symbol} | Stop: ${level.priceChangePercent}% | Current: ${profitData.priceChangePercent.toFixed(2)}%`);
            
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

          const isOldEnough = await this.isCoinListedAtLeast20Days(symbol);
          if (!isOldEnough) {
            return null;
          }

          const indicators = await this.calculateEnhancedIndicators(symbol);
          
          const meetsVolume = indicators.volume24h >= STRATEGY_CONFIG.minVolume24h && indicators.volume24h <= STRATEGY_CONFIG.maxVolume24h;
          const hasReversal = indicators.reversalSignal && indicators.confidence >= 50;

          if (!meetsVolume || !hasReversal) {
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
            riskLevel: indicators.riskLevel
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
      console.log(`🔍 TRACKING: ${symbol} | Pump: ${coinData.pumpPercent.toFixed(1)}% | Retrace: ${coinData.dropFromPeak.toFixed(1)}% | Confidence: ${coinData.confidence}% | Risk: ${coinData.riskLevel} | Patterns: ${coinData.bearishPatterns.join(', ')}`);
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

        coinData.dailyVolatility = indicators.dailyVolatility;
        coinData.volume24h = indicators.volume24h;
        coinData.volumeSpike = indicators.volumeSpike;
        coinData.marketMomentum = indicators.marketMomentum;
        coinData.ema = indicators.ema;
        coinData.resistanceLevel = indicators.resistanceLevel;
        coinData.supportLevel = indicators.supportLevel;
        coinData.hasEntrySignal = indicators.hasEntrySignal;
        coinData.signalType = indicators.signalType;
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

        if (coinData.hasEntrySignal && coinData.status === 'TRACKING') {
          console.log(`🎯 ENTRY SIGNAL: ${symbol} | ${coinData.signalType} | Pump: ${coinData.pumpPercent.toFixed(1)}% | Retrace: ${coinData.dropFromPeak.toFixed(1)}% | Confidence: ${coinData.confidence}%`);
          console.log(`   📉 Reversal Reasons: ${coinData.reversalReasons.join(', ')}`);
          console.log(`   🎯 Risk Level: ${coinData.riskLevel} | Patterns: ${coinData.bearishPatterns.join(', ')}`);
          
          coinData.status = 'READY_TO_ENTER';
        }

        if (coinData.status === 'READY_TO_ENTER') {
          console.log(`🚀 ENTERING POSITION: ${symbol} | ${coinData.signalType}`);
          
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
        // Không log lỗi
      }
    }
  }

  // CẢI THIỆN HÀM VÀO VỊ THẾ - KHỞI TẠO originalTakeProfitLevels và originalStopLossLevels
  async enterPosition(symbol: string, signalType: string, confidence: number, riskLevel: string): Promise<void> {
    if (this.positions.has(symbol)) return;

    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0 || !this.hasMinimumBalance()) return;

      const initialQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent, confidence);

      if (initialQty <= 0) return;

      const openResult = await this.openPosition(symbol, initialQty, 'SHORT', signalType);
      if (!openResult.success) return;

      const actualPrice = await this.getCurrentPrice(symbol);
      
      const takeProfitLevels: TakeProfitLevel[] = STRATEGY_CONFIG.takeProfitLevels.map(level => ({ 
        ...level, 
        executed: false,
        quantity: initialQty * level.closeRatio
      }));
      
      const stopLossLevels: StopLossLevel[] = STRATEGY_CONFIG.stopLossLevels.map(level => ({ 
        ...level, 
        executed: false,
        quantity: initialQty * level.closeRatio
      }));

      const dcaLevels: DcaLevel[] = STRATEGY_CONFIG.dcaLevels.map(level => ({ 
        ...level, 
        executed: false,
        condition: level.condition as 'RESISTANCE' | 'EMA_RESISTANCE' | 'FIBONACCI' | 'BASIC' | 'POSITIVE_PULLBACK' | 'MICRO_PULLBACK' | 'RESISTANCE_TOUCH' | 'STRONG_RESISTANCE'
      }));

      const positiveDcaLevels: PositiveDcaLevel[] = STRATEGY_CONFIG.positiveDcaLevels.map(level => ({
        ...level,
        executed: false
      }));

      const maxDcaVolume = await this.calculatePositionSize(symbol, 0.6, confidence);

      // KHỞI TẠO originalTakeProfitLevels và originalStopLossLevels NGAY TỪ ĐẦU
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
          activated: false
        } : undefined,
        pendingDcaOrders: new Map(),
        sltpRecalculated: false,
        originalTakeProfitLevels: JSON.parse(JSON.stringify(takeProfitLevels)), // KHỞI TẠO NGAY
        originalStopLossLevels: JSON.parse(JSON.stringify(stopLossLevels)), // KHỞI TẠO NGAY
        consecutiveDcaCount: 0,
        aggressiveDcaMode: false,
        totalDcaVolume: 0,
        maxDcaVolume,
        confidence,
        peakPrice: actualPrice * 1.05,
        positiveDcaCount: 0,
        extendedTpLevels: []
      };

      this.positions.set(symbol, position);

      console.log(`✅ POSITION OPENED: ${symbol} | Size: ${initialQty} | Entry: ${actualPrice} | Signal: ${signalType} | Confidence: ${confidence}% | Risk: ${riskLevel} | RealPositionID: ${openResult.realPositionId || 'Not found'}`);

    } catch (error) {
      console.error(`❌ Position Opening Error: ${symbol}`, error);
    }
  }

  async scanDcaOpportunities(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDcaScan < 60000) return;
    
    this.lastDcaScan = now;

    if (this.positions.size === 0) return;

    console.log(`🔍 SCANNING DCA OPPORTUNITIES: ${this.positions.size} positions`);

    for (const [symbol, position] of this.positions.entries()) {
      try {
        if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes) continue;

        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;

        await this.checkImmediateDCA(symbol, position, currentPrice);

      } catch (error) {
        // Không log lỗi
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
        // Không log lỗi
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

        let positiveDcaInfo = '';
        if (position.positiveDcaCount > 0) {
          positiveDcaInfo = ` | 🚀 Positive DCA: ${position.positiveDcaCount}`;
        }

        let extendedTpInfo = '';
        if (position.extendedTpLevels.length > 0) {
          const totalExtended = position.extendedTpLevels.reduce((a, b) => a + b, 0);
          extendedTpInfo = ` | 🎯 Extended TP: +${totalExtended.toFixed(1)}%`;
        }

        let positionIdInfo = '';
        if (position.realPositionId) {
          positionIdInfo = ` | RealPosID: ${position.realPositionId}`;
        }

        let confidenceInfo = '';
        if (position.confidence) {
          confidenceInfo = ` | Confidence: ${position.confidence}%`;
        }
        
        console.log(`   ${symbol}: ${status} $${profitData.profit.toFixed(2)} (${profitData.priceChangePercent.toFixed(1)}%) | Closed: ${closedPercent}%${dcaInfo}${positiveDcaInfo}${extendedTpInfo}${trailingInfo}${positionIdInfo}${confidenceInfo}`);
      }
    }
    console.log('');
  }

  async run(): Promise<void> {
    console.log('🚀 Starting ENHANCED FAKE PUMP STRATEGY BOT');
    console.log('🎯 ENTRY: Pump 15% + Reversal 5% từ đỉnh (Telegram Bot Logic)');
    console.log('📊 PUMP: Trong 10 nến 5m');
    console.log('💰 DCA: Thêm vào khi giá đi ngược hướng');
    console.log('🚀 DCA DƯƠNG: Nhồi thêm lệnh khi giá giảm mạnh & dời TP xa hơn');
    console.log('⏰ FILTER: Coin phải list ít nhất 20 ngày');
    console.log('🛡️ Risk Management: Confidence-based position sizing');
    
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
