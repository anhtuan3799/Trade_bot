"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
exports.CONFIG = {
    // Lấy authToken từ browser developer tools
    AUTH_TOKEN: process.env.MEXC_AUTH_TOKEN || "WEB_YOUR_TOKEN_HERE",
    // Cài đặt giao dịch
    TRADING: {
        MIN_PUMP_PERCENTAGE: 5, // Pump tối thiểu 5%
        INITIAL_POSITION_PERCENT: 0.2, // 20% vốn ban đầu
        DCA_PERCENT: 0.2, // 20% vốn cho mỗi lần DCA
        REVERSE_DCA_PERCENT: 0.1, // 10% vốn cho DCA ngược
        MAX_DCA_COUNT: 4, // Tối đa 4 lần DCA
        MAX_REVERSE_DCA_COUNT: 2, // Tối đa 2 lần DCA ngược
        LEVERAGE: 20, // Đòn bẩy
        TAKE_PROFIT_PERCENT: 5, // TP 5%
        STOP_LOSS_PERCENT: 2, // SL 2%
    },
    // Cài đặt volume
    VOLUME: {
        LOOKBACK_PERIOD: 10, // Số phiên lookback
        VOLUME_DECREASE_THRESHOLD: 0.8, // Volume giảm 20%
    }
};
