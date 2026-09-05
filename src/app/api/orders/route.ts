import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendToOrderDZ } from "@/lib/orderdz";
import { sendToConfirmiVoice } from "@/lib/confirmi-voice";
import { countCapUses } from "@/lib/influencer-stats";
import { recordCheckoutFailure, pageFromReferer } from "@/lib/checkout-failures";
import { signUpsellToken } from "@/lib/upsell-token";
import { moveStock, availableUnits } from "@/lib/stock";
import { sendPurchaseToMeta } from "@/lib/meta-capi";
import { resolveDefaultAgentId } from "@/lib/agent-routing";

// ─── Validation helpers ──────────────────────────────────

const PHONE_RE = /^0[567]\d{8}$/; // Algerian mobile: 05/06/07 + 8 digits

/**
 * Bring an Algerian mobile to its canonical `0XXXXXXXXX` form before we judge it.
 *
 * People type their own number the way they read it out: with spaces, with the
 * country code, sometimes both. All of these are the SAME phone —
 *   "+213557227001", "00213 557 227 001", "213557227001", "557227001",
 *   "05 57 22 70 01"  →  "0557227001"
 * — and we used to reject every one of them except the last shape, turning away
 * real customers at checkout with "the number must start with 05/06/07".
 *
 * Returns the canonical string, or the input trimmed when we can't make sense
 * of it (so PHONE_RE still rejects genuine rubbish rather than us guessing).
 */
function normalizeDzPhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00213")) digits = digits.slice(5);
  else if (digits.startsWith("213")) digits = digits.slice(3);
  // A bare national number ("557227001") is missing only its leading zero.
  if (digits.length === 9 && /^[567]/.test(digits)) digits = "0" + digits;
  return PHONE_RE.test(digits) ? digits : trimmed;
}

// Admin key — MUST be set in environment. No default = no access.
const ADMIN_KEY = process.env.ADMIN_KEY;

// ─── Security config ─────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes
const RATE_LIMIT_MAX_ORDERS = 5;               // max 5 orders per IP per window
const PHONE_COOLDOWN_MS = 60 * 60 * 1000;      // 1 hour
const PHONE_MAX_ORDERS = 3;                     // max 3 orders per phone per hour
const MIN_SUBMIT_TIME_MS = 3000;                // form must take at least 3 seconds

// ─── Coupon config ──────────────────────────────────────

interface CouponDef {
  discountAmount: number;
  applicableSlugs: string[];
  expiresAt: Date | null;
}

const ACTIVE_COUPONS: Record<string, CouponDef> = {
  INSTAGRAM: {
    discountAmount: 900,                  // 3900 → 3000 on the pack
    applicableSlugs: ["eid-2026-bundle"],
    expiresAt: process.env.COUPON_INSTAGRAM_EXPIRES
      ? new Date(process.env.COUPON_INSTAGRAM_EXPIRES)
      : null,                             // null = no expiry (set env var to enable)
  },
  // The printed gift card («هدية ليك» hang-tag): its QR opens /gift on the
  // frontend, which forwards to /roubla/?gift=HADIA400, and the page sends
  // this code with the order. Printed cards sit in drawers for months, so
  // no expiry — to kill or change the offer, edit this entry and redeploy.
  HADIA400: {
    discountAmount: 400,                  // 2400 → 2000 on Roubla
    applicableSlugs: ["roubla"],
    expiresAt: null,
  },
  // ─── Event / stand codes (the printed QR) ───────────────
  // We can play the games at events but not sell there, so a printed QR sends
  // people to /salon and they order from home. One QR, two doors: the landing
  // page picks the code for the game they tap, because a single code carries a
  // single amount and the two games are discounted differently.
  //
  //   SALON400 → Roubla 2400 → 2000
  //   SALON450 → Dlala  2200 → 1750
  //   either one, both games → 3500 (see CAMPAIGN_PAIR_OFF below)
  //
  // UNLIKE the gift card, these DO expire: the offer is "because you were with
  // us at the stand", and it stops being that a week later. The expiry is
  // enforced here on the server, so it holds even if a printed poster is still
  // on someone's fridge — no need to remember to switch anything off.
  // Nounouti, 5 Sep 2026: one week. Set to the end of 12 Sep, Algeria time
  // (UTC+1), so the last evening of the offer is a full evening.
  SALON400: {
    discountAmount: 400,
    applicableSlugs: ["roubla"],
    expiresAt: new Date("2026-09-12T23:00:00Z"),
  },
  SALON450: {
    discountAmount: 450,
    applicableSlugs: ["dlala"],
    expiresAt: new Date("2026-09-12T23:00:00Z"),
  },
};

// ─── Per-unit coupons ───────────────────────────────────
// Most codes are "X dinars off this order" — a voucher, correctly applied once.
// A few are really a PRICE CUT on one product. The Dlala warm launch tells past
// customers «دلالة بـ 1,750 دج بلاصة 2,200», which is a claim about the UNIT
// price, not about the basket. Until 2026-08-20 the flat discount came off once,
// so a customer who ordered two copies paid 1,750 for the first and 2,200 for
// the second (order #762, found and corrected by hand two hours into the blast).
// Codes listed here scale with the number of units they apply to.
//
// Leave a code OUT of this set unless it is advertised as a per-item price.
// HADIA400 is a gift card and INSTAGRAM is a basket discount — both are right
// to come off only once.
// The event poster prints «روبلة 2,000 دج» and «دلالة 1,750 دج» — those are
// claims about the price of ONE box, exactly like the Dlala launch. Someone who
// scans the stand's QR and buys two copies must get both at the printed price.
const PER_UNIT_COUPONS = new Set<string>(["DLALA-LAUNCH", "SALON400", "SALON450"]);

// ─── Campaign pair pricing ──────────────────────────────
// A code listed here REPLACES the normal 800 DA pair discount with its own,
// instead of stacking on top of it. The Dlala warm launch was doing both:
// 800 off the pair AND 450 off Dlala, so a campaign customer paid 3,350 for
// two games that are advertised at 3,800 (orders #760 and #792).
//
// Nounouti's decision (22 Aug): the campaign gives 450 off EACH game, so the
// pair is 1,750 + 1,950 = 3,700. Same discount per game as the single, and no
// double-dipping with the bundle.
//
// Only codes named here behave this way. An ordinary pair with no coupon keeps
// the full 800 off and stays at 3,800.
//
// The event codes land on ONE pair price from either direction. Nounouti set
// the stand's pair at 3,500 (the public pair is 3,800, so it is visibly better
// — at 3,750 it would have been worth 50 DA and not worth printing).
// Both doors must arrive at the same number, so each code carries its own rate:
//
//   SALON400 (came in on Roubla): 4600 − 700 − 400 = 3500
//   SALON450 (came in on Dlala):  4600 − 650 − 450 = 3500
//
// FIXED AMOUNTS — re-derive all four if either game's price moves.
const CAMPAIGN_PAIR_OFF: Record<string, number> = {
  "DLALA-LAUNCH": 450,
  SALON400: 700,
  SALON450: 650,
};

async function validateCoupon(
  code: string,
  productSlugs: string[]
): Promise<
  | { valid: true; discount: number; slugs: string[] }
  | { valid: false; error: string }
> {
  const coupon = ACTIVE_COUPONS[code];
  if (coupon) {
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
      return { valid: false, error: "كود التخفيض منتهي الصلاحية" };
    }
    const hasApplicable = productSlugs.some((s) =>
      coupon.applicableSlugs.includes(s)
    );
    if (!hasApplicable) {
      return { valid: false, error: "هذا الكود ما يخدمش مع المنتجات لي في السلة" };
    }
    return { valid: true, discount: coupon.discountAmount, slugs: coupon.applicableSlugs };
  }

  // Influencer codes live in the DB (managed from /influencers — no redeploys).
  // A 0-discount code is valid: it still attributes the order to the influencer.
  const influencer = await db.influencer.findUnique({
    where: { couponCode: code },
  });
  if (!influencer || !influencer.active) {
    return { valid: false, error: "كود التخفيض غير صالح" };
  }
  if (
    influencer.applicableSlugs.length > 0 &&
    !productSlugs.some((s) => influencer.applicableSlugs.includes(s))
  ) {
    return { valid: false, error: "هذا الكود ما يخدمش مع المنتجات لي في السلة" };
  }
  // Capped codes ("first 150 copies" launch offers): once the live-order
  // count hits maxUses the code politely stops — server-enforced, so the
  // cap holds even if a page still shows the offer.
  if (influencer.maxUses > 0) {
    const used = await countCapUses(influencer.couponCode);
    if (used >= influencer.maxUses) {
      return {
        valid: false,
        error:
          "😅 العرض الخاص كمّل — النسخ لي كانو بالتخفيض تحجزو قاع! تقدر تكمّل الطلب بالسعر العادي، وشكراً على ثقتك في كيوريو ❤️",
      };
    }
  }
  return { valid: true, discount: influencer.customerDiscount, slugs: influencer.applicableSlugs };
}

function unauthorized() {
  return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
}

/**
 * Get the real client IP from Netlify/proxy headers
 */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ─── GET /api/orders — List all orders (admin) ───────────

export async function GET(request: NextRequest) {
  // Admin key MUST be set in env — no default, no fallback
  if (!ADMIN_KEY) {
    console.error("ADMIN_KEY env var not set — admin access disabled");
    return unauthorized();
  }

  const key = request.headers.get("x-admin-key");
  if (key !== ADMIN_KEY) {
    return unauthorized();
  }

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status"); // filter by status
    const search = url.searchParams.get("search"); // search by name or phone
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Record<string, unknown> = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { customerName: { contains: search, mode: "insensitive" } },
        { customerPhone: { contains: search } },
      ];
    }

    // Get orders + total count
    const [orders, total] = await Promise.all([
      db.order.findMany({
        where,
        include: {
          items: {
            include: {
              product: {
                select: { name: true, slug: true, nameEn: true },
              },
            },
          },
          // Who is meant to call this customer. The admin table shows it on
          // every row so the owner can see the split at a glance before moving
          // orders between agents.
          assignedAgent: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      db.order.count({ where }),
    ]);

    return NextResponse.json({
      orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("GET /api/orders error:", error);
    return NextResponse.json(
      { error: "صار مشكل في تحميل الطلبات" },
      { status: 500 }
    );
  }
}

// ─── POST /api/orders — Create a new order ───────────────

export async function POST(request: NextRequest) {
  // Filled in as soon as we've parsed the body, so a failure row carries who
  // it was and what they were trying to buy. Declared out here so the 500
  // handler at the bottom can still log whatever we knew.
  const ctx: {
    page: string | null;
    ip: string | null;
    phone?: unknown;
    name?: unknown;
    wilayaCode?: unknown;
    slugs?: string[];
  } = { page: pageFromReferer(request.headers.get("referer")), ip: null };

  /**
   * Turn a customer away AND write it to the lost-order log. Every rejection
   * in this handler goes through here — a refused checkout used to vanish
   * without a trace, which is how a 5-week outage stayed invisible.
   * The log write is awaited but self-swallowing: it cannot fail the request.
   */
  async function reject(reason: string, message: string, status = 400) {
    await recordCheckoutFailure({ reason, message, status, ...ctx });
    return NextResponse.json({ error: message }, { status });
  }

  /**
   * Answer a bot with a FAKE success so it never learns it was blocked.
   *
   * ONLY for the honeypot, where a hit is certain: the field is invisible to
   * humans, so filling it proves you are a script. The speed trap used to come
   * through here too and it cost us a real customer — see the note there.
   *
   * Still logged (silent) so these never become invisible again.
   */
  async function fakeSuccess(reason: string) {
    await recordCheckoutFailure({
      reason,
      message: "(fake success returned — customer saw no error)",
      status: 201,
      silent: true,
      ...ctx,
    });
    return NextResponse.json(
      {
        success: true,
        orderNumber: Math.floor(Math.random() * 90000) + 10000,
        total: 0,
        message: "تم تسجيل طلبك بنجاح. راح نتصلو بيك قريبا للتأكيد.",
      },
      { status: 201 }
    );
  }

  try {
    const body = await request.json();
    const clientIp = getClientIp(request);
    ctx.ip = clientIp !== "unknown" ? clientIp : null;
    ctx.phone = body?.customerPhone;
    ctx.name = body?.customerName;
    ctx.wilayaCode = body?.wilayaCode;
    ctx.slugs = Array.isArray(body?.items)
      ? body.items.map((i: { slug?: string }) => i?.slug).filter(Boolean)
      : [];

    // ─── SECURITY CHECK 1: Honeypot ─────────────────────
    // Frontend has a hidden field called "website". Humans never see it.
    // Bots auto-fill it. If it has a value → silent reject (looks like success to the bot).
    if (body.website) {
      // Return fake success so bots think it worked
      return await fakeSuccess("bot_honeypot");
    }

    // ─── SECURITY CHECK 2: Speed trap ───────────────────
    // Frontend sends a timestamp of when the page loaded. A form filled in
    // under 3 seconds is almost certainly a bot.
    //
    // TWO THINGS THIS GETS WRONG IF WRITTEN NAIVELY, both found on 23 Aug after
    // a customer sent a screenshot of an order we had no record of:
    //
    // 1. `_t` is made on the CUSTOMER'S device, `Date.now()` here is OUR clock.
    //    A phone running a few minutes fast makes `elapsed` NEGATIVE, which is
    //    "less than 3 seconds", so a real buyer got treated as a bot. Her phone
    //    read 01:43 while the server logged 01:40 — she could not have escaped
    //    it without spending three minutes on the form. A negative elapsed means
    //    the two clocks disagree, never that a human typed impossibly fast, so
    //    it is not evidence of anything and we ignore it.
    //
    // 2. Answering a suspected bot with a fake success is right for the
    //    honeypot, where a hit is certain. Here a hit is a guess — and a human
    //    who guesses wrong is shown a convincing order number for an order that
    //    was never created, so they wait for a parcel that is not coming. Far
    //    better to ask them to try again: a person simply resubmits and passes
    //    (their second attempt is slower), while a bot looping instantly keeps
    //    hitting the same wall.
    const formLoadedAt = Number(body._t);
    if (Number.isFinite(formLoadedAt) && formLoadedAt > 0) {
      const elapsed = Date.now() - formLoadedAt;
      if (elapsed >= 0 && elapsed < MIN_SUBMIT_TIME_MS) {
        return await reject(
          "bot_speed_trap",
          "ثانية برك... عاود اضغط على الزر باش نأكدو الطلب 🙏",
          429
        );
      }
    }

    // ─── SECURITY CHECK 3: IP rate limiting ─────────────
    // Max 5 orders per IP in the last 10 minutes.
    if (clientIp !== "unknown") {
      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
      const recentOrdersByIp = await db.order.count({
        where: {
          ip: clientIp,
          createdAt: { gte: windowStart },
        },
      });

      if (recentOrdersByIp >= RATE_LIMIT_MAX_ORDERS) {
        return await reject("rate_limit_ip", "بزاف ديال الطلبات! جرب بعد شويا.", 429);
      }
    }

    // --- Extract fields ---
    const {
      items, // Array of { slug, quantity } or { productId, quantity }
      customerName,
      customerPhone,
      customerPhone2,
      wilayaCode,
      deliveryType, // "HOME" or "OFFICE"
      commune,      // baladiya name (Ecotrack commune) — required for HOME
      address,
      officeName,
      officeCommune,
      couponCode,
      notes,
      // Traffic source — sent by the site from the URL of the visitor's first
      // page. Wire names match the URL parameters so nothing has to be renamed
      // in three places when a tag changes.
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      referrer,
      // Meta's own cookies, read from document.cookie by the checkout. The
      // store API is on another domain so the browser never sends them itself.
      fbc,
      fbp,
    } = body;

    // These come straight off a URL a stranger can type, so treat them as
    // hostile: strings only, trimmed, length-capped, control characters out.
    // These arrive on a URL a stranger can type, so treat them as hostile.
    // Character filter rather than a regex: keeps Arabic and every other
    // script intact while dropping control characters and the few marks that
    // cause trouble when this text is later rendered in the console.
    const cleanTag = (v: unknown, max = 120): string | null => {
      if (typeof v !== "string") return null;
      let out = "";
      for (const ch of v) {
        const code = ch.charCodeAt(0);
        if (code < 32 || code === 127) continue;
        if (ch === "<" || ch === ">" || ch === String.fromCharCode(34) || ch === String.fromCharCode(39)) continue;
        out += ch;
      }
      const s = out.trim().slice(0, max);
      return s.length ? s : null;
    };

    // --- Validate required fields ---
    if (!customerName || typeof customerName !== "string" || customerName.trim().length < 2) {
      return await reject("name_missing", "الاسم مطلوب (حرفين على الأقل)");
    }

    // Accept the number however the customer wrote it, then judge the canonical
    // form. Everything downstream (cooldown check, the saved order, Ecotrack)
    // uses `phone` / `phone2` so we store one consistent shape.
    const phone = normalizeDzPhone(customerPhone);
    const phone2 = normalizeDzPhone(customerPhone2);

    if (!phone || !PHONE_RE.test(phone)) {
      return await reject("phone_invalid", "رقم الهاتف لازم يكون 10 أرقام ويبدا بـ 05 أو 06 أو 07");
    }

    if (customerPhone2 && !PHONE_RE.test(phone2)) {
      return await reject("phone2_invalid", "رقم الهاتف الثاني غير صحيح");
    }

    // ─── SECURITY CHECK 4: Phone number cooldown ────────
    // Max 3 orders per phone number per hour.
    const phoneCooldownStart = new Date(Date.now() - PHONE_COOLDOWN_MS);
    const recentOrdersByPhone = await db.order.count({
      where: {
        customerPhone: phone,
        createdAt: { gte: phoneCooldownStart },
      },
    });

    if (recentOrdersByPhone >= PHONE_MAX_ORDERS) {
      return await reject("rate_limit_phone", "عندك طلبات كثيرة. جرب بعد ساعة.", 429);
    }

    if (
      wilayaCode === undefined ||
      wilayaCode === null ||
      wilayaCode === "" ||
      (typeof wilayaCode !== "string" && typeof wilayaCode !== "number")
    ) {
      return await reject("wilaya_missing", "لازم تختار الولاية");
    }

    // Wilaya codes are stored 2-digit ("01".."58"). The checkout pages build
    // their dropdown from delivery.json, where the code is a plain number, so
    // wilayas 1-9 arrived here as "1".."9" and failed the lookup below —
    // silently killing every order from those 9 wilayas. Normalise on the way
    // in so any client (including pages already cached in customers' browsers)
    // resolves correctly.
    const normalizedWilayaCode = String(wilayaCode).trim().padStart(2, "0");

    if (deliveryType !== "HOME" && deliveryType !== "OFFICE") {
      return await reject("delivery_type_invalid", "نوع التوصيل لازم يكون HOME أو OFFICE");
    }

    if (deliveryType === "HOME" && (!address || address.trim().length < 5)) {
      return await reject("address_too_short", "دخل العنوان بالتفصيل (5 حروف على الأقل)");
    }

    if (deliveryType === "HOME" && (!commune || typeof commune !== "string" || !commune.trim())) {
      return await reject("commune_missing", "اختار البلدية");
    }

    if (deliveryType === "OFFICE" && !officeCommune) {
      return await reject("office_missing", "اختار المكتب لي تحب تستلم منه");
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return await reject("items_empty", "لازم تختار منتج واحد على الأقل");
    }

    // Cap items array to prevent abuse (nobody orders 50 different products)
    if (items.length > 10) {
      return await reject("items_too_many", "الطلب فيه بزاف ديال المنتجات");
    }

    // --- Look up wilaya from database ---
    const wilaya = await db.wilaya.findUnique({ where: { code: normalizedWilayaCode } });

    if (!wilaya || !wilaya.active) {
      return await reject("wilaya_unavailable", "الولاية غير متوفرة للتوصيل");
    }

    const deliveryPrice =
      deliveryType === "HOME" ? wilaya.homePrice : wilaya.officePrice;

    if (deliveryPrice === 0) {
      return await reject("wilaya_no_price", "التوصيل غير متوفر لهذه الولاية حاليا");
    }

    // --- Look up products and check stock (READ-ONLY — no decrement) ---
    const hasSlugs = items[0]?.slug;
    const products = hasSlugs
      ? await db.product.findMany({
          where: { slug: { in: items.map((i: { slug: string }) => i.slug) }, active: true },
        })
      : await db.product.findMany({
          where: { id: { in: items.map((i: { productId: string }) => i.productId) }, active: true },
        });

    if (products.length !== items.length) {
      return await reject("product_unavailable", "واحد من المنتجات غير متوفر");
    }

    // Build lookup by both id and slug
    const productBySlug = new Map(products.map((p) => [p.slug, p]));
    const productById = new Map(products.map((p) => [p.id, p]));

    let subtotal = 0;
    const orderItems: { productId: string; quantity: number; unitPrice: number }[] = [];
    // Built from the RESOLVED product, never from the request body. The
    // checkout still accepts a legacy productId-only shape, where `item.slug`
    // is undefined — deriving stock lines from the request there would hand
    // moveStock a blank slug and take no stock at all.
    const stockLines: { slug: string; quantity: number }[] = [];
    let hasWaitlistItem = false;

    for (const item of items) {
      const product = item.slug ? productBySlug.get(item.slug) : productById.get(item.productId);
      if (!product) {
        return await reject("product_unknown", "منتج غير معروف");
      }

      const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));

      // Check stock but DON'T decrement it.
      // Stock is only decremented when order is CONFIRMED.
      // This prevents fake orders from draining inventory.
      // When stock = 0, accept as waitlist (for next batch contact).
      // For a bundle, its own stored stock is meaningless — what can be sold
      // is whichever component runs out first. Reading the pack's own counter
      // would happily take an order for a pack when Roubla is finished, which
      // is exactly how the 79-person waitlist happened.
      const available = await availableUnits(product.slug);
      if (available > 0 && qty > available) {
        return await reject("out_of_stock", `${product.name} — الكمية المطلوبة غير متوفرة (باقي ${available})`);
      }
      if (available <= 0) {
        hasWaitlistItem = true;
      }

      orderItems.push({
        productId: product.id,
        quantity: qty,
        unitPrice: product.price,
      });
      stockLines.push({ slug: product.slug, quantity: qty });

      subtotal += product.price * qty;
    }

    // --- Bundle pricing: a Roubla + Dlala pair costs 3,800, not 4,600 ---
    // The product pages' upsell adds the two games as separate items; this
    // applies the promised pair price server-side (800 off per matched pair).
    // The homepage pack uses the dedicated roubla-dlala-pack product with its
    // own 3,800 price, so it is unaffected.
    // NOTE: this is a FIXED amount, so it must be re-derived whenever either
    // game's price moves. 2,400 + 2,200 = 4,600 − 800 = 3,800. (Jul 26 2026:
    // was 580, back when Roubla was 2,390 and Dlala 1,990.)
    const BUNDLE_PAIR_OFF = 800;
    const slugQty = (slug: string) =>
      orderItems.reduce((n, it) => {
        const p = productById.get(it.productId);
        return p?.slug === slug ? n + it.quantity : n;
      }, 0);
    const bundlePairs = Math.min(slugQty("roubla"), slugQty("dlala"));
    let bundleDiscount = bundlePairs * BUNDLE_PAIR_OFF;

    // --- Coupon validation (hardcoded legacy codes + DB influencer codes) ---
    let discountAmount = 0;
    let normalizedCoupon: string | null = null;
    if (couponCode && typeof couponCode === "string" && couponCode.trim()) {
      const cartSlugs = products.map((p) => p.slug);
      normalizedCoupon = couponCode.trim().toUpperCase();
      const couponResult = await validateCoupon(normalizedCoupon, cartSlugs);
      if (!couponResult.valid) {
        return await reject("coupon_rejected", couponResult.error);
      }
      discountAmount = couponResult.discount;

      // A price-cut code scales with quantity (see PER_UNIT_COUPONS above).
      // An empty slugs list means the code covers everything in the basket.
      if (discountAmount > 0 && PER_UNIT_COUPONS.has(normalizedCoupon)) {
        const eligibleUnits = couponResult.slugs.length
          ? couponResult.slugs.reduce((n, slug) => n + slugQty(slug), 0)
          : orderItems.reduce((n, it) => n + it.quantity, 0);
        discountAmount = discountAmount * Math.max(1, eligibleUnits);
      }

      // A campaign code sets its own pair rate in place of the usual 800.
      if (normalizedCoupon in CAMPAIGN_PAIR_OFF) {
        bundleDiscount = bundlePairs * CAMPAIGN_PAIR_OFF[normalizedCoupon];
      }

      // Whatever the code says, the customer never gets the goods for free.
      discountAmount = Math.max(0, Math.min(discountAmount, subtotal - bundleDiscount));
    }

    const total = subtotal - bundleDiscount - discountAmount + deliveryPrice;

    // Build notes with coupon info
    let orderNotes = notes || null;
    if (couponCode) {
      const couponInfo = discountAmount > 0
        ? `كود التخفيض: ${couponCode} (-${discountAmount} دج)`
        : `كود التخفيض: ${couponCode}`;
      orderNotes = couponInfo + (notes ? " | " + notes : "");
    }
    if (bundleDiscount > 0) {
      const bundleInfo = `باك روبلة+دلالة: -${bundleDiscount} دج`;
      orderNotes = orderNotes ? orderNotes + " | " + bundleInfo : bundleInfo;
    }

    // Append waitlist flag if any product was out of stock
    if (hasWaitlistItem) {
      const waitlistNote = "⏳ waitlist — منتج نسالو وقت الطلب";
      orderNotes = orderNotes ? orderNotes + " | " + waitlistNote : waitlistNote;
    }

    // --- Create order ---
    // If any line is sold out the order opens as WAITLIST, not PENDING. It
    // used to land in PENDING carrying only a note, which is how ~100 orders
    // hid among the genuinely new ones for three months before anyone
    // noticed. WAITLIST gives them their own tab from the moment they arrive.
    // Route the order to the default confirmation agent right now, so it lands
    // in a real person's queue instead of a pool nobody owns. Null (no agent
    // exists / lookup failed) is survivable — the owner reassigns it in /admin/.
    const routedAgentId = await resolveDefaultAgentId();

    const order = await db.order.create({
      data: {
        status: hasWaitlistItem ? "WAITLIST" : "PENDING",
        assignedAgentId: routedAgentId,
        customerName: customerName.trim(),
        customerPhone: phone,
        customerPhone2: phone2 || null,
        wilayaCode: normalizedWilayaCode,
        wilayaName: wilaya.name,
        deliveryType,
        commune: deliveryType === "HOME" ? commune.trim() : null,
        address: deliveryType === "HOME" ? address.trim() : null,
        officeName: deliveryType === "OFFICE" ? (officeName || null) : null,
        officeCommune: deliveryType === "OFFICE" ? officeCommune : null,
        deliveryPrice,
        subtotal,
        total,
        couponCode: normalizedCoupon,
        couponDiscount: discountAmount,
        ip: clientIp !== "unknown" ? clientIp : null,
        utmSource: cleanTag(utm_source, 40),
        utmMedium: cleanTag(utm_medium, 40),
        utmCampaign: cleanTag(utm_campaign, 120),
        utmContent: cleanTag(utm_content, 120),
        referrer: cleanTag(referrer, 300),
        fbc: cleanTag(fbc, 255),
        fbp: cleanTag(fbp, 255),
        // Taken from the request, never from the client — a browser can claim
        // to be anything, but Meta wants the string the request actually carried.
        userAgent: cleanTag(request.headers.get("user-agent"), 400),
        notes: orderNotes,
      },
    });

    // Create order items and decrement stock immediately
    for (const item of orderItems) {
      await db.orderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        },
      });
    }

    // Decrement stock immediately when order is placed — EXCEPT for a
    // waitlisted order, which by definition is not holding a unit (WAITLIST
    // is in RESTOCK_FAMILY). Taking stock here as well would double-count:
    // once now, and again when the agent moves it out of WAITLIST.
    if (!hasWaitlistItem) {
      // Through moveStock, so a pack takes a Roubla AND a Dlala off the
      // shelf rather than decrementing a counter for a box that does not
      // physically exist.
      await moveStock(stockLines, "take");
    }

    // --- Auto-send to OrderDZ for confirmation ---
    // DISABLED (Jul 2026): Curio now confirms in-house via its own console.
    // Kept behind a flag so it can be re-enabled instantly if ever needed.
    if (process.env.ORDERDZ_ENABLED === "true") {
    try {
      const confirmationItems = orderItems.map((item) => {
        const product = productById.get(item.productId);
        return {
          productName: product?.name || "Unknown",
          slug: product?.slug || "",
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        };
      });

      const orderdzResult = await sendToOrderDZ({
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerPhone2: order.customerPhone2,
        wilayaName: order.wilayaName,
        wilayaCode: order.wilayaCode,
        deliveryType: order.deliveryType,
        address: order.address,
        officeName: order.officeName,
        officeCommune: order.officeCommune,
        deliveryPrice: order.deliveryPrice,
        total: order.total,
        notes: order.notes,
        items: confirmationItems,
      });

      if (orderdzResult.externalId) {
        await db.order.update({
          where: { id: order.id },
          data: { externalId: orderdzResult.externalId },
        });
      }
    } catch (err) {
      console.error("[OrderDZ] Auto-send failed (order saved anyway):", err);
    }
    } // end ORDERDZ_ENABLED gate

    // --- Auto-queue Confirmi Voice (AI confirmation call) ---
    // Mirrors the OrderDZ fire-and-forget pattern. Confirmi schedules
    // an AI confirmation dial ~60-120s later. Env-gated: when
    // CONFIRMI_VOICE_URL/SECRET are unset, this returns silently.
    try {
      const confirmiItems = orderItems.map((item) => {
        const product = productById.get(item.productId);
        return {
          productSlug: product?.slug ?? "",
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        };
      });
      await sendToConfirmiVoice({
        orderNumber: order.orderNumber,
        createdAt: order.createdAt,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerPhone2: order.customerPhone2,
        wilayaCode: order.wilayaCode,
        wilayaName: order.wilayaName,
        deliveryType: order.deliveryType,
        address: order.address,
        officeName: order.officeName,
        officeCommune: order.officeCommune,
        deliveryPrice: order.deliveryPrice,
        total: order.total,
        notes: order.notes,
        items: confirmiItems,
      });
    } catch (err) {
      console.error("[ConfirmiVoice] Auto-send failed (order saved anyway):", err);
    }

    // --- Tell Meta about the sale, server-side ---
    // The checkout already fires the browser Purchase with eventID
    // "order-<n>"; this sends the same event_id so Meta counts ONE sale, not
    // two. The value is recovering the events that browser script never
    // manages to send — blocked by iOS tracking prevention, ad blockers, or a
    // tab closed too quickly — and carrying identifiers a browser never has.
    //
    // Deliberately awaited rather than fired and forgotten: on serverless the
    // process can be frozen the moment the response is returned, which would
    // silently drop most events. The call is capped at 2.5s and swallows its
    // own failures, so the worst case is a slightly slower response, never a
    // lost order.
    //
    // A WAITLIST order is NOT a sale and must never be reported as one. It
    // holds no stock (the decrement below skips it), reserves no unit, and is
    // really "tell me when it is back". Reporting it would be actively
    // harmful, not merely inaccurate: stock runs out mid-campaign, Meta keeps
    // being told the ads convert beautifully, and it pushes more budget at
    // traffic that cannot be fulfilled. ~101 of these once piled up unnoticed
    // over three months, so this is not a hypothetical.
    if (order.status !== "WAITLIST") {
      try {
        await sendPurchaseToMeta({
          orderNumber: order.orderNumber,
          total: order.total,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          wilayaName: order.wilayaName,
          commune: order.commune || order.officeCommune,
          ip: order.ip,
          userAgent: order.userAgent,
          fbc: order.fbc,
          fbp: order.fbp,
        });
      } catch (err) {
        console.error("[capi] Auto-send failed (order saved anyway):", err);
      }
    }

    // --- Return success ---
    // upsellToken lets THIS browser add the paired game to THIS order for the
    // next half hour (see lib/upsell-token). The product pages now save the
    // order before showing the cross-sell, so a customer who closes the page
    // at that moment is still a customer.
    return NextResponse.json(
      {
        success: true,
        orderNumber: order.orderNumber,
        total: order.total,
        upsellToken: signUpsellToken(order.orderNumber),
        message: "تم تسجيل طلبك بنجاح. راح نتصلو بيك قريبا للتأكيد.",
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/orders error:", error);
    // A crash costs a customer just as much as a validation refusal, so it
    // belongs in the same log — with the error text, to make it debuggable.
    const message = "صار مشكل في تسجيل الطلب. حاول مرة أخرى.";
    await recordCheckoutFailure({
      reason: "server_error",
      message: `${message} [${error instanceof Error ? error.message : String(error)}]`,
      status: 500,
      ...ctx,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
