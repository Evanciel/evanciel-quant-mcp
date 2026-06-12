/**
 * brokers/types.ts — 멀티브로커 어댑터 포트(v2 계약). v1에서는 **scaffold만**이며 실행 경로 없음.
 * v2(라이브, bring-your-own-keys)에서 Binance/한국투자(KIS)/키움 어댑터가 이 포트를 구현한다.
 * 설계: docs/02-design/quant-mcp-v1-design.md §5. 키움은 KIS와 wire 비호환 → 전용 KiwoomBrokerAdapter 필요.
 */
export type BrokerType = "hantoo" | "kiwoom" | "binance" | "alpaca";

export interface BrokerConfig {
  type: BrokerType;
  label: string;
  description: string;
  guideUrl?: string;
  guideSteps?: string[];
  fields: { key: string; label: string; type: "text" | "password" }[];
}

export type BrokerCredentials = Record<string, string>;

export interface AccountBalance {
  totalAsset: number;
  cashBalance: number;
  currency: string;
}

export interface Position {
  symbol: string;
  name: string;
  quantity: number;
  free?: number; // 현물 매도가능 수량(=balances.free, 잠긴 OCO 제외). 미설정=미상(선물/KIS/키움).
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  // market/limit + 거래소 상주 보호주문(트리거 시 발동): stop_market(손절 시장가), stop_limit(손절 지정가),
  // take_profit_market(익절 시장가). 보호주문은 stopPrice(트리거가) 필수 + reduceOnly 권장.
  type: "market" | "limit" | "stop_market" | "stop_limit" | "take_profit_market";
  quantity: number;
  price?: number;
  stopPrice?: number;     // 보호주문 트리거 가격(stop_*/take_profit_*).
  reduceOnly?: boolean;   // 포지션 축소 전용(보호주문·숏커버). 선물에서 의미.
  // 거래소 레벨 멱등키. 동일 clientOrderId 재전송은 거래소가 중복으로 거부/기존주문 반환 →
  // 같은 슬롯 재시도 시 중복 주문 방지. 모호한 실패 후 주문조회(reconcile)에도 사용.
  clientOrderId?: string;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  status: "filled" | "pending" | "rejected";
  timestamp: Date;
  /** 실제 체결 수량(부분체결 구분, audit P1-1). 미지원 브로커는 부재(quantity로 폴백). */
  executedQty?: number;
  /** 원 주문 수량. executedQty < origQty 면 부분체결. */
  origQty?: number;
}

export interface MarketPrice {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: Date;
}

export interface BrokerAdapter {
  type: BrokerType;
  getBalance(): Promise<AccountBalance>;
  getPositions(): Promise<Position[]>;
  getPrice(symbol: string): Promise<MarketPrice>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  // 주문 취소. symbol 필수(Binance 등 거래소가 요구). 미지정 시 어댑터가 credentials.symbol 폴백 시도.
  cancelOrder(orderId: string, symbol?: string): Promise<boolean>;
  // clientOrderId로 취소(상주 보호주문 정리/트레일링 교체). 미구현 어댑터는 undefined.
  cancelOrderByClientId?(symbol: string, clientOrderId: string): Promise<boolean>;
  // 심볼의 미체결(상주) 주문 목록. 고아 주문 정리/점검용. 미구현 어댑터는 undefined.
  getOpenOrders?(symbol: string): Promise<OrderResult[]>;
  // clientOrderId로 주문 조회 (모호한 placeOrder 실패 후 실제 체결 여부 reconcile).
  // 미구현 어댑터는 undefined → 호출측은 reconcile 불가로 간주(보수적 처리). 주문 없으면 null.
  getOrderByClientId?(symbol: string, clientOrderId: string): Promise<OrderResult | null>;
  // 거래소 orderId로 주문 조회(수동 지정가 체결 추적·역쿼리, audit P1-16/20). 주문 없으면 null.
  getOrderById?(symbol: string, orderId: string): Promise<OrderResult | null>;
  // 거래소 수량 단위(LOT_SIZE 등)에 맞춰 주문 수량 정규화. 미구현 시 원본 수량 사용.
  normalizeQuantity?(symbol: string, quantity: number, refPrice: number): Promise<number>;
  // 현물 OCO 보호주문(익절 LIMIT_MAKER + 손절 STOP_LOSS_LIMIT 묶음, 한쪽 체결 시 다른쪽 자동취소). 현물 SELL 전용.
  // 미지원 어댑터(선물/KIS/키움)는 undefined → 호출측이 typeof로 가드.
  placeOco?(p: { symbol: string; quantity: number; takeProfitPrice: number; stopPrice: number; stopLimitPrice?: number; listClientOrderId?: string }): Promise<{ orderListId: string; orders: OrderResult[] }>;
  cancelOco?(symbol: string, orderListId: string): Promise<boolean>;
  // 심볼의 상주 OCO 조회(세션 간 상태 복원·중복 등록 방지). 없으면 null.
  getOpenOco?(symbol: string): Promise<{ orderListId: string; tpPrice: number; slPrice: number } | null>;
  // 거래소 권위 base 자산(비표준 quote 페어 정확). 미구현 어댑터=undefined → 호출측 정규식 폴백.
  baseAssetOf?(symbol: string): Promise<string>;
}
