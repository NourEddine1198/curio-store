import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { computeStats, fetchOrdersForCodes } from "@/lib/influencer-stats";

// ─── The influencer's own results page ──────────────────────
// Opened via their secret link /i/<shareToken>. Read-only, live,
// shows ONLY their numbers — never customer names or phones.
// This page is the "you can watch your orders live" recruiting promise.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const STATUS_AR: Record<string, { text: string; cls: string }> = {
  PENDING: { text: "جديدة", cls: "st-wait" },
  NO_ANSWER: { text: "قيد الاتصال", cls: "st-wait" },
  CALLBACK: { text: "قيد الاتصال", cls: "st-wait" },
  CONFIRMED: { text: "مؤكدة", cls: "st-ok" },
  PROCESSING: { text: "مؤكدة", cls: "st-ok" },
  SHIPPED: { text: "في الطريق", cls: "st-ship" },
  OUT_FOR_DELIVERY: { text: "في الطريق", cls: "st-ship" },
  AT_STOPDESK: { text: "في المكتب", cls: "st-ship" },
  DELIVERY_FAILED: { text: "في الطريق", cls: "st-ship" },
  DELIVERED: { text: "وصلت ✓", cls: "st-good" },
  IN_RETURN: { text: "رجعت", cls: "st-bad" },
  RETURNED: { text: "رجعت", cls: "st-bad" },
  CANCELLED: { text: "ملغاة", cls: "st-off" },
  EXPIRED: { text: "ملغاة", cls: "st-off" },
  WRONG: { text: "ملغاة", cls: "st-off" },
  DUPLICATE: { text: "ملغاة", cls: "st-off" },
};

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

// Algerian month names, formatted on the server with no locale machinery —
// identical on every render (avoids hydration mismatches) and reads natural.
const MONTHS_DZ = [
  "جانفي", "فيفري", "مارس", "أفريل", "ماي", "جوان",
  "جويلية", "أوت", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];
function dateDz(d: Date): string {
  return d.getDate() + " " + MONTHS_DZ[d.getMonth()];
}

export default async function InfluencerResultsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token || token.length < 8) notFound();

  const influencer = await db.influencer.findUnique({
    where: { shareToken: token },
    include: { payments: { orderBy: { paidAt: "desc" } } },
  });
  if (!influencer) notFound();

  const ordersByCode = await fetchOrdersForCodes([influencer.couponCode]);
  const orders = ordersByCode.get(influencer.couponCode) ?? [];
  const paidTotal = influencer.payments.reduce((n, p) => n + p.amount, 0);
  const stats = computeStats(orders, influencer, paidTotal);

  const perLabel =
    influencer.commissionBasis === "UNIT" ? "على كل لعبة" : "على كل طلب";
  const triggerLabel =
    influencer.countTrigger === "PLACED" ? "مسجّل" : "مؤكد";

  const recent = orders.slice(0, 30);

  return (
    <div className="ip" dir="rtl">
      <style dangerouslySetInnerHTML={{ __html: `
        .ip{min-height:100vh;background:#FBF6EC;color:#141414;font-family:'Segoe UI',Tahoma,system-ui,sans-serif;padding:0 0 50px;}
        .ip *{box-sizing:border-box;}
        .ip-bar{background:#141414;color:#FBF6EC;padding:16px 20px;text-align:center;}
        .ip-logo{font-weight:800;font-size:20px;color:#F9C22E;letter-spacing:.03em;}
        .ip-wrap{max-width:560px;margin:0 auto;padding:20px 16px;}
        .ip-hero{background:#F9C22E;border:3px solid #141414;border-radius:14px;box-shadow:5px 5px 0 #141414;padding:18px;text-align:center;margin-bottom:16px;}
        .ip-hero h1{margin:0;font-size:22px;}
        .ip-code{display:inline-block;background:#141414;color:#F9C22E;border-radius:8px;padding:4px 16px;font-weight:800;font-size:18px;letter-spacing:.08em;margin-top:8px;}
        .ip-hero p{margin:10px 0 0;font-size:14px;font-weight:600;}
        .ip-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
        .ip-num{background:#fff;border:2px solid #141414;border-radius:12px;box-shadow:3px 3px 0 #141414;padding:12px 8px;text-align:center;}
        .ip-num b{display:block;font-size:22px;}
        .ip-num span{font-size:11.5px;color:#6b6b6b;font-weight:700;}
        .ip-money{background:#fff;border:3px solid #141414;border-radius:14px;box-shadow:5px 5px 0 #141414;padding:16px;margin-bottom:16px;}
        .ip-money h2{margin:0 0 10px;font-size:16px;}
        .ip-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed #ddd;font-size:14px;}
        .ip-row:last-child{border-bottom:none;}
        .ip-row b{font-size:15px;}
        .ip-balance{color:#E5443A;}
        .ip-deal{font-size:12.5px;color:#6b6b6b;margin-top:10px;}
        .ip-orders{background:#fff;border:3px solid #141414;border-radius:14px;box-shadow:5px 5px 0 #141414;padding:16px;}
        .ip-orders h2{margin:0 0 10px;font-size:16px;}
        .ip-list{list-style:none;margin:0;padding:0;}
        .ip-list li{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px dashed #eee;font-size:13.5px;}
        .ip-list li:last-child{border-bottom:none;}
        .ip-chip{border-radius:8px;padding:2px 10px;font-size:12px;font-weight:700;white-space:nowrap;}
        .st-ok{background:#e1f5ee;color:#0f6e56;} .st-good{background:#2E9E5B;color:#fff;}
        .st-bad{background:#fdecea;color:#a32d2d;} .st-ship{background:#e6f1fb;color:#185fa5;}
        .st-wait{background:#f1efe8;color:#5f5e5a;} .st-off{background:#eee;color:#888;}
        .ip-empty{color:#6b6b6b;font-size:14px;text-align:center;padding:14px 0;}
        .ip-foot{text-align:center;color:#6b6b6b;font-size:12px;margin-top:18px;}
      ` }} />

      <div className="ip-bar">
        <span className="ip-logo">CURIO كيوريو</span>
      </div>

      <div className="ip-wrap">
        <div className="ip-hero">
          <h1>صحّا {influencer.name}!</h1>
          <div className="ip-code">{influencer.couponCode}</div>
          {influencer.customerDiscount > 0 ? (
            <p>
              المتبعين ديالك ياخذو −{fmt(influencer.customerDiscount)} دج بالكود
              ديالك
            </p>
          ) : (
            <p>هذي النتائج ديالك مباشرة من نظام كيوريو</p>
          )}
        </div>

        <div className="ip-grid">
          <div className="ip-num">
            <b>{fmt(stats.countedOrders)}</b>
            <span>طلب {triggerLabel} محسوب ليك</span>
          </div>
          <div className="ip-num">
            <b>{fmt(stats.delivered)}</b>
            <span>وصلت للزبون</span>
          </div>
          <div className="ip-num">
            <b>{fmt(stats.inFlight)}</b>
            <span>في الطريق</span>
          </div>
        </div>

        <div className="ip-money">
          <h2>الحساب ديالك</h2>
          <div className="ip-row">
            <span>الربح متاعك حتى الآن</span>
            <b>{fmt(stats.owedTotal)} دج</b>
          </div>
          <div className="ip-row">
            <span>وصلك (مدفوع)</span>
            <b>{fmt(stats.paidTotal)} دج</b>
          </div>
          <div className="ip-row">
            <span>الباقي عند كيوريو</span>
            <b className="ip-balance">{fmt(Math.max(0, stats.balance))} دج</b>
          </div>
          <p className="ip-deal">
            الاتفاق:{" "}
            {influencer.commissionRate > 0
              ? fmt(influencer.commissionRate) + " دج " + perLabel + " " + triggerLabel
              : "مبلغ ثابت"}
            {influencer.fixedFee > 0
              ? " + " + fmt(influencer.fixedFee) + " دج ثابتة"
              : ""}
          </p>
        </div>

        <div className="ip-orders">
          <h2>آخر الطلبات بالكود ديالك</h2>
          {recent.length === 0 ? (
            <p className="ip-empty">
              مازال والو — أول ما يستعمل واحد الكود ديالك، يبان هنا مباشرة.
            </p>
          ) : (
            <ul className="ip-list">
              {recent.map((o) => {
                const st = STATUS_AR[o.status] ?? { text: o.status, cls: "st-off" };
                return (
                  <li key={o.orderNumber}>
                    <span>
                      {dateDz(new Date(o.createdAt))} · {o.units}{" "}
                      {o.units === 1 ? "لعبة" : "ألعاب"}
                    </span>
                    <span className={"ip-chip " + st.cls}>{st.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="ip-foot">
          الأرقام حية مباشرة من نظام كيوريو — كل ما تشارك الكود، ترتفع.
        </p>
      </div>
    </div>
  );
}
