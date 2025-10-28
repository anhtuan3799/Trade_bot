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
  initialPositionPercent: 0.20,
  maxTotalPositionPercent: 0.60,
  takeProfitLevels: [
    { priceChangePercent: 4.0, closeRatio: 0.4 },
    { priceChangePercent: 8.0, closeRatio: 0.4 },
    { priceChangePercent: 15.0, closeRatio: 0.2 }
  ],
  stopLossLevels: [
    { priceChangePercent: 2.5, closeRatio: 0.5 },
    { priceChangePercent: 4.0, closeRatio: 0.5 }
  ],
  minDailyVolatility: 5.0,
  maxVolume24h: 5000000,
  trendStrengthThreshold: 0.8,
  volumeSpikeThreshold: 1.5,
  maxActivePositions: 3,
  maxTrackingCoins: 10,
  minAccountBalancePercent: 0.15,
  emaPeriod: 21,
  resistanceLookback: 20,
  dcaLevels: [
    { priceChangePercent: 1.0, addRatio: 1.0, condition: 'MICRO_PULLBACK' },
    { priceChangePercent: 2.5, addRatio: 1.0, condition: 'STRONG_RESISTANCE' }
  ],
  maxDcaTimes: 2,
  dcaConditions: {
    volumeDropThreshold: 0.7,
    emaResistance: true,
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
    minPumpPercent: 8,
    volumeDivergenceThreshold: 1.2,
    timeFrame: 4,
    momentumDivergence: true,
    emaRejection: true,
    maxRetracement: 0.382,
    minPumpCandles: 4,
    maxDropFromPump: 8,
    requireUptrend: false 
  },
  strongDowntrend: {
    minTrendStrength: 0.85,
    minVolumeSpike: 1.8,
    accelerationThreshold: -0.002,
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
    minPullbackPercent: 0.5,
    maxPullbackPercent: 4.0,
    volumeDropThreshold: 0.8,
    momentumThreshold: 0.02,
    emaResistance: true,
    pullbackDCA: {
      enabled: true,
      minTrendStrength: 0.7,
      maxConsecutiveDCA: 2,
      timeBetweenDCA: 180000,
      requireVolumeConfirmation: true,
      maxTotalDcaPercent: 0.40
    }
  },
  entryFilters: {
    max24hDropPercent: 15,
    maxRecentDropPercent: 10,
    minDistanceToSupportPercent: 2,
    maxDowntrendDurationHours: 48
  }
};

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
  condition: string;
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
  checkCount: number;
  trailingStopLoss?: {
    enabled: boolean;
    activationPrice: number;
    currentStopPrice: number;
    highestProfit: number;
    activated: boolean;
  };
  pendingDcaOrders: Map<string, any>;
  sltpRecalculated: boolean;
  originalTakeProfitLevels?: TakeProfitLevel[];
  originalStopLossLevels?: StopLossLevel[];
  lastDcaTime?: number;
  consecutiveDcaCount: number;
  aggressiveDcaMode: boolean;
  totalDcaVolume: number;
  maxDcaVolume: number;
  isStrongTrend?: boolean;
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
  ema: number;
  atr: number;
  hasEntrySignal: boolean;
  signalType: string;
  entrySide: 'SHORT';
  fakePumpSignal: boolean;
  fakePumpStrength: number;
  fakePumpReason: string;
  strongDowntrendSignal: boolean;
  trendAcceleration: number;
  emaAlignment: boolean;
  hasStrongBearishCandle?: boolean;
  strongBearishReason?: string;
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

class VolumeFilteredStrategyBot {
  public positions: Map<string, PositionData> = new Map();
  private trackingCoins: Map<string, CoinTrackingData> = new Map();
  private candidateCoins: Map<string, CoinTrackingData> = new Map();
  private accountBalance: number = 0;
  private initialBalance: number = 0;
  private isRunning: boolean = false;
  private totalOrders: number = 0;
  private totalProfit: number = 0;
  private lastScanTime: number = 0;
  private contractInfoCache: Map<string, any> = new Map();
  private lastStatusDisplay: number = 0;
  private statusDisplayInterval: number = 60000;
  private orderManager: OrderManager = new OrderManager();
  private activePositionMonitoring: Set<string> = new Set();
  private lastDcaCheck: Map<string, number> = new Map();
  
  // Parallel processing intervals
  private monitoringInterval: NodeJS.Timeout | null = null;
  private scanningInterval: NodeJS.Timeout | null = null;
  private entryProcessingInterval: NodeJS.Timeout | null = null;
  private statusInterval: NodeJS.Timeout | null = null;

  // Lock mechanism để tránh race condition
  private positionLocks: Map<string, boolean> = new Map();
  private trackingLock: boolean = false;

  constructor() {
    console.log('🤖 VOLUME FILTERED STRATEGY BOT - PARALLEL PROCESSING VERSION');
    console.log('🔄 PARALLEL SYSTEMS: Monitoring, Scanning, Entry Processing');
    console.log('📊 VOLUME FILTER: < 5M USDT');
    console.log('💰 POSITION SIZE: 20% account | DCA: 2x 20%');
    console.log('📈 TOTAL EXPOSURE: 60% account (20% + 40% DCA)');
    console.log('🎯 TP MỞ RỘNG: 3 levels (4%-8%-15%)');
    console.log('⚡ REAL-TIME PARALLEL MONITORING: TP/SL/DCA & Tracking Coins');
  }

  // ==================== PARALLEL PROCESSING SYSTEM ====================

  private startParallelProcessing(): void {
    console.log('🚀 Starting parallel processing systems...');
    
    // 1. Monitoring System - Ưu tiên cao nhất (3 giây)
    this.monitoringInterval = setInterval(async () => {
      if (!this.isRunning) return;
      await this.monitorActivePositions();
    }, 3000);

    // 2. Scanning System - Ưu tiên trung bình (2 phút)
    this.scanningInterval = setInterval(async () => {
      if (!this.isRunning) return;
      await this.scanAndSelectTopCoins();
    }, 120000);

    // 3. Entry Processing System - Ưu tiên cao (10 giây)
    this.entryProcessingInterval = setInterval(async () => {
      if (!this.isRunning) return;
      await this.processEntryOpportunities();
    }, 10000);

    // 4. Status Display - Ưu tiên thấp (1 phút)
    this.statusInterval = setInterval(async () => {
      if (!this.isRunning) return;
      await this.displayRealTimeStatus();
    }, 60000);

    console.log('✅ All parallel systems started');
  }

  private stopParallelProcessing(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    if (this.scanningInterval) {
      clearInterval(this.scanningInterval);
      this.scanningInterval = null;
    }
    if (this.entryProcessingInterval) {
      clearInterval(this.entryProcessingInterval);
      this.entryProcessingInterval = null;
    }
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  }

  // ==================== THREAD-SAFE POSITION MANAGEMENT ====================

  private async acquirePositionLock(symbol: string): Promise<boolean> {
    if (this.positionLocks.get(symbol)) {
      return false;
    }
    this.positionLocks.set(symbol, true);
    return true;
  }

  private releasePositionLock(symbol: string): void {
    this.positionLocks.delete(symbol);
  }

  private async acquireTrackingLock(): Promise<boolean> {
    if (this.trackingLock) {
      return false;
    }
    this.trackingLock = true;
    return true;
  }

  private releaseTrackingLock(): void {
    this.trackingLock = false;
  }

  // ==================== OPTIMIZED MONITORING SYSTEM ====================

  private async monitorActivePositions(): Promise<void> {
    if (this.positions.size === 0) return;

    const monitoringPromises = Array.from(this.positions.entries()).map(async ([symbol, position]) => {
      if (!(await this.acquirePositionLock(symbol))) {
        return;
      }

      try {
        await this.monitorSinglePosition(symbol, position);
      } catch (error) {
        console.error(`Error monitoring position ${symbol}:`, error);
      } finally {
        this.releasePositionLock(symbol);
      }
    });

    await Promise.allSettled(monitoringPromises);
  }

  private async monitorSinglePosition(symbol: string, position: PositionData): Promise<void> {
    const currentPrice = await this.getCurrentPrice(symbol);
    if (currentPrice <= 0) return;

    const checks = [
      this.executeRealTimeDCA(symbol, position, currentPrice),
      this.checkImmediateSLTP(symbol, position, currentPrice),
      this.checkTrailingStopLoss(symbol, position, currentPrice)
    ];

    await Promise.allSettled(checks);
    position.checkCount++;
  }

  // ==================== OPTIMIZED SCANNING SYSTEM ====================

  private async scanAndSelectTopCoins(): Promise<void> {
    const now = Date.now();
    if (now - this.lastScanTime < 60000) {
      return;
    }

    if (!(await this.acquireTrackingLock())) {
      return;
    }

    try {
      this.lastScanTime = now;
      const symbols = await this.getAllFuturePairs();
      
      console.log(`🔍 Scanning ${symbols.length} coins...`);
      
      const batchSize = 10;
      const batches: string[][] = [];
      
      for (let i = 0; i < symbols.length; i += batchSize) {
        batches.push(symbols.slice(i, i + batchSize));
      }

      const allCandidates: { symbol: string; coinData: CoinTrackingData }[] = [];

      for (const batch of batches) {
        const batchPromises = batch.map(async (symbol) => {
          if (this.positions.has(symbol) || this.trackingCoins.has(symbol)) {
            return null;
          }

          try {
            const indicators = await this.calculateIndicators(symbol);
            
            const meetsVolume = indicators.volume24h <= STRATEGY_CONFIG.maxVolume24h;
            const hasSignal = indicators.hasEntrySignal;
            const meetsVolatility = indicators.dailyVolatility >= STRATEGY_CONFIG.minDailyVolatility;

            if (!meetsVolume || !hasSignal || !meetsVolatility) {
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
              strengthScore: indicators.trendStrength * 100,
              resistanceLevel: indicators.resistanceLevel,
              supportLevel: indicators.supportLevel,
              marketMomentum: indicators.marketMomentum,
              ema: indicators.ema,
              atr: indicators.atr,
              hasEntrySignal: indicators.hasEntrySignal,
              signalType: indicators.signalType,
              entrySide: 'SHORT',
              fakePumpSignal: indicators.fakePumpSignal,
              fakePumpStrength: indicators.fakePumpStrength,
              fakePumpReason: indicators.fakePumpReason,
              strongDowntrendSignal: indicators.strongDowntrendSignal,
              trendAcceleration: indicators.trendAcceleration,
              emaAlignment: indicators.emaAlignment,
              hasStrongBearishCandle: indicators.hasStrongBearishCandle,
              strongBearishReason: indicators.strongBearishReason
            };

            return { symbol, coinData };
          } catch (error) {
            return null;
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);
        const validResults = batchResults
          .filter((result): result is PromiseFulfilledResult<{ symbol: string; coinData: CoinTrackingData } | null> => 
            result.status === 'fulfilled' && result.value !== null
          )
          .map(result => result.value)
          .filter((item): item is { symbol: string; coinData: CoinTrackingData } => item !== null);

        allCandidates.push(...validResults);

        await new Promise(resolve => setTimeout(resolve, 500));
      }

      allCandidates.sort((a, b) => b.coinData.strengthScore - a.coinData.strengthScore);
      const topCandidates = allCandidates.slice(0, STRATEGY_CONFIG.maxTrackingCoins);

      this.candidateCoins.clear();
      topCandidates.forEach(candidate => {
        this.candidateCoins.set(candidate.symbol, candidate.coinData);
      });

      this.updateTrackingList();
      
      console.log(`✅ Scan completed: ${symbols.length} coins, ${allCandidates.length} candidates, ${topCandidates.length} selected`);

    } catch (error) {
      console.error('Scanning error:', error);
    } finally {
      this.releaseTrackingLock();
    }
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
      console.log(`📝 Added to tracking: ${symbol} | Score: ${coinData.strengthScore.toFixed(1)} | Signal: ${coinData.signalType}`);
    });
  }

  // ==================== OPTIMIZED ENTRY PROCESSING ====================

  private async processEntryOpportunities(): Promise<void> {
    if (this.trackingCoins.size === 0) return;

    if (!(await this.acquireTrackingLock())) {
      return;
    }

    try {
      const readyCoins = Array.from(this.trackingCoins.entries())
        .filter(([_, coinData]) => coinData.status === 'READY_TO_ENTER')
        .slice(0, STRATEGY_CONFIG.maxActivePositions - this.positions.size);

      const entryPromises = readyCoins.map(async ([symbol, coinData]) => {
        try {
          if (!this.hasMinimumBalance() || this.positions.size >= STRATEGY_CONFIG.maxActivePositions) {
            return;
          }

          console.log(`🚀 ENTERING: ${symbol} | ${coinData.signalType} | Volume: ${(coinData.volume24h/1000000).toFixed(2)}M`);
          
          await this.enterPosition(symbol, coinData.signalType, coinData.hasStrongBearishCandle || false);
          coinData.status = 'ENTERED';
          this.trackingCoins.delete(symbol);

        } catch (error) {
          console.error(`Error entering position for ${symbol}:`, error);
        }
      });

      await Promise.allSettled(entryPromises);

    } finally {
      this.releaseTrackingLock();
    }
  }

  // ==================== CORE STRATEGY METHODS ====================

  private calculateMarketMomentum(candles: SimpleCandle[]): number {
    if (candles.length < 10) return 0;
    const recentPrices = candles.slice(-10).map(c => c.close);
    const midPrices = candles.slice(-20, -10).map(c => c.close);
    const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const midAvg = midPrices.reduce((a, b) => a + b, 0) / midPrices.length;
    return midAvg > 0 ? (recentAvg - midAvg) / midAvg : 0;
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
    let direction: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' = 'SIDEWAYS';
    if (ema20 > ema50 && currentPrice > ema20) {
      direction = 'UPTREND';
    } else if (ema20 < ema50 && currentPrice < ema20) {
      direction = 'DOWNTREND';
    }
    const priceEma20Ratio = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 0;
    const emaGap = ema20 > 0 && ema50 > 0 ? Math.abs(ema20 - ema50) / ((ema20 + ema50) / 2) : 0;
    const strength = Math.min((priceEma20Ratio * 10 + emaGap * 20) / 2, 1);
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

  private calculateVolumeSpike(volumes: number[]): number {
    if (volumes.length < 8) return 1;
    const currentVolume = volumes[volumes.length - 1];
    const previousVolumes = volumes.slice(-8, -1);
    const avgVolume = previousVolumes.reduce((a, b) => a + b, 0) / previousVolumes.length;
    return avgVolume > 0 ? currentVolume / avgVolume : 1;
  }

  private calculatePriceChangePercent(entryPrice: number, currentPrice: number): number {
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }

  private detectStrongBearishCandle(candles: SimpleCandle[]): { hasStrongBearish: boolean; reason: string; candleStrength: number } {
    if (candles.length < 2) {
      return { hasStrongBearish: false, reason: 'INSUFFICIENT_DATA', candleStrength: 0 };
    }

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const totalRange = lastCandle.high - lastCandle.low;
    const bodyRatio = totalRange > 0 ? (bodySize / totalRange) * 100 : 0;
    
    const isBearish = lastCandle.close < lastCandle.open;
    const candleChangePercent = ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;
    
    const avgVolume = candles.slice(-10).reduce((sum, c) => sum + c.volume, 0) / 10;
    const volumeRatio = avgVolume > 0 ? lastCandle.volume / avgVolume : 1;

    let bearishScore = 0;
    let reasons: string[] = [];

    if (isBearish && candleChangePercent <= -3.0) {
      bearishScore += 40;
      reasons.push(`STRONG_DROP_${Math.abs(candleChangePercent).toFixed(1)}%`);
    } else if (isBearish && candleChangePercent <= -1.5) {
      bearishScore += 25;
      reasons.push(`MEDIUM_DROP_${Math.abs(candleChangePercent).toFixed(1)}%`);
    }

    if (bodyRatio >= 70) {
      bearishScore += 25;
      reasons.push(`STRONG_BODY_${bodyRatio.toFixed(0)}%`);
    } else if (bodyRatio >= 50) {
      bearishScore += 15;
      reasons.push(`GOOD_BODY_${bodyRatio.toFixed(0)}%`);
    }

    if (volumeRatio >= 2.0) {
      bearishScore += 20;
      reasons.push(`HIGH_VOLUME_${volumeRatio.toFixed(1)}`);
    } else if (volumeRatio >= 1.5) {
      bearishScore += 15;
      reasons.push(`GOOD_VOLUME_${volumeRatio.toFixed(1)}`);
    }

    const prevLow = prevCandle.low;
    const brokeSupport = lastCandle.low < prevLow;
    if (brokeSupport) {
      bearishScore += 15;
      reasons.push('BROKE_SUPPORT');
    }

    const hasStrongBearish = bearishScore >= 60;
    const candleStrength = Math.min(bearishScore / 100, 1);

    return {
      hasStrongBearish,
      reason: reasons.join(','),
      candleStrength
    };
  }

  private detectFakePumpSignal(
    candles: SimpleCandle[], 
    currentPrice: number,
    ema: number,
    marketMomentum: number,
    volume24h: number
  ): { isFakePump: boolean; pumpStrength: number; reason: string; pumpPercent: number } {
    
    if (candles.length < 24) {
      return { isFakePump: false, pumpStrength: 0, reason: 'INSUFFICIENT_DATA', pumpPercent: 0 };
    }

    if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
      return { isFakePump: false, pumpStrength: 0, reason: 'VOLUME_TOO_HIGH', pumpPercent: 0 };
    }

    const pumpCandles = candles.slice(-STRATEGY_CONFIG.fakePumpDetection.minPumpCandles);
    const pumpHigh = Math.max(...pumpCandles.map(c => c.high));
    const pumpLow = Math.min(...pumpCandles.map(c => c.low));
    const pumpPercent = ((pumpHigh - pumpLow) / pumpLow) * 100;
    
    if (pumpPercent < STRATEGY_CONFIG.fakePumpDetection.minPumpPercent) {
      return { isFakePump: false, pumpStrength: 0, reason: `PUMP_TOO_SMALL_${pumpPercent.toFixed(1)}%`, pumpPercent };
    }

    const dropFromHigh = ((pumpHigh - currentPrice) / pumpHigh) * 100;
    if (dropFromHigh > STRATEGY_CONFIG.fakePumpDetection.maxDropFromPump) {
      return { isFakePump: false, pumpStrength: 0, reason: `EXCESSIVE_DROP_${dropFromHigh.toFixed(1)}%`, pumpPercent };
    }

    const volumeDuringPump = pumpCandles.slice(-4).reduce((sum, c) => sum + c.volume, 0) / 4;
    const volumeBeforePump = pumpCandles.slice(-8, -4).reduce((sum, c) => sum + c.volume, 0) / 4;
    const volumeSpike = volumeBeforePump > 0 ? volumeDuringPump / volumeBeforePump : 1;
    
    if (volumeSpike < STRATEGY_CONFIG.fakePumpDetection.volumeDivergenceThreshold) {
      return { isFakePump: false, pumpStrength: 0, reason: `LOW_VOLUME_SPIKE_${volumeSpike.toFixed(1)}`, pumpPercent };
    }

    let pumpScore = 0;
    let reasons: string[] = [];

    if (pumpPercent >= 15 && pumpPercent <= 50) {
      pumpScore += 35;
      reasons.push(`STRONG_PUMP_${pumpPercent.toFixed(1)}%`);
    } else if (pumpPercent >= 8) {
      pumpScore += 25;
      reasons.push(`PUMP_${pumpPercent.toFixed(1)}%`);
    }

    if (volumeSpike >= 2.0) {
      pumpScore += 25;
      reasons.push(`HIGH_VOLUME_${volumeSpike.toFixed(1)}`);
    } else if (volumeSpike >= 1.2) {
      pumpScore += 20;
      reasons.push(`GOOD_VOLUME_${volumeSpike.toFixed(1)}`);
    }

    if (dropFromHigh <= 5.0) {
      pumpScore += 20;
      reasons.push(`SMALL_DROP_${dropFromHigh.toFixed(1)}%`);
    } else if (dropFromHigh <= 8.0) {
      pumpScore += 15;
      reasons.push(`MODERATE_DROP_${dropFromHigh.toFixed(1)}%`);
    }

    const lastCandle = candles[candles.length - 1];
    const upperShadow = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const isRejectionCandle = upperShadow > (bodySize * 1.5);

    if (isRejectionCandle) {
      pumpScore += 15;
      reasons.push('REJECTION_CANDLE');
    }

    const distanceToEMA = ema > 0 ? Math.abs(currentPrice - ema) / ema : 0;
    const isEMARejection = distanceToEMA <= 0.02 && currentPrice < ema;

    if (isEMARejection) {
      pumpScore += 15;
      reasons.push('EMA_REJECTION');
    }

    const isFakePump = pumpScore >= 70;
    const pumpStrength = Math.min(pumpScore / 100, 1);

    return { 
      isFakePump, 
      pumpStrength, 
      reason: reasons.join(','),
      pumpPercent
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
    marketMomentum: number,
    trendDirection: string,
    volume24h: number,
    trendStrength: number,
    volumeSpike: number
  ): { hasSignal: boolean; signalType: string; side: 'SHORT'; hasStrongBearishCandle?: boolean; bearishReason?: string } {
    
    if (candles.length < 2) {
      return { hasSignal: false, signalType: '', side: 'SHORT' };
    }

    if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
      return { hasSignal: false, signalType: `FILTERED:VOLUME_TOO_HIGH_${(volume24h/1000000).toFixed(1)}M`, side: 'SHORT' };
    }

    const bearishCandle = this.detectStrongBearishCandle(candles);
    const hasStrongBearish = bearishCandle.hasStrongBearish;

    const fakePumpSignal = this.detectFakePumpSignal(
      candles, currentPrice, ema, marketMomentum, volume24h
    );
    
    if (fakePumpSignal.isFakePump) {
      return { 
        hasSignal: true, 
        signalType: `FAKE_PUMP_${fakePumpSignal.reason}${hasStrongBearish ? '_STRONG_BEARISH' : ''}`, 
        side: 'SHORT',
        hasStrongBearishCandle: hasStrongBearish,
        bearishReason: bearishCandle.reason
      };
    }

    const strongDowntrend = this.detectStrongDowntrend(
      candles, trendStrength, trendDirection, volumeSpike, currentPrice, ema
    );

    if (strongDowntrend.isStrongDowntrend) {
      return {
        hasSignal: true,
        signalType: `STRONG_DOWNTREND_${strongDowntrend.reason}${hasStrongBearish ? '_STRONG_BEARISH' : ''}`,
        side: 'SHORT',
        hasStrongBearishCandle: hasStrongBearish,
        bearishReason: bearishCandle.reason
      };
    }

    return { hasSignal: false, signalType: '', side: 'SHORT' };
  }

  // ==================== EXCHANGE METHODS ====================

  async fetchKlineData(symbol: string, interval = "Min5", limit = 288): Promise<SimpleCandle[]> {
    const formattedSymbol = symbol.replace('USDT', '_USDT');
    const url = `https://contract.mexc.com/api/v1/contract/kline/${formattedSymbol}`;
    
    try {
      const response = await axios.get<any>(url, {
        params: { interval, limit },
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

  async calculateIndicators(symbol: string): Promise<{
    dailyVolatility: number;
    volume24h: number;
    trendStrength: number;
    trendDirection: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
    currentPrice: number;
    volumeSpike: number;
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
    fakePumpStrength: number;
    fakePumpReason: string;
    strongDowntrendSignal: boolean;
    trendAcceleration: number;
    emaAlignment: boolean;
    hasStrongBearishCandle?: boolean;
    strongBearishReason?: string;
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
      const atr = this.calculateATR(candles);
      const resistanceLevel = this.findResistanceLevel(candles, STRATEGY_CONFIG.resistanceLookback);
      const supportLevel = this.findSupportLevel(candles, STRATEGY_CONFIG.resistanceLookback);

      const trendAcceleration = this.calculateTrendAcceleration(candles);
      const emaAlignment = this.checkEmaAlignment(candles);

      const bearishCandle = this.detectStrongBearishCandle(candles);

      const entrySignal = this.detectEntrySignal(
        candles, currentPrice, ema, marketMomentum, trendAnalysis.direction, 
        volume24h, trendAnalysis.strength, volumeSpike
      );
      
      const strongDowntrendDetection = this.detectStrongDowntrend(
        candles, trendAnalysis.strength, trendAnalysis.direction, volumeSpike, currentPrice, ema
      );

      const fakePumpDetection = this.detectFakePumpSignal(
        candles, currentPrice, ema, marketMomentum, volume24h
      );

      return { 
        dailyVolatility,
        volume24h,
        trendStrength: trendAnalysis.strength,
        trendDirection: trendAnalysis.direction,
        currentPrice, 
        volumeSpike, 
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
        fakePumpStrength: fakePumpDetection.pumpStrength,
        fakePumpReason: fakePumpDetection.reason,
        strongDowntrendSignal: strongDowntrendDetection.isStrongDowntrend,
        trendAcceleration,
        emaAlignment,
        hasStrongBearishCandle: bearishCandle.hasStrongBearish,
        strongBearishReason: bearishCandle.reason
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
      fakePumpStrength: 0,
      fakePumpReason: 'ERROR',
      strongDowntrendSignal: false,
      trendAcceleration: 0,
      emaAlignment: false,
      hasStrongBearishCandle: false,
      strongBearishReason: 'ERROR'
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

  async getContractInfo(symbol: string): Promise<any> {
    const cacheKey = symbol.replace('USDT', '_USDT');
    
    if (this.contractInfoCache.has(cacheKey)) {
      return this.contractInfoCache.get(cacheKey)!;
    }

    try {
      const response = await axios.get<any>("https://contract.mexc.com/api/v1/contract/detail");
      const data = response.data;
      let contractInfo: any;
      
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
      } else {
        contractInfo = this.getFallbackContractInfo(symbol, cacheKey);
      }

      this.contractInfoCache.set(cacheKey, contractInfo);
      return contractInfo;

    } catch (error: any) {
      return this.getFallbackContractInfo(symbol, cacheKey);
    }
  }

  private getFallbackContractInfo(symbol: string, cacheKey: string): any {
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

  async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const formattedSymbol = symbol.replace('USDT', '_USDT');
      const ticker = await client.getTicker(formattedSymbol) as any;
      return ticker.data.lastPrice;
    } catch (error: any) {
      return 0;
    }
  }

  // ==================== POSITION MANAGEMENT ====================

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

      const positionId = this.orderManager.generatePositionId();
      this.totalOrders++;
      
      return {success: true, positionId, realPositionId};

    } catch (err: any) {
      return {success: false};
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
        return false;
      }

      if (position) {
        const profit = await this.calculateProfitForQuantity(position, currentPrice, closeQty);
        this.totalProfit += profit;
      }
      
      return true;

    } catch (err: any) {
      return false;
    }
  }

  // ==================== REAL-TIME DCA & SL/TP MONITORING ====================

  private async executeRealTimeDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    const now = Date.now();
    const lastCheck = this.lastDcaCheck.get(symbol) || 0;
    if (now - lastCheck < 5000) {
      return;
    }
    this.lastDcaCheck.set(symbol, now);

    if (position.dcaCount >= STRATEGY_CONFIG.maxDcaTimes) {
      return;
    }

    try {
      const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
      
      const dcaChecks = position.dcaLevels.map(async (level, i) => {
        if (!level.executed && priceChange >= level.priceChangePercent) {
          console.log(`🎯 DCA SIGNAL: ${symbol} | Level ${i+1} | Price Change: ${priceChange.toFixed(2)}%`);
          
          const dcaQty = await this.calculatePositionSize(
            symbol, 
            STRATEGY_CONFIG.initialPositionPercent * level.addRatio
          );
          
          if (dcaQty > 0 && await this.executeDCAOrder(symbol, dcaQty, position, currentPrice, `DCA_LEVEL_${i+1}`)) {
            level.executed = true;
          }
        }
      });

      await Promise.allSettled(dcaChecks);

    } catch (error) {
      console.error(`DCA error for ${symbol}:`, error);
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

    this.recalculateSLTPAfterDCA(position);
    
    console.log(`✅ DCA ${position.dcaCount} EXECUTED: ${symbol} | New Avg: ${position.averagePrice.toFixed(6)} | Reason: ${reason}`);
  }

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

  private async checkImmediateSLTP(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
    
    const tpChecks = position.takeProfitLevels.map(async (level, i) => {
      if (!level.executed) {
        const shouldTP = profitData.priceChangePercent <= -level.priceChangePercent;

        if (shouldTP) {
          await this.executeTP(symbol, position, level, i, profitData);
        }
      }
    });

    const slChecks = position.stopLossLevels.map(async (level, i) => {
      if (!level.executed) {
        const shouldSL = profitData.priceChangePercent >= level.priceChangePercent;

        if (shouldSL) {
          await this.executeSL(symbol, position, level, i, profitData);
        }
      }
    });

    await Promise.allSettled([...tpChecks, ...slChecks]);
  }

  private async executeTP(symbol: string, position: PositionData, level: TakeProfitLevel, index: number, profitData: any): Promise<void> {
    const remainingQty = position.positionSize - position.closedAmount;
    let closeQty = level.quantity || remainingQty * level.closeRatio;
    
    const contractInfo = await this.getContractInfo(symbol);
    closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
    closeQty = Math.min(closeQty, remainingQty);
    
    if (closeQty > 0) {
      console.log(`🎯 TP ${index+1} TRIGGERED: ${symbol} | Target: ${level.priceChangePercent}% | Current: ${profitData.priceChangePercent.toFixed(2)}%`);
      
      const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `TP${index+1}`, position.positionId);
      if (closeSuccess) {
        position.closedAmount += closeQty;
        level.executed = true;

        this.recalculateSLTPAfterPartialClose(position);
        
        if (position.closedAmount >= position.positionSize) {
          this.cleanupPosition(symbol);
        }
      }
    }
  }

  private async executeSL(symbol: string, position: PositionData, level: StopLossLevel, index: number, profitData: any): Promise<void> {
    const remainingQty = position.positionSize - position.closedAmount;
    let closeQty = level.quantity || remainingQty * level.closeRatio;
    
    const contractInfo = await this.getContractInfo(symbol);
    closeQty = this.roundVolume(closeQty, contractInfo.volumePrecision);
    closeQty = Math.min(closeQty, remainingQty);
    
    if (closeQty > 0) {
      console.log(`🛑 SL ${index+1} TRIGGERED: ${symbol} | Stop: ${level.priceChangePercent}% | Current: ${profitData.priceChangePercent.toFixed(2)}%`);
      
      const closeSuccess = await this.closePosition(symbol, closeQty, 'SHORT', `SL${index+1}`, position.positionId);
      if (closeSuccess) {
        position.closedAmount += closeQty;
        level.executed = true;

        this.recalculateSLTPAfterPartialClose(position);
        
        if (position.closedAmount >= position.positionSize) {
          this.cleanupPosition(symbol);
        }
      }
    }
  }

  private async checkTrailingStopLoss(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (!STRATEGY_CONFIG.trailingStopLoss.enabled || !position.trailingStopLoss) {
      return;
    }

    const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);

    if (!position.trailingStopLoss.activated && profitData.priceChangePercent <= -STRATEGY_CONFIG.trailingStopLoss.activationProfitPercent) {
      position.trailingStopLoss.activated = true;
      position.trailingStopLoss.activationPrice = currentPrice;
      position.trailingStopLoss.currentStopPrice = currentPrice * (1 + STRATEGY_CONFIG.trailingStopLoss.trailDistancePercent / 100);
      position.trailingStopLoss.highestProfit = profitData.priceChangePercent;
      console.log(`🛡️ TRAILING SL ACTIVATED: ${symbol} | Activation: ${currentPrice}`);
    }
    
    if (position.trailingStopLoss.activated) {
      if (profitData.priceChangePercent < position.trailingStopLoss.highestProfit) {
        position.trailingStopLoss.highestProfit = profitData.priceChangePercent;
        const newStopPrice = currentPrice * (1 + STRATEGY_CONFIG.trailingStopLoss.trailDistancePercent / 100);
        if (newStopPrice < position.trailingStopLoss.currentStopPrice) {
          position.trailingStopLoss.currentStopPrice = newStopPrice;
          console.log(`🛡️ TRAILING SL UPDATED: ${symbol} | New Stop: ${newStopPrice}`);
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
          }
        }
      }
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

  async addToPosition(symbol: string, quantity: number, side: 'SHORT', signalType: string): Promise<boolean> {
    try {
      const contractInfo = await this.getContractInfo(symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      if (currentPrice <= 0) return false;
      
      let openQty = this.roundVolume(quantity, contractInfo.volumePrecision);
      
      if (openQty <= 0) return false;

      const formattedSymbol = symbol.replace('USDT', '_USDT');
      const orderSide = 3;

      console.log(`🔔 DCA ORDER: ${symbol} | ${openQty} contracts | Price: ${currentPrice} | Side: SHORT`);

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

      return orderResponse.success === true && orderResponse.code === 0;

    } catch (err: any) {
      return false;
    }
  }

  async calculateProfitForQuantity(position: PositionData, currentPrice: number, quantity: number): Promise<number> {
    const contractInfo = await this.getContractInfo(position.symbol);
    return (position.averagePrice - currentPrice) * quantity * contractInfo.contractSize;
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

  // ==================== COIN SCANNING & TRACKING ====================

  async getAllFuturePairs(): Promise<string[]> {
    try {
      const response = await axios.get<any>("https://contract.mexc.com/api/v1/contract/detail");
      const data = response.data;
      let contracts: any[] = [];
      
      if (Array.isArray(data.data)) {
        contracts = data.data;
      } else if (data.data && typeof data.data === 'object') {
        contracts = [data.data];
      }
      
      const symbols = contracts
        .filter((contract: any) => {
          if (!contract.symbol || !contract.symbol.includes('USDT')) return false;
          return true;
        })
        .map((contract: any) => contract.symbol.replace('_USDT', 'USDT'));

      return symbols;
    } catch (error: any) {
      return [];
    }
  }

  private hasMinimumBalance(): boolean {
    if (this.initialBalance === 0) return true;
    const minBalance = this.initialBalance * STRATEGY_CONFIG.minAccountBalancePercent;
    return this.accountBalance >= minBalance;
  }

  async enterPosition(symbol: string, signalType: string, hasStrongBearishCandle: boolean): Promise<void> {
    if (this.positions.has(symbol)) return;

    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0 || !this.hasMinimumBalance()) return;

      const initialQty = await this.calculatePositionSize(symbol, STRATEGY_CONFIG.initialPositionPercent);

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
        executed: false
      }));

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
        maxDcaVolume,
        isStrongTrend: hasStrongBearishCandle
      };

      this.positions.set(symbol, position);

      console.log(`✅ POSITION OPENED: ${symbol} | Size: ${initialQty} (${(STRATEGY_CONFIG.initialPositionPercent * 100).toFixed(1)}%) | Entry: ${actualPrice} | Signal: ${signalType} | Strong Trend: ${hasStrongBearishCandle}`);

    } catch (error) {
      console.error(`❌ Failed to enter position for ${symbol}:`, error);
    }
  }

  private cleanupPosition(symbol: string): void {
    this.positions.delete(symbol);
    this.lastDcaCheck.delete(symbol);
    console.log(`🧹 Cleaned up position: ${symbol}`);
  }

  // ==================== OPTIMIZED STATUS DISPLAY ====================

  private async displayRealTimeStatus(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStatusDisplay < this.statusDisplayInterval) {
      return;
    }

    this.lastStatusDisplay = now;
    
    console.log(`\n📊 [${new Date().toLocaleTimeString()}] PARALLEL SYSTEM STATUS:`);
    console.log(`   💰 Balance: ${this.accountBalance.toFixed(2)} USDT`);
    console.log(`   🔍 Tracking: ${this.trackingCoins.size} coins`);
    console.log(`   💼 Positions: ${this.positions.size}`);
    console.log(`   📈 Orders: ${this.totalOrders}`);
    console.log(`   💵 PnL: ${this.totalProfit.toFixed(2)} USDT`);
    
    if (this.positions.size > 0) {
      console.log(`\n💼 ACTIVE POSITIONS (Real-time):`);
      
      const positionPromises = Array.from(this.positions.entries()).map(async ([symbol, position]) => {
        const currentPrice = await this.getCurrentPrice(symbol);
        const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
        const status = profitData.profit >= 0 ? '🟢 PROFIT' : '🔴 LOSS';
        const closedPercent = ((position.closedAmount / position.positionSize) * 100).toFixed(1);
        
        let dcaInfo = '';
        if (position.dcaCount > 0) {
          dcaInfo = ` | DCA: ${position.dcaCount}/${STRATEGY_CONFIG.maxDcaTimes}`;
        }

        let trendInfo = '';
        if (position.isStrongTrend) {
          trendInfo = ` | 🚨 STRONG TREND`;
        }
        
        return `   ${symbol}: ${status} $${profitData.profit.toFixed(2)} (${profitData.priceChangePercent.toFixed(1)}%) | Closed: ${closedPercent}%${dcaInfo}${trendInfo}`;
      });

      const positionResults = await Promise.allSettled(positionPromises);
      positionResults.forEach(result => {
        if (result.status === 'fulfilled') {
          console.log(result.value);
        }
      });
    }

    if (this.trackingCoins.size > 0) {
      console.log(`\n🔍 TRACKING COINS (Real-time):`);
      for (const [symbol, coinData] of this.trackingCoins.entries()) {
        let statusIcon = '⏳';
        if (coinData.status === 'READY_TO_ENTER') statusIcon = '🎯';
        
        let bearishInfo = '';
        if (coinData.hasStrongBearishCandle) {
          bearishInfo = ` | 🚨 BEARISH`;
        }
        
        console.log(`   ${statusIcon} ${symbol}: ${coinData.signalType} | Vol: ${(coinData.volume24h/1000000).toFixed(2)}M${bearishInfo}`);
      }
    }
    
    console.log('');
  }

  // ==================== MAIN BOT LOOP - SIMPLIFIED ====================

  async run(): Promise<void> {
    console.log('🚀 Starting PARALLEL PROCESSING BOT');
    console.log('🔄 PARALLEL SYSTEMS: Monitoring (3s), Scanning (2m), Entry (10s), Status (1m)');
    console.log('📊 VOLUME FILTER: < 5M USDT only');
    console.log('💰 POSITION SIZE: 20% account | DCA: 2x 20%');
    console.log('📈 TOTAL EXPOSURE: 60% account (20% + 40% DCA)');
    console.log('🎯 TP MỞ RỘNG: 3 levels (4%-8%-15%)');
    
    this.accountBalance = await this.getUSDTBalance();
    this.initialBalance = this.accountBalance;
    
    if (this.accountBalance <= 0) {
      console.error('❌ Cannot get balance');
      return;
    }
    
    console.log(`💰 Initial Balance: ${this.initialBalance.toFixed(2)} USDT\n`);
    
    this.isRunning = true;

    this.startParallelProcessing();

    console.log('✅ All parallel systems started successfully');
    console.log('🎯 Bot is now running with parallel processing...');
  }

  stop(): void {
    this.isRunning = false;
    this.stopParallelProcessing();
    console.log(`\n🛑 All parallel systems stopped | Total Orders: ${this.totalOrders} | Total PnL: ${this.totalProfit.toFixed(2)} USDT`);
  }
}

const bot = new VolumeFilteredStrategyBot();

process.on('SIGINT', () => {
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bot.stop();
  process.exit(0);
});

bot.run().catch(console.error);
