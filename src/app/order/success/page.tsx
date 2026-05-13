// src/app/order/success/page.tsx
//
// Phase 8 — order-success page with the "Amina will call you in N seconds"
// countdown overlay. Server component shell + a client poll component
// that hits Confirmi's public status endpoint every 2 seconds.
//
// During a demo: the founder either redirects the prospect here after
// the storefront form submits, or hands them the URL manually
// (/order/success?orderNumber=12345). The countdown fills the dead air
// between "order placed" and "phone rings."

import { OrderSuccessClient } from "./OrderSuccessClient";

export const runtime = "nodejs";

export default function OrderSuccessPage({
  searchParams,
}: {
  searchParams: { orderNumber?: string };
}) {
  const orderNumber = searchParams.orderNumber ?? "";
  const confirmiBase = process.env.NEXT_PUBLIC_CONFIRMI_VOICE_BASE_URL ?? "";
  const source = process.env.NEXT_PUBLIC_CONFIRMI_VOICE_SOURCE ?? "curiodz";

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 px-4 py-12">
      <div className="mx-auto max-w-2xl space-y-8">
        <header className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">شكراً على طلبك</h1>
          <p className="text-neutral-400">
            تم تسجيل طلبك بنجاح. شوف الأسفل باش تعرف وقتاش غادي نعيطلك.
          </p>
        </header>

        <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-lg">
          {orderNumber ? (
            <OrderSuccessClient
              orderNumber={orderNumber}
              confirmiBase={confirmiBase}
              source={source}
            />
          ) : (
            <p className="text-sm text-neutral-400 text-center">
              لا يوجد رقم طلب في الرابط.
            </p>
          )}
        </div>

        <footer className="text-center text-xs text-neutral-500">
          Curio — ألعاب الكارطة بالجزائرية
        </footer>
      </div>
    </main>
  );
}
