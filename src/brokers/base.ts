/**
 * brokers/base.ts — BaseBrokerAdapter (v2 scaffold). credentials 저장 + 포트 추상화만.
 * v2에서 BinanceBrokerAdapter / HantooBrokerAdapter / KiwoomBrokerAdapter 가 extends 한다.
 * KIS/키움은 토큰 인증 공유 → 향후 TokenAuthAdapter extends BaseBrokerAdapter 권장(설계 §5b).
 */
import type {
  BrokerAdapter,
  BrokerType,
  BrokerCredentials,
  AccountBalance,
  Position,
  MarketPrice,
  OrderRequest,
  OrderResult,
} from "./types.js";

export abstract class BaseBrokerAdapter implements BrokerAdapter {
  abstract type: BrokerType;
  protected credentials: BrokerCredentials;

  constructor(credentials: BrokerCredentials) {
    this.credentials = credentials;
  }

  abstract getBalance(): Promise<AccountBalance>;
  abstract getPositions(): Promise<Position[]>;
  abstract getPrice(symbol: string): Promise<MarketPrice>;
  abstract placeOrder(order: OrderRequest): Promise<OrderResult>;
  abstract cancelOrder(orderId: string): Promise<boolean>;
}
