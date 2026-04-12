import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendToOrderDZ } from "@/lib/orderdz";

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
};

function validateCoupon(
  code: string,
  productSlugs: string[]
): { valid: true; discount: number } | { valid: false; error: string } {
  const coupon = ACTIVE_COUPONS[code];
  if (!coupon) {
    return { valid: false, error: "كود التخفيض غير صالح" };
  }
  if (coupon.expiresAt && new Date() > coupon.expiresAt) {
    return { valid: false, error: "كود التخفيض منتهي الصلاحية" };
  }
  const hasApplicable = productSlugs.some((s) =>
    coupon.applicableSlugs.includes(s)
  );
  if (!hasApplicable) {
    return { valid: false, error: "هذا الكود يخدم غير مع الباك" };
  }
  return { valid: true, discount: coupon.discountAmount };
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function unauthorized() {
  return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
}

function tooMany(message: string) {
  return NextResponse.json({ error: message }, { status: 429 });
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
  try {
    const body = await request.json();
    const clientIp = getClientIp(request);

    // ─── SECURITY CHECK 1: Honeypot ─────────────────────
    // Frontend has a hidden field called "website". Humans never see it.
    // Bots auto-fill it. If it has a value → silent reject (looks like success to the bot).
    if (body.website) {
      // Return fake success so bots think it worked
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

    // ─── SECURITY CHECK 2: Speed trap ───────────────────
    // Frontend sends a timestamp of when the page loaded.
    // If the form was submitted in < 3 seconds, it's almost certainly a bot.
    const formLoadedAt = Number(body._t);
    if (formLoadedAt) {
      const elapsed = Date.now() - formLoadedAt;
      if (elapsed < MIN_SUBMIT_TIME_MS) {
        // Too fast — silent fake success
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
        return tooMany("بزاف ديال الطلبات! جرب بعد شويا.");
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
      address,
      officeName,
      officeCommune,
      couponCode,
      notes,
    } = body;

    // --- Validate required fields ---
    if (!customerName || typeof customerName !== "string" || customerName.trim().length < 2) {
      return badRequest("الاسم مطلوب (حرفين على الأقل)");
    }

    if (!customerPhone || !PHONE_RE.test(customerPhone)) {
      return badRequest("رقم الهاتف لازم يكون 10 أرقام ويبدا بـ 05 أو 06 أو 07");
    }

    if (customerPhone2 && !PHONE_RE.test(customerPhone2)) {
      return badRequest("رقم الهاتف الثاني غير صحيح");
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
      return tooMany("عندك طلبات كثيرة. جرب بعد ساعة.");
    }

    if (!wilayaCode || typeof wilayaCode !== "string") {
      return badRequest("لازم تختار الولاية");
    }

    if (deliveryType !== "HOME" && deliveryType !== "OFFICE") {
      return badRequest("نوع التوصيل لازم يكون HOME أو OFFICE");
    }

    if (deliveryType === "HOME" && (!address || address.trim().length < 5)) {
      return badRequest("دخل العنوان بالتفصيل (5 حروف على الأقل)");
    }

    if (deliveryType === "OFFICE" && (!officeName || !officeCommune)) {
      return badRequest("اختار المكتب لي تحب تستلم منه");
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return badRequest("لازم تختار منتج واحد على الأقل");
    }

    // Cap items array to prevent abuse (nobody orders 50 different products)
    if (items.length > 10) {
      return badRequest("الطلب فيه بزاف ديال المنتجات");
    }

    // --- Look up wilaya from database ---
    const wilaya = await db.wilaya.findUnique({ where: { code: wilayaCode } });

    if (!wilaya || !wilaya.active) {
      return badRequest("الولاية غير متوفرة للتوصيل");
    }

    const deliveryPrice =
      deliveryType === "HOME" ? wilaya.homePrice : wilaya.officePrice;

    if (deliveryPrice === 0) {
      return badRequest("التوصيل غير متوفر لهذه الولاية حاليا");
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
      return badRequest("واحد من المنتجات غير متوفر");
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
        return badRequest("منتج غير معروف");
      }

      const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));

      // Check stock but DON'T decrement it.
      // Stock is only decremented when order is CONFIRMED.
      // This prevents fake orders from draining inventory.
      // When stock = 0, accept as waitlist (for next batch contact).
      if (product.stock > 0 && qty > product.stock) {
        return badRequest(`${product.name} — الكمية المطلوبة غير متوفرة (باقي ${product.stock})`);
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

    // --- Coupon validation ---
    let discountAmount = 0;
    if (couponCode && typeof couponCode === "string") {
      const cartSlugs = products.map((p) => p.slug);
      const couponResult = validateCoupon(
        couponCode.trim().toUpperCase(),
        cartSlugs
      );
      if (!couponResult.valid) {
        return badRequest(couponResult.error);
      }
      discountAmount = couponResult.discount;
    }

    const total = subtotal - discountAmount + deliveryPrice;

    // Build notes with coupon info
    let orderNotes = notes || null;
    if (couponCode) {
      const couponInfo = discountAmount > 0
        ? `كود التخفيض: ${couponCode} (-${discountAmount} دج)`
        : `كود التخفيض: ${couponCode}`;
      orderNotes = couponInfo + (notes ? " | " + notes : "");
    }

    // Append waitlist flag if any product was out of stock
    if (hasWaitlistItem) {
      const waitlistNote = "⏳ waitlist — منتج نسالو وقت الطلب";
      orderNotes = orderNotes ? orderNotes + " | " + waitlistNote : waitlistNote;
    }

    // --- Create order (NO stock decrement — that happens on confirmation) ---
    const order = await db.order.create({
      data: {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerPhone2: customerPhone2?.trim() || null,
        wilayaCode,
        wilayaName: wilaya.name,
        deliveryType,
        address: deliveryType === "HOME" ? address.trim() : null,
        officeName: deliveryType === "OFFICE" ? officeName : null,
        officeCommune: deliveryType === "OFFICE" ? officeCommune : null,
        deliveryPrice,
        subtotal,
        total,
        ip: clientIp !== "unknown" ? clientIp : null,
        notes: orderNotes,
      },
    });

    // Create order items one by one
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

    // NOTE: Stock is NOT decremented here anymore.
    // Stock decreases only when order status → CONFIRMED (via webhook or admin).
    // This prevents fake/bot orders from draining inventory.

    // --- Auto-send to OrderDZ for confirmation ---
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
    return NextResponse.json(
      { error: "صار مشكل في تسجيل الطلب. حاول مرة أخرى." },
      { status: 500 }
    );
  }
}
