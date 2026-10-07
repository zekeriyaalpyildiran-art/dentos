/**
 * Payment Service
 * Integrates with Iyzico for Turkish payment processing
 *
 * Supports:
 * - One-time payments
 * - Installment plans (3, 6, 12 months)
 * - Card storage and recurring payments
 * - Invoice generation
 */

export interface PaymentConfig {
  iyzApiKey: string;
  iyzSecretKey: string;
  iyzBaseUrl: string;
}

export interface PaymentPayload {
  treatmentPlanId: string;
  patientId: string;
  amount: number;
  currency: "TRY" | "USD" | "EUR";
  cardHolderName: string;
  cardNumber: string;
  expireMonth: string;
  expireYear: string;
  cvc: string;
  installments?: number; // 1, 3, 6, 12
}

export interface PaymentResponse {
  success: boolean;
  transactionId?: string;
  status?: "approved" | "pending" | "declined";
  message?: string;
  error?: string;
}

export interface InstallmentPlan {
  installments: number;
  monthlyAmount: number;
  totalAmount: number;
  interestRate: number;
}

export class PaymentService {
  private apiKey: string;
  private secretKey: string;
  private baseUrl: string;

  constructor(config: PaymentConfig) {
    this.apiKey = config.iyzApiKey;
    this.secretKey = config.iyzSecretKey;
    this.baseUrl = config.iyzBaseUrl;
  }

  /**
   * Process payment via Iyzico
   */
  async processPayment(payload: PaymentPayload): Promise<PaymentResponse> {
    try {
      if (!this.validateCard(payload)) {
        return {
          success: false,
          error: "Invalid card information",
        };
      }

      // TODO: Implement actual Iyzico API call
      // const response = await fetch(`${this.baseUrl}/payment`, {
      //   method: 'POST',
      //   headers: this.getHeaders(),
      //   body: JSON.stringify({
      //     locale: 'tr',
      //     conversationId: payload.treatmentPlanId,
      //     price: payload.amount,
      //     paidPrice: payload.amount,
      //     currency: payload.currency,
      //     installment: payload.installments || 1,
      //     basketId: payload.treatmentPlanId,
      //     paymentChannel: 'WEB',
      //     paymentGroup: 'PRODUCT',
      //     paymentCard: {
      //       cardHolderName: payload.cardHolderName,
      //       cardNumber: payload.cardNumber,
      //       expireMonth: payload.expireMonth,
      //       expireYear: payload.expireYear,
      //       cvc: payload.cvc,
      //     },
      //   }),
      // });

      const transactionId = `iyz_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      console.log(
        `[PAYMENT-STUB] Processed ₺${payload.amount} for plan ${payload.treatmentPlanId}`
      );

      return {
        success: true,
        transactionId,
        status: "approved",
        message: "Ödeme başarıyla alındı",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Payment processing failed",
      };
    }
  }

  /**
   * Calculate installment plans
   */
  calculateInstallments(totalAmount: number): InstallmentPlan[] {
    const plans: InstallmentPlan[] = [];

    // Interest rates (typically 0%, 2%, 5% for 3, 6, 12 months)
    const interestRates = {
      1: 0,
      3: 0,
      6: 0.02,
      12: 0.05,
    } as Record<number, number>;

    for (const [months, rate] of Object.entries(interestRates)) {
      const monthsNum = parseInt(months);
      const interest = totalAmount * rate;
      const totalWithInterest = totalAmount + interest;
      const monthlyAmount = totalWithInterest / monthsNum;

      plans.push({
        installments: monthsNum,
        monthlyAmount: parseFloat(monthlyAmount.toFixed(2)),
        totalAmount: parseFloat(totalWithInterest.toFixed(2)),
        interestRate: rate * 100,
      });
    }

    return plans;
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(transactionId: string): Promise<PaymentResponse> {
    try {
      // TODO: Query Iyzico for transaction status
      // const response = await fetch(`${this.baseUrl}/payment/${transactionId}`, {
      //   headers: this.getHeaders(),
      // });

      console.log(`[PAYMENT-STATUS] Querying ${transactionId}`);

      return {
        success: true,
        transactionId,
        status: "approved",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get payment status",
      };
    }
  }

  /**
   * Refund payment
   */
  async refundPayment(
    transactionId: string,
    amount?: number
  ): Promise<PaymentResponse> {
    try {
      // TODO: Implement Iyzico refund API call
      // const response = await fetch(`${this.baseUrl}/payment/${transactionId}/refund`, {
      //   method: 'POST',
      //   headers: this.getHeaders(),
      //   body: JSON.stringify({
      //     price: amount,
      //   }),
      // });

      console.log(
        `[PAYMENT-REFUND] Refund initiated for ${transactionId} (${amount})`
      );

      return {
        success: true,
        message: "İade işlemi başlatıldı",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Refund failed",
      };
    }
  }

  /**
   * Validate card information
   */
  private validateCard(payload: PaymentPayload): boolean {
    // Basic validation
    if (!payload.cardNumber || payload.cardNumber.length < 13) {
      return false;
    }

    if (!payload.expireMonth || !payload.expireYear) {
      return false;
    }

    if (!payload.cvc || payload.cvc.length < 3) {
      return false;
    }

    return true;
  }

  /**
   * Get request headers for Iyzico API
   */
  private getHeaders(): Record<string, string> {
    // TODO: Add HMAC signature
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}

export function createPaymentService(config: PaymentConfig): PaymentService {
  return new PaymentService(config);
}
