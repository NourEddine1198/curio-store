import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendToOrderDZ } from "@/lib/orderdz";
import { sendToConfirmiVoice } from "@/lib/confirmi-voice";
import { countCapUses } from "@/lib/influencer-stats";
import { recordCheckoutFailure, pageFromReferer } from "@/lib/checkout-failures";

// ─── Validation helpers ──────────────────────────────────

const PHONE_RE = /^0[567]\d{8}$/; // Algerian mobile: 05/06/07 + 8 digits

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
};

async function validateCoupon(
  code: string,
  productSlugs: string[]
): Promise<{ valid: true; discount: number } | { valid: false; error: string }> {
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
    return { valid: true, discount: coupon.discountAmount };
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
  return { valid: true, discount: influencer.customerDiscount };
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
   * Bot traps answer with a FAKE success, so the customer (or bot) sees no
   * error at all. Logged as silent so a real person caught by the speed trap
   * isn't invisible — that would be the same blind spot all over again.
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
    // Frontend sends a timestamp of when the page loaded.
    // If the form was submitted in < 3 seconds, it's almost certainly a bot.
    const formLoadedAt = Number(body._t);
    if (formLoadedAt) {
      const elapsed = Date.now() - formLoadedAt;
      if (elapsed < MIN_SUBMIT_TIME_MS) {
        // Too fast — silent fake success
        return await fakeSuccess("bot_speed_trap");
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
    } = body;

    // --- Validate required fields ---
    if (!customerName || typeof customerName !== "string" || customerName.trim().length < 2) {
      return await reject("name_missing", "الاسم مطلوب (حرفين على الأقل)");
    }

    if (!customerPhone || !PHONE_RE.test(customerPhone)) {
      return await reject("phone_invalid", "رقم الهاتف لازم يكون 10 أرقام ويبدا بـ 05 أو 06 أو 07");
    }

    if (customerPhone2 && !PHONE_RE.test(customerPhone2)) {
      return await reject("phone2_invalid", "رقم الهاتف الثاني غير صحيح");
    }

    // ─── SECURITY CHECK 4: Phone number cooldown ────────
    // Max 3 orders per phone number per hour.
    const phoneCooldownStart = new Date(Date.now() - PHONE_COOLDOWN_MS);
    const recentOrdersByPhone = await db.order.count({
      where: {
        customerPhone: customerPhone,
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
      if (product.stock > 0 && qty > product.stock) {
        return await reject("out_of_stock", `${product.name} — الكمية المطلوبة غير متوفرة (باقي ${product.stock})`);
      }
      if (product.stock <= 0) {
        hasWaitlistItem = true;
      }

      orderItems.push({
        productId: product.id,
        quantity: qty,
        unitPrice: product.price,
      });

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
    const bundleDiscount = bundlePairs * BUNDLE_PAIR_OFF;

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
    const order = await db.order.create({
      data: {
        status: hasWaitlistItem ? "WAITLIST" : "PENDING",
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerPhone2: customerPhone2?.trim() || null,
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
      for (const item of orderItems) {
        await db.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });
      }
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

    // --- Return success ---
    return NextResponse.json(
      {
        success: true,
        orderNumber: order.orderNumber,
        total: order.total,
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
