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
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

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
    const config: any = {
      headers: {
        'X-MEXC-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };

    if (proxyAgent) {
      config.httpsAgent = proxyAgent;
    }

    const res = await axios.post(url, null, config);

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
    const config: any = {
      headers: {
        'X-MEXC-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };

    if (proxyAgent) {
      config.httpsAgent = proxyAgent;
    }

    const res = await axios.get(url, config);
    const responseData = res.data as any;
      if (Array.isArray(responseData.balances)) {
        const assetBalance = responseData.balances.find((b: any) => b.asset === asset);
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
interface SpotBalance {
  asset: string;
  free: string;
  locked: string;
}

interface SpotAccountResponse {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: number;
  accountType: string;
  balances: SpotBalance[];
  permissions: string[];
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
  dcaCount: number;
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
  // CÁC PHƯƠNG THỨC CHUYỂN TIỀN MỚI
  // =========================

  private async checkAndTransferBalance(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBalanceCheck < this.BALANCE_CHECK_INTERVAL) {
      return;
    }
    this.lastBalanceCheck = now;

    try {
      const futuresBalance = this.accountBalance;
      const minFuturesBalance = STRATEGY_CONFIG.balanceConfig.minFuturesBalance;
      
      if (futuresBalance < minFuturesBalance) {
        console.log(`💰 [BALANCE_CHECK] Futures balance: $${futuresBalance.toFixed(2)} < $${minFuturesBalance}, checking spot balance...`);
        
        const spotBalance = await getSpotBalance('USDT');
        
        if (spotBalance > 0) {
          let transferAmount = STRATEGY_CONFIG.balanceConfig.transferAmount;
          
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
            await new Promise(resolve => setTimeout(resolve, 2000));
            
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

  private async ensureSufficientBalance(): Promise<boolean> {
    const minBalance = this.initialBalance * STRATEGY_CONFIG.minAccountBalancePercent;
    
    if (this.accountBalance < minBalance) {
      console.log(`⚠️ [BALANCE_LOW] Current balance: $${this.accountBalance.toFixed(2)}, minimum required: $${minBalance.toFixed(2)}`);
      
      await this.checkAndTransferBalance();
      
      this.accountBalance = await this.getUSDTBalance();
      
      if (this.accountBalance < minBalance) {
        console.log('❌ [INSUFFICIENT_BALANCE] Cannot open new position');
        return false;
      }
    }
    
    return true;
  }

  // =========================
  // CÁC PHƯƠNG THỨC CÒN THIẾU
  // =========================

  public async calculateEnhancedIndicators(symbol: string): Promise<{
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
    // Implementation for enhanced indicators
    if (!this.validSymbolsCache.has(symbol)) {
      return this.getDefaultEnhancedIndicatorResult();
    }

    try {
      const candles = await this.fetch1MinKlineData(symbol, 50);
      if (candles.length < 15) {
        return this.getDefaultEnhancedIndicatorResult();
      }

      const currentPrice = await this.getCurrentPrice(symbol);
      const volume24h = await this.getVolume24h(symbol);

      // Simplified implementation - you should replace with actual logic
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

  public async getListingAgeDays(symbol: string): Promise<number> {
    const cache = this.coinAgeCache.get(symbol);
    const now = Date.now();
    
    if (cache && (now - cache.lastUpdated) <= this.COIN_AGE_CACHE_TTL) {
      return cache.ageInDays;
    }

    await this.refreshCoinListingAge(symbol);
    return this.coinAgeCache.get(symbol)?.ageInDays || 0;
  }

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

  async getUSDTBalance(): Promise<number> {
    try {
      const usdtAsset = await client.getAccountAsset('USDT') as any;
      return usdtAsset.data.availableBalance || 0;
    } catch (e: any) {
      return 0;
    }
  }

  async fetchKlineData(symbol: string, interval: string = "Min5", limit: number = 288): Promise<SimpleCandle[]> {
    if (!this.validSymbolsCache.has(symbol)) {
      return [];
    }

    const formattedSymbol = symbol.replace('USDT', '_USDT');
    const url = `https://futures.mexc.co/api/v1/contract/kline/${formattedSymbol}`;
    
    try {
      const response = await withRetry(async () => {
        return await axios.get(url, {
          params: { interval, limit },
        });
      });
      
      const data = response.data as MexcResponse<KlineDataResponse>;
      
      if (data.success === true && data.code === 0 && data.data) {
        const obj = data.data;
        if (Array.isArray(obj.time)) {
          const candles: SimpleCandle[] = obj.time.map((t: number, idx: number) => ({
            open: parseFloat(obj.open?.[idx] || obj.close?.[idx] || '0'),
            low: parseFloat(obj.low[idx] || '0'),
            close: parseFloat(obj.close[idx] || '0'),
            high: parseFloat(obj.high[idx] || '0'),
            volume: parseFloat(obj.vol?.[idx]?.toString() || '0'),
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

  async fetch1MinKlineData(symbol: string, limit: number = 50): Promise<SimpleCandle[]> {
    return this.fetchKlineData(symbol, "Min1", limit);
  }

  async getCurrentPrice(symbol: string): Promise<number> {
    if (!this.validSymbolsCache.has(symbol)) {
      return 0;
    }

    try {
      const tickerData = await this.getTicker24hData(symbol);
      return tickerData ? tickerData.lastPrice : 0;
    } catch (error: any) {
      return 0;
    }
  }

  private async getTicker24hData(symbol: string): Promise<TickerData | null> {
    if (!this.validSymbolsCache.has(symbol) && this.invalidSymbolsCache.has(symbol)) {
      return null;
    }

    await this.updateAllTickersCache();

    const ticker = this.allTickersCache.get(symbol);
    if (ticker) {
      return ticker;
    }

    return null;
  }

  private async updateAllTickersCache(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAllTickersUpdate < this.ALL_TICKERS_CACHE_TTL) {
      return;
    }

    try {
      const response = await withRetry(async () => {
        return await axios.get("https://futures.mexc.co/api/v1/contract/ticker");
      });
      
      const data = response.data as MexcResponse<TickerDataResponse[]>;
      
      if (data && data.code === 0 && Array.isArray(data.data)) {
        this.allTickersCache.clear();
        
        data.data.forEach((ticker: TickerDataResponse) => {
          const symbol = ticker.symbol.replace('_USDT', 'USDT');
          this.allTickersCache.set(symbol, {
            symbol,
            lastPrice: parseFloat(ticker.lastPrice) || 0,
            change24h: parseFloat(ticker.rose) * 100 || 0,
            amount24: parseFloat(ticker.amount24) || 0
          });
        });
        
        this.lastAllTickersUpdate = now;
      }
    } catch (error: any) {
      // Bỏ log lỗi
    }
  }

  async getVolume24h(symbol: string): Promise<number> {
    if (!this.validSymbolsCache.has(symbol) && this.invalidSymbolsCache.has(symbol)) {
      return 0;
    }

    try {
      const tickerData = await this.getTicker24hData(symbol);
      if (tickerData) {
        return tickerData.amount24;
      }
    } catch (error) {
      // Bỏ log lỗi
    }

    return 0;
  }

  private async calculatePositionSize(symbol: string, percent: number, confidence: number = 50): Promise<number> {
    try {
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice <= 0) return 0;

      const contractInfo = await this.getContractInfo(symbol);
      
      let capital = this.accountBalance * percent;
      
      const maxPositionValue = this.accountBalance * LEVERAGE;
      const requestedPositionValue = capital * LEVERAGE;
      
      if (requestedPositionValue > maxPositionValue) {
        capital = this.accountBalance * 0.05;
      }
      
      let vol = (capital * LEVERAGE) / (currentPrice * contractInfo.contractSize);
      
      const minVol = Math.pow(10, -contractInfo.volumePrecision);
      if (vol < minVol) {
        vol = minVol;
      }
      
      const stepSize = Math.pow(10, -contractInfo.volumePrecision);
      vol = Math.floor(vol / stepSize) * stepSize;
      
      return vol;
    } catch (error) {
      return 0;
    }
  }

  async getContractInfo(symbol: string): Promise<ContractInfo> {
    if (!this.validSymbolsCache.has(symbol)) {
      return this.getFallbackContractInfo(symbol, symbol.replace('USDT', '_USDT'));
    }

    const cacheKey = symbol.replace('USDT', '_USDT');
    
    if (this.contractInfoCache.has(cacheKey)) {
      return this.contractInfoCache.get(cacheKey)!;
    }

    try {
      const response = await withRetry(async () => {
        const result = await axios.get<any>("https://futures.mexc.co/api/v1/contract/detail");
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

  async openPosition(symbol: string, quantity: number, side: 'SHORT', signalType: string): Promise<{success: boolean, positionId?: string, realPositionId?: string}> {
    if (!this.validSymbolsCache.has(symbol)) {
      return {success: false};
    }

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

  private roundVolume(volume: number, volumePrecision: number): number {
    const stepSize = Math.pow(10, -volumePrecision);
    return Math.floor(volume / stepSize) * stepSize;
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

        if (!position.lowestPrice || currentPrice < position.lowestPrice) {
          position.lowestPrice = currentPrice;
        }
        if (!position.highestPrice || currentPrice > position.highestPrice) {
          position.highestPrice = currentPrice;
        }

        await this.checkImmediateSLTP(symbol, position, currentPrice);
        
        if (!position.dcaDisabled) {
          await this.checkImmediateDCA(symbol, position, currentPrice);
          await this.checkImprovedDCA(symbol, position, currentPrice);
        }

      } catch (error) {
        // Bỏ log lỗi
      }
    }, 5000);

    if (!this.realTimeMonitorInterval) {
      this.realTimeMonitorInterval = monitorInterval;
    }
  }

  private async checkImmediateSLTP(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    await this.checkRiskManagement(symbol, position, currentPrice);
    
    if (!position.riskManagement.partialTakeProfitExecuted) {
      const candles = await this.fetch1MinKlineData(symbol, 10);
      if (this.detectStrongBullishReversal(candles)) {
        const remainingQty = position.positionSize - position.closedAmount;
        if (remainingQty > 0) {
          await this.closePosition(symbol, remainingQty, 'SHORT', 'STRONG_BULLISH_REVERSAL', position.positionId);
        }
        return;
      }
    }
  }

  private async checkImmediateDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    try {
      await this.checkPumpDCA(symbol, position, currentPrice);
    } catch (error) {
      // Bỏ log lỗi
    }
  }

  private async checkRiskManagement(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    // Simplified risk management implementation
    try {
      const riskConfig = STRATEGY_CONFIG.riskManagement;
      
      let firstTakeProfitPercent = 0;
      let secondTakeProfitPercent = 0;
      let volumeCategory: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH';

      const volume24h = position.volume24h || 0;
      
      if (volume24h < 1000000) {
        firstTakeProfitPercent = riskConfig.volumeBasedTakeProfit.lowVolume.firstTp;
        secondTakeProfitPercent = riskConfig.volumeBasedTakeProfit.lowVolume.secondTp;
        volumeCategory = 'LOW';
      } else if (volume24h >= 5000000 && volume24h <= 10000000) {
        firstTakeProfitPercent = riskConfig.volumeBasedTakeProfit.mediumVolume.firstTp;
        secondTakeProfitPercent = riskConfig.volumeBasedTakeProfit.mediumVolume.secondTp;
        volumeCategory = 'MEDIUM';
      } else {
        firstTakeProfitPercent = riskConfig.volumeBasedTakeProfit.highVolume.firstTp;
        secondTakeProfitPercent = riskConfig.volumeBasedTakeProfit.highVolume.secondTp;
        volumeCategory = 'HIGH';
      }

      position.riskManagement.volumeBasedTP.volumeCategory = volumeCategory;

      if (!position.riskManagement.partialTakeProfitExecuted) {
        const profitPercent = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
        
        if (profitPercent <= -firstTakeProfitPercent) {
          const closeQty = position.positionSize * riskConfig.partialTakeProfitRatio;
          const success = await this.closePosition(
            symbol, 
            closeQty, 
            'SHORT', 
            `PARTIAL_TP_${firstTakeProfitPercent}%`, 
            position.positionId
          );
          
          if (success) {
            position.riskManagement.partialTakeProfitExecuted = true;
            position.closedAmount += closeQty;
            console.log(`💰 [BALANCE_UPDATED] Số dư mới: $${this.accountBalance.toFixed(2)}`);
          }
        }
      }

      if (position.riskManagement.partialTakeProfitExecuted && 
          !position.riskManagement.secondTakeProfitExecuted) {
        
        const profitPercent = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
        const candles = await this.fetch1MinKlineData(symbol, 10);
        const hasReversal = this.detectStrongBullishReversal(candles);

        if (profitPercent <= -secondTakeProfitPercent && hasReversal) {
          const remainingQty = position.positionSize - position.closedAmount;
          if (remainingQty > 0) {
            const success = await this.closePosition(
              symbol, 
              remainingQty, 
              'SHORT', 
              `SECOND_TP_${secondTakeProfitPercent}%_WITH_REVERSAL`, 
              position.positionId
            );
            
            if (success) {
              position.riskManagement.secondTakeProfitExecuted = true;
              position.closedAmount = position.positionSize;
              console.log(`💰 [BALANCE_UPDATED] Số dư mới: $${this.accountBalance.toFixed(2)}`);
            }
          }
        }
      }

      await this.checkTrailingStop(symbol, position, currentPrice);

    } catch (error) {
      // Bỏ log lỗi
    }
  }

  private async checkTrailingStop(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    try {
      if (position.closedAmount >= position.positionSize) return;

      const profitPercent = (position.averagePrice - currentPrice) / position.averagePrice * 100;

      if (!position.trailingStop.activated) {
        if (profitPercent >= STRATEGY_CONFIG.trailingStopConfig.activationProfitPercent) {
          position.trailingStop.activated = true;
          position.trailingStop.maxProfitPercent = profitPercent;
          position.trailingStop.activationPrice = currentPrice;
          position.trailingStop.lastTrailingUpdate = Date.now();
          
          console.log(`🎯 [TRAILING_ACTIVATED] ${symbol} | Lợi nhuận: ${profitPercent.toFixed(2)}%`);
        }
      }

      if (position.trailingStop.activated) {
        if (profitPercent > position.trailingStop.maxProfitPercent) {
          position.trailingStop.maxProfitPercent = profitPercent;
          position.trailingStop.lastTrailingUpdate = Date.now();
        }

        const drawdownFromPeak = position.trailingStop.maxProfitPercent - profitPercent;

        if (drawdownFromPeak >= 2 && !position.trailingStop.partialCloseExecuted) {
          const remainingQty = position.positionSize - position.closedAmount;
          const closeQty = remainingQty * (STRATEGY_CONFIG.trailingStopConfig.partialClosePercent / 100);
          
          if (closeQty > 0) {
            const success = await this.closePosition(symbol, closeQty, 'SHORT', `TRAILING_PARTIAL_CLOSE_50%_DRAWDOWN_2%`, position.positionId);
            if (success) {
              position.trailingStop.partialCloseExecuted = true;
              position.closedAmount += closeQty;
              console.log(`💰 [TRAILING_PARTIAL_CLOSE] ${symbol} | Đã chốt 50% lệnh | Lợi nhuận từ đỉnh: ${drawdownFromPeak.toFixed(2)}%`);
              console.log(`💰 [BALANCE_UPDATED] Số dư mới: $${this.accountBalance.toFixed(2)}`);
            }
          }
        }

        if (STRATEGY_CONFIG.trailingStopConfig.fullCloseAtEntry && currentPrice >= position.averagePrice) {
          const remainingQty = position.positionSize - position.closedAmount;
          if (remainingQty > 0) {
            const success = await this.closePosition(symbol, remainingQty, 'SHORT', 'TRAILING_FULL_CLOSE_AT_ENTRY', position.positionId);
            if (success) {
              position.closedAmount = position.positionSize;
              console.log(`🛑 [TRAILING_FULL_CLOSE] ${symbol} | Đã đóng hết lệnh tại entry`);
              console.log(`💰 [BALANCE_UPDATED] Số dư mới: $${this.accountBalance.toFixed(2)}`);
            }
          }
        }
      }
    } catch (error) {
      // Bỏ log lỗi
    }
  }

  private async checkPumpDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (position.dcaCount >= STRATEGY_CONFIG.pumpStrategy.maxDcaCount) {
      if (!position.riskManagement.maxDcaReached) {
        position.riskManagement.maxDcaReached = true;
      }
      return;
    }

    const priceChange = this.calculatePriceChangePercent(position.averagePrice, currentPrice);

    if (priceChange > STRATEGY_CONFIG.pumpStrategy.negativeDcaThreshold) {
      return;
    }

    const now = Date.now();
    const minDcaInterval = STRATEGY_CONFIG.dcaConfig.minDcaInterval;
    if (position.lastNegativeDcaTime && (now - position.lastNegativeDcaTime) < minDcaInterval) {
      return;
    }

    if (position.lastNegativeDcaPrice) {
      const priceMovement = Math.abs((currentPrice - position.lastNegativeDcaPrice) / position.lastNegativeDcaPrice * 100);
      if (priceMovement < STRATEGY_CONFIG.dcaConfig.minPriceMovement) {
        return;
      }
    }

    if (position.totalDcaPercent >= STRATEGY_CONFIG.pumpStrategy.maxTotalDcaPercent) {
      position.dcaDisabled = true;
      if (!position.riskManagement.maxDcaReached) {
        position.riskManagement.maxDcaReached = true;
      }
      return;
    }

    const dcaQty = await this.calculatePositionSize(
      symbol, 
      STRATEGY_CONFIG.pumpStrategy.dcaPercent,
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
        position.totalDcaPercent += STRATEGY_CONFIG.pumpStrategy.dcaPercent;

        this.recalculatePumpTPSLAfterDCA(position, currentPrice);
        
        this.pendingDcaOrders.delete(dcaOrderId);

        if (position.dcaCount >= STRATEGY_CONFIG.pumpStrategy.maxDcaCount && !position.riskManagement.maxDcaReached) {
          position.riskManagement.maxDcaReached = true;
        }
      } else {
        this.pendingDcaOrders.delete(dcaOrderId);
      }
    }
  }

  private recalculatePumpTPSLAfterDCA(position: PositionData, currentPrice: number): void {
    // Simplified TPSL recalculation
    const remainingQty = position.totalQty - position.closedAmount;
    
    const takeProfitLevels: TakeProfitLevel[] = [];
    const stopLossLevels: StopLossLevel[] = [];

    position.takeProfitLevels = takeProfitLevels;
    position.stopLossLevels = stopLossLevels;
    position.sltpRecalculated = true;
  }

  private async checkImprovedDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (!STRATEGY_CONFIG.improvedDcaStrategy.enabled) return;
    if (position.dcaDisabled) return;
    if (position.improvedDcaCount >= STRATEGY_CONFIG.improvedDcaStrategy.maxDcaCount) return;

    try {
      const now = Date.now();
      
      if (position.lastImprovedDcaTime && 
          (now - position.lastImprovedDcaTime) < STRATEGY_CONFIG.improvedDcaStrategy.minDcaInterval) {
        return;
      }

      if (position.lastImprovedDcaPrice) {
        const priceMovement = Math.abs((currentPrice - position.lastImprovedDcaPrice) / position.lastImprovedDcaPrice * 100);
        if (priceMovement < STRATEGY_CONFIG.improvedDcaStrategy.minPriceMovement) {
          return;
        }
      }

      if (position.totalDcaPercent >= STRATEGY_CONFIG.improvedDcaStrategy.maxTotalDcaPercent) {
        position.dcaDisabled = true;
        return;
      }

      const candles = await this.fetch1MinKlineData(symbol, 20);
      if (candles.length < STRATEGY_CONFIG.improvedDcaStrategy.minCandlesForRetrace) {
        return;
      }

      const retracementAnalysis = this.analyzeRetracement(symbol, position, currentPrice, candles);
      
      if (retracementAnalysis.shouldDCA && retracementAnalysis.hasRetracement) {
        const dcaQty = await this.calculatePositionSize(
          symbol, 
          STRATEGY_CONFIG.improvedDcaStrategy.dcaPercent,
          position.confidence || 50
        );
        
        if (dcaQty > 0) {
          const dcaOrderId = `improved_dca_${symbol}_${position.improvedDcaCount}_${Date.now()}`;
          this.pendingDcaOrders.set(dcaOrderId, {
            symbol,
            level: position.improvedDcaCount,
            quantity: dcaQty,
            timestamp: now
          });
          
          const success = await this.addToPosition(symbol, dcaQty, 'SHORT', `IMPROVED_DCA_FIB_${(retracementAnalysis.targetFibLevel * 100).toFixed(1)}%`);
          
          if (success) {
            const newTotalQty = position.totalQty + dcaQty;
            position.averagePrice = (position.averagePrice * position.totalQty + currentPrice * dcaQty) / newTotalQty;
            position.totalQty = newTotalQty;
            position.positionSize = newTotalQty;
            
            position.improvedDcaCount++;
            position.lastImprovedDcaTime = now;
            position.lastImprovedDcaPrice = currentPrice;
            position.consecutiveImprovedDcaCount++;
            position.totalDcaVolume += dcaQty;
            position.totalDcaPercent += STRATEGY_CONFIG.improvedDcaStrategy.dcaPercent;

            position.improvedDcaLevels.push({
              fibLevel: retracementAnalysis.targetFibLevel,
              price: currentPrice,
              executed: true,
              timestamp: now
            });

            this.recalculateTPSLAfterDCA(position, currentPrice);

            this.pendingDcaOrders.delete(dcaOrderId);
          } else {
            this.pendingDcaOrders.delete(dcaOrderId);
          }
        }
      }

    } catch (error) {
      // Bỏ log lỗi
    }
  }

  private analyzeRetracement(symbol: string, position: PositionData, currentPrice: number, candles: SimpleCandle[]): {
    hasRetracement: boolean;
    retraceStart: number;
    retracePeak: number;
    currentRetraceLevel: number;
    fibLevels: number[];
    shouldDCA: boolean;
    targetFibLevel: number;
  } {
    if (!position.lowestPrice || candles.length < STRATEGY_CONFIG.improvedDcaStrategy.minCandlesForRetrace) {
      return {
        hasRetracement: false,
        retraceStart: 0,
        retracePeak: 0,
        currentRetraceLevel: 0,
        fibLevels: [],
        shouldDCA: false,
        targetFibLevel: 0
      };
    }

    let retraceStart = position.lowestPrice;
    let retracePeak = position.lowestPrice;

    const recentCandles = candles.slice(-STRATEGY_CONFIG.improvedDcaStrategy.maxRetraceCandles);
    for (const candle of recentCandles) {
      if (candle.high > retracePeak) {
        retracePeak = candle.high;
      }
    }

    const retraceAmount = ((retracePeak - retraceStart) / retraceStart) * 100;
    if (retraceAmount < 1.0) {
      return {
        hasRetracement: false,
        retraceStart,
        retracePeak,
        currentRetraceLevel: 0,
        fibLevels: [],
        shouldDCA: false,
        targetFibLevel: 0
      };
    }

    const fibLevels = STRATEGY_CONFIG.improvedDcaStrategy.fibLevels.map(level => 
      retraceStart + (retracePeak - retraceStart) * level
    );

    let currentRetraceLevel = 0;
    let targetFibLevel = 0;
    let shouldDCA = false;

    for (let i = 0; i < fibLevels.length; i++) {
      const fibPrice = fibLevels[i];
      const fibLevel = STRATEGY_CONFIG.improvedDcaStrategy.fibLevels[i];
      
      if (Math.abs(currentPrice - fibPrice) / fibPrice < 0.002) {
        currentRetraceLevel = fibLevel;
        targetFibLevel = fibLevel;

        const alreadyDCAed = position.improvedDcaLevels.some(level => 
          Math.abs(level.fibLevel - fibLevel) < 0.01
        );

        if (!alreadyDCAed) {
          const lastCandle = candles[candles.length - 1];
          const prevCandle = candles[candles.length - 2];
          
          let bearishConfirmation = false;
          
          if (STRATEGY_CONFIG.improvedDcaStrategy.requireBearishConfirmation) {
            bearishConfirmation = lastCandle.close < lastCandle.open;
            
            if (!bearishConfirmation && prevCandle) {
              const isBearishRejection = lastCandle.high > prevCandle.high && lastCandle.close < prevCandle.close;
              bearishConfirmation = isBearishRejection;
            }
          } else {
            bearishConfirmation = true;
          }

          let volumeConfirmation = false;
          if (STRATEGY_CONFIG.improvedDcaStrategy.requireVolumeConfirmation) {
            const avgVolume = candles.slice(-10, -1).reduce((sum, c) => sum + c.volume, 0) / 9;
            volumeConfirmation = lastCandle.volume > avgVolume * STRATEGY_CONFIG.improvedDcaStrategy.volumeSpikeThreshold;
          } else {
            volumeConfirmation = true;
          }

          shouldDCA = bearishConfirmation && volumeConfirmation;
        }
        break;
      }
    }

    return {
      hasRetracement: true,
      retraceStart,
      retracePeak,
      currentRetraceLevel,
      fibLevels,
      shouldDCA,
      targetFibLevel
    };
  }

  private recalculateTPSLAfterDCA(position: PositionData, currentPrice: number): void {
    const remainingQty = position.totalQty - position.closedAmount;
    
    const takeProfitLevels: TakeProfitLevel[] = [];
    const stopLossLevels: StopLossLevel[] = [];

    position.takeProfitLevels = takeProfitLevels;
    position.stopLossLevels = stopLossLevels;
    
    position.currentTpLevels = takeProfitLevels.map(tp => tp.priceChangePercent);
    position.currentSlLevels = stopLossLevels.map(sl => sl.priceChangePercent);
    
    position.sltpRecalculated = true;
  }

  async addToPosition(symbol: string, quantity: number, side: 'SHORT', signalType: string): Promise<boolean> {
    const position = this.positions.get(symbol);
    const positionId = position?.positionId;
    
    const result = await this.openPosition(symbol, quantity, side, signalType);
    
    return result.success;
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
        
        this.accountBalance = await this.getUSDTBalance();
        console.log(`💰 [BALANCE_UPDATED] Số dư mới: $${this.accountBalance.toFixed(2)}`);
        
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
        type: 5,
        openType: 2,
        leverage: LEVERAGE,
        positionId: targetPositionId,
      }) as any;

      if (orderResponse && orderResponse.code === 0) {
        position.closedAmount = position.positionSize;
        this.positions.delete(symbol);
        this.activePositionMonitoring.delete(symbol);
        
        this.accountBalance = await this.getUSDTBalance();
        console.log(`💰 [BALANCE_UPDATED] Số dư mới: $${this.accountBalance.toFixed(2)}`);
      }

    } catch (error: any) {
      // Bỏ log lỗi
    }
  }

  async calculateProfitForQuantity(position: PositionData, currentPrice: number, quantity: number): Promise<number> {
    const contractInfo = await this.getContractInfo(position.symbol);
    return (position.averagePrice - currentPrice) * quantity * contractInfo.contractSize;
  }

  private calculatePriceChangePercent(entryPrice: number, currentPrice: number): number {
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }

  // =========================
  // CÁC PHƯƠNG THỨC TRACKING VÀ SCANNING
  // =========================

  private stopIndividualTracker(symbol: string): void {
    const tracker = this.individualTrackers.get(symbol);
    if (tracker) {
      tracker.stop();
      this.individualTrackers.delete(symbol);
    }
  }

  async validateAllSymbols(): Promise<void> {
    try {
        const allSymbols = await this.getAllFuturePairs();
        
        await this.updateAllTickersCache();
        
        for (const symbol of allSymbols) {
            const isValid = this.allTickersCache.has(symbol);
            if (isValid) {
                this.validSymbolsCache.add(symbol);
            } else {
                this.invalidSymbolsCache.add(symbol);
            }
        }
        
        this.lastSymbolValidation = Date.now();
        
    } catch (error) {
        // Bỏ log lỗi
    }
  }

  async getAllFuturePairs(): Promise<string[]> {
    try {
        await this.fetchBinanceSymbols();

        const response = await axios.get<any>("https://futures.mexc.co/api/v1/contract/detail");
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

  private async fetchBinanceSymbols(): Promise<void> {
    try {
      const now = Date.now();
      if (now - this.lastBinanceUpdate < 60 * 60 * 1000 && this.binanceSymbolsCache.size > 0) {
        return;
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
      
    } catch (error) {
      // Keep existing cache on error
    }
  }

  private isOnBinance(symbol: string): boolean {
    const baseSymbol = symbol.replace('USDT', '').toUpperCase();
    return this.binanceSymbolsCache.has(baseSymbol);
  }

  async updateRealPositionIds(): Promise<void> {
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
      // Bỏ log lỗi
    }
  }

  async scanForPumpSignals(): Promise<void> {
    const now = Date.now();
    
    if (now - this.lastScanTime < 10000) {
      return;
    }

    this.lastScanTime = now;
    
    const symbols = await this.getVolumeFilteredSymbols();
    
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
          const isTooVolatile = await this.isCoinTooVolatile(symbol);
          if (isTooVolatile) {
            return;
          }

          const isOldEnough = await this.checkCoinAgeWithLog(symbol, 'SCAN_PUMP_SIGNALS');
          if (!isOldEnough) {
            return;
          }

          const candles = await this.fetch1MinKlineData(symbol, 50);
          if (candles.length < 10) return;

          const currentPrice = await this.getCurrentPrice(symbol);
          if (currentPrice <= 0) return;

          const volume24h = await this.getVolume24h(symbol);

          if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
            return;
          }

          await this.handlePumpTracking(symbol, candles, currentPrice);

        } catch (error) {
        }
      }
    );
  }

  async getVolumeFilteredSymbols(): Promise<string[]> {
    try {
      const validSymbols = await this.getValidSymbols();
      
      const symbolsWithVolume: VolumeRankedSymbol[] = [];
      
      await this.updateAllTickersCache();
      
      for (const symbol of validSymbols) {
        try {
          const tickerData = this.allTickersCache.get(symbol);
          
          if (tickerData && tickerData.amount24 > 0) {
            symbolsWithVolume.push({
              symbol,
              volume24h: tickerData.amount24,
              change24h: tickerData.change24h || 0
            });
          }
        } catch (error) {
        }
      }

      const filteredSymbols = symbolsWithVolume
        .filter(item => 
          item.volume24h >= STRATEGY_CONFIG.minVolume24h && 
          item.volume24h <= STRATEGY_CONFIG.maxVolume24h
        )
        .sort((a, b) => a.volume24h - b.volume24h)
        .slice(0, STRATEGY_CONFIG.targetLowVolumeCoins)
        .map(item => item.symbol);

      return filteredSymbols;

    } catch (error) {
      return [];
    }
  }

  async getValidSymbols(): Promise<string[]> {
    try {
      const allSymbols = await this.getAllFuturePairs();
      
      const validSymbols: string[] = [];
      
      await this.updateAllTickersCache();
      
      for (const symbol of allSymbols) {
        try {
          if (this.allTickersCache.has(symbol)) {
            validSymbols.push(symbol);
            this.validSymbolsCache.add(symbol);
          } else {
            this.invalidSymbolsCache.add(symbol);
          }
          
        } catch (error) {
        }
      }
      
      return validSymbols;

    } catch (error) {
      return [];
    }
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

  private async handlePumpTracking(symbol: string, candles: SimpleCandle[], currentPrice: number): Promise<boolean> {
    if (!this.validSymbolsCache.has(symbol)) {
      return false;
    }

    const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
    
    if (reversalSignal.shouldTrack && !reversalSignal.isTracked) {
      const isOldEnough = await this.checkCoinAgeWithLog(symbol, 'PUMP_TRACKING');
      if (!isOldEnough) {
        return false;
      }

      const volume24h = await this.getVolume24h(symbol);
      
      if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
        return false;
      }

      const trendAnalysis = await this.analyzeLongTermTrend(symbol);

      await this.startIndividualPumpTracker(symbol, reversalSignal.initialPumpPct, reversalSignal.peakPrice);
      return true;
    }

    return false;
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
    
    const isTracked = this.pumpTrackingCoins.has(symbol);
    
    let shouldTrack = false;
    if (!isTracked && pumpPct >= STRATEGY_CONFIG.trackingConfig.pumpThreshold) {
      shouldTrack = true;
    }

    const reasons: string[] = [];
    let confidence = 0;
    let riskLevel = 'MEDIUM';
    let reversalType = '';
    let hasReversal = false;

    if (isTracked) {
      const trackData = this.pumpTrackingCoins.get(symbol)!;
      
      const hasReversalSignal = dropFromPeak >= Math.abs(STRATEGY_CONFIG.trackingConfig.reversalConfirmationPct);

      if (hasReversalSignal) {
        hasReversal = true;
        confidence = 100;
        reversalType = 'PUMP_RETRACE_3%';
        riskLevel = 'MEDIUM';

        reasons.push(`PUMP_${pumpPct.toFixed(1)}%`);
        reasons.push(`RETRACE_${dropFromPeak.toFixed(1)}%`);
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
      hasBearishPattern: false,
      bearishPatterns: [],
      priceUnderMA: false,
      consecutiveBearish: false,
      peakPrice: highestPrice,
      pumpDurationCandles: 0,
      requiredRetracePercent: 0,
      isTracked,
      shouldTrack,
      initialPumpPct: pumpPct
    };
  }

  private async startIndividualPumpTracker(symbol: string, initialPumpPct: number, peakPrice: number): Promise<void> {
    if (this.pumpTrackers.has(symbol)) return;

    const tracker = new IndividualCoinTracker(symbol, this);
    this.pumpTrackers.set(symbol, tracker);

    this.pumpTrackingCoins.set(symbol, {
      symbol,
      addedAt: Date.now(),
      peakPrice,
      peakTime: Date.now(),
      initialPumpPct,
      notifiedReversal: false,
      riskLevel: 'MEDIUM',
      listingAgeDays: await this.getListingAgeDays(symbol)
    });

    tracker.start();
  }

  private async updatePumpTrackingCoins(): Promise<void> {
    for (const [symbol, tracker] of this.pumpTrackers.entries()) {
      if (!this.pumpTrackingCoins.has(symbol)) {
        tracker.stop();
        this.pumpTrackers.delete(symbol);
      }
    }
  }

  async scanAndSelectTopCoins(): Promise<void> {
    const now = Date.now();
    
    if (now - this.lastScanTime < 20000) {
      return;
    }

    this.lastScanTime = now;
    
    const symbols = await this.getVolumeFilteredSymbols();
    
    const symbolsToProcess = symbols.filter(symbol => 
      !this.positions.has(symbol) && !this.trackingCoins.has(symbol)
    );

    if (symbolsToProcess.length === 0) {
      return;
    }

    const candidateList = await this.processInParallel(
      symbolsToProcess,
      async (symbol): Promise<{ symbol: string; coinData: CoinTrackingData; trendAnalysis: TrendAnalysis } | null> => {
        try {
          const isTooVolatile = await this.isCoinTooVolatile(symbol);
          if (isTooVolatile) {
            return null;
          }

          const isOldEnough = await this.checkCoinAgeWithLog(symbol, 'SCAN_SELECTION');
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

          const trendAnalysis = await this.analyzeLongTermTrend(symbol);

          const currentPrice = await this.getCurrentPrice(symbol);
          const ageInDays = await this.getListingAgeDays(symbol);
          
          let finalConfidence = indicators.confidence;
          
          if (trendAnalysis.trendDirection === 'STRONG_BEARISH') {
            finalConfidence = Math.min(100, indicators.confidence + 20);
          } else if (trendAnalysis.trendDirection === 'BEARISH') {
            finalConfidence = Math.min(100, indicators.confidence + 10);
          }
          
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

          return { symbol, coinData, trendAnalysis };

        } catch (error) {
          return null;
        }
      }
    );

    candidateList.sort((a, b) => {
      if (a.trendAnalysis.priority !== b.trendAnalysis.priority) {
        return b.trendAnalysis.priority - a.trendAnalysis.priority;
      }
      return b.coinData.confidence - a.coinData.confidence;
    });

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
      .sort(([,a], [,b]) => {
        if (a.trendPriority !== b.trendPriority) {
          return b.trendPriority! - a.trendPriority!;
        }
        return b.confidence - a.confidence;
      });

    const coinsToAdd = candidatesArray.slice(0, availableSlots);
    coinsToAdd.forEach(([symbol, coinData]) => {
      this.trackingCoins.set(symbol, coinData);
      this.candidateCoins.delete(symbol);
      
      this.startIndividualTracker(symbol);
    });
  }

  private startIndividualTracker(symbol: string): void {
    if (this.individualTrackers.has(symbol)) return;

    const tracker = new IndividualCoinTracker(symbol, this);
    this.individualTrackers.set(symbol, tracker);
    tracker.start();
  }

  async trackTopCoinsRealTime(): Promise<void> {
    for (const [symbol, tracker] of this.individualTrackers.entries()) {
      if (!this.trackingCoins.has(symbol)) {
        tracker.stop();
        this.individualTrackers.delete(symbol);
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
        await this.checkImprovedDCA(symbol, position, currentPrice);

      } catch (error) {
      }
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

  // =========================
  // CÁC PHƯƠNG THỨC TIỆN ÍCH
  // =========================

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

  public async analyzeLongTermTrend(symbol: string): Promise<TrendAnalysis> {
    const cacheKey = symbol;
    const cached = this.trendAnalysisCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.TREND_CACHE_TTL) {
      return cached.data;
    }

    try {
      const timeframeScores = [];
      let totalWeight = 0;
      let weightedScore = 0;
      let bearishTimeframes = 0;

      for (const tf of STRATEGY_CONFIG.trendAnalysis.timeframes) {
        const score = await this.analyzeTimeframeTrend(symbol, tf.interval, tf.emaPeriod);
        timeframeScores.push({
          interval: tf.interval,
          score: score.trendScore,
          direction: score.direction,
          priceVsEMA: score.priceVsEMA,
          emaSlope: score.emaSlope,
          volumeTrend: score.volumeTrend
        });

        if (score.direction === 'BEARISH') {
          bearishTimeframes++;
        }

        weightedScore += score.trendScore * tf.weight;
        totalWeight += tf.weight;
      }

      const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

      let trendDirection: 'STRONG_BEARISH' | 'BEARISH' | 'NEUTRAL' | 'BULLISH';
      let confidence = 0;
      let priority = 0;

      if (overallScore >= 0.8 && bearishTimeframes === STRATEGY_CONFIG.trendAnalysis.requiredBearishTimeframes) {
        trendDirection = 'STRONG_BEARISH';
        confidence = 90;
        priority = 100;
      } 
      else if (overallScore >= 0.6 && bearishTimeframes === STRATEGY_CONFIG.trendAnalysis.requiredBearishTimeframes) {
        trendDirection = 'BEARISH';
        confidence = 75;
        priority = 80;
      }
      else if (overallScore >= 0.4) {
        trendDirection = 'NEUTRAL';
        confidence = 50;
        priority = 50;
      }
      else {
        trendDirection = 'BULLISH';
        confidence = 25;
        priority = 30;
      }

      const trendAnalysis: TrendAnalysis = {
        symbol,
        overallScore,
        trendDirection,
        timeframeScores,
        confidence,
        priority
      };

      this.trendAnalysisCache.set(cacheKey, { data: trendAnalysis, timestamp: Date.now() });
      return trendAnalysis;

    } catch (error) {
      return this.getDefaultTrendAnalysis(symbol);
    }
  }

  private async analyzeTimeframeTrend(symbol: string, interval: string, emaPeriod: number): Promise<{
    trendScore: number;
    direction: 'BEARISH' | 'BULLISH' | 'NEUTRAL';
    priceVsEMA: number;
    emaSlope: number;
    volumeTrend: number;
  }> {
    try {
      const candles = await this.fetchKlineData(symbol, interval, 300);
      if (candles.length < emaPeriod + 50) {
        return { trendScore: 0.5, direction: 'NEUTRAL', priceVsEMA: 0, emaSlope: 0, volumeTrend: 0 };
      }

      const currentPrice = candles[candles.length - 1].close;
      const ema = this.calculateEMA(candles, emaPeriod);
      
      if (ema === 0) {
        return { trendScore: 0.5, direction: 'NEUTRAL', priceVsEMA: 0, emaSlope: 0, volumeTrend: 0 };
      }

      const previousCandles = candles.slice(0, -50);
      const previousEMA = this.calculateEMA(previousCandles, emaPeriod);
      const emaSlope = ((ema - previousEMA) / previousEMA) * 100;

      const priceVsEMA = ((currentPrice - ema) / ema) * 100;

      const recentVolumes = candles.slice(-50).map(c => c.volume);
      const olderVolumes = candles.slice(-100, -50).map(c => c.volume);
      const recentAvgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const olderAvgVolume = olderVolumes.reduce((a, b) => a + b, 0) / olderVolumes.length;
      const volumeTrend = olderAvgVolume > 0 ? (recentAvgVolume - olderAvgVolume) / olderAvgVolume : 0;

      let trendScore = 0;
      let direction: 'BEARISH' | 'BULLISH' | 'NEUTRAL' = 'NEUTRAL';

      if (currentPrice < ema && emaSlope < -0.5) {
        trendScore = 0.9;
        direction = 'BEARISH';
      } 
      else if (currentPrice < ema && emaSlope < 0) {
        trendScore = 0.7;
        direction = 'BEARISH';
      }
      else if (currentPrice < ema) {
        trendScore = 0.6;
        direction = 'BEARISH';
      }
      else if (currentPrice > ema && emaSlope > 0) {
        trendScore = 0.3;
        direction = 'BULLISH';
      }
      else {
        trendScore = 0.5;
        direction = 'NEUTRAL';
      }

      if (direction === 'BEARISH' && volumeTrend > 0.2) {
        trendScore = Math.min(trendScore + 0.1, 1.0);
      }

      return { trendScore, direction, priceVsEMA, emaSlope, volumeTrend };

    } catch (error) {
      return { trendScore: 0.5, direction: 'NEUTRAL', priceVsEMA: 0, emaSlope: 0, volumeTrend: 0 };
    }
  }

  private getDefaultTrendAnalysis(symbol: string): TrendAnalysis {
    return {
      symbol,
      overallScore: 0.5,
      trendDirection: 'NEUTRAL',
      timeframeScores: [],
      confidence: 50,
      priority: 50
    };
  }

  public async isCoinTooVolatile(symbol: string): Promise<boolean> {
    try {
      const tickerData = await this.getTicker24hData(symbol);
      if (!tickerData) return true;
      
      const isTooVolatile = Math.abs(tickerData.change24h) > STRATEGY_CONFIG.max24hChangePercent;
      
      return isTooVolatile;
    } catch (error) {
      return true;
    }
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

  private calculateMA(candles: SimpleCandle[], period: number): number {
    if (candles.length < period) return 0;
    const recentCandles = candles.slice(-period);
    const closes = recentCandles.map(c => c.close);
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  }

  private calculateDailyVolatility(candles: SimpleCandle[]): number {
    if (candles.length < 24) return 0;
    
    const recentCandles = candles.slice(-24);
    const dailyHigh = Math.max(...recentCandles.map(c => c.high));
    const dailyLow = Math.min(...recentCandles.map(c => c.low));
    const avgPrice = (dailyHigh + dailyLow) / 2;
    
    return avgPrice > 0 ? ((dailyHigh - dailyLow) / avgPrice) * 100 : 0;
  }

  private calculateMarketMomentum(candles: SimpleCandle[]): number {
    if (candles.length < 10) return 0;

    const recentPrices = candles.slice(-10).map(c => c.close);
    const midPrices = candles.slice(-20, -10).map(c => c.close);
    
    const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const midAvg = midPrices.reduce((a, b) => a + b, 0) / midPrices.length;
    
    return midAvg > 0 ? (recentAvg - midAvg) / midAvg : 0;
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
      
      if (reversalSignal.hasReversal && reversalSignal.confidence >= 40) {
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

  private detectStrongBullishReversal(candles: SimpleCandle[]): boolean {
    if (candles.length < 3) return false;

    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];
    const secondPreviousCandle = candles[candles.length - 3];

    const isBullishEngulfing = previousCandle.close < previousCandle.open &&
                              currentCandle.close > currentCandle.open &&
                              currentCandle.open <= previousCandle.close &&
                              currentCandle.close >= previousCandle.open;

    const body = Math.abs(currentCandle.close - currentCandle.open);
    const lowerShadow = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
    const upperShadow = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
    const isHammer = lowerShadow > body * 2 && upperShadow < body * 0.5;

    const isMorningStar = secondPreviousCandle.close < secondPreviousCandle.open &&
                         previousCandle.close < previousCandle.open &&
                         currentCandle.close > currentCandle.open &&
                         currentCandle.close > secondPreviousCandle.open;

    const ema21 = this.calculateEMA(candles, 21);
    const priceAboveEMA = currentCandle.close > ema21;
    
    const avgVolume = candles.slice(-10, -1).reduce((sum, c) => sum + c.volume, 0) / 9;
    const volumeSpike = currentCandle.volume > avgVolume * 1.5;

    return (isBullishEngulfing || isHammer || isMorningStar) && priceAboveEMA && volumeSpike;
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

  // =========================
  // PHƯƠNG THỨC CHÍNH
  // =========================

  async enterPosition(symbol: string, signalType: string, confidence: number, riskLevel: string): Promise<void> {
    const hasSufficientBalance = await this.ensureSufficientBalance();
    if (!hasSufficientBalance) {
      return;
    }

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
        
        await this.checkAndTransferBalance();
        
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
