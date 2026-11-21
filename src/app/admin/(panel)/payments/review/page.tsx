// Admin payment-review queue (Phase 3, H-16). The review API existed with
// zero callers; this page is its admin surface. Role + MFA are enforced by
// the admin panel layout.
import { listPaymentReviewCases } from "@/services/payment-review.service";
import { PaymentReviewQueue } from "@/components/admin/payment-review-queue";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment review · Admin" };

export default async function AdminPaymentReviewPage() {
  const cases = await listPaymentReviewCases();
  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <PaymentReviewQueue cases={cases} />
      </div>
    </div>
  );
}
