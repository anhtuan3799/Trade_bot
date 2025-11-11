import * as dotenv from "dotenv";
import { MexcFuturesClient } from "mexc-futures-sdk";
import axios from "axios";

dotenv.config();

const WEB_TOKEN = process.env.MEXC_AUTH_TOKEN ?? "";
const LEVERAGE = 20;

const client = new MexcFuturesClient({
  authToken: WEB_TOKEN,
  baseURL: "https://futures.mexc.co/api/v1",
});

// Định nghĩa interface cho response từ MEXC API
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
  initialPositionPercent: 0.02,
  maxTotalPositionPercent: 0.28,
  max24hChangePercent: 30,
  maxVolume24h: 6000000,
  minVolume24h: 10000,
  maxHotCoinVolume: 50000000,
  targetLowVolumeCoins: 500,
  fakePumpMinPercent: 10,
  volumeSpikeThreshold: 2.5,
  maxActivePositions: 7,
  maxTrackingCoins: 8,
  minAccountBalancePercent: 0.1,
  emaPeriod: 21,
  resistanceLookback: 20,
  volumeDropThreshold: 0.6,
  
  // CẤU HÌNH TỰ ĐỘNG CHUYỂN TIỀN
  autoTransfer: {
    enabled: true,
    checkInterval: 20000, // 20 giây
    minFutureBalance: 10, // Số dư futures tối thiểu để kích hoạt chuyển tiền ($)
    transferAmount: 50, // Số tiền chuyển mỗi lần ($)
    maxTotalTransfer: 1000, // Tổng số tiền chuyển tối đa ($)
    spotToFuture: true, // Chuyển từ spot sang futures
    otherAccounts: false // Có chuyển từ các tài khoản khác không (nếu có API)
  },
  
  pumpStrategy: {
    minRetracePercent: 3, 
    maxDcaCount: 20,
    dcaPercent: 0.02,
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
    takeProfitPercent: 5,
    partialTakeProfitRatio: 0.5,
    trendTakeProfitRatio: 0.5
  },

  // CHIẾN LƯỢC DCA MỚI - BẮT ĐỈNH HỒI TRONG TREND GIẢM
  improvedDcaStrategy: {
    enabled: true,
    // Các mức Fibonacci retracement để vào lệnh
    fibLevels: [0.236, 0.382, 0.5, 0.618, 0.786],
    // Phần trăm vốn sử dụng cho mỗi lần DCA
    dcaPercent: 0.05,
    // Số lần DCA tối đa theo chiến lược mới
    maxDcaCount: 20,
    // Tổng phần trăm vốn tối đa cho DCA mới
    maxTotalDcaPercent: 0.02,
    // Khoảng cách tối thiểu giữa các lần DCA (ms)
    minDcaInterval: 180000,
    // Biến động giá tối thiểu để DCA (%)
    minPriceMovement: 0.5,
    // Số nến tối thiểu để xác nhận đợt hồi
    minCandlesForRetrace: 3,
    // Độ dài tối đa của đợt hồi (số nến)
    maxRetraceCandles: 10,
    // Tín hiệu xác nhận: nến giảm sau khi chạm Fibonacci
    requireBearishConfirmation: true,
    // Volume tăng khi giá bắt đầu giảm trở lại
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
    negativeDcaPercent: 0.07,
    maxTotalDcaPercent: 42.0,
    trendWeakThreshold: -0.1,
    negativeDcaMinPercent: 1.0,
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

// INTERFACE MỚI CHO CHIẾN LƯỢC DCA CẢI TIẾN
interface ImprovedDcaLevel {
  fibLevel: number;
  price: number;
  executed: boolean;
  timestamp?: number;
}

interface RiskManagementData {
  hardStopLossPrice?: number;
  partialTakeProfitExecuted: boolean;
  trendTakeProfitExecuted: boolean;
  maxDcaReached: boolean;
  initialEntryPrice: number;
}

interface PositionData {
  symbol: string;
  entryPrice: number;
  positionSize: number;
  takeProfitLevels: TakeProfitLevel[];
  stopLossLevels: StopLossLevel[];
  dcaLevels: DcaLevel[];
  // THAY THẾ positiveDcaLevels BẰNG improvedDcaLevels
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
  // THAY THẾ positiveDcaCount BẰNG improvedDcaCount
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
  // THÊM DỮ LIỆU CHO CHIẾN LƯỢC MỚI
  retraceStartPrice?: number;
  retracePeakPrice?: number;
  retraceLevels: number[];
  lastRetraceCheck?: number;
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

  // Batch API caches
  private allTickersCache: Map<string, TickerData> = new Map();
  private lastAllTickersUpdate: number = 0;
  private readonly ALL_TICKERS_CACHE_TTL = 10000; // 10 seconds

  // BIẾN MỚI CHO TỰ ĐỘNG CHUYỂN TIỀN
  private lastTransferCheck: number = 0;
  private totalTransferred: number = 0;
  private transferInProgress: boolean = false;

  constructor() {
    console.log('🤖 FAKE PUMP STRATEGY BOT - GỒNG LỆNH KHÔNG SL HOÀN TOÀN');
    console.log('🎯 VOLUME TỐI ĐA: 6M USDT');
    console.log('⏰ TUỔI COIN: > 14 ngày');
    console.log('📉 LOẠI COIN BIẾN ĐỘNG > 30% 24H');
    console.log('🚫 LOẠI COIN HOT (VOLUME > 50M)');
    console.log('💰 VÀO LỆNH: 5% tài sản');
    console.log('🔄 DCA ÂM: 5% vốn khi lỗ 50%');
    console.log('🎯 DCA MỚI: 5% vốn tại các mức Fibonacci hồi lại');
    console.log('🚫 KHÔNG CÓ STOP LOSS - GỒNG ĐẾN KHI CHÁY HOÀN TOÀN');
    console.log('🎯 TP: 50% tại +5% | 50% theo trend');
    console.log('⚠️  SL CỨNG: -80% sau khi max DCA');
    console.log('📈 XU HƯỚNG: EMA200 (4H + 1H)');
    console.log('💸 TỰ ĐỘNG CHUYỂN TIỀN: 20s kiểm tra 1 lần, chuyển $50 khi futures < $10');
  }

  // HÀM MỚI: LẤY SỐ DƯ SPOT
  private async getSpotBalance(): Promise<number> {
    try {
      // Sử dụng API khác để lấy số dư spot
      // Lưu ý: Đây là ví dụ, cần thay thế bằng API thực tế của MEXC
      const response = await withRetry(async () => {
        return await axios.get("https://www.mexc.com/open/api/v2/account/info", {
          headers: {
            'ApiKey': WEB_TOKEN,
            'Content-Type': 'application/json'
          }
        });
      });
      
      if (response.data && response.data.data) {
        const balances = response.data.data.balances || [];
        const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
        return parseFloat(usdtBalance?.free || 0);
      }
      return 0;
    } catch (error: any) {
      console.error('❌ [SPOT_BALANCE_ERROR] Lỗi khi lấy số dư spot:', error.message);
      return 0;
    }
  }

  // HÀM MỚI: CHUYỂN TIỀN TỪ SPOT SANG FUTURES
  private async transferSpotToFutures(amount: number): Promise<boolean> {
    try {
      console.log(`🔄 [TRANSFER] Đang chuyển $${amount} từ spot sang futures...`);
      
      // Sử dụng API chuyển tiền của MEXC
      const response = await withRetry(async () => {
        return await axios.post("https://www.mexc.com/open/api/v2/transfer", {
          from: 'SPOT',
          to: 'FUTURES',
          asset: 'USDT',
          amount: amount
        }, {
          headers: {
            'ApiKey': WEB_TOKEN,
            'Content-Type': 'application/json'
          }
        });
      });
      
      if (response.data && response.data.code === 0) {
        console.log(`✅ [TRANSFER_SUCCESS] Đã chuyển $${amount} từ spot sang futures`);
        this.totalTransferred += amount;
        return true;
      } else {
        console.log(`❌ [TRANSFER_FAILED] Không thể chuyển tiền:`, response.data?.msg || 'Unknown error');
        return false;
      }
    } catch (error: any) {
      console.error('❌ [TRANSFER_ERROR] Lỗi khi chuyển tiền:', error.message);
      return false;
    }
  }

  // HÀM MỚI: KIỂM TRA VÀ TỰ ĐỘNG CHUYỂN TIỀN
  private async checkAndTransferFunds(): Promise<void> {
    if (!STRATEGY_CONFIG.autoTransfer.enabled) return;
    
    const now = Date.now();
    if (now - this.lastTransferCheck < STRATEGY_CONFIG.autoTransfer.checkInterval) {
      return;
    }

    if (this.transferInProgress) {
      return;
    }

    this.lastTransferCheck = now;

    try {
      // Kiểm tra số dư futures hiện tại
      const currentFutureBalance = await this.getUSDTBalance();
      
      // Nếu số dư futures thấp hơn mức tối thiểu
      if (currentFutureBalance < STRATEGY_CONFIG.autoTransfer.minFutureBalance) {
        
        // Kiểm tra tổng số tiền đã chuyển
        if (this.totalTransferred >= STRATEGY_CONFIG.autoTransfer.maxTotalTransfer) {
          console.log(`⚠️ [TRANSFER_LIMIT] Đã đạt giới hạn chuyển tiền: $${this.totalTransferred}`);
          return;
        }

        // Lấy số dư spot
        const spotBalance = await this.getSpotBalance();
        
        if (spotBalance > STRATEGY_CONFIG.autoTransfer.transferAmount) {
          this.transferInProgress = true;
          
          const transferAmount = Math.min(
            STRATEGY_CONFIG.autoTransfer.transferAmount,
            spotBalance,
            STRATEGY_CONFIG.autoTransfer.maxTotalTransfer - this.totalTransferred
          );

          const success = await this.transferSpotToFutures(transferAmount);
          
          if (success) {
            // Cập nhật số dư tài khoản sau khi chuyển
            this.accountBalance = await this.getUSDTBalance();
            console.log(`💰 [BALANCE_UPDATE] Số dư futures mới: $${this.accountBalance.toFixed(2)}`);
          }
          
          this.transferInProgress = false;
        } else {
          console.log(`⚠️ [INSUFFICIENT_SPOT] Không đủ tiền trong spot: $${spotBalance.toFixed(2)}`);
        }
      }
    } catch (error: any) {
      console.error('❌ [AUTO_TRANSFER_ERROR] Lỗi tự động chuyển tiền:', error.message);
      this.transferInProgress = false;
    }
  }

  // Batch API methods
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
        console.log(`✅ [BATCH_TICKERS] Đã cập nhật ${this.allTickersCache.size} tickers`);
      }
    } catch (error: any) {
      console.error('❌ [BATCH_TICKERS_ERROR] Lỗi khi lấy batch tickers:', error.message);
    }
  }

  // Sửa phương thức getTicker24hData để dùng batch cache
  private async getTicker24hData(symbol: string): Promise<TickerData | null> {
    if (!this.validSymbolsCache.has(symbol) && this.invalidSymbolsCache.has(symbol)) {
      return null;
    }

    // Luôn cập nhật cache trước
    await this.updateAllTickersCache();

    const ticker = this.allTickersCache.get(symbol);
    if (ticker) {
      return ticker;
    }

    return null;
  }

  // Thêm hàm getContractInfo bị thiếu
  async getContractInfo(symbol: string): Promise<ContractInfo> {
    // Kiểm tra symbol hợp lệ trước
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

  // Sửa lỗi TypeScript - sử dụng type assertion
  private async isValidSymbol(symbol: string): Promise<boolean> {
    if (this.validSymbolsCache.has(symbol)) return true;
    if (this.invalidSymbolsCache.has(symbol)) return false;

    try {
        // Sử dụng batch cache để kiểm tra symbol
        await this.updateAllTickersCache();
        
        if (this.allTickersCache.has(symbol)) {
            this.validSymbolsCache.add(symbol);
            return true;
        }
        
        console.log(`⚠️ [INVALID_SYMBOL] ${symbol} không hợp lệ hoặc không có quyền truy cập`);
        this.invalidSymbolsCache.add(symbol);
        return false;
        
    } catch (error: any) {
        console.log(`⚠️ [SYMBOL_CHECK_ERROR] ${symbol} - Lỗi kiểm tra:`, error.message);
        this.invalidSymbolsCache.add(symbol);
        return false;
    }
  }

  async validateAllSymbols(): Promise<void> {
    try {
        const allSymbols = await this.getAllFuturePairs();
        console.log(`🔍 [VALIDATE_SYMBOLS] Bắt đầu kiểm tra ${allSymbols.length} symbol...`);
        
        // Sử dụng batch cache để validate
        await this.updateAllTickersCache();
        
        const invalidSymbols: string[] = [];
        const validSymbols: string[] = [];
        
        for (const symbol of allSymbols) {
            const isValid = this.allTickersCache.has(symbol);
            if (isValid) {
                validSymbols.push(symbol);
                this.validSymbolsCache.add(symbol);
            } else {
                invalidSymbols.push(symbol);
                this.invalidSymbolsCache.add(symbol);
            }
        }
        
        console.log(`✅ [VALIDATION_RESULT] Tổng số symbol hợp lệ: ${validSymbols.length}`);
        console.log(`🚫 [VALIDATION_RESULT] Tổng số symbol không hợp lệ: ${invalidSymbols.length}`);
        
        if (invalidSymbols.length > 0) {
            console.log(`📋 [INVALID_SYMBOLS] Danh sách ${Math.min(invalidSymbols.length, 20)} symbol không hợp lệ đầu tiên:`);
            invalidSymbols.slice(0, 20).forEach(sym => console.log(`   - ${sym}`));
            if (invalidSymbols.length > 20) {
                console.log(`   ... và ${invalidSymbols.length - 20} symbol khác`);
            }
        }
        
        this.lastSymbolValidation = Date.now();
        
    } catch (error) {
        console.error('❌ [VALIDATE_SYMBOLS_ERROR] Lỗi khi kiểm tra symbol:', error);
    }
  }

  private async analyzeLongTermTrend(symbol: string): Promise<TrendAnalysis> {
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
        priority = 30;
      }
      else {
        trendDirection = 'BULLISH';
        confidence = 25;
        priority = 10;
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
      console.error(`❌ [TREND_ANALYSIS_ERROR] Lỗi phân tích trend ${symbol}:`, error);
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
      console.error(`❌ [TIMEFRAME_TREND_ERROR] ${symbol} ${interval}:`, error);
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

  private async isCoinTooVolatile(symbol: string): Promise<boolean> {
    try {
      const tickerData = await this.getTicker24hData(symbol);
      if (!tickerData) return true;
      
      const isTooVolatile = Math.abs(tickerData.change24h) > STRATEGY_CONFIG.max24hChangePercent;
      
      if (isTooVolatile) {
        console.log(`⚠️ [VOLATILE_COIN] ${symbol} bị loại do biến động 24h quá cao: ${tickerData.change24h.toFixed(2)}%`);
      }
      
      return isTooVolatile;
    } catch (error) {
      console.error(`❌ [VOLATILE_CHECK_ERROR] Lỗi khi kiểm tra biến động của ${symbol}:`, error);
      return true;
    }
  }

  private async isCoinTooHot(symbol: string): Promise<boolean> {
    try {
      const volume24h = await this.getVolume24h(symbol);
      const isTooHot = volume24h > STRATEGY_CONFIG.maxHotCoinVolume;
      
      if (isTooHot) {
        console.log(`🔥 [HOT_COIN] ${symbol} bị loại do volume quá cao: ${(volume24h/1000000).toFixed(2)}M`);
      }
      
      return isTooHot;
    } catch (error) {
      console.error(`❌ [HOT_COIN_CHECK_ERROR] Lỗi khi kiểm tra độ hot của ${symbol}:`, error);
      return true;
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
      console.error(`❌ [VOLUME24H_ERROR] Lỗi khi lấy volume 24h của ${symbol}:`, error);
    }

    return 0;
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
    
    const takeProfitLevels: TakeProfitLevel[] = [];

    const stopLossLevels: StopLossLevel[] = [];

    return { 
      tpLevels: takeProfitLevels, 
      slLevels: stopLossLevels 
    };
  }

  private async handlePumpTracking(symbol: string, candles: SimpleCandle[], currentPrice: number): Promise<boolean> {
    if (!this.validSymbolsCache.has(symbol)) {
      return false;
    }

    const reversalSignal = this.detectPumpAlertReversalSignal(symbol, candles, currentPrice);
    
    if (reversalSignal.shouldTrack && !reversalSignal.isTracked) {
      const listingAgeDays = await this.getListingAgeDays(symbol);
      
      const volume24h = await this.getVolume24h(symbol);
      
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
      
      const volume24h = await this.getVolume24h(symbol);
      
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

  // Sửa lỗi TypeScript trong fetchKlineData - sửa lỗi volume type
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
      
      // Sửa lỗi TypeScript bằng cách ép kiểu
      const data = response.data as MexcResponse<KlineDataResponse>;
      
      if (data.success === true && data.code === 0 && data.data) {
        const obj = data.data;
        if (Array.isArray(obj.time)) {
          const candles: SimpleCandle[] = obj.time.map((t: number, idx: number) => ({
            open: parseFloat(obj.open?.[idx] || obj.close?.[idx] || '0'),
            low: parseFloat(obj.low[idx] || '0'),
            close: parseFloat(obj.close[idx] || '0'),
            high: parseFloat(obj.high[idx] || '0'),
            // Sửa lỗi volume: chuyển đổi sang number
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

  async fetch5MinKlineData(symbol: string, limit: number = 100): Promise<SimpleCandle[]> {
    return this.fetchKlineData(symbol, "Min5", limit);
  }

  // Sửa lỗi TypeScript trong fetch1MinKlineData - sửa lỗi volume type
  async fetch1MinKlineData(symbol: string, limit: number = 50): Promise<SimpleCandle[]> {
    if (!this.validSymbolsCache.has(symbol)) {
      return [];
    }

    const formattedSymbol = symbol.replace('USDT', '_USDT');
    const url = `https://futures.mexc.co/api/v1/contract/kline/${formattedSymbol}`;
    
    try {
      const response = await withRetry(async () => {
        return await axios.get(url, {
          params: { interval: 'Min1', limit },
        });
      });
      
      // Sửa lỗi TypeScript bằng cách ép kiểu
      const data = response.data as MexcResponse<KlineDataResponse>;
      
      if (data.success === true && data.code === 0 && data.data) {
        const obj = data.data;
        if (Array.isArray(obj.time)) {
          const candles: SimpleCandle[] = obj.time.map((t: number, idx: number) => ({
            open: parseFloat(obj.open?.[idx] || obj.close?.[idx] || '0'),
            low: parseFloat(obj.low[idx] || '0'),
            close: parseFloat(obj.close[idx] || '0'),
            high: parseFloat(obj.high[idx] || '0'),
            // Sửa lỗi volume: chuyển đổi sang number
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
      
      let capital = this.accountBalance * percent;
      
      const maxPositionValue = this.accountBalance * LEVERAGE;
      const requestedPositionValue = capital * LEVERAGE;
      
      if (requestedPositionValue > maxPositionValue) {
        console.log(`⚠️ [POSITION_SIZE] Giảm kích thước lệnh do vượt quá đòn bẩy cho phép`);
        capital = this.accountBalance * 0.05;
      }
      
      let vol = (capital * LEVERAGE) / (currentPrice * contractInfo.contractSize);
      
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

  private async checkRiskManagement(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    try {
      const riskConfig = STRATEGY_CONFIG.riskManagement;
      
      if (!position.riskManagement.partialTakeProfitExecuted) {
        const profitPercent = this.calculatePriceChangePercent(position.averagePrice, currentPrice);
        
        if (profitPercent <= -riskConfig.takeProfitPercent) {
          const closeQty = position.positionSize * riskConfig.partialTakeProfitRatio;
          const success = await this.closePosition(
            symbol, 
            closeQty, 
            'SHORT', 
            `PARTIAL_TP_${riskConfig.takeProfitPercent}%`, 
            position.positionId
          );
          
          if (success) {
            position.riskManagement.partialTakeProfitExecuted = true;
            position.closedAmount += closeQty;
            console.log(`🎯 [PARTIAL_TP] ${symbol} | Chốt lời ${riskConfig.partialTakeProfitRatio * 100}% tại +${riskConfig.takeProfitPercent}% | Khối lượng: ${closeQty}`);
          }
        }
      }

      if (position.riskManagement.maxDcaReached && !position.riskManagement.trendTakeProfitExecuted) {
        if (!position.riskManagement.hardStopLossPrice) {
          position.riskManagement.hardStopLossPrice = 
            position.averagePrice * (1 + Math.abs(riskConfig.slAfterMaxDca) / 100);
          console.log(`🚨 [HARD_SL_SET] ${symbol} | SL: ${riskConfig.slAfterMaxDca}% | Giá SL: $${position.riskManagement.hardStopLossPrice.toFixed(6)}`);
        }

        if (currentPrice >= position.riskManagement.hardStopLossPrice!) {
          const remainingQty = position.positionSize - position.closedAmount;
          if (remainingQty > 0) {
            const success = await this.closePosition(
              symbol, 
              remainingQty, 
              'SHORT', 
              `HARD_SL_${riskConfig.slAfterMaxDca}%`, 
              position.positionId
            );
            
            if (success) {
              position.riskManagement.trendTakeProfitExecuted = true;
              position.closedAmount = position.positionSize;
              console.log(`💀 [HARD_SL_HIT] ${symbol} | Cắt lỗ tại -${Math.abs(riskConfig.slAfterMaxDca)}% | Khối lượng: ${remainingQty}`);
            }
          }
        }
      }

      if (position.riskManagement.partialTakeProfitExecuted && 
          !position.riskManagement.trendTakeProfitExecuted &&
          !position.riskManagement.maxDcaReached) {
        
        const candles = await this.fetch1MinKlineData(symbol, 10);
        if (this.detectStrongBullishReversal(candles)) {
          const remainingQty = position.positionSize - position.closedAmount;
          if (remainingQty > 0) {
            const success = await this.closePosition(
              symbol, 
              remainingQty, 
              'SHORT', 
              'TREND_TP_REVERSAL', 
              position.positionId
            );
            
            if (success) {
              position.riskManagement.trendTakeProfitExecuted = true;
              position.closedAmount = position.positionSize;
              console.log(`🎯 [TREND_TP] ${symbol} | Chốt lời theo trend (đảo chiều) | Khối lượng: ${remainingQty}`);
            }
          }
        }
      }

    } catch (error) {
      console.error(`❌ [RISK_MGMT_ERROR] ${symbol}:`, error);
    }
  }

  // HÀM MỚI: PHÂN TÍCH ĐỢT HỒI VÀ XÁC ĐỊNH MỨC FIBONACCI
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

    // Tìm đáy gần nhất và đỉnh của đợt hồi
    let retraceStart = position.lowestPrice;
    let retracePeak = position.lowestPrice;

    // Xác định đỉnh của đợt hồi (từ đáy lên)
    const recentCandles = candles.slice(-STRATEGY_CONFIG.improvedDcaStrategy.maxRetraceCandles);
    for (const candle of recentCandles) {
      if (candle.high > retracePeak) {
        retracePeak = candle.high;
      }
    }

    // Nếu không có đợt hồi đáng kể
    const retraceAmount = ((retracePeak - retraceStart) / retraceStart) * 100;
    if (retraceAmount < 1.0) { // Ít nhất 1% hồi
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

    // Tính các mức Fibonacci
    const fibLevels = STRATEGY_CONFIG.improvedDcaStrategy.fibLevels.map(level => 
      retraceStart + (retracePeak - retraceStart) * level
    );

    // Xác định mức Fibonacci hiện tại
    let currentRetraceLevel = 0;
    let targetFibLevel = 0;
    let shouldDCA = false;

    for (let i = 0; i < fibLevels.length; i++) {
      const fibPrice = fibLevels[i];
      const fibLevel = STRATEGY_CONFIG.improvedDcaStrategy.fibLevels[i];
      
      // Kiểm tra nếu giá đang ở gần mức Fibonacci (trong phạm vi 0.2%)
      if (Math.abs(currentPrice - fibPrice) / fibPrice < 0.002) {
        currentRetraceLevel = fibLevel;
        targetFibLevel = fibLevel;

        // Kiểm tra xem mức Fibonacci này đã được DCA chưa
        const alreadyDCAed = position.improvedDcaLevels.some(level => 
          Math.abs(level.fibLevel - fibLevel) < 0.01
        );

        if (!alreadyDCAed) {
          // Kiểm tra tín hiệu xác nhận bearish
          const lastCandle = candles[candles.length - 1];
          const prevCandle = candles[candles.length - 2];
          
          let bearishConfirmation = false;
          
          if (STRATEGY_CONFIG.improvedDcaStrategy.requireBearishConfirmation) {
            // Nến đỏ (giảm) sau khi chạm Fibonacci
            bearishConfirmation = lastCandle.close < lastCandle.open;
            
            // Hoặc pattern bearish
            if (!bearishConfirmation && prevCandle) {
              const isBearishRejection = lastCandle.high > prevCandle.high && lastCandle.close < prevCandle.close;
              bearishConfirmation = isBearishRejection;
            }
          } else {
            bearishConfirmation = true;
          }

          // Kiểm tra volume confirmation
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

  // HÀM MỚI: DCA THEO CHIẾN LƯỢC CẢI TIẾN
  private async checkImprovedDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (!STRATEGY_CONFIG.improvedDcaStrategy.enabled) return;
    if (position.dcaDisabled) return;
    if (position.improvedDcaCount >= STRATEGY_CONFIG.improvedDcaStrategy.maxDcaCount) return;

    try {
      const now = Date.now();
      
      // Kiểm tra khoảng thời gian tối thiểu giữa các lần DCA
      if (position.lastImprovedDcaTime && 
          (now - position.lastImprovedDcaTime) < STRATEGY_CONFIG.improvedDcaStrategy.minDcaInterval) {
        return;
      }

      // Kiểm tra biến động giá tối thiểu
      if (position.lastImprovedDcaPrice) {
        const priceMovement = Math.abs((currentPrice - position.lastImprovedDcaPrice) / position.lastImprovedDcaPrice * 100);
        if (priceMovement < STRATEGY_CONFIG.improvedDcaStrategy.minPriceMovement) {
          return;
        }
      }

      // Kiểm tra tổng phần trăm DCA
      if (position.totalDcaPercent >= STRATEGY_CONFIG.improvedDcaStrategy.maxTotalDcaPercent) {
        position.dcaDisabled = true;
        console.log(`⏹️ [IMPROVED_DCA_STOPPED] ${symbol} | Đã đạt ${position.totalDcaPercent.toFixed(1)}% vốn DCA`);
        return;
      }

      // Lấy dữ liệu nến để phân tích
      const candles = await this.fetch1MinKlineData(symbol, 20);
      if (candles.length < STRATEGY_CONFIG.improvedDcaStrategy.minCandlesForRetrace) {
        return;
      }

      // Phân tích đợt hồi
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

            // Lưu thông tin mức Fibonacci đã DCA
            position.improvedDcaLevels.push({
              fibLevel: retracementAnalysis.targetFibLevel,
              price: currentPrice,
              executed: true,
              timestamp: now
            });

            this.recalculateTPSLAfterDCA(position, currentPrice);

            this.pendingDcaOrders.delete(dcaOrderId);
            
            console.log(`✅ [IMPROVED_DCA] ${symbol} | Fib ${(retracementAnalysis.targetFibLevel * 100).toFixed(1)}% | Lần ${position.improvedDcaCount} | Giá: $${currentPrice.toFixed(6)}`);
            console.log(`   📊 Retrace: ${((retracementAnalysis.retracePeak - retracementAnalysis.retraceStart) / retracementAnalysis.retraceStart * 100).toFixed(2)}% | Vốn DCA: ${(STRATEGY_CONFIG.improvedDcaStrategy.dcaPercent * 100).toFixed(1)}% | Tổng DCA: ${position.totalDcaPercent.toFixed(2)}%`);

            if (position.improvedDcaCount >= STRATEGY_CONFIG.improvedDcaStrategy.maxDcaCount) {
              console.log(`⚠️ [IMPROVED_DCA_MAX] ${symbol} | Đã đạt tối đa ${position.improvedDcaCount} lần DCA theo chiến lược mới`);
            }
          } else {
            this.pendingDcaOrders.delete(dcaOrderId);
          }
        }
      }

    } catch (error) {
      console.error(`❌ [IMPROVED_DCA_ERROR] ${symbol}:`, error);
    }
  }

  async openPosition(symbol: string, quantity: number, side: 'SHORT', signalType: string): Promise<{success: boolean, positionId?: string, realPositionId?: string}> {
    if (!this.validSymbolsCache.has(symbol)) {
      console.log(`🚫 [INVALID_SYMBOL_ORDER] ${symbol} - Không thể vào lệnh do symbol không hợp lệ`);
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
        type: 5,
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

        if (!position.lowestPrice || currentPrice < position.lowestPrice) {
          position.lowestPrice = currentPrice;
        }
        if (!position.highestPrice || currentPrice > position.highestPrice) {
          position.highestPrice = currentPrice;
        }

        await this.checkImmediateSLTP(symbol, position, currentPrice);
        
        if (!position.dcaDisabled) {
          await this.checkImmediateDCA(symbol, position, currentPrice);
          await this.checkImprovedDCA(symbol, position, currentPrice); // THAY THẾ DCA DƯƠNG BẰNG DCA CẢI TIẾN
        }

      } catch (error) {
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
        console.log(`🎯 [STRONG_REVERSAL_DETECTED] ${symbol} - Đảo chiều mạnh, chốt lời ngay`);
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
      await this.checkPumpDCA(symbol, position, currentPrice); // DCA ÂM VẪN GIỮ NGUYÊN
      // ĐÃ LOẠI BỎ DCA DƯƠNG CŨ
    } catch (error) {
      console.error(`❌ [DCA_ERROR] ${symbol}:`, error);
    }
  }

  private async checkPumpDCA(symbol: string, position: PositionData, currentPrice: number): Promise<void> {
    if (position.dcaCount >= STRATEGY_CONFIG.pumpStrategy.maxDcaCount) {
      if (!position.riskManagement.maxDcaReached) {
        position.riskManagement.maxDcaReached = true;
        console.log(`⚠️ [MAX_DCA_REACHED] ${symbol} | Đã đạt tối đa ${position.dcaCount} lần DCA | Kích hoạt SL cứng`);
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
        console.log(`⚠️ [MAX_DCA_PERCENT_REACHED] ${symbol} | Đã đạt ${position.totalDcaPercent.toFixed(1)}% vốn DCA | Kích hoạt SL cứng`);
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
        
        console.log(`✅ [PUMP_DCA] ${symbol} | Lần ${position.dcaCount} | Lỗ: ${priceChange.toFixed(2)}% | Vốn DCA: ${(STRATEGY_CONFIG.pumpStrategy.dcaPercent * 100).toFixed(1)}% | Tổng DCA: ${position.totalDcaPercent.toFixed(2)}%`);

        if (position.dcaCount >= STRATEGY_CONFIG.pumpStrategy.maxDcaCount && !position.riskManagement.maxDcaReached) {
          position.riskManagement.maxDcaReached = true;
          console.log(`⚠️ [MAX_DCA_REACHED] ${symbol} | Đã đạt tối đa ${position.dcaCount} lần DCA | Kích hoạt SL cứng`);
        }
      } else {
        this.pendingDcaOrders.delete(dcaOrderId);
      }
    }
  }

  private recalculatePumpTPSLAfterDCA(position: PositionData, currentPrice: number): void {
    const remainingQty = position.totalQty - position.closedAmount;
    
    const takeProfitLevels: TakeProfitLevel[] = [];

    const stopLossLevels: StopLossLevel[] = [];

    position.takeProfitLevels = takeProfitLevels;
    position.stopLossLevels = stopLossLevels;
    position.sltpRecalculated = true;
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

  async getValidSymbols(): Promise<string[]> {
    try {
      console.log(`🔍 [SYMBOL_SCAN] Đang quét tất cả symbol hợp lệ...`);
      
      const allSymbols = await this.getAllFuturePairs();
      
      const validSymbols: string[] = [];
      
      console.log(`🔍 [SYMBOL_VALIDATION] Đang kiểm tra ${allSymbols.length} symbol...`);
      
      // Sử dụng batch cache để validate
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
          console.log(`⚠️ [SYMBOL_VALIDATION_SKIP] Bỏ qua ${symbol} do lỗi kiểm tra`);
        }
      }
      
      console.log(`✅ [SYMBOL_VALIDATION] Tìm thấy ${validSymbols.length} symbol hợp lệ`);
      return validSymbols;

    } catch (error) {
      console.error('❌ [SYMBOL_SCAN_ERROR] Lỗi khi lấy danh sách symbol:', error);
      return [];
    }
  }

  async getVolumeFilteredSymbols(): Promise<string[]> {
    try {
      console.log(`🔍 [VOLUME_FILTER] Đang lọc symbol theo volume 24h <= 6M...`);
      
      const validSymbols = await this.getValidSymbols();
      
      const symbolsWithVolume: VolumeRankedSymbol[] = [];
      
      // Sử dụng batch cache để lấy volume
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

      // Lọc symbol theo volume 24h <= 6M và >= 10k
      const filteredSymbols = symbolsWithVolume
        .filter(item => 
          item.volume24h >= STRATEGY_CONFIG.minVolume24h && 
          item.volume24h <= STRATEGY_CONFIG.maxVolume24h
        )
        .sort((a, b) => a.volume24h - b.volume24h)
        .slice(0, STRATEGY_CONFIG.targetLowVolumeCoins)
        .map(item => item.symbol);

      if (symbolsWithVolume.length > 0) {
        const minVolume = Math.min(...symbolsWithVolume.map(item => item.volume24h));
        const maxVolumeInFiltered = Math.max(...filteredSymbols.map(sym => {
          const item = symbolsWithVolume.find(s => s.symbol === sym);
          return item ? item.volume24h : 0;
        }));
        
        console.log(`📊 [VOLUME_FILTER_RESULT] Đã chọn ${filteredSymbols.length} coin volume <= 6M`);
        console.log(`   📈 Volume thấp nhất: ${(minVolume/1000000).toFixed(3)}M`);
        console.log(`   📈 Volume cao nhất trong nhóm: ${(maxVolumeInFiltered/1000000).toFixed(3)}M`);
      }

      return filteredSymbols;

    } catch (error) {
      console.error('❌ [VOLUME_FILTER_ERROR] Lỗi khi lọc symbol theo volume:', error);
      return [];
    }
  }

  private async updatePumpTrackingCoins(): Promise<void> {
    if (this.pumpTrackingCoins.size === 0) return;

    console.log(`🔍 [PUMP_TRACKING] Đang theo dõi ${this.pumpTrackingCoins.size} coin pump...`);

    for (const [symbol, trackData] of this.pumpTrackingCoins.entries()) {
      try {
        if (!this.hasMinimumBalance() || this.positions.size >= STRATEGY_CONFIG.maxActivePositions) {
          continue;
        }

        if (!this.validSymbolsCache.has(symbol)) {
          this.pumpTrackingCoins.delete(symbol);
          continue;
        }

        const candles = await this.fetch1MinKlineData(symbol, 50);
        if (candles.length < 10) continue;

        const currentPrice = await this.getCurrentPrice(symbol);
        if (currentPrice <= 0) continue;

        const volume24h = await this.getVolume24h(symbol);
        
        if (volume24h > STRATEGY_CONFIG.maxVolume24h) {
          this.pumpTrackingCoins.delete(symbol);
          continue;
        }

        const listingAgeDays = await this.getListingAgeDays(symbol);
        if (listingAgeDays < 14) {
          this.pumpTrackingCoins.delete(symbol);
          continue;
        }

        trackData.currentPrice = currentPrice;
        trackData.volume24h = volume24h;
        trackData.dropFromPeak = ((trackData.peakPrice - currentPrice) / trackData.peakPrice) * 100;

        console.log(`🔍 [PUMP_MONITOR] ${symbol}: Pump +${trackData.initialPumpPct.toFixed(1)}% | Drop: ${trackData.dropFromPeak.toFixed(1)}% | Required: ${STRATEGY_CONFIG.pumpStrategy.minRetracePercent}%`);

        const meetsRetraceCondition = trackData.dropFromPeak >= STRATEGY_CONFIG.pumpStrategy.minRetracePercent;
        const meetsVolumeCondition = volume24h >= STRATEGY_CONFIG.minVolume24h && volume24h <= STRATEGY_CONFIG.maxVolume24h;
        const hasPositionSlot = this.positions.size < STRATEGY_CONFIG.maxActivePositions;
        const hasBalance = this.hasMinimumBalance();
        const isNotInPosition = !this.positions.has(symbol);

        if (meetsRetraceCondition && meetsVolumeCondition && hasPositionSlot && hasBalance && isNotInPosition) {
          console.log(`🎯 [PUMP_ENTRY_SIGNAL] ${symbol} | Drop: ${trackData.dropFromPeak.toFixed(1)}% >= ${STRATEGY_CONFIG.pumpStrategy.minRetracePercent}% | Volume: ${(volume24h/1000000).toFixed(2)}M`);
          
          await this.enterPumpPosition(symbol, currentPrice, volume24h, trackData);
          
          this.pumpTrackingCoins.delete(symbol);
        }

        const trackingDuration = Date.now() - trackData.addedAt;
        if (trackingDuration > STRATEGY_CONFIG.trackingConfig.maxTrackingTime) {
          this.pumpTrackingCoins.delete(symbol);
          console.log(`⏰ [PUMP_EXPIRED] ${symbol} - Đã theo dõi quá 30 phút`);
        }

      } catch (error) {
        console.error(`❌ [PUMP_TRACKING_ERROR] Lỗi khi theo dõi ${symbol}:`, error);
      }
    }
  }

  private async enterPumpPosition(
    symbol: string, 
    currentPrice: number, 
    volume24h: number,
    trackData: TrackingData
  ): Promise<void> {
    try {
      const confidence = 80;
      const initialQty = await this.calculatePositionSize(
        symbol, 
        STRATEGY_CONFIG.initialPositionPercent, 
        confidence
      );

      if (initialQty <= 0) {
        console.log(`❌ [PUMP_ENTRY_SKIP] ${symbol} | Position size too small`);
        return;
      }

      const openResult = await this.openPosition(symbol, initialQty, 'SHORT', `PUMP_TRACKING_${trackData.initialPumpPct.toFixed(1)}%`);

      if (!openResult.success) {
        console.log(`❌ [PUMP_ENTRY_FAILED] ${symbol} | Failed to open position`);
        return;
      }

      const riskManagement: RiskManagementData = {
        partialTakeProfitExecuted: false,
        trendTakeProfitExecuted: false,
        maxDcaReached: false,
        initialEntryPrice: currentPrice
      };

      const position: PositionData = {
        symbol,
        entryPrice: currentPrice,
        positionSize: initialQty,
        takeProfitLevels: [],
        stopLossLevels: [],
        dcaLevels: [],
        improvedDcaLevels: [], // THAY THẾ positiveDcaLevels
        timestamp: Date.now(),
        initialQty,
        closedAmount: 0,
        dcaCount: 0,
        side: 'SHORT',
        averagePrice: currentPrice,
        totalQty: initialQty,
        signalType: `PUMP_TRACKING_${trackData.initialPumpPct.toFixed(1)}%`,
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
        improvedDcaCount: 0, // THAY THẾ positiveDcaCount
        extendedTpLevels: [],
        currentTpLevels: [],
        currentSlLevels: [],
        riskLevel: trackData.riskLevel,
        dcaDisabled: false,
        totalDcaPercent: 0,
        trendStrength: 0,
        lastDcaPrice: currentPrice,
        lastNegativeDcaPrice: currentPrice,
        lastImprovedDcaPrice: currentPrice,
        lastNegativeDcaTime: Date.now(),
        lastImprovedDcaTime: Date.now(),
        consecutiveNegativeDcaCount: 0,
        consecutiveImprovedDcaCount: 0,
        strategyType: 'PUMP',
        volume24h: volume24h,
        initialAccountBalance: this.accountBalance,
        lowestPrice: currentPrice,
        highestPrice: currentPrice,
        riskManagement,
        retraceLevels: [] // THÊM CHO CHIẾN LƯỢC MỚI
      };

      this.positions.set(symbol, position);

      console.log(`✅ [PUMP_POSITION_OPENED] ${symbol} | Entry: $${currentPrice.toFixed(6)}`);
      console.log(`   📊 Initial Pump: +${trackData.initialPumpPct.toFixed(1)}% | Current Drop: ${trackData.dropFromPeak?.toFixed(1)}%`);
      console.log(`   💰 Vốn sử dụng: ${(STRATEGY_CONFIG.initialPositionPercent * 100).toFixed(1)}% (5%)`);
      console.log(`   🎯 TP: 50% tại +${STRATEGY_CONFIG.riskManagement.takeProfitPercent}% | 50% theo trend`);
      console.log(`   🚫 SL: KHÔNG CÓ STOP LOSS HOÀN TOÀN - GỒNG ĐẾN CHÁY`);
      console.log(`   📈 Volume: ${(volume24h/1000000).toFixed(2)}M`);
      console.log(`   🔄 DCA ÂM: Khi lỗ ${STRATEGY_CONFIG.pumpStrategy.negativeDcaThreshold}% (5% vốn)`);
      console.log(`   🔄 DCA MỚI: 5% vốn tại các mức Fibonacci hồi lại (23.6%, 38.2%, 50%, 61.8%, 78.6%)`);
      console.log(`   ⚠️  SL CỨNG: -${Math.abs(STRATEGY_CONFIG.riskManagement.slAfterMaxDca)}% sau khi max DCA`);

    } catch (error) {
      console.error(`❌ [PUMP_ENTRY_ERROR] Lỗi khi vào lệnh ${symbol}:`, error);
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

          const isOldEnough = await this.isCoinListedAtLeast14Days(symbol);
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

          const trendAnalysis = await this.analyzeLongTermTrend(symbol);

          if (trendAnalysis.trendDirection !== 'BEARISH' && trendAnalysis.trendDirection !== 'STRONG_BEARISH') {
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
            confidence: Math.min(indicators.confidence, trendAnalysis.confidence),
            riskLevel: indicators.riskLevel,
            pumpDurationCandles: indicators.pumpDurationCandles,
            requiredRetracePercent: indicators.requiredRetracePercent
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

    if (topCandidates.length > 0) {
      console.log(`📊 [TREND_ANALYSIS] Top ${topCandidates.length} coin xu hướng giảm (EMA200):`);
      topCandidates.slice(0, 5).forEach(candidate => {
        console.log(`   ${candidate.symbol}: ${candidate.trendAnalysis.trendDirection} (Score: ${(candidate.trendAnalysis.overallScore * 100).toFixed(1)}%, Priority: ${candidate.trendAnalysis.priority})`);
      });
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
    });
  }

  async trackTopCoinsRealTime(): Promise<void> {
    if (this.trackingCoins.size === 0) return;

    let enteredCount = 0;

    const sortedTrackingCoins = Array.from(this.trackingCoins.entries())
      .sort(([,a], [,b]) => {
        const trendA = this.trendAnalysisCache.get(a.symbol);
        const trendB = this.trendAnalysisCache.get(b.symbol);
        const priorityA = trendA?.data.priority || 50;
        const priorityB = trendB?.data.priority || 50;
        return priorityB - priorityA;
      });

    for (const [symbol, coinData] of sortedTrackingCoins) {
      try {
        if (!this.hasMinimumBalance() || this.positions.size >= STRATEGY_CONFIG.maxActivePositions) {
          continue;
        }

        const currentTrend = await this.analyzeLongTermTrend(symbol);
        if (currentTrend.trendDirection !== 'BEARISH' && currentTrend.trendDirection !== 'STRONG_BEARISH') {
          this.trackingCoins.delete(symbol);
          console.log(`⚠️ [TREND_CHANGED] ${symbol} đã đổi trend, bỏ theo dõi`);
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
        coinData.confidence = Math.min(indicators.confidence, currentTrend.confidence);
        coinData.riskLevel = indicators.riskLevel;
        coinData.pumpDurationCandles = indicators.pumpDurationCandles;
        coinData.requiredRetracePercent = indicators.requiredRetracePercent;

        if (coinData.hasEntrySignal && coinData.status === 'TRACKING') {
          coinData.status = 'READY_TO_ENTER';
        }

        if (coinData.status === 'READY_TO_ENTER') {
          console.log(`🎯 [TREND_PRIORITY_ENTRY] ${symbol} | Trend: ${currentTrend.trendDirection} | Priority: ${currentTrend.priority}`);
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
        console.error(`❌ [TREND_TRACKING_ERROR] Lỗi khi theo dõi ${symbol}:`, error);
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
      const volume24h = await this.getVolume24h(symbol);
      
      const riskManagement: RiskManagementData = {
        partialTakeProfitExecuted: false,
        trendTakeProfitExecuted: false,
        maxDcaReached: false,
        initialEntryPrice: actualPrice
      };

      const position: PositionData = {
        symbol,
        entryPrice: actualPrice,
        positionSize: initialQty,
        takeProfitLevels: [],
        stopLossLevels: [],
        dcaLevels: [],
        improvedDcaLevels: [], // THAY THẾ positiveDcaLevels
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
        improvedDcaCount: 0, // THAY THẾ positiveDcaCount
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
        retraceLevels: [] // THÊM CHO CHIẾN LƯỢC MỚI
      };

      this.positions.set(symbol, position);

      console.log(`✅ [PUMP_POSITION_OPENED] ${symbol} | Size: ${initialQty} | Entry: $${actualPrice.toFixed(6)}`);
      console.log(`   📊 Volume 24h: ${(volume24h/1000000).toFixed(2)}M`);
      console.log(`   💰 Vốn sử dụng: ${(STRATEGY_CONFIG.initialPositionPercent * 100).toFixed(1)}% (5%)`);
      console.log(`   🎯 TP: 50% tại +${STRATEGY_CONFIG.riskManagement.takeProfitPercent}% | 50% theo trend`);
      console.log(`   🚫 SL: KHÔNG CÓ STOP LOSS HOÀN TOÀN - GỒNG ĐẾN CHÁY`);
      console.log(`   🔄 DCA ÂM: Khi lỗ ${STRATEGY_CONFIG.pumpStrategy.negativeDcaThreshold}% (5% vốn)`);
      console.log(`   🔄 DCA MỚI: 5% vốn tại các mức Fibonacci hồi lại (23.6%, 38.2%, 50%, 61.8%, 78.6%)`);
      console.log(`   ⚠️  SL CỨNG: -${Math.abs(STRATEGY_CONFIG.riskManagement.slAfterMaxDca)}% sau khi max DCA`);

    } catch (error) {
      console.error(`❌ [PUMP_ENTRY_ERROR] Lỗi khi vào lệnh ${symbol}:`, error);
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
        await this.checkImprovedDCA(symbol, position, currentPrice); // THÊM KIỂM TRA DCA CẢI TIẾN

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
    
    console.log(`\n📊 STATUS: Balance: $${this.accountBalance.toFixed(2)} | Positions: ${this.positions.size}/${STRATEGY_CONFIG.maxActivePositions} | PnL: $${this.totalProfit.toFixed(2)}`);
    console.log(`   Tracking: Pump: ${this.pumpTrackingCoins.size} | General: ${this.trackingCoins.size}`);
    console.log(`   Valid Symbols: ${this.validSymbolsCache.size} | Invalid Symbols: ${this.invalidSymbolsCache.size}`);
    console.log(`   💸 Auto Transfer: $${this.totalTransferred} transferred | Next check: 20s`);
    console.log(`   🎯 Volume Max: 6M | TP: 50% tại +${STRATEGY_CONFIG.riskManagement.takeProfitPercent}% + 50% theo trend`);
    console.log(`   🚫 SL: KHÔNG CÓ HOÀN TOÀN - GỒNG ĐẾN CHÁY`);
    console.log(`   ⚠️  SL CỨNG: -${Math.abs(STRATEGY_CONFIG.riskManagement.slAfterMaxDca)}% sau max DCA`);
    console.log(`   📉 Loại coin biến động > 30% 24H & chỉ chọn coin XU HƯỚNG GIẢM DÀI HẠN (EMA200 4H+1H)`);
    console.log(`   🚫 Loại coin hot (volume > 50M)`);
    console.log(`   🎯 Chỉ theo dõi coin volume <= 6M & xu hướng giảm`);
    console.log(`   💰 Vốn mỗi lệnh: 5% | DCA Âm: 5% khi lỗ 50% | DCA Mới: 5% tại Fibonacci`);
    console.log(`   🔄 DCA Mới: 5% vốn tại các mức Fibonacci (23.6%, 38.2%, 50%, 61.8%, 78.6%)`);
    
    if (this.trackingCoins.size > 0) {
      console.log(`\n🎯 TREND TRACKING (${this.trackingCoins.size} coins):`);
      for (const [symbol, coinData] of this.trackingCoins.entries()) {
        const trend = this.trendAnalysisCache.get(symbol);
        const trendInfo = trend ? `${trend.data.trendDirection} (${(trend.data.overallScore * 100).toFixed(1)}%)` : 'N/A';
        console.log(`   ${symbol}: Trend ${trendInfo} | Confidence: ${coinData.confidence}% | ${coinData.signalType}`);
      }
    }
    
    if (this.pumpTrackingCoins.size > 0) {
      console.log(`\n🎯 PUMP TRACKING (${this.pumpTrackingCoins.size} coins):`);
      for (const [symbol, trackData] of this.pumpTrackingCoins.entries()) {
        const currentPrice = trackData.currentPrice || await this.getCurrentPrice(symbol);
        const dropFromPeak = trackData.dropFromPeak || ((trackData.peakPrice - currentPrice) / trackData.peakPrice) * 100;
        console.log(`   ${symbol}: Pump +${trackData.initialPumpPct.toFixed(1)}% | Drop: ${dropFromPeak.toFixed(1)}% | Risk: ${trackData.riskLevel}`);
      }
    }
    
    if (this.positions.size > 0) {
      for (const [symbol, position] of this.positions.entries()) {
        const currentPrice = await this.getCurrentPrice(symbol);
        const profitData = await this.calculateProfitAndPriceChange(position, currentPrice);
        const status = profitData.profit >= 0 ? 'PROFIT' : 'LOSS';
        const closedPercent = ((position.closedAmount / position.positionSize) * 100).toFixed(1);
        const accountLossPercent = position.initialAccountBalance ? 
          ((position.initialAccountBalance - this.accountBalance) / position.initialAccountBalance * 100).toFixed(1) : '0.0';
        
        let extraInfo = '';
        if (position.dcaCount > 0) {
          extraInfo += ` | DCA:${position.dcaCount}`;
        }
        if (position.improvedDcaCount > 0) {
          extraInfo += ` | FibDCA:${position.improvedDcaCount}`;
        }
        if (position.dcaDisabled) {
          extraInfo += ` | DCA_STOPPED`;
        }
        if (position.riskManagement.partialTakeProfitExecuted) {
          extraInfo += ` | 50%_TP_HIT`;
        }
        if (position.riskManagement.maxDcaReached) {
          extraInfo += ` | MAX_DCA`;
        }
        if (position.riskManagement.hardStopLossPrice) {
          const slPercent = ((position.riskManagement.hardStopLossPrice - position.averagePrice) / position.averagePrice * 100).toFixed(1);
          extraInfo += ` | SL:${slPercent}%`;
        }
        
        console.log(`   ${symbol}: ${status} $${profitData.profit.toFixed(2)} (${profitData.priceChangePercent.toFixed(1)}%) | Closed: ${closedPercent}% | Acc Loss: ${accountLossPercent}% | ${position.signalType}${extraInfo}`);
      }
    }

    console.log('');
  }

  async run(): Promise<void> {
    console.log('🚀 FAKE PUMP STRATEGY BOT STARTED - GỒNG LỆNH KHÔNG SL HOÀN TOÀN');
    console.log('🎯 VOLUME TỐI ĐA: 6M USDT');
    console.log('⏰ TUỔI COIN: > 14 ngày');
    console.log('📉 LOẠI COIN BIẾN ĐỘNG > 30% 24H');
    console.log('🚫 LOẠI COIN HOT (VOLUME > 50M)');
    console.log('💰 VÀO LỆNH: 5% tài sản');
    console.log('🔄 DCA ÂM: 5% vốn khi lỗ 50%');
    console.log('🎯 DCA MỚI: 5% vốn tại các mức Fibonacci hồi lại');
    console.log('🚫 KHÔNG CÓ STOP LOSS HOÀN TOÀN - GỒNG ĐẾN KHI CHÁY HOÀN TOÀN');
    console.log('🎯 TP: 50% tại +5% | 50% theo trend');
    console.log('⚠️  SL CỨNG: -80% sau khi max DCA');
    console.log('📈 XU HƯỚNG: EMA200 (4H + 1H)');
    console.log('💸 TỰ ĐỘNG CHUYỂN TIỀN: 20s kiểm tra 1 lần, chuyển $50 khi futures < $10');

    console.log('\n🔍 [SYMBOL_VALIDATION] Đang kiểm tra symbol hợp lệ...');
    await this.validateAllSymbols();

    await this.fetchBinanceSymbols();
    
    this.accountBalance = await this.getUSDTBalance();
    this.initialBalance = this.accountBalance;
    
    if (this.accountBalance <= 0) {
      console.error('❌ [BALANCE_ERROR] Cannot get balance');
      return;
    }
    
    console.log(`💰 [BALANCE] Initial Balance: $${this.initialBalance.toFixed(2)}\n`);
    
    this.isRunning = true;

    // INTERVAL KIỂM TRA VÀ CHUYỂN TIỀN 20 GIÂY 1 LẦN
    const transferInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(transferInterval);
        return;
      }
      await this.checkAndTransferFunds();
    }, STRATEGY_CONFIG.autoTransfer.checkInterval);

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
        console.log('🔄 [SYMBOL_REVALIDATION] Đang kiểm tra lại symbol hợp lệ...');
        await this.validateAllSymbols();
      }
    }, 30 * 60 * 1000);

    const mainLoop = async (): Promise<void> => {
      if (!this.isRunning) return;

      try {
        this.accountBalance = await this.getUSDTBalance();
        
        await this.scanForPumpSignals();
        
        await this.updatePumpTrackingCoins();
        
        await this.scanAndSelectTopCoins();
        this.updateTrackingList();
        await this.trackTopCoinsRealTime();
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
    
    console.log(`\n🛑 Bot stopped | Orders: ${this.totalOrders} | PnL: $${this.totalProfit.toFixed(2)} | Transferred: $${this.totalTransferred}`);
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
