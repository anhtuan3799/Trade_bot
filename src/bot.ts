import * as dotenv from "dotenv";
import { MexcFuturesClient } from "mexc-futures-sdk";
import axios from "axios";
import crypto from "crypto";
import { HttpsProxyAgent } from 'https-proxy-agent';

dotenv.config();

const WEB_TOKEN = process.env.MEXC_AUTH_TOKEN ?? "";
const LEVERAGE = 21;

// =========================
// CẤU HÌNH PROXY VÀ API KEY
// =========================
const PROXY_URL = process.env.PROXY_URL || 'http://user1762258669:pass1762258669@14.224.225.105:39411';
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const API_KEY = process.env.MEXC_API_KEY || process.env.MEXC_AUTH_TOKEN || "";
const API_SECRET = process.env.MEXC_SECRET_KEY || "";

const BASE_URL = 'https://api.mexc.com';

const client = new MexcFuturesClient({
  authToken: WEB_TOKEN,
  baseURL: "https://futures.mexc.co/api/v1",
});

// =========================
// HÀM CHUYỂN TIỀN SPOT ↔ FUTURES
// =========================
function signParams(params: any): string {
  const queryString = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(queryString)
    .digest('hex');
  return `${queryString}&signature=${signature}`;
}

async function universalTransfer({ fromAccountType, toAccountType, asset, amount }: {
  fromAccountType: string;
  toAccountType: string;
  asset: string;
  amount: string;
}): Promise<boolean> {
  const timestamp = Date.now();
  const recvWindow = 5000;

  const params = {
    fromAccountType,
    toAccountType,
    asset,
    amount: String(amount),
    recvWindow,
    timestamp,
  };

  const signedQuery = signParams(params);
  const url = `${BASE_URL}/api/v3/capital/transfer?${signedQuery}`;

  try {
    const res = await axios.post(url, null, {
      headers: {
        'X-MEXC-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
      httpsAgent: proxyAgent,
      timeout: 15000,
    });

    console.log(`✅ [TRANSFER_SUCCESS] ${fromAccountType} → ${toAccountType}: ${amount} ${asset}`);
    return true;

  } catch (err: any) {
    if (err.response) {
      console.error('❌ [TRANSFER_FAILED] API error:', err.response.data);
    } else {
      console.error('❌ [TRANSFER_FAILED] Network error:', err.message);
    }
    return false;
  }
}

async function getSpotBalance(asset: string = 'USDT'): Promise<number> {
  const timestamp = Date.now();
  const recvWindow = 5000;

  const params = {
    recvWindow,
    timestamp,
  };

  const signedQuery = signParams(params);
  const url = `${BASE_URL}/api/v3/account?${signedQuery}`;

  try {
    const res = await axios.get(url, {
      headers: {
        'X-MEXC-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
      httpsAgent: proxyAgent,
      timeout: 15000,
    });

    if (res.data && Array.isArray(res.data.balances)) {
      const assetBalance = res.data.balances.find((b: any) => b.asset === asset);
      return parseFloat(assetBalance?.free || '0');
    }
    return 0;
  } catch (err: any) {
    console.error('❌ [SPOT_BALANCE_ERROR]', err.message);
    return 0;
  }
}

// =========================
// INTERFACES VÀ CẤU HÌNH CHÍNH
// =========================
interface MexcResponse<T = any> {
  code: number;
  data: T;
  msg?: string;
  success?: boolean;
}

interface TickerDataResponse {
  symbol: string;
  lastPrice: string;
  rose: string;
  amount24: string;
}

interface KlineDataResponse {
  time: number[];
  open: string[];
  close: string[];
  high: string[];
  low: string[];
  vol: string[];
}

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
  initialPositionPercent: 0.2,
  maxTotalPositionPercent: 0.28,
  max24hChangePercent: 30,
  maxVolume24h: 10000000,
  minVolume24h: 10000,
  maxHotCoinVolume: 50000000,
  targetLowVolumeCoins: 500,
  fakePumpMinPercent: 10,
  volumeSpikeThreshold: 2.5,
  maxActivePositions: 5,
  maxTrackingCoins: 8,
  minAccountBalancePercent: 0.1,
  emaPeriod: 21,
  resistanceLookback: 20,
  volumeDropThreshold: 0.6,
  
  pumpStrategy: {
    minRetracePercent: 3, 
    maxDcaCount: 12,
    dcaPercent: 0.05,
    maxTotalDcaPercent: 0.6,
    negativeDcaThreshold: -50,
  },

  trendAnalysis: {
    enabled: true,
    timeframes: [
      { interval: 'Hour4', weight: 0.6, emaPeriod: 200 },
      { interval: 'Hour1', weight: 0.4, emaPeriod: 200 }
    ],
    minBearishScore: 0.6,
    volumeConfirmation: true,
    requiredBearishTimeframes: 2
  },

  riskManagement: {
    slAfterMaxDca: -80,
    volumeBasedTakeProfit: {
      lowVolume: { firstTp: 4, secondTp: 6 },
      mediumVolume: { firstTp: 1.5, secondTp: 3 },
      highVolume: { firstTp: 3, secondTp: 4 }
    },
    partialTakeProfitRatio: 0.5,
    trendTakeProfitRatio: 0.5
  },

  improvedDcaStrategy: {
    enabled: true,
    fibLevels: [0.236, 0.382, 0.5, 0.618, 0.786],
    dcaPercent: 0.05,
    maxDcaCount: 12,
    maxTotalDcaPercent: 0.05,
    minDcaInterval: 180000,
    minPriceMovement: 0.5,
    minCandlesForRetrace: 3,
    maxRetraceCandles: 10,
    requireBearishConfirmation: true,
    requireVolumeConfirmation: true,
    volumeSpikeThreshold: 1.5
  },
  
  dcaLevels: [
    { priceChangePercent: 0.5, addRatio: 0.1, condition: 'MICRO_PULLBACK' },
    { priceChangePercent: 1.0, addRatio: 0.1, condition: 'RESISTANCE_TOUCH' },
    { priceChangePercent: 1.5, addRatio: 0.1, condition: 'STRONG_RESISTANCE' }
  ],
  
  maxDcaTimes: 1000,
  
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
    reversalConfirmationPct: -3, 
    strongReversalPct: -8,
    volumeSpikeRatio: 2.0,
    maxTrackingTime: 30 * 60 * 1000
  },
  
  dcaConfig: {
    negativeDcaPercent: 0.05,
    maxTotalDcaPercent: 42.0,
    trendWeakThreshold: -0.1,
    negativeDcaMinPercent: 1.0,
    minDcaInterval: 180000,
    minPriceMovement: 0.5,
    maxConsecutiveDca: 6,
    dcaCooldown: 300000
  },

  trailingStopConfig: {
    activationProfitPercent: 2,
    partialClosePercent: 50,
    fullCloseAtEntry: true
  },

  // THÊM CẤU HÌNH CHUYỂN TIỀN
  balanceConfig: {
    minFuturesBalance: 50,
    transferAmount: 50,
    checkInterval: 60000
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

async function withRetry<T>(operation: () => Promise<T>, maxRetries: number = 3, delay: number = 1000): Promise<T> {
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

// =========================
// CÁC INTERFACE CHÍNH
// =========================
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

interface ImprovedDcaLevel {
  fibLevel: number;
  price: number;
  executed: boolean;
  timestamp?: number;
}

interface RiskManagementData {
  hardStopLossPrice?: number;
  partialTakeProfitExecuted: boolean;
  secondTakeProfitExecuted: boolean;
  maxDcaReached: boolean;
  initialEntryPrice: number;
  volumeBasedTP: {
    firstTp: number;
    secondTp: number;
    volumeCategory: 'LOW' | 'MEDIUM' | 'HIGH';
  };
}

interface TrailingStopData {
  activated: boolean;
  maxProfitPercent: number;
  partialCloseExecuted: boolean;
  lastTrailingUpdate: number;
  activationPrice: number;
}

interface PositionData {
  symbol: string;
  entryPrice: number;
  positionSize: number;
  takeProfitLevels: TakeProfitLevel[];
  stopLossLevels: StopLossLevel[];
  dcaLevels: DcaLevel[];
  improvedDcaLevels: ImprovedDcaLevel[];
  timestamp: number;
  initialQty: number;
  closedAmount: number;
  dcaCount: 0;
  side: 'SHORT';
  averagePrice: number;
  totalQty: number;
  signalType: string;
  positionId: string;
  realPositionId?: string;
  lastCheckTime?: number;
  checkCount: number;
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
  improvedDcaCount: number;
  extendedTpLevels: number[];
  lastImprovedDcaTime?: number;
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
  lastImprovedDcaPrice?: number;
  lastNegativeDcaTime?: number;
  consecutiveNegativeDcaCount: number;
  consecutiveImprovedDcaCount: number;
  strategyType: 'PUMP';
  volume24h?: number;
  initialAccountBalance?: number;
  lowestPrice?: number;
  highestPrice?: number;
  riskManagement: RiskManagementData;
  retraceStartPrice?: number;
  retracePeakPrice?: number;
  retraceLevels: number[];
  lastRetraceCheck?: number;
  trailingStop: TrailingStopData;
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
  currentPrice?: number;
  volume24h?: number;
  dropFromPeak?: number;
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
  trendPriority?: number;
}

interface TrendAnalysis {
  symbol: string;
  overallScore: number;
  trendDirection: 'STRONG_BEARISH' | 'BEARISH' | 'NEUTRAL' | 'BULLISH';
  timeframeScores: {
    interval: string;
    score: number;
    direction: 'BEARISH' | 'BULLISH' | 'NEUTRAL';
    priceVsEMA: number;
    emaSlope: number;
    volumeTrend: number;
  }[];
  confidence: number;
  priority: number;
}

interface TickerData {
  symbol: string;
  lastPrice: number;
  change24h: number;
  amount24: number;
}

interface VolumeRankedSymbol {
  symbol: string;
  volume24h: number;
  change24h: number;
}

interface CoinAgeCache {
  listingTime: number;
  lastUpdated: number;
  ageInDays: number;
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

class IndividualCoinTracker {
  private symbol: string;
  private bot: FakePumpStrategyBot;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private lastProcessTime: number = 0;
  private processInterval: number = 8000;

  constructor(symbol: string, bot: FakePumpStrategyBot) {
    this.symbol = symbol;
    this.bot = bot;
  }

  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    this.intervalId = setInterval(async () => {
      if (!this.isRunning) return;
      
      const now = Date.now();
      if (now - this.lastProcessTime < this.processInterval) return;
      
      this.lastProcessTime = now;
      await this.processCoin();
    }, 2000);
  }

  stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async processCoin(): Promise<void> {
    try {
      if (!this.bot.isSymbolValid(this.symbol)) {
        this.stop();
        return;
      }

      if (this.bot.hasPosition(this.symbol)) {
        this.stop();
        return;
      }

      const isOldEnough = await this.bot.checkCoinAgeWithLog(this.symbol, 'INDIVIDUAL_TRACKER');
      if (!isOldEnough) {
        this.stop();
        return;
      }

      const volume24h = await this.bot.getVolume24h(this.symbol);
      if (volume24h < STRATEGY_CONFIG.minVolume24h || volume24h > STRATEGY_CONFIG.maxVolume24h) {
        return;
      }

      const isTooVolatile = await this.bot.isCoinTooVolatile(this.symbol);
      if (isTooVolatile) {
        return;
      }

      const trendAnalysis = await this.bot.analyzeLongTermTrend(this.symbol);
      
      const indicators = await this.bot.calculateEnhancedIndicators(this.symbol);
      
      let finalConfidence = indicators.confidence;
      
      if (trendAnalysis.trendDirection === 'STRONG_BEARISH') {
        finalConfidence = Math.min(100, indicators.confidence + 20);
      } else if (trendAnalysis.trendDirection === 'BEARISH') {
        finalConfidence = Math.min(100, indicators.confidence + 10);
      }
      
      if (!indicators.reversalSignal || finalConfidence < 50) {
        return;
      }

      const ageInDays = await this.bot.getListingAgeDays(this.symbol);
      const coinData: CoinTrackingData = {
        symbol: this.symbol,
        currentPrice: indicators.currentPrice,
        dailyVolatility: indicators.dailyVolatility,
        volume24h: indicators.volume24h,
        timestamp: Date.now(),
        status: indicators.hasEntrySignal ? 'READY_TO_ENTER' : 'TRACKING',
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
        listingAgeDays: ageInDays,
        peakPrice: indicators.peakPrice,
        dropFromPeak: indicators.dropFromPeak,
        volumeRatio: indicators.volumeRatio,
        hasBearishPattern: indicators.hasBearishPattern,
        bearishPatterns: indicators.bearishPatterns,
        ma5: indicators.ma5,
        ma10: indicators.ma10,
        priceUnderMA: indicators.priceUnderMA,
        consecutiveBearish: indicators.consecutiveBearish,
        confidence: finalConfidence,
        riskLevel: indicators.riskLevel,
        pumpDurationCandles: indicators.pumpDurationCandles,
        requiredRetracePercent: indicators.requiredRetracePercent,
        trendPriority: trendAnalysis.priority
      };

      this.bot.updateTrackingCoin(this.symbol, coinData);

      if (indicators.hasEntrySignal && 
          this.bot.hasMinimumBalance() && 
          this.bot.canOpenNewPosition()) {
        
        const finalAgeCheck = await this.bot.checkCoinAgeWithLog(this.symbol, 'TRƯỚC_KHI_VÀO_LỆNH');
        if (!finalAgeCheck) {
          return;
        }
        
        await this.bot.enterPosition(this.symbol, indicators.signalType, finalConfidence, indicators.riskLevel);
        this.stop();
      }

    } catch (error) {
      // Bỏ log lỗi
    }
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
  private validSymbolsCache: Set<string> = new Set();
  private invalidSymbolsCache: Set<string> = new Set();
  private lastSymbolValidation: number = 0;
  private readonly SYMBOL_VALIDATION_TTL = 60 * 60 * 1000;

  private concurrentRequests: number = 0;
  private maxConcurrentRequests: number = 8;
  private lastRequestTime: number = 0;
  private requestsPerSecond: number = 8;

  private trendAnalysisCache: Map<string, { data: TrendAnalysis; timestamp: number }> = new Map();
  private readonly TREND_CACHE_TTL = 10 * 60 * 1000;

  private individualTrackers: Map<string, IndividualCoinTracker> = new Map();
  private pumpTrackers: Map<string, IndividualCoinTracker> = new Map();

  private allTickersCache: Map<string, TickerData> = new Map();
  private lastAllTickersUpdate: number = 0;
  private readonly ALL_TICKERS_CACHE_TTL = 10000;

  private coinAgeCache: Map<string, CoinAgeCache> = new Map();
  private readonly COIN_AGE_CACHE_TTL = 60 * 60 * 1000;
  private lastCoinAgeRefresh: number = 0;
  private readonly COIN_AGE_REFRESH_INTERVAL = 30 * 60 * 1000;

  // THÊM BIẾN CHO CHỨC NĂNG CHUYỂN TIỀN
  private lastBalanceCheck: number = 0;
  private readonly BALANCE_CHECK_INTERVAL = STRATEGY_CONFIG.balanceConfig.checkInterval;

  constructor() {
    console.log('🤖 FAKE PUMP STRATEGY BOT - GỒNG LỆNH KHÔNG SL HOÀN TOÀN');
    console.log('💰 TÍCH HỢP TỰ ĐỘNG CHUYỂN TIỀN SPOT → FUTURES');
  }

  // =========================
  // CÁC HÀM CHUYỂN TIỀN MỚI
  // =========================

  /**
   * Kiểm tra và tự động chuyển tiền từ spot sang futures khi cần
   */
  private async checkAndTransferBalance(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBalanceCheck < this.BALANCE_CHECK_INTERVAL) {
      return;
    }
    this.lastBalanceCheck = now;

    try {
      const futuresBalance = this.accountBalance;
      const minFuturesBalance = STRATEGY_CONFIG.balanceConfig.minFuturesBalance;
      
      // Nếu số dư futures dưới mức tối thiểu
      if (futuresBalance < minFuturesBalance) {
        console.log(`💰 [BALANCE_CHECK] Futures balance: $${futuresBalance.toFixed(2)} < $${minFuturesBalance}, checking spot balance...`);
        
        const spotBalance = await getSpotBalance('USDT');
        
        if (spotBalance > 0) {
          // Tính số tiền cần chuyển
          let transferAmount = STRATEGY_CONFIG.balanceConfig.transferAmount;
          
          // Nếu số dư spot ít hơn 50 USDT thì chuyển hết
          if (spotBalance < transferAmount) {
            transferAmount = spotBalance;
          }
          
          console.log(`🔄 [BALANCE_TRANSFER] Transferring $${transferAmount.toFixed(2)} from SPOT to FUTURES...`);
          
          const success = await universalTransfer({
            fromAccountType: 'SPOT',
            toAccountType: 'FUTURES',
            asset: 'USDT',
            amount: transferAmount.toFixed(2)
          });
          
          if (success) {
            // Đợi một chút để hệ thống cập nhật số dư
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Cập nhật lại số dư futures
            this.accountBalance = await this.getUSDTBalance();
            console.log(`✅ [BALANCE_UPDATED] New futures balance: $${this.accountBalance.toFixed(2)}`);
          }
        } else {
          console.log('⚠️ [BALANCE_CHECK] Spot balance is 0, cannot transfer');
        }
      }
    } catch (error) {
      console.error('❌ [BALANCE_CHECK_ERROR]', error);
    }
  }

  /**
   * Kiểm tra số dư trước khi vào lệnh
   */
  private async ensureSufficientBalance(): Promise<boolean> {
    const minBalance = this.initialBalance * STRATEGY_CONFIG.minAccountBalancePercent;
    
    if (this.accountBalance < minBalance) {
      console.log(`⚠️ [BALANCE_LOW] Current balance: $${this.accountBalance.toFixed(2)}, minimum required: $${minBalance.toFixed(2)}`);
      
      // Thử chuyển tiền ngay lập tức
      await this.checkAndTransferBalance();
      
      // Kiểm tra lại sau khi chuyển
      this.accountBalance = await this.getUSDTBalance();
      
      if (this.accountBalance < minBalance) {
        console.log('❌ [INSUFFICIENT_BALANCE] Cannot open new position');
        return false;
      }
    }
    
    return true;
  }

  // =========================
  // CÁC PHƯƠNG THỨC HIỆN CÓ (giữ nguyên)
  // =========================

  private async refreshCoinListingAge(symbol: string): Promise<void> {
    try {
      const candles = await this.fetchKlineData(symbol, "Day1", 30);
      
      let listingTime: number;
      if (candles.length === 0) {
        listingTime = Date.now() - (15 * 24 * 60 * 60 * 1000);
      } else {
        listingTime = Math.min(...candles.map(c => c.timestamp));
      }

      const currentTime = Date.now();
      const ageInMs = currentTime - listingTime;
      const ageInDays = ageInMs / (1000 * 60 * 60 * 24);

      this.coinAgeCache.set(symbol, {
        listingTime,
        lastUpdated: currentTime,
        ageInDays
      });

    } catch (error) {
      const fallbackTime = Date.now() - (15 * 24 * 60 * 60 * 1000);
      this.coinAgeCache.set(symbol, {
        listingTime: fallbackTime,
        lastUpdated: Date.now(),
        ageInDays: 15
      });
    }
  }

  private async refreshAllCoinAges(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCoinAgeRefresh < this.COIN_AGE_REFRESH_INTERVAL) {
      return;
    }

    const symbolsToRefresh = new Set<string>();
    
    for (const symbol of this.trackingCoins.keys()) {
      symbolsToRefresh.add(symbol);
    }
    
    for (const symbol of this.pumpTrackingCoins.keys()) {
      symbolsToRefresh.add(symbol);
    }
    
    for (const symbol of this.positions.keys()) {
      symbolsToRefresh.add(symbol);
    }
    
    for (const symbol of this.candidateCoins.keys()) {
      symbolsToRefresh.add(symbol);
    }

    let refreshedCount = 0;
    const refreshPromises: Promise<void>[] = [];

    for (const symbol of symbolsToRefresh) {
      const cache = this.coinAgeCache.get(symbol);
      if (!cache || (now - cache.lastUpdated) > this.COIN_AGE_CACHE_TTL) {
        refreshPromises.push(this.refreshCoinListingAge(symbol));
        refreshedCount++;
        
        if (refreshPromises.length >= 5) {
          await Promise.all(refreshPromises);
          refreshPromises.length = 0;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    if (refreshPromises.length > 0) {
      await Promise.all(refreshPromises);
    }

    this.lastCoinAgeRefresh = now;
  }

  public async checkCoinAgeWithLog(symbol: string, context: string): Promise<boolean> {
    const ageInDays = await this.getListingAgeDays(symbol);
    const isOldEnough = ageInDays >= STRATEGY_CONFIG.reversalDetection.minListingDays;
    
    return isOldEnough;
  }

  isSymbolValid(symbol: string): boolean {
    return this.validSymbolsCache.has(symbol);
  }

  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  hasMinimumBalance(): boolean {
    if (this.initialBalance === 0) return true;
    const minBalance = this.initialBalance * STRATEGY_CONFIG.minAccountBalancePercent;
    return this.accountBalance >= minBalance;
  }

  canOpenNewPosition(): boolean {
    return this.positions.size < STRATEGY_CONFIG.maxActivePositions;
  }

  updateTrackingCoin(symbol: string, coinData: CoinTrackingData): void {
    this.trackingCoins.set(symbol, coinData);
  }

  // ... (giữ nguyên tất cả các phương thức khác)

  async enterPosition(symbol: string, signalType: string, confidence: number, riskLevel: string): Promise<void> {
    // KIỂM TRA SỐ DƯ TRƯỚC KHI VÀO LỆNH
    const hasSufficientBalance = await this.ensureSufficientBalance();
    if (!hasSufficientBalance) {
      return;
    }

    // KIỂM TRA TUỔI COIN NGHIÊM NGẶT TRƯỚC KHI VÀO LỆNH
    const ageCheck = await this.checkCoinAgeWithLog(symbol, 'KIỂM_TRA_CUỐI_CÙNG_TRƯỚC_LỆNH');
    if (!ageCheck) {
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
      const volume24h = await this.getVolume24h(symbol);
      
      let firstTp = 0;
      let secondTp = 0;
      let volumeCategory: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH';

      if (volume24h < 1000000) {
        firstTp = STRATEGY_CONFIG.riskManagement.volumeBasedTakeProfit.lowVolume.firstTp;
        secondTp = STRATEGY_CONFIG.riskManagement.volumeBasedTakeProfit.lowVolume.secondTp;
        volumeCategory = 'LOW';
      } else if (volume24h >= 5000000 && volume24h <= 10000000) {
        firstTp = STRATEGY_CONFIG.riskManagement.volumeBasedTakeProfit.mediumVolume.firstTp;
        secondTp = STRATEGY_CONFIG.riskManagement.volumeBasedTakeProfit.mediumVolume.secondTp;
        volumeCategory = 'MEDIUM';
      } else {
        firstTp = STRATEGY_CONFIG.riskManagement.volumeBasedTakeProfit.highVolume.firstTp;
        secondTp = STRATEGY_CONFIG.riskManagement.volumeBasedTakeProfit.highVolume.secondTp;
        volumeCategory = 'HIGH';
      }

      const riskManagement: RiskManagementData = {
        partialTakeProfitExecuted: false,
        secondTakeProfitExecuted: false,
        maxDcaReached: false,
        initialEntryPrice: actualPrice,
        volumeBasedTP: {
          firstTp,
          secondTp,
          volumeCategory
        }
      };

      const trailingStop: TrailingStopData = {
        activated: false,
        maxProfitPercent: 0,
        partialCloseExecuted: false,
        lastTrailingUpdate: 0,
        activationPrice: actualPrice
      };

      const position: PositionData = {
        symbol,
        entryPrice: actualPrice,
        positionSize: initialQty,
        takeProfitLevels: [],
        stopLossLevels: [],
        dcaLevels: [],
        improvedDcaLevels: [],
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
        pendingDcaOrders: new Map(),
        sltpRecalculated: false,
        originalTakeProfitLevels: [],
        originalStopLossLevels: [],
        consecutiveDcaCount: 0,
        aggressiveDcaMode: false,
        totalDcaVolume: 0,
        maxDcaVolume: initialQty * 3,
        confidence,
        improvedDcaCount: 0,
        extendedTpLevels: [],
        currentTpLevels: [],
        currentSlLevels: [],
        riskLevel: riskLevel,
        dcaDisabled: false,
        totalDcaPercent: 0,
        trendStrength: 0,
        lastDcaPrice: actualPrice,
        lastNegativeDcaPrice: actualPrice,
        lastImprovedDcaPrice: actualPrice,
        lastNegativeDcaTime: Date.now(),
        lastImprovedDcaTime: Date.now(),
        consecutiveNegativeDcaCount: 0,
        consecutiveImprovedDcaCount: 0,
        strategyType: 'PUMP',
        volume24h: volume24h,
        initialAccountBalance: this.accountBalance,
        lowestPrice: actualPrice,
        highestPrice: actualPrice,
        riskManagement,
        retraceLevels: [],
        trailingStop
      };

      this.positions.set(symbol, position);

      this.stopIndividualTracker(symbol);
      this.trackingCoins.delete(symbol);

      console.log(`✅ [POSITION_OPENED] ${symbol} | Size: ${initialQty} | Entry: $${actualPrice.toFixed(6)}`);
      console.log(`💰 [BALANCE_UPDATED] Số dư mới: $${this.accountBalance.toFixed(2)}`);

    } catch (error) {
      // Bỏ log lỗi
    }
  }

  async run(): Promise<void> {
    console.log('🚀 FAKE PUMP STRATEGY BOT STARTED');
    console.log('💰 TÍCH HỢP TỰ ĐỘNG CHUYỂN TIỀN SPOT → FUTURES');

    await this.validateAllSymbols();

    await this.fetchBinanceSymbols();
    
    this.accountBalance = await this.getUSDTBalance();
    this.initialBalance = this.accountBalance;
    
    if (this.accountBalance <= 0) {
      console.error('❌ [BALANCE_ERROR] Cannot get balance');
      return;
    }
    
    console.log(`💰 [BALANCE] Initial Balance: $${this.initialBalance.toFixed(2)}`);
    
    this.isRunning = true;

    // Thêm interval để refresh coin ages định kỳ
    const coinAgeRefreshInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(coinAgeRefreshInterval);
        return;
      }
      await this.refreshAllCoinAges();
    }, this.COIN_AGE_REFRESH_INTERVAL);

    const positionIdUpdateInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(positionIdUpdateInterval);
        return;
      }
      await this.updateRealPositionIds();
    }, 600000);

    const symbolValidationInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(symbolValidationInterval);
        return;
      }
      if (Date.now() - this.lastSymbolValidation > this.SYMBOL_VALIDATION_TTL) {
        await this.validateAllSymbols();
      }
    }, 30 * 60 * 1000);

    const mainLoop = async (): Promise<void> => {
      if (!this.isRunning) return;

      try {
        this.accountBalance = await this.getUSDTBalance();
        
        // KIỂM TRA VÀ CHUYỂN TIỀN TỰ ĐỘNG
        await this.checkAndTransferBalance();
        
        // Refresh coin ages trước khi scan
        await this.refreshAllCoinAges();
        
        await this.scanForPumpSignals();
        
        await this.updatePumpTrackingCoins();
        
        await this.scanAndSelectTopCoins();
        this.updateTrackingList();
        await this.trackTopCoinsRealTime();
        await this.managePositions();
        
        await this.scanDcaOpportunities();

        setImmediate(mainLoop);

      } catch (error) {
        setTimeout(mainLoop, 5000);
      }
    };

    mainLoop();
  }

  // ... (giữ nguyên tất cả các phương thức khác)

  stop(): void {
    this.isRunning = false;
    if (this.realTimeMonitorInterval) {
      clearInterval(this.realTimeMonitorInterval);
      this.realTimeMonitorInterval = null;
    }
    
    for (const [symbol, tracker] of this.individualTrackers.entries()) {
      tracker.stop();
    }
    this.individualTrackers.clear();
    
    for (const [symbol, tracker] of this.pumpTrackers.entries()) {
      tracker.stop();
    }
    this.pumpTrackers.clear();
    
    console.log(`🛑 Bot stopped | Orders: ${this.totalOrders} | PnL: $${this.totalProfit.toFixed(2)}`);
    console.log(`💰 [BALANCE] Final Balance: $${this.accountBalance.toFixed(2)}`);
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
