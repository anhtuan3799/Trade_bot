"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mexc_futures_sdk_1 = require("mexc-futures-sdk");
const config_1 = require("./config");
class MEXCFutureTradingBot {
    constructor() {
        this.positions = new Map();
        this.priceHistory = new Map();
        this.accountInfo = {
            availableBalance: 0,
            totalBalance: 0,
            unrealizedPL: 0
        };
        this.client = new mexc_futures_sdk_1.MexcFuturesClient({
            authToken: config_1.CONFIG.AUTH_TOKEN
        });
        console.log('🤖 MEXC Future Trading Bot initialized');
    }
    // Lấy tất cả các cặp future
    async getAllFuturePairs() {
        try {
            // Lấy tất cả tickers - API này có thể cần điều chỉnh theo SDK thực tế
            const response = await this.client.getTicker("");
            return Array.isArray(response.data) ? response.data : [response.data];
        }
        catch (error) {
            console.error('❌ Lỗi khi lấy danh sách cặp:', error);
            return [];
        }
    }
    // Cập nhật lịch sử giá
    updatePriceHistory(symbol, ticker) {
        if (!this.priceHistory.has(symbol)) {
            this.priceHistory.set(symbol, []);
        }
        const history = this.priceHistory.get(symbol);
        history.push(ticker);
        // Giữ chỉ 50 phiên gần nhất
        if (history.length > 50) {
            history.shift();
        }
    }
    // Phân tích tín hiệu giao dịch
    analyzeTradingSignal(ticker) {
        const symbol = ticker.symbol;
        const currentPrice = parseFloat(ticker.lastPrice);
        const pumpPercentage = parseFloat(ticker.riseFallRate) * 100;
        this.updatePriceHistory(symbol, ticker);
        const history = this.priceHistory.get(symbol);
        if (!history || history.length < config_1.CONFIG.VOLUME.LOOKBACK_PERIOD) {
            return {
                symbol,
                signal: 'HOLD',
                reason: 'Không đủ dữ liệu lịch sử',
                currentPrice,
                pumpPercentage,
                volumeChange: 0,
                timestamp: Date.now()
            };
        }
        // Tính toán volume change
        const recentVolumes = history.slice(-5).map(h => parseFloat(h.volume));
        const previousVolumes = history.slice(-10, -5).map(h => parseFloat(h.volume));
        const avgRecentVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
        const avgPreviousVolume = previousVolumes.reduce((a, b) => a + b, 0) / previousVolumes.length;
        const volumeRatio = avgPreviousVolume > 0 ? avgRecentVolume / avgPreviousVolume : 1;
        // Điều kiện vào lệnh SHORT
        if (pumpPercentage > config_1.CONFIG.TRADING.MIN_PUMP_PERCENTAGE) {
            if (volumeRatio < config_1.CONFIG.VOLUME.VOLUME_DECREASE_THRESHOLD) {
                return {
                    symbol,
                    signal: 'SHORT',
                    reason: `Pump ${pumpPercentage.toFixed(2)}% với volume giảm ${((1 - volumeRatio) * 100).toFixed(2)}%`,
                    currentPrice,
                    pumpPercentage,
                    volumeChange: volumeRatio,
                    timestamp: Date.now()
                };
            }
        }
        return {
            symbol,
            signal: 'HOLD',
            reason: 'Không đủ điều kiện',
            currentPrice,
            pumpPercentage,
            volumeChange: volumeRatio,
            timestamp: Date.now()
        };
    }
    // Lấy thông tin tài khoản
    async updateAccountInfo() {
        try {
            // Giả sử có API để lấy account info - cần kiểm tra SDK thực tế
            const account = await this.client.getAccount();
            this.accountInfo = {
                availableBalance: parseFloat(account.data.availableBalance),
                totalBalance: parseFloat(account.data.totalBalance),
                unrealizedPL: parseFloat(account.data.unrealizedPL)
            };
            console.log(`💰 Số dư khả dụng: ${this.accountInfo.availableBalance} USDT`);
        }
        catch (error) {
            console.error('❌ Lỗi khi cập nhật thông tin tài khoản:', error);
        }
    }
    // Vào lệnh SHORT
    async openShortPosition(signal) {
        try {
            const positionSize = this.calculatePositionSize(signal.currentPrice, config_1.CONFIG.TRADING.INITIAL_POSITION_PERCENT);
            const order = await this.client.submitOrder({
                symbol: signal.symbol,
                price: signal.currentPrice,
                vol: positionSize,
                side: 3, // 3 = open short
                type: 5, // 5 = market order
                openType: 2, // 1 = isolated margin
                leverage: config_1.CONFIG.TRADING.LEVERAGE,
            });
            if (order.code === 0) {
                console.log(`✅ Đã vào lệnh SHORT: ${signal.symbol}`);
                console.log(`   Khối lượng: ${positionSize}, Giá: ${signal.currentPrice}`);
                console.log(`   Lý do: ${signal.reason}`);
                // Lưu thông tin position
                const position = {
                    symbol: signal.symbol,
                    entryPrice: signal.currentPrice,
                    positionSize: positionSize,
                    dcaCount: 1,
                    positionType: 'SHORT',
                    timestamp: Date.now()
                };
                this.positions.set(signal.symbol, position);
                // Đặt TP/SL
                await this.setTakeProfitAndStopLoss(position);
                return true;
            }
            else {
                console.error(`❌ Lỗi đặt lệnh: ${order.msg}`);
                return false;
            }
        }
        catch (error) {
            console.error(`❌ Lỗi khi vào lệnh SHORT cho ${signal.symbol}:`, error);
            return false;
        }
    }
    // Tính toán khối lượng position
    calculatePositionSize(price, percent) {
        const amount = this.accountInfo.availableBalance * percent;
        return parseFloat((amount / price).toFixed(6)); // Làm tròn 6 số thập phân
    }
    // DCA khi giá giảm
    async addDCAPosition(symbol, currentPrice) {
        const position = this.positions.get(symbol);
        if (!position) {
            console.log(`❌ Không tìm thấy position cho ${symbol}`);
            return false;
        }
        if (position.dcaCount >= config_1.CONFIG.TRADING.MAX_DCA_COUNT) {
            console.log(`⚠️ Đã đạt max DCA (${config_1.CONFIG.TRADING.MAX_DCA_COUNT}) cho ${symbol}`);
            return false;
        }
        const dcaSize = this.calculatePositionSize(currentPrice, config_1.CONFIG.TRADING.DCA_PERCENT);
        try {
            const order = await this.client.submitOrder({
                symbol: symbol,
                price: currentPrice,
                vol: dcaSize,
                side: 3, // open short
                type: 5, // market order
                openType: 2, // isolated margin
                leverage: config_1.CONFIG.TRADING.LEVERAGE,
            });
            if (order.code === 0) {
                position.dcaCount++;
                position.positionSize += dcaSize;
                position.entryPrice = (position.entryPrice * (position.dcaCount - 1) + currentPrice) / position.dcaCount;
                console.log(`📈 Đã DCA lần ${position.dcaCount} cho ${symbol}`);
                console.log(`   Khối lượng: ${dcaSize}, Giá DCA: ${currentPrice}`);
                // Cập nhật TP/SL
                await this.setTakeProfitAndStopLoss(position);
                return true;
            }
            return false;
        }
        catch (error) {
            console.error(`❌ Lỗi khi DCA cho ${symbol}:`, error);
            return false;
        }
    }
    // DCA ngược khi giá tăng
    async addReverseDCAPosition(symbol, currentPrice) {
        const position = this.positions.get(symbol);
        if (!position) {
            console.log(`❌ Không tìm thấy position cho ${symbol}`);
            return false;
        }
        if (position.dcaCount >= config_1.CONFIG.TRADING.MAX_REVERSE_DCA_COUNT) {
            console.log(`⚠️ Đã đạt max reverse DCA (${config_1.CONFIG.TRADING.MAX_REVERSE_DCA_COUNT}) cho ${symbol}`);
            return false;
        }
        const dcaSize = this.calculatePositionSize(currentPrice, config_1.CONFIG.TRADING.REVERSE_DCA_PERCENT);
        try {
            const order = await this.client.submitOrder({
                symbol: symbol,
                price: currentPrice,
                vol: dcaSize,
                side: 3, // open short
                type: 5, // market order
                openType: 2, // isolated margin
                leverage: config_1.CONFIG.TRADING.LEVERAGE,
            });
            if (order.code === 0) {
                position.dcaCount++;
                position.positionSize += dcaSize;
                position.entryPrice = (position.entryPrice * (position.dcaCount - 1) + currentPrice) / position.dcaCount;
                console.log(`🔄 Đã Reverse DCA lần ${position.dcaCount} cho ${symbol}`);
                console.log(`   Khối lượng: ${dcaSize}, Giá: ${currentPrice}`);
                await this.setTakeProfitAndStopLoss(position);
                return true;
            }
            return false;
        }
        catch (error) {
            console.error(`❌ Lỗi khi reverse DCA cho ${symbol}:`, error);
            return false;
        }
    }
    // Đặt Take Profit và Stop Loss
    async setTakeProfitAndStopLoss(position) {
        const { entryPrice, symbol } = position;
        // Tính toán giá TP/SL
        const tpPrice = entryPrice * (1 - config_1.CONFIG.TRADING.TAKE_PROFIT_PERCENT / 100);
        const slPrice = entryPrice * (1 + config_1.CONFIG.TRADING.STOP_LOSS_PERCENT / 100);
        console.log(`📊 Đặt TP/SL cho ${symbol}:`);
        console.log(`   TP: ${tpPrice.toFixed(6)} (${config_1.CONFIG.TRADING.TAKE_PROFIT_PERCENT}%)`);
        console.log(`   SL: ${slPrice.toFixed(6)} (${config_1.CONFIG.TRADING.STOP_LOSS_PERCENT}%)`);
        console.log(`   Entry: ${entryPrice.toFixed(6)}`);
        // Trong thực tế, bạn cần implement logic đặt lệnh TP/SL
        // Có thể sử dụng limit order cho TP và stop market cho SL
    }
    // Theo dõi và quản lý positions
    async monitorPositions() {
        for (const [symbol, position] of this.positions.entries()) {
            try {
                const ticker = await this.client.getTicker(symbol);
                const currentPrice = parseFloat(ticker.data.lastPrice);
                const priceChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
                console.log(`📈 Theo dõi ${symbol}:`);
                console.log(`   Giá hiện tại: ${currentPrice}`);
                console.log(`   P/L: ${priceChange.toFixed(2)}%`);
                // Logic DCA và Reverse DCA
                if (priceChange < -2 && priceChange > -10) { // Giá giảm 2-10%
                    await this.addDCAPosition(symbol, currentPrice);
                }
                else if (priceChange > 1 && priceChange < 5) { // Giá tăng 1-5%
                    await this.addReverseDCAPosition(symbol, currentPrice);
                }
            }
            catch (error) {
                console.error(`❌ Lỗi khi theo dõi position ${symbol}:`, error);
            }
        }
    }
    // Hàm chạy bot
    async run() {
        console.log('🚀 Bắt đầu MEXC Future Trading Bot...');
        await this.updateAccountInfo();
        setInterval(async () => {
            try {
                console.log('\n🔍 Quét tín hiệu giao dịch...');
                await this.updateAccountInfo();
                const pairs = await this.getAllFuturePairs();
                let signalsCount = 0;
                for (const pair of pairs) {
                    const signal = this.analyzeTradingSignal(pair);
                    if (signal.signal === 'SHORT' && !this.positions.has(signal.symbol)) {
                        console.log(`🎯 Tìm thấy tín hiệu: ${signal.symbol} - ${signal.reason}`);
                        await this.openShortPosition(signal);
                        signalsCount++;
                    }
                }
                if (signalsCount === 0) {
                    console.log('⏳ Không tìm thấy tín hiệu giao dịch phù hợp');
                }
                // Theo dõi positions hiện có
                if (this.positions.size > 0) {
                    await this.monitorPositions();
                }
            }
            catch (error) {
                console.error('❌ Lỗi trong vòng lặp chính:', error);
            }
        }, 60000); // Quét mỗi 1 phút
    }
}
// Chạy bot
const bot = new MEXCFutureTradingBot();
// Xử lý lỗi toàn cục
process.on('uncaughtException', (error) => {
    console.error('⚠️ Lỗi nghiêm trọng:', error);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection tại:', promise, 'lí do:', reason);
});
// Khởi động bot
bot.run().catch(console.error);
