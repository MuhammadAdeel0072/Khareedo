// Unit tests — rendered order email templates (Phase 3, Chunk 7-final —
// D14/H-14). The transporter is mocked; these assert the subject, body
// and order link each send function renders, and that customer data is
// escaped in the HTML body. Run with: npm test.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentMails = vi.hoisted(() => [] as Array<{
  from?: string; to?: string; subject?: string; text?: string; html?: string;
}>);
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({
  sendMail: vi.fn(async (mail: unknown) => { sentMails.push(mail as never); }),
})) } }));

import {
  sendOrderCancelledEmail,
  sendOrderConfirmedEmail,
  sendOrderPaymentFailedEmail,
  sendOrderPaymentSucceededEmail,
  sendOrderRefundSucceededEmail,
  sendOrderStatusEmail,
} from "@/services/email.service";

const base = {
  email: "buyer@example.invalid",
  name: "Test Buyer",
  orderId: "ord-1",
  reference: "KH261120000001",
  total: 2000,
  paymentMethod: "COD",
};

beforeAll(() => {
  process.env.SMTP_HOST = "smtp.example.invalid";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_FROM = "Khareedo <no-reply@khareedo.test>";
  process.env.NEXTAUTH_URL = "http://localhost:3000";
});
beforeEach(() => { sentMails.length = 0; });

const link = "http://localhost:3000/account/orders/ord-1";

describe("order email templates", () => {
  it("confirmation email: subject, reference, total, COD line and order link", async () => {
    await sendOrderConfirmedEmail(base);
    expect(sentMails).toHaveLength(1);
    const mail = sentMails[0];
    expect(mail.to).toBe(base.email);
    expect(mail.subject).toBe("Your Khareedo order KH261120000001 is confirmed");
    expect(mail.text).toContain("KH261120000001");
    expect(mail.text).toContain("Rs 2,000");
    expect(mail.text).toContain("Cash on Delivery");
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(link);
    expect(mail.html).toContain("Hello Test Buyer,");
  });

  it("confirmation email for an online order says the payment was received", async () => {
    await sendOrderConfirmedEmail({ ...base, paymentMethod: "ONLINE" });
    expect(sentMails[0].text).toContain("your payment has been received");
  });

  it("status email: shipped carries the carrier and tracking number", async () => {
    await sendOrderStatusEmail({ ...base, status: "SHIPPED", carrier: "TCS", trackingNumber: "TRK-123" });
    const mail = sentMails[0];
    expect(mail.subject).toBe("Your Khareedo order KH261120000001 has shipped");
    expect(mail.text).toContain("Carrier: TCS");
    expect(mail.text).toContain("Tracking number: TRK-123");
    expect(mail.text).toContain(link);
    expect(mail.html).toContain("Track your order");
  });

  it("status email: delivered and processing use their own phrases", async () => {
    await sendOrderStatusEmail({ ...base, status: "DELIVERED" });
    expect(sentMails[0].subject).toBe("Your Khareedo order KH261120000001 has been delivered");
    sentMails.length = 0;
    await sendOrderStatusEmail({ ...base, status: "PROCESSING" });
    expect(sentMails[0].subject).toBe("Your Khareedo order KH261120000001 is being prepared");
  });

  it("status email: confirmed uses its own phrase (Stream G — no admin flow reaches it today, see integration.order-emails.test.ts)", async () => {
    await sendOrderStatusEmail({ ...base, status: "CONFIRMED" });
    expect(sentMails[0].subject).toBe("Your Khareedo order KH261120000001 is confirmed");
    expect(sentMails[0].text).toContain("KH261120000001 is confirmed");
    expect(sentMails[0].text).toContain(link);
  });

  it("cancellation email: subject and body name the order and total", async () => {
    await sendOrderCancelledEmail(base);
    const mail = sentMails[0];
    expect(mail.subject).toBe("Your Khareedo order KH261120000001 was cancelled");
    expect(mail.text).toContain("Your order has been cancelled");
    expect(mail.text).toContain("Rs 2,000");
    expect(mail.text).toContain(link);
  });

  it("payment succeeded email: subject and amount paid", async () => {
    await sendOrderPaymentSucceededEmail(base);
    const mail = sentMails[0];
    expect(mail.subject).toBe("Payment received for your Khareedo order KH261120000001");
    expect(mail.text).toContain("Amount paid: Rs 2,000");
    expect(mail.text).toContain(link);
  });

  it("payment failed email: subject and retry copy", async () => {
    await sendOrderPaymentFailedEmail(base);
    const mail = sentMails[0];
    expect(mail.subject).toBe("Payment failed for your Khareedo order KH261120000001");
    expect(mail.text).toContain("could not be completed");
    expect(mail.text).toContain("place the order again");
  });

  it("refund succeeded email: refund amount is converted from minor units", async () => {
    await sendOrderRefundSucceededEmail({ ...base, refundAmountMinor: 50000 });
    const mail = sentMails[0];
    expect(mail.subject).toBe("Refund processed for your Khareedo order KH261120000001");
    expect(mail.text).toContain("Refund amount: Rs 500");
    expect(mail.text).toContain(link);
  });

  it("escapes customer data in the HTML body", async () => {
    await sendOrderConfirmedEmail({ ...base, name: "<script>alert(1)</script>" });
    const mail = sentMails[0];
    expect(mail.html).not.toContain("<script>alert(1)</script>");
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
