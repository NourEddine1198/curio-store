import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// ─── Validation helpers ──────────────────────────────────

const PHONE_RE = /^0[567]\d{8}$/; // Algerian mobile: 05/06/07 + 8 digits

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

// ─── POST /api/orders — Create a new order ───────────────

export async function POST(request: Request) {
  try {
    const body = await request.json();

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

    // --- Look up products and calculate subtotal ---
    // Accept either slugs or IDs (slugs preferred from frontend)
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

    for (const item of items) {
      const product = item.slug ? productBySlug.get(item.slug) : productById.get(item.productId);
      if (!product) {
        return badRequest("منتج غير معروف");
      }

      const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));

      if (qty > product.stock) {
        return badRequest(`${product.name} — الكمية المطلوبة غير متوفرة (باقي ${product.stock})`);
      }

      orderItems.push({
        productId: product.id,
        quantity: qty,
        unitPrice: product.price,
      });

      subtotal += product.price * qty;
    }

    const total = subtotal + deliveryPrice;

    // --- Create order, then items, then update stock ---
    // Neon HTTP adapter doesn't support transactions (even implicit nested creates).
    // We do each step separately. Fine for COD with manual confirmation.
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
        notes: couponCode
          ? `كود التخفيض: ${couponCode}${notes ? " | " + notes : ""}`
          : notes || null,
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

    // Decrease stock for each product
    for (const item of orderItems) {
      await db.product.update({
        where: { id: item.productId },
        data: { stock: { decrement: item.quantity } },
      });
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
