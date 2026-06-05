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
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  price?: number;
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
  cancelOrder(orderId: string): Promise<boolean>;
  // clientOrderId로 주문 조회 (모호한 placeOrder 실패 후 실제 체결 여부 reconcile).
  // 미구현 어댑터는 undefined → 호출측은 reconcile 불가로 간주(보수적 처리). 주문 없으면 null.
  getOrderByClientId?(symbol: string, clientOrderId: string): Promise<OrderResult | null>;
  // 거래소 수량 단위(LOT_SIZE 등)에 맞춰 주문 수량 정규화. 미구현 시 원본 수량 사용.
  normalizeQuantity?(symbol: string, quantity: number, refPrice: number): Promise<number>;
}
